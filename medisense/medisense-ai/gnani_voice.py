"""Gnani voice layer for VELA: Prisma (speech-to-text) and Timbre (text-to-speech).

Everything that talks to Gnani lives here so it can be read top to bottom.
The API key is read from the backend environment only; it never reaches the browser.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import time
import unicodedata
from collections import defaultdict
from datetime import datetime

import httpx
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from pydantic import BaseModel

GNANI_BASE = "https://api.vachana.ai"      # one host for both Prisma and Timbre
PRISMA_MODEL = "prisma-v3.0"               # v3.0 understands Hindi+English mixed speech
PRISMA_LANGS = "hi-IN,en-IN"               # hints, not locks: the model follows what is spoken
PRISMA_FORMAT = "codemix"                  # keep English words in Latin script, Hindi in Devanagari
TIMBRE_MODEL = "timbre-v2.5"               # recommended model in Gnani's docs
TTS_MAX_CHARS = 2500                       # keep requests small; long text returns HTTP 500
MAX_AUDIO_BYTES = int(float(os.getenv("GNANI_MAX_AUDIO_MB", "4")) * 1024 * 1024)

# Voice per language. Hinglish uses Poorvi (the only hi-en voice) and can be
# switched to Nalini with HINGLISH_VOICE=Nalini if Poorvi sounds off.
VOICES = {
    "hi-IN": "Nalini",
    "hi-en": os.getenv("HINGLISH_VOICE", "Poorvi"),
    "en-IN": "Kaveri",
}
_DEVANAGARI = re.compile(r"[ऀ-ॿ]")


def _api_key() -> str:
    # Read at call time so a key added to .env and reloaded is picked up.
    return os.getenv("GNANI_API_KEY", "").strip()


def pick_language(text: str) -> str:
    """Devanagari text is Hindi; anything else is Indian English unless the caller says Hinglish."""
    return "hi-IN" if _DEVANAGARI.search(text) else "en-IN"


# One shared HTTP client keeps the TLS connection to Gnani open between calls,
# which saves a handshake (~100-200 ms) on every request.
_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=GNANI_BASE, timeout=httpx.Timeout(30.0, connect=5.0),
                                    limits=httpx.Limits(keepalive_expiry=120))   # default is 5 s: a pause = new TLS handshake
    return _client


# Some Gnani accounts allow only ONE request at a time (extra ones get HTTP 429).
# One lock for Prisma AND Timbre makes every call wait its turn instead of failing.
_gnani_lock = asyncio.Lock()


# Running totals since the server started, so a manager can watch Gnani usage (credits) and latency.
STATS = {"since": time.time(),
         "prisma": {"calls": 0, "errors": 0, "audio_kb": 0, "ms_total": 0},
         "timbre": {"calls": 0, "errors": 0, "chars": 0, "ms_total": 0}}


def _count(service: str, ok: bool, ms: int) -> None:
    st = STATS[service]
    st["calls"] += 1
    st["ms_total"] += ms
    if not ok:
        st["errors"] += 1


class GnaniError(Exception):
    """Raised when Prisma/Timbre cannot do the job; `status` is the HTTP status to report."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


TimbreError = GnaniError   # older name, kept so existing imports keep working


async def _post(path: str, ms_key: str, timings: dict | None, **kwargs) -> httpx.Response:
    """POST to Gnani under the lock; retry on 429 with a short backoff; record how long it took."""
    key = _api_key()
    if not key:
        raise GnaniError(503, "Voice service not configured")
    async with _gnani_lock:
        t0 = time.perf_counter()
        for attempt in range(4):
            try:
                r = await _get_client().post(path, headers={"X-API-Key-ID": key}, **kwargs)
            except httpx.HTTPError as e:
                raise GnaniError(502, f"Voice service unreachable ({type(e).__name__})")
            if r.status_code != 429:
                break
            await asyncio.sleep(0.3 * (2 ** attempt))   # 0.3s, 0.6s, 1.2s, 2.4s
        elapsed = round((time.perf_counter() - t0) * 1000)
        if timings is not None:
            timings[ms_key] = elapsed
        _count("prisma" if path.startswith("/stt") else "timbre", r.status_code == 200, elapsed)
    return r


# ───────────────────────── Timbre: text -> speech ─────────────────────────

async def synthesize(text: str, language: str | None = None, voice: str | None = None,
                     timings: dict | None = None) -> bytes:
    """Turn text into MP3 bytes with Timbre."""
    text = (text or "").strip()[:TTS_MAX_CHARS]
    if not text:
        raise GnaniError(400, "Nothing to say")
    language = language or pick_language(text)
    body = {
        "text": text,
        "model": TIMBRE_MODEL,
        "voice": voice or VOICES.get(language, "Nalini"),
        "language": language,
        "speed": 1.0,
        # MP3 so the browser (and Atlas's existing player) can play it directly.
        "audio_config": {"sample_rate": 24000, "num_channels": 1, "sample_width": 2,
                         "encoding": "linear_pcm", "container": "mp3", "bitrate": "64k"},
    }
    r = await _post("/api/v1/tts/inference", "timbre_ms", timings, json=body)
    STATS["timbre"]["chars"] += len(text)
    if r.status_code == 200:
        return r.content
    # 401/402/403 etc. are our problem (key/credits), not the user's: report as 502.
    print(f"⚠️ Timbre returned {r.status_code}")
    raise GnaniError(502, "Voice service unavailable")


# ───────────────────────── Prisma: speech -> text ─────────────────────────

def _looks_like_audio(b: bytes) -> bool:
    """Check the first bytes (the 'magic number'), not the filename the client claims."""
    return (
        (b[:4] == b"RIFF" and b[8:12] == b"WAVE")       # WAV (what the browser recorder sends)
        or b[:4] == b"OggS"                              # OGG
        or b[:4] == b"fLaC"                              # FLAC
        or b[:3] == b"ID3" or b[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")   # MP3
        or b[4:8] == b"ftyp"                             # M4A / AAC in MP4
    )


async def transcribe(audio: bytes, timings: dict | None = None) -> dict:
    """Send recorded audio to Prisma. Returns {"transcript": str, "language": str}."""
    if not audio:
        raise GnaniError(400, "No audio received")
    if len(audio) > MAX_AUDIO_BYTES:
        raise GnaniError(413, "Recording is too large")
    if not _looks_like_audio(audio):
        raise GnaniError(415, "Unsupported audio format (send WAV)")
    r = await _post(
        "/stt/v3", "prisma_ms", timings,
        files={"audio_file": ("speech.wav", audio, "audio/wav")},
        data={"model": PRISMA_MODEL, "language_code": PRISMA_LANGS, "format": PRISMA_FORMAT},
    )
    STATS["prisma"]["audio_kb"] += len(audio) // 1024
    if r.status_code == 200:
        body = r.json()
        return {"transcript": (body.get("transcript") or "").strip(),
                "language": body.get("detected_language_code") or ""}
    err = ""
    try:
        err = (r.json().get("error") or {}).get("type", "")
    except ValueError:
        pass
    print(f"⚠️ Prisma returned {r.status_code} {err}")
    if err == "MAX_AUDIO_DURATION_EXCEEDED":
        raise GnaniError(413, "Recording is longer than 30 seconds")
    if r.status_code == 429:
        raise GnaniError(429, "Voice service is busy, please try again")
    raise GnaniError(502, "Speech service unavailable")


# ───────────────────────── Public-route rate limit ─────────────────────────
# These routes spend Gnani and OpenAI credits and need no login, so each IP gets
# a small budget: FRONTDESK_RATE_LIMIT calls per FRONTDESK_RATE_WINDOW seconds.
RATE_LIMIT = int(os.getenv("FRONTDESK_RATE_LIMIT", "20"))
RATE_WINDOW = int(os.getenv("FRONTDESK_RATE_WINDOW", "60"))
CHECKIN_LIMIT = int(os.getenv("FRONTDESK_CHECKIN_LIMIT", "6"))   # check-ins create real tickets: keep it tighter
_hits: dict[tuple, list[float]] = defaultdict(list)


def client_ip(request: Request) -> str:
    # Behind Render's proxy the real address is in X-Forwarded-For (only trust it when told to).
    if os.getenv("VELA_TRUST_PROXY", "").lower() in ("1", "true", "yes"):
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(request: Request, bucket: str = "speech", limit: int = RATE_LIMIT) -> None:
    """Raise 429 when this IP has used up its budget for this bucket (sliding window)."""
    ip, now = (bucket, client_ip(request)), time.time()
    recent = [t for t in _hits[ip] if now - t < RATE_WINDOW]
    if len(recent) >= limit:
        _hits[ip] = recent
        raise HTTPException(status_code=429, detail="Too many requests, please wait a moment")
    recent.append(now)
    _hits[ip] = recent
    if len(_hits) > 5000:                 # keep memory bounded under a spray of IPs
        for k in [k for k, v in _hits.items() if not v or now - v[-1] > RATE_WINDOW]:
            _hits.pop(k, None)


# ───────────────────────────── Routes ─────────────────────────────

router = APIRouter()


@router.get("/api/voice/stats")
def voice_stats():
    """Gnani usage since the server started (managers and owners only; see authz.py)."""
    out = {"status": "success", "since": datetime.utcfromtimestamp(STATS["since"]).isoformat() + "Z",
           "cached_clips": {"fillers": len(_filler_audio), "emergency": len(_emergency_audio)}}
    for name in ("prisma", "timbre"):
        st = dict(STATS[name])
        st["avg_ms"] = round(st["ms_total"] / st["calls"]) if st["calls"] else 0
        out[name] = st
    return out


async def _transcribe_upload(audio: UploadFile) -> dict:
    """Shared body of both speech routes: read the upload, call Prisma, report timings."""
    timings: dict = {}
    data = await audio.read(MAX_AUDIO_BYTES + 1)     # read one byte past the cap so we can reject
    try:
        result = await transcribe(data, timings)
    except GnaniError as e:
        raise HTTPException(status_code=e.status, detail=str(e))
    print(f"⏱️  stt prisma={timings.get('prisma_ms')}ms bytes={len(data)}")
    # The kiosk needs these the instant Prisma returns, to pick which cached clip to play.
    return {"status": "success", **result, "emergency": is_emergency(result["transcript"]),
            "reply_language": reply_language(result["transcript"]), "timings": timings}


@router.post("/api/frontdesk/transcribe")      # public kiosk route (no login), rate limited
async def frontdesk_transcribe(request: Request, audio: UploadFile = File(...)):
    rate_limit(request)
    return await _transcribe_upload(audio)


@router.post("/api/stt")                       # signed-in screens (Atlas, patient dashboard, ...)
async def stt(audio: UploadFile = File(...)):
    return await _transcribe_upload(audio)


# ═════════════════════════ Voice front desk (kiosk check-in) ═════════════════════════
# Flow: browser records -> /transcribe (Prisma) -> browser plays a cached filler line at once ->
# /checkin: keyword triage -> ticket + GPT reply, streamed sentence by sentence to Timbre.

# ── 1. Triage: a plain keyword list. The LLM never decides whether something is an emergency. ──

def normalize(text: str) -> str:
    """Lowercase, unify Unicode, drop punctuation (including the Hindi danda), collapse spaces."""
    text = unicodedata.normalize("NFKC", text).lower()
    text = text.replace("ँ", "ं")                      # chandrabindu -> anusvara: साँस == सांस
    text = re.sub(r"['’ʼ]", "", text)                  # can't -> cant (delete, don't split the word)
    text = "".join(" " if unicodedata.category(c)[0] in "PS" else c for c in text)
    return re.sub(r"\s+", " ", text).strip()

# Roman spellings, Devanagari spellings, and the way Prisma tends to write Hinglish.
_EMERGENCY_WORDS = [
    # English
    "chest pain", "chest hurts", "heart attack", "cant breathe", "can not breathe", "difficulty breathing",
    "trouble breathing", "short of breath", "shortness of breath", "not breathing", "unconscious", "passed out",
    "fainted", "seizure", "fits", "stroke", "face drooping", "heavy bleeding", "severe bleeding", "bleeding a lot",
    "snake bite", "poison", "overdose", "suicide", "choking", "accident", "paralysis",
    # Roman Hindi / Hinglish
    "seene mein dard", "seene me dard", "seene mai dard", "chhati mein dard", "chaati mein dard", "saans", "dam ghut",
    "behosh", "bebosh", "hosh nahi", "dil ka daura", "bahut khoon", "khoon beh", "saanp ne kata", "zeher", "jahar",
    "lakwa", "jal gaya", "durghatna",
    # Devanagari
    "सीने में दर्द", "सीने मे दर्द", "सीने में तेज दर्द", "छाती में दर्द", "छाती मे दर्द", "सांस", "सास नहीं",
    "सास लेने", "दम घुट", "बेहोश", "होश नहीं", "दिल का दौरा", "हार्ट अटैक", "चेस्ट पेन", "बहुत खून", "खून बह",
    "सांप ने काट", "जहर", "ज़हर", "लकवा", "दौरा", "जल गया", "एक्सीडेंट", "दुर्घटना", "आत्महत्या", "ब्लीडिंग",
]
# A keyword matches at the START of a word (so "saans" also catches "saansein"), never mid-word.
_EMERGENCY_RE = re.compile("|".join(r"(?<!\S)" + re.escape(normalize(w)) for w in _EMERGENCY_WORDS))


def is_emergency(text: str) -> bool:
    # Deliberately over-cautious: "no chest pain" still counts. A false alarm costs a nurse a
    # glance; a missed emergency costs far more.
    return bool(_EMERGENCY_RE.search(normalize(text)))


# ── 2. Which language to answer in ──

def reply_language(text: str) -> str:
    """Devanagari only -> Hindi; Devanagari mixed with English words -> Hinglish; else English."""
    if _DEVANAGARI.search(text):
        return "hi-en" if re.search(r"[A-Za-z]{3,}", text) else "hi-IN"
    return "en-IN"


# ── 3. Canned lines. The filler is generated once and cached; the others are the safe fallback. ──

# Fillers are ~2 s long on purpose: they cover the time GPT and Timbre need for the real reply.
# The Hindi lines use the feminine verb form (देखती, रही) because all three Timbre voices are female.
FILLERS = {"hi-IN": "हाँ जी, मैं देखती हूँ, एक पल रुकिए।",
           "hi-en": "Haan ji, main dekhti hoon, ek second rukiye.",
           "en-IN": "Sure, let me check that for you, one moment."}
ACK = {   # (routine, emergency) - route to staff, never advice
    "hi-IN": ("मैं आपकी बात रिसेप्शन स्टाफ तक पहुँचा रही हूँ।", "मैं अभी स्टाफ को बुला रही हूँ, कृपया वहीं रुकिए।"),
    "hi-en": ("Main aapki baat reception staff tak pahuncha rahi hoon.", "Main abhi staff ko bula rahi hoon, kripya wahin rukiye."),
    "en-IN": ("I'm passing this on to our reception staff.", "I'm calling our staff right now, please stay where you are."),
}
TOKEN = {  # (routine, emergency); {n} is the token number
    "hi-IN": ("आपका टोकन नंबर {n} है। कृपया रिसेप्शन के पास बैठिए।", "आपका टोकन नंबर {n} है। स्टाफ आपको सबसे पहले देखेंगे।"),
    "hi-en": ("Aapka token number {n} hai. Kripya reception ke paas baithiye.", "Aapka token number {n} hai. Staff aapko sabse pehle dekhenge."),
    "en-IN": ("Your token number is {n}. Please take a seat near reception.", "Your token number is {n}. Our staff will see you first."),
}
_filler_audio: dict[str, bytes] = {}       # routine "one moment" clips
_emergency_audio: dict[str, bytes] = {}    # "I'm calling staff right now" clips: no GPT, no Timbre wait


async def build_fillers() -> None:
    """Synthesize the fixed clips once (at startup); after that they cost no Timbre call at all."""
    for lang in FILLERS:
        for cache, text in ((_filler_audio, FILLERS[lang]), (_emergency_audio, ACK[lang][1])):
            if lang not in cache:
                try:
                    cache[lang] = await synthesize(text, lang)
                except GnaniError as e:
                    print(f"⚠️ clip for {lang} not cached: {e}")


_last_activity = 0.0
_keepwarm_task: asyncio.Task | None = None


async def _keepwarm() -> None:
    """While the kiosk is in use, ping Gnani and OpenAI every 20 s so their connections stay open.
    (A cold connection costs 200-300 ms of TLS set-up on the next real request.) Pings spend no credits."""
    while time.time() - _last_activity < 600:                 # stop after 10 idle minutes
        await asyncio.sleep(20)
        try:
            await _get_client().get("/")                      # Gnani answers 401; the point is the open socket
            await _openai().models.retrieve(LLM_MODEL)
        except Exception:
            pass


def touch() -> None:
    """Note kiosk activity and make sure the keep-warm loop is running."""
    global _last_activity, _keepwarm_task
    _last_activity = time.time()
    if _keepwarm_task is None or _keepwarm_task.done():
        _keepwarm_task = asyncio.create_task(_keepwarm())


async def on_startup() -> None:
    asyncio.create_task(build_fillers())      # in the background so the server boots at once


# ── 4. OpenAI (gpt-4o-mini): extraction + a short streamed reply ──

LLM_MODEL = "gpt-4o-mini"
# Off by default: a spoken GPT sentence needs GPT (~1.2 s) + Timbre (~0.7 s) before it can play, and Gnani
# runs one request at a time, so it would delay the token number. The spoken text stays fixed and safe;
# GPT still extracts the symptom. Set FRONTDESK_GPT_REPLY=1 to speak a streamed GPT sentence as well.
GPT_REPLY = os.getenv("FRONTDESK_GPT_REPLY", "0") == "1"
_oai: AsyncOpenAI | None = None


def _openai() -> AsyncOpenAI:
    global _oai
    if _oai is None:
        _oai = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"), timeout=8.0, max_retries=1,
                           http_client=httpx.AsyncClient(timeout=8.0, limits=httpx.Limits(keepalive_expiry=120)))
    return _oai


async def extract(transcript: str) -> dict:
    """Ask the model for intent + symptom. Shown on screen and in the ticket note; it never sets triage."""
    try:
        r = await _openai().chat.completions.create(
            model=LLM_MODEL, temperature=0, max_tokens=80, response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": 'Return JSON: {"intent":"checkin|appointment|question|emergency",'
                 '"symptom":"main complaint in at most 6 English words, or empty","urgency":"routine|urgent|emergency"}'},
                {"role": "user", "content": transcript}])
        d = json.loads(r.choices[0].message.content or "{}")
        return {"intent": str(d.get("intent", ""))[:20], "symptom": str(d.get("symptom", ""))[:60],
                "urgency": str(d.get("urgency", ""))[:12]}
    except Exception as e:                        # extraction is optional; the check-in must not fail
        print(f"⚠️ extract failed: {type(e).__name__}")
        return {"intent": "", "symptom": "", "urgency": ""}


_LANG_RULE = {
    "hi-IN": "Reply in simple Hindi, in Devanagari script.",
    "hi-en": "Reply in Hinglish: Hindi written in Roman letters, like 'Main aapki madad ke liye staff ko bata rahi hoon.'",
    "en-IN": "Reply in simple English.",
}
# The model only writes the acknowledgement. Routing to staff is the whole job; advice is forbidden.
_SYSTEM = ("You are the voice front desk of a hospital. Reply with ONE short sentence (under 15 words) that "
           "acknowledges the patient and says you are informing the reception staff. Never give medical advice, "
           "diagnosis, medicine names, or tell them what to do for their symptoms. No digits. {rule}")
_ADVICE = re.compile(r"\b(take|tablet|pill|medicine|medication|paracetamol|ibuprofen|drink|rest|lena|dawa|dawai|goli)\b"
                     r"|दवा|दवाई|गोली|टैबलेट|आराम", re.I)
_SENTENCE_END = re.compile(r"(?<=[.!?।])\s+")


async def reply_sentences(transcript: str, lang: str, emergency: bool):
    """Yield the reply one sentence at a time, as soon as each one is complete.

    Streaming means the first sentence can go to Timbre while GPT is still writing the rest.
    If GPT fails, is slow, or says something that sounds like advice, use the canned line instead."""
    fallback = ACK[lang][1 if emergency else 0]
    sent = 0
    try:
        stream = await _openai().chat.completions.create(
            model=LLM_MODEL, temperature=0.3, max_tokens=50, stream=True,
            messages=[{"role": "system", "content": _SYSTEM.format(rule=_LANG_RULE[lang])},
                      {"role": "user", "content": f"Patient said: {transcript}\nEmergency: {'yes' if emergency else 'no'}"}])
        buf = ""
        async for ev in stream:
            buf += (ev.choices[0].delta.content or "") if ev.choices else ""
            *done, buf = _SENTENCE_END.split(buf)           # everything but the unfinished tail is complete
            for sentence in done:
                sentence = sentence.strip()
                if sentence and sent < 2:
                    sent += 1
                    yield fallback if _ADVICE.search(sentence) else sentence
        if buf.strip() and sent < 2:
            sent += 1
            yield fallback if _ADVICE.search(buf) else buf.strip()
    except Exception as e:
        print(f"⚠️ reply stream failed: {type(e).__name__}")
    if sent == 0:
        yield fallback


# ── 5. The ticket: reuses the receptionist's own create_ticket, so emergency ordering and the
#       Socket.IO events (queue_updated / emergency_intake) are exactly the normal ones. ──

_doctor_cache: dict = {"at": 0.0, "id": None}


def _pick_doctor(hospital_id: str) -> str | None:
    """The reception queue only lists tickets assigned to a staff member of the hospital, so pick a doctor."""
    if time.time() - _doctor_cache["at"] < 60 and _doctor_cache["id"]:
        return _doctor_cache["id"]
    from main import supabase_admin                 # imported here: main imports this module
    rows = supabase_admin.table("vela_staff").select("id,active").eq("hospital_id", hospital_id).eq("role", "doctor").execute().data
    rows = [r for r in rows if r.get("active") is not False]
    _doctor_cache.update(at=time.time(), id=rows[0]["id"] if rows else None)
    return _doctor_cache["id"]


async def make_ticket(emergency: bool, notes: str) -> dict:
    from receptionist import create_ticket, TicketCreateRequest
    hospital, vela_id = os.getenv("KIOSK_HOSPITAL_ID", "").strip(), os.getenv("KIOSK_DEMO_VELA_ID", "").strip()
    if not hospital or not vela_id:
        raise RuntimeError("Kiosk is not configured (KIOSK_HOSPITAL_ID / KIOSK_DEMO_VELA_ID)")
    doctor_id = await asyncio.to_thread(_pick_doctor, hospital)
    res = await create_ticket(TicketCreateRequest(
        vela_id=vela_id, department="General", doctor_id=doctor_id, notes=notes,
        triage_level="Emergency" if emergency else "Routine", hospital_id=hospital))
    if res.get("status") != "success":
        raise RuntimeError(res.get("message", "ticket failed"))
    return res


def _save_note(ticket_id: str, note: str) -> None:
    from main import supabase_admin
    supabase_admin.table("tickets").update({"notes": note}).eq("id", ticket_id).execute()


async def improve_note(ticket_id: str, extract_task: "asyncio.Task", transcript: str) -> None:
    """When the extraction finishes, put the clean symptom in the ticket note (best effort, after the fact)."""
    try:
        ex = await extract_task
        if ex.get("symptom"):
            await asyncio.to_thread(_save_note, ticket_id, f"Voice check-in: {ex['symptom']} | said: {transcript}")
    except Exception as e:
        print(f"⚠️ note update skipped: {type(e).__name__}")


# ── 6. Routes ──

@router.get("/api/frontdesk/warm")
async def frontdesk_warm(request: Request):
    """Called when the kiosk page loads: opens the Gnani and OpenAI connections and returns the
    cached filler clips, so the first real request pays no connection set-up."""
    rate_limit(request)
    touch()
    await build_fillers()
    try:
        await _openai().models.retrieve(LLM_MODEL)         # a free GET that opens the OpenAI connection
    except Exception:
        pass
    pack = lambda cache, texts: {l: {"text": texts[l], "audio": base64.b64encode(a).decode()}   # noqa: E731
                                 for l, a in cache.items()}
    return {"status": "success", "fillers": pack(_filler_audio, FILLERS),
            "emergency_acks": pack(_emergency_audio, {l: ACK[l][1] for l in ACK})}


class CheckinBody(BaseModel):
    transcript: str
    skip_ack: bool = False      # the browser already played the cached emergency line itself


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


@router.post("/api/frontdesk/checkin")
async def frontdesk_checkin(body: CheckinBody, request: Request):
    """Server-sent events: meta -> audio sentences -> ticket -> final audio -> done (+ timings)."""
    rate_limit(request, "checkin", CHECKIN_LIMIT)
    transcript = body.transcript.strip()[:500]
    if len(transcript) < 2:
        raise HTTPException(status_code=400, detail="I didn't catch that")

    async def events():
        t0 = time.perf_counter()
        ms = lambda: round((time.perf_counter() - t0) * 1000)          # noqa: E731 - elapsed ms since request start
        timings: dict = {}
        touch()
        emergency = is_emergency(transcript)                           # deterministic, instant
        lang = reply_language(transcript)
        yield _sse({"type": "meta", "emergency": emergency, "language": lang})

        # Everything slow starts NOW and runs side by side: the ticket (database) and the extraction (GPT).
        # Nothing waits for GPT, so the token number is spoken as soon as the ticket exists.
        extract_task = asyncio.create_task(extract(transcript))
        raw_note = f"Voice check-in: said: {transcript}"

        async def ticket_job():
            t = time.perf_counter()
            res = await make_ticket(emergency, raw_note)
            timings["ticket_ms"] = round((time.perf_counter() - t) * 1000)
            return res
        ticket_task = asyncio.create_task(ticket_job())

        try:
            if emergency:
                # Emergencies never wait for GPT: use the fixed, cached line (unless the browser played it).
                if not body.skip_ack:
                    clip = _emergency_audio.get(lang) or await synthesize(ACK[lang][1], lang)
                    timings["first_audio_ms"] = ms()
                    yield _sse({"type": "audio", "text": ACK[lang][1], "audio": base64.b64encode(clip).decode()})
            elif GPT_REPLY:
                async for sentence in reply_sentences(transcript, lang, emergency):
                    timings.setdefault("gpt_first_sentence_ms", ms())
                    audio = await synthesize(sentence, lang)
                    timings.setdefault("first_audio_ms", ms())
                    yield _sse({"type": "audio", "text": sentence, "audio": base64.b64encode(audio).decode()})

            ticket = await ticket_task
            number = int(ticket["ticket_number"].split("-")[-1])       # TKT-20261110-0007 -> 7
            yield _sse({"type": "ticket", "ticket_number": ticket["ticket_number"], "token": number,
                        "queue_position": ticket["queue_position"], "emergency": emergency})
            timings["ticket_event_ms"] = ms()
            line = TOKEN[lang][1 if emergency else 0].format(n=number)
            audio = await synthesize(line, lang)                       # the only Timbre call on the critical path
            timings["token_audio_ms"] = ms()
            yield _sse({"type": "audio", "text": line, "audio": base64.b64encode(audio).decode(), "final": True})
            asyncio.create_task(improve_note(ticket["ticket"]["id"], extract_task, transcript))
            yield _sse({"type": "extract", **(await extract_task)})
        except Exception as e:
            print(f"⚠️ checkin failed: {type(e).__name__}: {e}")
            ticket_task.cancel(); extract_task.cancel()
            yield _sse({"type": "error", "message": "Please see the reception desk."})
        timings["total_ms"] = ms()
        print(f"⏱️  checkin lang={lang} emergency={emergency} {timings}")
        yield _sse({"type": "timings", **timings})

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

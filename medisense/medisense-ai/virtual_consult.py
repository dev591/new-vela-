"""Virtual consultation: a doctor opens a patient's reports by VELA ID, in plain language, and can download them.

Scenario: the patient is in another city and phones the doctor, who types the VELA ID the patient gives.

COLLEGE-PRESENTATION NOTE: the VELA ID alone opens the records here. The real product must make the patient
approve each access with a one-time code (OTP) first. That step is deliberately left out for now.

Three parts, each a plain function so it can be read top to bottom:
  1. collect()  - turn the database rows into reports, abnormal values and trends (no AI involved)
  2. analyse()  - ask the model for a plain-language reading of those facts (cached for 30 minutes)
  3. build_pdf() - lay the same facts out as a clean PDF
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import re
import time
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

router = APIRouter()

NOT_NORMAL = {"low", "high", "critical", "abnormal", "borderline", "elevated"}
ANALYSIS_TTL = 1800                      # seconds an analysis is reused
_analysis_cache: dict[tuple, tuple[float, dict]] = {}


class VelaIdBody(BaseModel):
    vela_id: str


class FileBody(BaseModel):
    vela_id: str
    document_id: str


class SpeakBody(BaseModel):
    vela_id: str
    lang: str = "hi-IN"          # hi-IN (Hindi), hi-en (Hinglish) or en-IN (English)


# ───────────────────────── 1. Facts from the database ─────────────────────────

def _db():
    from main import supabase_admin          # imported here: main imports this module
    return supabase_admin


def find_patient(vela_id: str) -> dict:
    vid = (vela_id or "").strip().upper()
    rows = _db().table("patients").select("*").eq("vela_id", vid).limit(1).execute().data if vid else []
    if not rows:
        raise HTTPException(status_code=404, detail="No patient found with that VELA ID")
    return rows[0]


def _number(text) -> float | None:
    m = re.search(r"-?\d+(?:\.\d+)?", str(text or "").replace(",", ""))
    return float(m.group()) if m else None


def _range(reference) -> tuple[float | None, float | None]:
    """'13.8 - 17.2' -> (13.8, 17.2); '< 200' -> (None, 200); '> 40' -> (40, None)."""
    ref = str(reference or "")
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", ref)]
    if len(nums) >= 2:
        return nums[0], nums[1]
    if len(nums) == 1:
        return (None, nums[0]) if "<" in ref else (nums[0], None) if ">" in ref else (None, None)
    return None, None


def collect(patient: dict) -> dict:
    docs = _db().table("documents").select(
        "id,filename,report_date,risk_score,summary,atlas_summary,critical_flags,values,uploaded_at,file_url"
    ).eq("patient_id", patient["id"]).order("report_date", desc=True).execute().data or []

    reports, abnormal, series = [], [], {}
    for d in docs:
        if (d.get("summary") or "") == "processing":
            continue                                           # still being read by the OCR pipeline
        values = d.get("values") if isinstance(d.get("values"), list) else []
        clean = []
        for v in values:
            lo, hi = _range(v.get("reference"))
            item = {"test": v.get("test"), "unit": v.get("unit") or "", "result": v.get("result"),
                    "status": v.get("status") or "", "reference": v.get("reference") or "",
                    "number": _number(v.get("result")), "low": lo, "high": hi}
            clean.append(item)
            if str(item["status"]).strip().lower() in NOT_NORMAL:
                abnormal.append({**item, "date": d.get("report_date"), "report": d.get("filename")})
            if item["number"] is not None and item["test"]:
                series.setdefault(item["test"], []).append(
                    {"date": d.get("report_date"), "value": item["number"], "status": item["status"], "unit": item["unit"],
                     "reference": item["reference"]})
        reports.append({
            "id": d["id"], "filename": d.get("filename"), "date": d.get("report_date"), "risk_score": d.get("risk_score"),
            "summary": d.get("summary"), "atlas_summary": d.get("atlas_summary"), "flags": d.get("critical_flags") or [],
            "values": clean, "has_file": bool(d.get("file_url")),
        })
    trends = []
    for test, pts in series.items():
        pts.sort(key=lambda p: p["date"] or "")
        if len(pts) >= 2:                                      # a trend needs at least two readings
            trends.append({"test": test, "unit": pts[-1]["unit"], "reference": pts[-1]["reference"], "points": pts})
    return {"reports": reports, "abnormal": abnormal, "trends": trends}


def patient_card(p: dict) -> dict:
    return {k: p.get(k) for k in ("id", "name", "vela_id", "age", "gender", "blood_group", "allergies",
                                  "existing_conditions", "risk_score", "diagnosis", "phone")}


# ───────────────────────── 2. Plain-language reading ─────────────────────────

_SYSTEM = """You help a doctor who is on a phone call with a patient in another city and has just opened the patient's reports.
Write for a busy doctor in plain, short sentences. Use ONLY the data given. Do not diagnose with certainty: say "may suggest".
If something is missing, say so. Return JSON with exactly these keys:
{"headline": one plain sentence (max 22 words) giving the overall picture,
 "summary": 3 to 4 short sentences,
 "findings": [up to 5 of {"title": max 6 words, "detail": one plain sentence, "level": "good" | "watch" | "concern"}],
 "explanations": {"<exact test name>": "one plain sentence: what this result means for the patient"}  (one entry for EVERY test whose status is not normal),
 "questions_to_ask": [up to 5 short questions to ask the patient on the call],
 "consider": [up to 4 things for the doctor to consider, phrased as considerations, never as orders]}"""


def _facts_for_model(patient: dict, facts: dict) -> str:
    slim = {
        "patient": {k: patient.get(k) for k in ("age", "gender", "blood_group", "allergies", "existing_conditions")},
        "reports": [{"date": r["date"], "file": r["filename"], "risk_score": r["risk_score"], "flags": r["flags"],
                     "summary": (r["summary"] or "")[:700],
                     "values": [{k: v[k] for k in ("test", "result", "unit", "status", "reference")} for v in r["values"][:40]]}
                    for r in facts["reports"][:8]],
    }
    return json.dumps(slim, default=str)


async def analyse(patient: dict, facts: dict) -> dict:
    if not facts["reports"]:
        return {"headline": "No reports on file for this patient yet.", "summary": "", "findings": [],
                "explanations": {}, "questions_to_ask": ["Do you have any recent reports you can read out or share?"], "consider": []}
    key = (patient["id"], ";".join(sorted(r["id"] for r in facts["reports"])))
    hit = _analysis_cache.get(key)
    if hit and time.time() - hit[0] < ANALYSIS_TTL:
        return hit[1]
    from main import openai_client            # the shared client; calls are blocking, so run them in a thread

    def call():
        r = openai_client.chat.completions.create(
            model="gpt-4o-mini", temperature=0.2, max_tokens=900, response_format={"type": "json_object"},
            messages=[{"role": "system", "content": _SYSTEM}, {"role": "user", "content": _facts_for_model(patient, facts)}])
        return json.loads(r.choices[0].message.content or "{}")
    try:
        data = await asyncio.to_thread(call)
    except Exception as e:
        print(f"⚠️ virtual-consult analysis failed: {type(e).__name__}")
        raise HTTPException(status_code=502, detail="The reading is unavailable right now. The reports below are still correct.")
    for k, empty in (("headline", ""), ("summary", ""), ("findings", []), ("explanations", {}),
                     ("questions_to_ask", []), ("consider", [])):
        data.setdefault(k, empty)
    _analysis_cache[key] = (time.time(), data)
    return data


# ───────────────────────── 2b. Spoken explanation for the patient (Gnani Timbre) ─────────────────────────

_LANG_RULE = {
    "en-IN": "Use simple English.",
    "hi-IN": "Write in simple Hindi, in Devanagari script.",
    "hi-en": "Write in Hinglish: Hindi words in Roman letters, the way people speak, e.g. 'Aapka hemoglobin thoda kam hai.'",
}
_SPEAK_SYSTEM = """The doctor is on a phone call and will play this to the PATIENT. Turn the findings below into a short spoken
explanation of the patient's own results: 4 to 6 short, warm sentences, no medical jargon, at most two numbers.
Never give treatment or medicine advice and never say how serious it is beyond what the findings say.
End with one sentence saying the doctor will explain the next steps. {rule}
Return JSON: {{"script": "..."}}"""
_speech_cache: dict[tuple, tuple[float, dict]] = {}


async def spoken_explanation(patient: dict, facts: dict, lang: str) -> dict:
    """The explanation as text and as Timbre audio. Cached, because the doctor may press play more than once."""
    from gnani_voice import GnaniError, VOICES, synthesize
    if lang not in VOICES:
        raise HTTPException(status_code=400, detail="Choose English, Hindi or Hinglish")
    analysis = await analyse(patient, facts)
    if not facts["reports"]:
        raise HTTPException(status_code=404, detail="No reports to explain")
    key = (patient["id"], ";".join(sorted(r["id"] for r in facts["reports"])), lang)
    hit = _speech_cache.get(key)
    if hit and time.time() - hit[0] < ANALYSIS_TTL:
        return hit[1]
    from main import openai_client
    source = json.dumps({"headline": analysis.get("headline"), "summary": analysis.get("summary"),
                         "findings": [f"{f.get('title')}: {f.get('detail')}" for f in analysis.get("findings", [])]})

    def write_script():
        r = openai_client.chat.completions.create(
            model="gpt-4o-mini", temperature=0.3, max_tokens=500, response_format={"type": "json_object"},
            messages=[{"role": "system", "content": _SPEAK_SYSTEM.format(rule=_LANG_RULE[lang])}, {"role": "user", "content": source}])
        return (json.loads(r.choices[0].message.content or "{}").get("script") or "").strip()
    try:
        script = await asyncio.to_thread(write_script)
        if not script:
            raise ValueError("empty script")
        audio = await synthesize(script[:1200], lang)
    except GnaniError as e:
        raise HTTPException(status_code=e.status, detail="The voice service is unavailable right now")
    except Exception as e:
        print(f"⚠️ spoken explanation failed: {type(e).__name__}")
        raise HTTPException(status_code=502, detail="Could not prepare the spoken explanation")
    out = {"script": script, "audio": base64.b64encode(audio).decode(), "lang": lang}
    _speech_cache[key] = (time.time(), out)
    return out


# ───────────────────────── 3. PDF ─────────────────────────

def build_pdf(patient: dict, facts: dict, analysis: dict, doctor: str) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    BRAND, INK, MUTED = colors.HexColor("#0071E3"), colors.HexColor("#1D1D1F"), colors.HexColor("#6E6E73")
    LEVEL = {"good": colors.HexColor("#248A3D"), "watch": colors.HexColor("#B25E00"), "concern": colors.HexColor("#D70015")}
    base = getSampleStyleSheet()
    h1 = ParagraphStyle("h1", parent=base["Title"], fontSize=20, textColor=INK, alignment=0, spaceAfter=2)
    h2 = ParagraphStyle("h2", parent=base["Heading2"], fontSize=12.5, textColor=BRAND, spaceBefore=12, spaceAfter=4)
    body = ParagraphStyle("body", parent=base["BodyText"], fontSize=9.5, leading=13, textColor=INK)
    small = ParagraphStyle("small", parent=body, fontSize=8, textColor=MUTED, leading=11)
    esc = lambda t: (str(t or "")).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")   # noqa: E731

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                            title=f"VELA virtual consultation - {patient.get('name')}")
    s = [Paragraph("VELA · Virtual consultation summary", small), Paragraph(esc(patient.get("name")), h1),
         Paragraph(esc(" · ".join(str(x) for x in (patient.get("vela_id"), f"{patient.get('age')} yrs" if patient.get("age") else "",
                                                    patient.get("gender"), f"Blood group {patient.get('blood_group')}" if patient.get("blood_group") else "") if x)), body)]
    if patient.get("allergies"):
        s.append(Paragraph(f"<font color='#D70015'><b>Allergies:</b></font> {esc(patient['allergies'])}", body))
    if patient.get("existing_conditions"):
        s.append(Paragraph(f"<b>Known conditions:</b> {esc(patient['existing_conditions'])}", body))

    if analysis.get("headline"):
        s += [Paragraph("At a glance", h2), Paragraph(f"<b>{esc(analysis['headline'])}</b>", body)]
        if analysis.get("summary"):
            s.append(Paragraph(esc(analysis["summary"]), body))
        for f in analysis.get("findings", []):
            c = LEVEL.get(f.get("level"), MUTED).hexval()[2:]
            s.append(Paragraph(f"<font color='#{c}'>●</font> <b>{esc(f.get('title'))}</b>: {esc(f.get('detail'))}", body))

    if facts["abnormal"]:
        s.append(Paragraph("Numbers to look at", h2))
        rows = [["Test", "Result", "Normal range", "Status", "What it means"]]
        for a in facts["abnormal"]:
            rows.append([Paragraph(esc(a["test"]), body), f"{a['result']} {a['unit']}", a["reference"], a["status"],
                         Paragraph(esc(analysis.get("explanations", {}).get(a["test"], "")), small)])
        t = Table(rows, colWidths=[34 * mm, 24 * mm, 26 * mm, 18 * mm, 72 * mm], repeatRows=1)
        t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), BRAND), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                               ("FONTSIZE", (0, 0), (-1, -1), 8.5), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                               ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F5F7")]),
                               ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#D2D2D7"))]))
        s.append(t)

    for tr in facts["trends"]:
        pts = ", ".join(f"{p['date']}: {p['value']}" for p in tr["points"])
        s.append(Paragraph(f"<b>Trend · {esc(tr['test'])}</b> ({esc(tr['unit'])}): {esc(pts)}", small))

    s.append(Paragraph("Reports", h2))
    for r in facts["reports"]:
        s.append(Paragraph(f"<b>{esc(r['filename'])}</b> · {esc(r['date'])}" + (f" · risk {r['risk_score']}" if r["risk_score"] is not None else ""), body))
        if r["summary"]:
            s.append(Paragraph(esc(r["summary"])[:900], small))
        if r["values"]:
            rows = [["Test", "Result", "Range", "Status"]] + [[v["test"], f"{v['result']} {v['unit']}", v["reference"], v["status"]] for v in r["values"]]
            t = Table(rows, colWidths=[62 * mm, 34 * mm, 40 * mm, 28 * mm], repeatRows=1)
            t.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 8), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8F2FD")),
                                   ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#D2D2D7"))]))
            s += [Spacer(1, 3), t]
        s.append(Spacer(1, 8))

    for title, key in (("Questions to ask the patient", "questions_to_ask"), ("For the doctor to consider", "consider")):
        if analysis.get(key):
            s.append(Paragraph(title, h2))
            s += [Paragraph("• " + esc(x), body) for x in analysis[key]]

    s += [Spacer(1, 14), Paragraph(
        f"Prepared {datetime.now().strftime('%d %b %Y, %H:%M')} for {esc(doctor) or 'the treating doctor'}. This is decision support built from the "
        "patient's uploaded reports; it is not a diagnosis. College presentation build: records open with the VELA ID only. "
        "The patient's one-time-code approval will be added later.", small)]
    doc.build(s)
    return buf.getvalue()


# ───────────────────────── Routes (doctors only; see authz.py) ─────────────────────────

@router.post("/api/virtual-consult/open")
async def open_records(body: VelaIdBody):
    """Instant: the patient card, every report, the abnormal values and the trends."""
    patient = await asyncio.to_thread(find_patient, body.vela_id)
    facts = await asyncio.to_thread(collect, patient)
    return {"status": "success", "patient": patient_card(patient), **facts}


@router.post("/api/virtual-consult/analysis")
async def reading(body: VelaIdBody):
    """Slower (a model call): the plain-language reading. The page shows the reports first and fills this in after."""
    patient = await asyncio.to_thread(find_patient, body.vela_id)
    facts = await asyncio.to_thread(collect, patient)
    return {"status": "success", "analysis": await analyse(patient, facts)}


@router.post("/api/virtual-consult/speak")
async def speak(body: SpeakBody):
    """Timbre reads the patient's results aloud in simple words, in English, Hindi or Hinglish."""
    patient = await asyncio.to_thread(find_patient, body.vela_id)
    facts = await asyncio.to_thread(collect, patient)
    return {"status": "success", **(await spoken_explanation(patient, facts, body.lang))}


@router.post("/api/virtual-consult/pdf")
async def download_pdf(body: VelaIdBody, request: Request):
    patient = await asyncio.to_thread(find_patient, body.vela_id)
    facts = await asyncio.to_thread(collect, patient)
    try:
        analysis = await analyse(patient, facts)
    except HTTPException:
        analysis = {}                                          # the PDF is still useful without the model's reading
    doctor = (getattr(request.state, "session", None) or {}).get("name", "")
    pdf = await asyncio.to_thread(build_pdf, patient, facts, analysis, doctor)
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", f"VELA_{patient.get('vela_id')}_summary")
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{name}.pdf"'})


@router.post("/api/virtual-consult/file")
async def original_file(body: FileBody):
    """The original scan of one report (stored as an embedded image)."""
    patient = await asyncio.to_thread(find_patient, body.vela_id)
    rows = _db().table("documents").select("file_url,filename").eq("id", body.document_id).eq("patient_id", patient["id"]).execute().data
    url = (rows[0].get("file_url") if rows else "") or ""
    m = re.match(r"data:([\w/+.-]+);base64,(.+)$", url, re.S)
    if not m:
        raise HTTPException(status_code=404, detail="The original file is not available")
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", rows[0].get("filename") or "report")
    ext = {"image/jpeg": ".jpg", "image/png": ".png", "application/pdf": ".pdf"}.get(m.group(1), "")
    name = name if name.lower().endswith(ext) or not ext else name + ext
    return Response(base64.b64decode(m.group(2)), media_type=m.group(1),
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})

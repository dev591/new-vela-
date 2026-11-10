# VELA Voice Front Desk — Great Indian AI Internship Challenge (Gnani AI)

**One line:** a patient walks up to a hospital kiosk, says what is wrong in Hindi, Hinglish or English, and is
checked in within about two seconds: an emergency jumps the queue, the kiosk answers out loud in the same language
with a token number, and the receptionist's screen updates live. Speech in and speech out are **Gnani Prisma and Timbre**.

## The problem

Hospital front desks in India are slow and language-limited. Patients describe symptoms in Hindi or a Hindi-English
mix; forms and kiosks expect typed English. A chest-pain patient should never wait behind a routine check-up
because nobody could read a form fast enough.

## What we built (all three use Gnani models)

1. **Voice front desk kiosk** (`/frontdesk`, public, no login). Tap, speak, done.
2. **Atlas voice assistant for doctors.** An always-on microphone (Space mutes and unmutes) with Prisma for input
   and Timbre for the spoken answer. It remembers what it just asked ("Shall I notify reception?" -> "okay").
3. **Virtual consultation.** A doctor on a phone call opens a patient's reports by VELA ID and presses a button;
   Timbre explains the results to the patient in Hindi, Hinglish or English, in plain words.

## Gnani models and APIs used

| Model | Endpoint | How we use it |
|---|---|---|
| **Prisma v3.0** (speech-to-text) | `POST /stt/v3` | `language_code=hi-IN,en-IN`, `format=codemix`: Hindi stays in Devanagari, English words stay in Latin script. Audio is recorded in the browser as 16 kHz mono WAV (Prisma rejects the WebM that Chrome's recorder makes; we tested). |
| **Timbre v2.5** (text-to-speech) | `POST /api/v1/tts/inference` | MP3 output. Voices: Nalini (Hindi), Poorvi (Hinglish), Kaveri (English). Short lines are cached at startup. |

Both are plain REST. The Gnani key is read on the server only and never reaches the browser.

## How a check-in works

```mermaid
flowchart LR
  A[Patient speaks] --> B[Browser records 16 kHz WAV, trims silence]
  B --> C[Prisma v3.0 via our server]
  C --> D{Emergency keywords?}
  D -- yes --> E[Cached urgent line plays at once]
  D -- no --> F[Cached "one moment" line plays at once]
  C --> G[Ticket created: emergencies go to the front]
  G --> H[Socket.IO: receptionist screen updates live]
  G --> I[Timbre says the token number in the patient's language]
```

- **Triage is a keyword list, never the model alone.** Devanagari and Roman spellings (सीने में दर्द, सांस, बेहोश,
  chest pain, saans, behosh ...) are matched after lowercasing and stripping punctuation, including the Hindi danda.
  It is deliberately over-cautious. 24 tests cover the triage and language rules (18 of them are emergency and routine phrases).
- **The spoken text is fixed and safe.** The kiosk only checks people in and alerts staff; it never gives medical advice.
  GPT-4o-mini only extracts the symptom for the ticket note and the screen.
- **Reply language follows the patient:** Hindi only -> Hindi; Hindi with English words -> Hinglish; otherwise English.

## Designed for "instant"

Gnani accepts **one active request at a time per account**, so Prisma and Timbre calls share one lock and everything
slow was moved off the critical path:

- a short chime the moment the patient stops talking (no network);
- a cached "one moment" clip (about 2 s) or, for emergencies, a cached urgent clip, played the instant Prisma returns;
- the ticket is created from the raw transcript without waiting for the model; the clean symptom is added afterwards;
- silence is trimmed from the upload; connections to Gnani and OpenAI are kept warm; clips play gaplessly with the Web Audio API.

Measured on a development laptop (synthetic speech from macOS `say`; **not yet measured with a real microphone**):

| Step | Time |
|---|---|
| Prisma v3.0, warm, server-side | 0.13 - 0.3 s |
| Prisma back -> first sound in the browser | 6 - 72 ms (cached clip) |
| Recording ends -> first sound (Chrome) | 0.2 - 0.7 s, plus about 0.6 s for silence detection |
| Timbre v2.5, short line | 0.5 - 0.8 s |
| Routine check-in, server total (ticket + token line) | 1.3 - 1.7 s (was about 10 s before the redesign) |
| Emergency check-in, urgent line | plays from cache, 0 server calls |

Prisma was accurate on all five test clips (Hindi, Hinglish, English), and the Hindi that Timbre generates is
intelligible: sent back through Prisma, it is transcribed almost word for word, including numbers.

## Trust and safety

- Emergency triage is deterministic and tested; the model cannot downgrade it.
- Public kiosk routes are rate limited per IP; the kiosk can only check in one fixed synthetic demo patient.
- Every route has an explicit role policy (a test fails the build if one is missing); hospital staff can only reach their own hospital.
- Access to patient data is written to a hash-chained audit log.
- **Virtual consultation is a college-presentation build:** a VELA ID alone opens the records. The real product will
  require the patient's one-time-code (OTP) approval first. This is stated on the page and in the PDF.
- **All demo data is synthetic** (invented names, no real phone numbers or IDs), as the challenge requires.

## Demo script (about 90 seconds)

1. **Kiosk, Hindi emergency.** Say "मुझे सीने में दर्द हो रहा है और सांस नहीं आ रही है". Chime, instant urgent line,
   token number spoken and shown. Split screen: the receptionist's queue gets a red emergency toast and the ticket jumps to the top.
2. **Kiosk, Hinglish routine.** "Mujhe do din se bukhar hai." Spoken "one moment", then the token number.
3. **Atlas.** Doctor presses Space once and just talks: "Admit him, he is critical." Atlas recommends an ICU bed and
   asks to notify reception; the doctor says "okay"; reception gets the request.
4. **Ward board.** Receptionist confirms; the bed tile shows the patient; click for details; move or discharge.
5. **Virtual consultation.** Type VLA-9002; trends and the plain-language reading appear; press Hindi and Timbre explains the results aloud.

## For judges: try it in two minutes

The sign-in screen lists three logins in order (patient, reception, doctor) with a "Sign in" button for each. A guide
in the corner says what to press and has a "Sign out, go to the next role" button.

1. **Patient** (Rajesh Kumar): Book a visit. Only the demo hospital, VELA Care, is offered. Pick Dr. Arjun Rao and a time.
2. **Reception** (Meera Shah): Appointments, then Accept Request.
3. **Doctor** (Dr. Arjun Rao): open Rajesh, press Space and say "Order a CBC test for him". One **Blood CBC** order is
   created (pathology, Rs 350). Say it again and Atlas says it is already ordered. Say "Admit him, he is critical" for a bed
   recommendation. The lab then files the result and VELA builds the PDF report.

**Where the data comes from:** `/data-sources` lists every sample file with a download button: the two blood reports the
patient uploads, and the lab report VELA generates. All of it is synthetic.

## Challenge checklist

- [x] Uses Gnani's models: Prisma (speech-to-text) and Timbre (text-to-speech)
- [x] Synthetic data only
- [ ] Demo video posted on LinkedIn or X with `#GnaniAI` and `#GreatIndianAIInternshipChallenge`
- [ ] Submission: video, this explanation, models/APIs used, and the nominated post link(s)
- Deadline: 11:59 PM IST, 10 November 2026

## Run it

See `README.md`. Backend env for voice: `GNANI_API_KEY`, `KIOSK_HOSPITAL_ID`, `KIOSK_DEMO_VELA_ID`.
`python seed_demo_patients.py` adds three synthetic patients with reports for the virtual consultation demo.

## Known limits and next steps

- Gnani's one-request-at-a-time limit means two kiosks used at the same moment queue behind each other; a higher limit would remove that.
- The microphone thresholds were tuned on synthetic audio; a real-room test is the next step.
- Kiosk identification (VELA ID or phone by voice), guest registration and Punjabi are not built yet.
- OTP approval for virtual consultation, and a wake word for the always-on microphone.

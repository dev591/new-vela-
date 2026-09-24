"""
Radiology image analysis (X-ray / CT / MRI / ultrasound) for VELA.

This is deliberately a SEPARATE path from `doc_ocr`. Both take an image, but
they are asking completely different questions:

  doc_ocr   → "what text is printed on this page?"  (transcription)
  imaging   → "what is abnormal in this anatomy?"   (interpretation)

Running a radiograph through the doc_ocr prompt returns `doc_type: unreadable`
with no findings — correct behaviour for that prompt, useless to a doctor. So
uploads are classified first and routed here when they are radiology.

SAFETY POSTURE — this matters more than the feature:
A general vision model is NOT a radiology-grade diagnostic device. It is
reasonable at gross, high-contrast findings (large consolidation, pleural
effusion, pneumothorax, cardiomegaly, obvious fractures) and unreliable on
subtle ones (small nodules, early interstitial change, hairline fractures).
Therefore this module:
  - always returns findings as SUGGESTIONS carrying an explicit confidence,
  - never emits a definitive diagnosis, only a differential-style impression,
  - never auto-updates the patient's diagnosis, risk score, or medications,
  - requires a doctor to confirm each finding before it enters the record.
The frontend renders the disclaimer this module returns; do not strip it.
"""

from __future__ import annotations

import base64
import io
import json

from PIL import Image, ImageOps

# Stable strings the API/frontend key off. Keep in sync with ImagingAnalysis.tsx.
DISCLAIMER = (
    "AI-assisted second read. Not a diagnosis and not a medical device. "
    "All findings require confirmation by a qualified radiologist or the "
    "treating physician before any clinical action."
)
URGENT_FLAG = "⚠ URGENT — IMMEDIATE REVIEW"

_MAX_SIDE = 2000     # longest side sent to the vision model
_MAX_PAGES = 4       # multi-slice CT / multi-view series cap
_MIN_SIDE = 900      # upscale small images to at least this on the long side


# ── encoding ────────────────────────────────────────────────────────────────

def prepare_for_vision(img: Image.Image) -> Image.Image:
    """
    Radiographs must NOT go through the doc_ocr pipeline. Deskew, autocontrast
    and unsharp-mask are tuned for text on paper; on a radiograph they distort
    the greyscale relationships that carry the diagnostic signal (and can
    manufacture edges that look like findings). The only safe operations are
    orientation correction and resizing.
    """
    try:
        work = ImageOps.exif_transpose(img).convert("RGB")
        long_side = max(work.width, work.height)
        if long_side < _MIN_SIDE:
            scale = _MIN_SIDE / long_side
            work = work.resize((int(work.width * scale), int(work.height * scale)),
                               Image.LANCZOS)
        elif long_side > _MAX_SIDE:
            scale = _MAX_SIDE / long_side
            work = work.resize((int(work.width * scale), int(work.height * scale)),
                               Image.LANCZOS)
        return work
    except Exception as e:
        print(f"⚠️ imaging.prepare_for_vision fell back to original: {e}")
        return img


def _encode(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


# ── classification (routing) ────────────────────────────────────────────────

_CLASSIFY_SYSTEM = """You classify an uploaded medical file into exactly one bucket.

"radiology"  — a medical IMAGE of anatomy: X-ray/radiograph, CT slice, MRI, ultrasound, mammogram, fluoroscopy, DEXA.
"document"   — a PAGE OF TEXT: lab report, prescription, discharge summary, doctor's note, bill, ID card, consent form. This includes a typed RADIOLOGY REPORT (text about a scan is a document, not a scan).
"other"      — anything else, or too unclear to tell.

Respond with STRICT JSON, no markdown:
{"kind": "radiology" | "document" | "other", "modality": "X-ray|CT|MRI|Ultrasound|Mammogram|Other|", "confidence": "high"|"medium"|"low"}"""


def classify_image(openai_client, img: Image.Image) -> dict:
    """
    Cheap routing call: is this a scan or a piece of paper? Uses the small model
    at low detail — this only needs to tell anatomy from text, not read either.
    Any failure returns "document", which routes to the existing, well-tested
    OCR path rather than into radiology interpretation.
    """
    try:
        thumb = img.copy()
        thumb.thumbnail((768, 768), Image.LANCZOS)
        resp = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": _CLASSIFY_SYSTEM},
                {"role": "user", "content": [
                    {"type": "text", "text": "Classify this file."},
                    {"type": "image_url",
                     "image_url": {"url": _encode(thumb), "detail": "low"}},
                ]},
            ],
            response_format={"type": "json_object"},
            max_tokens=100,
        )
        data = json.loads(resp.choices[0].message.content.strip())
        kind = str(data.get("kind", "document")).lower()
        if kind not in ("radiology", "document", "other"):
            kind = "document"
        return {
            "kind": kind,
            "modality": data.get("modality") or "",
            "confidence": str(data.get("confidence", "low")).lower(),
        }
    except Exception as e:
        print(f"⚠️ imaging.classify_image failed, defaulting to document: {e}")
        return {"kind": "document", "modality": "", "confidence": "low"}


# ── interpretation ──────────────────────────────────────────────────────────

_RADIOLOGY_SYSTEM = """You are assisting a physician by providing a structured SECOND READ of a radiology image. Your output is decision support, never a diagnosis.

How to read:
1. Identify modality and view/projection. If you cannot tell, say so rather than guessing.
2. Assess technical adequacy (rotation, penetration, inspiration, cropping, motion). A film that is too poor to read is itself the finding — report it and stop.
3. Work through anatomy systematically and report NEGATIVES too. For a chest film that means airway, breathing (lung fields, pleura), circulation (heart size, mediastinum), diaphragm, bones, soft tissue, devices/lines.
4. Report each abnormality separately with its anatomical location and laterality.

Calibration rules — these are the most important instructions:
- You are reliable on GROSS findings (large consolidation, sizeable effusion, pneumothorax, cardiomegaly, obvious displaced fracture, gross bowel obstruction) and UNRELIABLE on subtle ones (small nodules, early interstitial change, hairline/undisplaced fractures, subtle ischaemia). Set confidence accordingly and never claim high confidence on a subtle finding.
- If the image is not a radiology image at all, return findings: [] and say so in technical_quality.
- Do NOT invent findings to seem useful. A normal study reported as normal is a correct and valuable answer.
- Never state a definitive diagnosis. `impression` is a ranked differential in the radiologist's register ("findings are consistent with…", "cannot exclude…").
- Do NOT recommend specific drugs or doses. Next steps may name imaging, labs, or a specialist referral only.

If clinical context (age, sex, presenting complaint, recent labs) is supplied, use it in `correlation` to state whether the image supports, contradicts, or is unrelated to the existing picture. Cite the specific lab or history item you are correlating with. If no context is supplied, return an empty correlation array.

Respond with STRICT JSON, no markdown:
{
  "is_radiology": true | false,
  "modality": "X-ray" | "CT" | "MRI" | "Ultrasound" | "Mammogram" | "Unknown",
  "body_region": "e.g. Chest, Abdomen, Left Knee, Head",
  "view": "e.g. PA erect, AP supine, Lateral, Axial, Unknown",
  "technical_quality": "one line on adequacy and any limitation",
  "normal_study": true | false,
  "findings": [
    {
      "finding": "short clinical phrase, e.g. 'Right lower zone consolidation'",
      "location": "anatomical location + laterality",
      "severity": "critical" | "significant" | "minor" | "incidental",
      "confidence": "high" | "medium" | "low",
      "description": "one or two sentences on what is seen and why it supports this finding"
    }
  ],
  "normal_structures": ["structures explicitly checked and found normal"],
  "impression": "2-4 sentence ranked differential in radiological register",
  "correlation": [
    {"observation": "the imaging finding", "context": "the lab/history item", "interpretation": "supports / contradicts / unrelated, and why"}
  ],
  "urgent": true | false,
  "urgent_reason": "why this needs review now, or empty string",
  "next_steps": ["further imaging, labs, or referral — no drugs or doses"],
  "overall_confidence": "high" | "medium" | "low"
}

Set urgent=true only for findings needing attention within hours: pneumothorax (especially tension), free intraperitoneal air, large/expanding effusion, suspected intracranial haemorrhage, aortic dissection or widened mediastinum, displaced fracture with deformity, bowel obstruction/perforation."""


def _clinical_context_block(context: dict | None) -> str:
    """Flatten patient context into a short prompt block. Absent → empty string."""
    if not context:
        return ""
    bits: list[str] = []
    demo = ", ".join(str(x) for x in (context.get("age"), context.get("gender")) if x)
    if demo:
        bits.append(f"Patient: {demo}")
    for key, label in (("complaint", "Presenting complaint"),
                       ("conditions", "Known conditions"),
                       ("allergies", "Allergies")):
        if context.get(key):
            bits.append(f"{label}: {context[key]}")
    labs = context.get("recent_labs") or []
    if labs:
        rendered = "; ".join(
            f"{l.get('test')} {l.get('result')} {l.get('unit', '')}".strip()
            + (f" ({l['status']})" if l.get("status") else "")
            for l in labs[:12] if l.get("test")
        )
        if rendered:
            bits.append(f"Recent labs: {rendered}")
    if not bits:
        return ""
    return "CLINICAL CONTEXT (use for the correlation field):\n" + "\n".join(bits)


def _normalise(data: dict) -> dict:
    """
    Harden model output so the API and UI can trust every field's shape and so
    the safety posture holds even if the model drifts from the schema.
    """
    valid_sev = {"critical", "significant", "minor", "incidental"}
    valid_conf = {"high", "medium", "low"}

    findings = []
    for f in (data.get("findings") or []):
        if not isinstance(f, dict) or not f.get("finding"):
            continue
        severity = str(f.get("severity", "minor")).lower()
        confidence = str(f.get("confidence", "low")).lower()
        findings.append({
            "finding": str(f["finding"]),
            "location": str(f.get("location") or ""),
            "severity": severity if severity in valid_sev else "minor",
            "confidence": confidence if confidence in valid_conf else "low",
            "description": str(f.get("description") or ""),
        })

    correlation = [
        {
            "observation": str(c.get("observation") or ""),
            "context": str(c.get("context") or ""),
            "interpretation": str(c.get("interpretation") or ""),
        }
        for c in (data.get("correlation") or []) if isinstance(c, dict)
    ]

    overall = str(data.get("overall_confidence", "low")).lower()
    if overall not in valid_conf:
        overall = "low"

    # A study is only "normal" if the model said so AND listed nothing of
    # consequence — a model that reports consolidation and still ticks
    # normal_study must not render as a clean film.
    normal = bool(data.get("normal_study")) and not any(
        f["severity"] in ("critical", "significant") for f in findings
    )
    # Any critical finding escalates, whatever the model set `urgent` to.
    urgent = bool(data.get("urgent")) or any(
        f["severity"] == "critical" for f in findings
    )

    return {
        "is_radiology": bool(data.get("is_radiology", True)),
        "modality": str(data.get("modality") or "Unknown"),
        "body_region": str(data.get("body_region") or "Unknown"),
        "view": str(data.get("view") or "Unknown"),
        "technical_quality": str(data.get("technical_quality") or ""),
        "normal_study": normal,
        "findings": findings,
        "normal_structures": [str(s) for s in (data.get("normal_structures") or [])],
        "impression": str(data.get("impression") or ""),
        "correlation": correlation,
        "urgent": urgent,
        "urgent_reason": str(data.get("urgent_reason") or ""),
        "next_steps": [str(s) for s in (data.get("next_steps") or [])],
        "overall_confidence": overall,
        "disclaimer": DISCLAIMER,
    }


_CORRELATION_SYSTEM = """You are correlating an ALREADY-COMPLETED radiology read against a patient's clinical record. A radiologist read the film blind and produced the findings below. You are NOT looking at the image and you are NOT re-reading the study.

ABSOLUTE RULE: the findings list is FIXED. You may not add a finding, remove a finding, upgrade a severity, or raise a confidence. If the blind read found nothing, then nothing was found — say the imaging does not corroborate the clinical picture. A normal film in a sick patient is an important, valid result; do not invent an abnormality to explain the symptoms.

Your job is only to state how the existing findings relate to the clinical context, and to write an impression that accounts for both.

Respond with STRICT JSON, no markdown:
{
  "correlation": [
    {"observation": "the imaging finding, or 'No abnormality on imaging'", "context": "the specific lab value or history item", "interpretation": "supports / contradicts / unrelated, and why"}
  ],
  "impression": "2-4 sentence impression accounting for the imaging AND the clinical context. If imaging is normal, say so plainly and note that a normal study does not exclude the suspected condition.",
  "next_steps": ["further imaging, labs, or referral — no drugs or doses"]
}"""


def analyze_study(openai_client, images: list[Image.Image], filename: str,
                  context: dict | None = None) -> dict:
    """
    Interpret a radiology study. Returns the normalised structure above.
    Raises on API failure so the caller decides the fallback.

    TWO PASSES, and the split is a safety control, not an optimisation.

    Testing this against a normal chest film exposed severe context bias: read
    blind, the model correctly reported a clear film; given a context block
    describing fever, productive cough and a raised WBC/CRP, the SAME image came
    back as "right lower zone consolidation" at HIGH confidence — and then cited
    the labs as corroboration of a finding it had just invented to fit them.
    That failure mode is at its most convincing exactly when it is wrong.

    So detection never sees the clinical context:
      pass 1 — blind read of the pixels alone. Produces the findings.
      pass 2 — text-only correlation. Receives the pass-1 findings as FIXED and
               may only relate them to the record; it cannot add or escalate.

    The findings a doctor sees therefore depend only on the image.
    """
    header = (f"Filename: {filename}. {len(images[:_MAX_PAGES])} image(s)/slice(s) "
              f"from a single study. Read them together as one study.")
    content = [{"type": "text", "text": header}]
    for im in images[:_MAX_PAGES]:
        content.append({"type": "image_url",
                        "image_url": {"url": _encode(im), "detail": "high"}})

    resp = openai_client.chat.completions.create(
        model="gpt-4o",  # vision-capable; gpt-4o-mini is materially worse here
        messages=[{"role": "system", "content": _RADIOLOGY_SYSTEM},
                  {"role": "user", "content": content}],
        response_format={"type": "json_object"},
        temperature=0.2,   # interpretation should be stable across re-reads
        max_tokens=2000,
    )
    study = _normalise(json.loads(resp.choices[0].message.content.strip()))

    ctx = _clinical_context_block(context)
    if not ctx or not study.get("is_radiology"):
        return study

    # ── pass 2: correlation only, no image, findings frozen ──────────────
    try:
        findings_block = json.dumps({
            "findings": study["findings"],
            "normal_study": study["normal_study"],
            "blind_impression": study["impression"],
        }, indent=2)
        corr_resp = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": _CORRELATION_SYSTEM},
                {"role": "user", "content": f"BLIND READ RESULT:\n{findings_block}\n\n{ctx}"},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=1000,
        )
        corr = json.loads(corr_resp.choices[0].message.content.strip())

        study["correlation"] = [
            {
                "observation": str(c.get("observation") or ""),
                "context": str(c.get("context") or ""),
                "interpretation": str(c.get("interpretation") or ""),
            }
            for c in (corr.get("correlation") or []) if isinstance(c, dict)
        ]
        # Impression and next steps may be enriched by context; findings may not.
        if corr.get("impression"):
            study["impression"] = str(corr["impression"])
        if corr.get("next_steps"):
            study["next_steps"] = [str(s) for s in corr["next_steps"]]
    except Exception as e:
        # Correlation is additive. Losing it must never lose the blind read.
        print(f"⚠️ imaging: correlation pass failed, returning blind read: {e}")

    return study


def summary_line(study: dict) -> str:
    """One-line summary for the document timeline and RAG index."""
    head = f"{study['modality']} {study['body_region']}".strip()
    if study.get("normal_study") or not study.get("findings"):
        return f"{head}: no significant abnormality reported (AI second read)."
    top = "; ".join(f["finding"] for f in study["findings"][:3])
    return f"{head}: {top} (AI second read — requires doctor confirmation)."

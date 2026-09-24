"""Generated clinical documents — lab reports and visit summaries.

Two things happen to every document this module produces:

1. It is rendered to a real PDF on disk, so the patient can open or download it
   from their dashboard and hand it to a chemist.
2. Its text is filed into the `documents` table and pushed through the RAG
   pipeline, so Atlas answers "what did his last report say?" without anyone
   re-uploading anything.

Step 2 is the important one. Before this, a lab report submitted through VELA
lived only in the `lab_reports` table, which RAG never reads — so the hospital's
own reports were the one thing Atlas could not recall.
"""

from __future__ import annotations

import os
import textwrap
from datetime import datetime
from typing import Optional

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

REPORTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "generated_reports")
os.makedirs(REPORTS_DIR, exist_ok=True)

# VELA brand
_GOLD = colors.HexColor("#8A7A5C")  # print-safe variant of the VELA gold
_INK = colors.HexColor("#1A1A17")
_MUTED = colors.HexColor("#6B6B63")
_RULE = colors.HexColor("#D8D4CA")
_RED = colors.HexColor("#B3261E")
_AMBER = colors.HexColor("#8A6100")

_styles = getSampleStyleSheet()

S_TITLE = ParagraphStyle("VTitle", parent=_styles["Title"], fontName="Helvetica-Bold",
                         fontSize=20, leading=24, textColor=_INK, spaceAfter=2)
S_SUB = ParagraphStyle("VSub", parent=_styles["Normal"], fontName="Helvetica",
                       fontSize=8.5, leading=12, textColor=_MUTED, alignment=TA_CENTER)
S_H2 = ParagraphStyle("VH2", parent=_styles["Heading2"], fontName="Helvetica-Bold",
                      fontSize=11, leading=14, textColor=_INK, spaceBefore=12, spaceAfter=5)
S_BODY = ParagraphStyle("VBody", parent=_styles["Normal"], fontName="Helvetica",
                        fontSize=9.5, leading=14, textColor=_INK)
S_SMALL = ParagraphStyle("VSmall", parent=_styles["Normal"], fontName="Helvetica",
                         fontSize=8, leading=11, textColor=_MUTED)
S_CELL = ParagraphStyle("VCell", parent=_styles["Normal"], fontName="Helvetica",
                        fontSize=9, leading=12, textColor=_INK)


def _doctor(name: str) -> str:
    """Format a clinician's name with exactly one "Dr." prefix.

    Staff names in VELA are stored inconsistently — some already carry the
    title ("Dr. Himanshu"), some don't ("Mehta") — so prefixing blindly
    produced "Dr. Dr. Himanshu" on the printed record.
    """
    name = (name or "").strip()
    if not name:
        return ""
    return name if name.lower().startswith(("dr.", "dr ")) else f"Dr. {name}"


def _safe(v) -> str:
    """Escape the handful of characters ReportLab's mini-markup treats specially."""
    return (str(v) if v is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _header(story: list, title: str, subtitle: str, hospital_name: str):
    story.append(Paragraph("V E L A", ParagraphStyle(
        "brand", parent=S_SUB, fontName="Helvetica-Bold", fontSize=10,
        textColor=_GOLD, spaceAfter=1)))
    story.append(Paragraph(_safe(hospital_name), S_SUB))
    story.append(Spacer(1, 7))
    story.append(Paragraph(_safe(title), S_TITLE))
    story.append(Paragraph(_safe(subtitle), S_SUB))
    story.append(Spacer(1, 5))
    story.append(HRFlowable(width="100%", thickness=1.1, color=_GOLD, spaceAfter=8))


def _patient_block(story: list, patient: dict, meta_rows: list[tuple[str, str]]):
    left = [
        ("Patient", patient.get("name") or "—"),
        ("VELA ID", patient.get("vela_id") or "—"),
        ("Age / Sex", f"{patient.get('age') or '—'} / {patient.get('gender') or '—'}"),
        ("Blood Group", patient.get("blood_group") or "—"),
    ]
    rows = []
    for i in range(max(len(left), len(meta_rows))):
        lk, lv = left[i] if i < len(left) else ("", "")
        rk, rv = meta_rows[i] if i < len(meta_rows) else ("", "")
        rows.append([
            Paragraph(f"<font color='#6B6B63'>{_safe(lk)}</font>", S_CELL) if lk else "",
            Paragraph(f"<b>{_safe(lv)}</b>", S_CELL) if lk else "",
            Paragraph(f"<font color='#6B6B63'>{_safe(rk)}</font>", S_CELL) if rk else "",
            Paragraph(f"<b>{_safe(rv)}</b>", S_CELL) if rk else "",
        ])

    t = Table(rows, colWidths=[24 * mm, 55 * mm, 27 * mm, 54 * mm])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(t)
    story.append(Spacer(1, 4))
    story.append(HRFlowable(width="100%", thickness=0.6, color=_RULE, spaceAfter=6))


def _footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(_MUTED)
    canvas.drawString(18 * mm, 12 * mm,
                      "Generated by VELA OS · This is a computer-generated document.")
    canvas.drawRightString(A4[0] - 18 * mm, 12 * mm, f"Page {canvas.getPageNumber()}")
    canvas.setStrokeColor(_RULE)
    canvas.setLineWidth(0.5)
    canvas.line(18 * mm, 16 * mm, A4[0] - 18 * mm, 16 * mm)
    canvas.restoreState()


def _doc_template(path: str, title: str) -> SimpleDocTemplate:
    return SimpleDocTemplate(
        path, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=15 * mm, bottomMargin=22 * mm,
        title=title, author="VELA OS",
    )


# ── ABNORMALITY DETECTION ──────────────────────────────────────────────────────

def classify_values(values: dict, normal_ranges: dict) -> list[dict]:
    """Compare entered results against their reference ranges.

    Returns one entry per numeric field with a status of normal / abnormal /
    critical. `critical` means the value is more than half a reference-range
    width outside the range — the same rule the lab UI highlights with.
    """
    out = []
    for field, value in (values or {}).items():
        rng = (normal_ranges or {}).get(field) or {}
        lo, hi = rng.get("min"), rng.get("max")
        entry = {"field": field, "value": value, "min": lo, "max": hi, "status": "normal", "direction": None}

        if isinstance(value, bool) or not isinstance(value, (int, float)) or lo is None or hi is None:
            entry["status"] = "text"
            out.append(entry)
            continue

        if value < lo or value > hi:
            entry["status"] = "abnormal"
            entry["direction"] = "low" if value < lo else "high"
            width = hi - lo
            deviation = (lo - value) if value < lo else (value - hi)
            if width > 0 and (deviation / width) * 100 > 50:
                entry["status"] = "critical"
        out.append(entry)
    return out


def abnormal_summary_lines(classified: list[dict]) -> list[str]:
    """Human/LLM-readable one-liners for every out-of-range finding."""
    lines = []
    for c in classified:
        if c["status"] in ("abnormal", "critical"):
            tag = "CRITICAL" if c["status"] == "critical" else "ABNORMAL"
            lines.append(
                f"{tag}: {c['field']} = {c['value']} "
                f"({c['direction']}, reference {c['min']}–{c['max']})"
            )
    return lines


# ── LAB REPORT PDF ─────────────────────────────────────────────────────────────

def render_lab_report_pdf(
    *,
    report_id: str,
    patient: dict,
    test_type: str,
    department: str,
    values: dict,
    normal_ranges: dict,
    units: Optional[dict] = None,
    lab_notes: str = "",
    technician: str = "",
    ordered_by: str = "",
    atlas_analysis: str = "",
    risk_score: int = 0,
    hospital_name: str = "VELA Partner Hospital",
    submitted_at: Optional[str] = None,
) -> tuple[str, str]:
    """Render a lab result sheet. Returns (pdf_path, plain_text_for_rag)."""
    units = units or {}
    submitted_at = submitted_at or datetime.utcnow().isoformat()
    when = datetime.fromisoformat(submitted_at.replace("Z", "")).strftime("%d %b %Y, %H:%M")

    filename = f"lab_{_slug(test_type)}_{report_id[:8]}.pdf"
    path = os.path.join(REPORTS_DIR, filename)

    classified = classify_values(values, normal_ranges)
    story: list = []

    _header(story, f"{test_type} Report", f"{department.title()} Department · Report ID {report_id[:8].upper()}", hospital_name)
    _patient_block(story, patient, [
        ("Reported", when),
        ("Referred By", _doctor(ordered_by) or "—"),
        ("Technician", technician or "—"),
        ("Department", department.title()),
    ])

    # Results table
    story.append(Paragraph("Results", S_H2))
    head = ["Parameter", "Result", "Unit", "Reference Range", "Flag"]
    data = [[Paragraph(f"<b>{h}</b>", S_CELL) for h in head]]
    flag_styles = []

    for i, c in enumerate(classified, start=1):
        if c["status"] == "text":
            ref, flag, color = "—", "", None
        else:
            ref = f"{c['min']} – {c['max']}"
            if c["status"] == "critical":
                flag, color = f"CRITICAL {'↓' if c['direction'] == 'low' else '↑'}", _RED
            elif c["status"] == "abnormal":
                flag, color = f"{'LOW ↓' if c['direction'] == 'low' else 'HIGH ↑'}", _AMBER
            else:
                flag, color = "Normal", None

        data.append([
            Paragraph(_safe(c["field"]), S_CELL),
            Paragraph(f"<b>{_safe(c['value'])}</b>", S_CELL),
            Paragraph(_safe(units.get(c["field"], "")), S_CELL),
            Paragraph(_safe(ref), S_CELL),
            Paragraph(_safe(flag), S_CELL),
        ])
        if color is not None:
            flag_styles.append(("TEXTCOLOR", (4, i), (4, i), color))
            flag_styles.append(("FONTNAME", (4, i), (4, i), "Helvetica-Bold"))

    table = Table(data, colWidths=[52 * mm, 25 * mm, 22 * mm, 38 * mm, 27 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F4F2ED")),
        ("LINEBELOW", (0, 0), (-1, 0), 0.8, _GOLD),
        ("LINEBELOW", (0, 1), (-1, -1), 0.35, _RULE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
    ] + flag_styles))
    story.append(table)

    flagged = abnormal_summary_lines(classified)
    if flagged:
        story.append(Paragraph("Flagged Findings", S_H2))
        for line in flagged:
            story.append(Paragraph(f"• {_safe(line)}", S_BODY))

    if lab_notes:
        story.append(Paragraph("Laboratory Observations", S_H2))
        story.append(Paragraph(_safe(lab_notes), S_BODY))

    if atlas_analysis:
        story.append(Paragraph("Atlas Clinical Interpretation", S_H2))
        story.append(Paragraph(f"<i>{_safe(atlas_analysis)}</i>", S_BODY))
        story.append(Spacer(1, 3))
        story.append(Paragraph(
            f"Composite risk score: <b>{risk_score}</b>/100. "
            "AI-generated interpretation — not a substitute for clinical judgement.", S_SMALL))

    story.append(Spacer(1, 14))
    story.append(HRFlowable(width="40%", thickness=0.6, color=_RULE, spaceAfter=3, hAlign="RIGHT"))
    story.append(Paragraph(f"{_safe(technician or 'Laboratory')}<br/>Authorised Signatory",
                           ParagraphStyle("sig", parent=S_SMALL, alignment=2)))

    _doc_template(path, f"{test_type} Report").build(story, onFirstPage=_footer, onLaterPages=_footer)

    # ── plain text twin, for RAG ──
    lines = [
        f"LABORATORY REPORT — {test_type}",
        f"Department: {department.title()}",
        f"Hospital: {hospital_name}",
        f"Patient: {patient.get('name')} ({patient.get('vela_id')}), "
        f"Age {patient.get('age')}, {patient.get('gender')}, Blood group {patient.get('blood_group')}",
        f"Reported: {when}",
        f"Referred by: {_doctor(ordered_by)}" if ordered_by else "",
        "",
        "RESULTS:",
    ]
    for c in classified:
        unit = units.get(c["field"], "")
        if c["status"] == "text":
            lines.append(f"  {c['field']}: {c['value']}")
        else:
            ref = f"reference {c['min']}-{c['max']} {unit}".strip()
            status = {"critical": "CRITICAL", "abnormal": "ABNORMAL", "normal": "normal"}[c["status"]]
            arrow = f" ({c['direction']})" if c["direction"] else ""
            lines.append(f"  {c['field']}: {c['value']} {unit} — {status}{arrow}, {ref}")

    if flagged:
        lines += ["", "ABNORMAL / FLAGGED FINDINGS:"] + [f"  {l}" for l in flagged]
    else:
        lines += ["", "All measured parameters are within their reference ranges."]

    if lab_notes:
        lines += ["", f"Laboratory observations: {lab_notes}"]
    if atlas_analysis:
        lines += ["", f"Atlas clinical interpretation: {atlas_analysis}",
                  f"Composite risk score: {risk_score}/100."]

    return path, "\n".join(l for l in lines if l is not None)


# ── VISIT / CONSULTATION REPORT PDF ────────────────────────────────────────────

def render_visit_report_pdf(
    *,
    visit_id: str,
    patient: dict,
    doctor_name: str,
    visit_date: str,
    diagnosis: str = "",
    chief_complaint: str = "",
    medications: Optional[list[dict]] = None,
    tests_ordered: Optional[list[dict]] = None,
    abnormalities: Optional[list[str]] = None,
    vitals: Optional[dict] = None,
    advice: str = "",
    follow_up: str = "",
    hospital_name: str = "VELA Partner Hospital",
) -> tuple[str, str]:
    """Render the consultation record the patient carries out of the hospital.

    Deliberately generated even when nothing was prescribed: an empty
    prescription block still leaves a dated record of the visit, the vitals and
    any AI-flagged abnormalities from the patient's reports.
    """
    medications = medications or []
    tests_ordered = tests_ordered or []
    abnormalities = abnormalities or []
    vitals = vitals or {}

    filename = f"visit_{_slug(patient.get('name') or 'patient')}_{visit_id[:8]}.pdf"
    path = os.path.join(REPORTS_DIR, filename)
    when = _fmt_date(visit_date)

    story: list = []
    _header(story, "Consultation Record", f"Visit ID {visit_id[:8].upper()} · {when}", hospital_name)
    _patient_block(story, patient, [
        ("Date", when),
        ("Consultant", _doctor(doctor_name) or "—"),
        ("Visit ID", visit_id[:8].upper()),
    ])

    if chief_complaint:
        story.append(Paragraph("Presenting Complaint", S_H2))
        story.append(Paragraph(_safe(chief_complaint), S_BODY))

    if diagnosis:
        story.append(Paragraph("Clinical Impression", S_H2))
        story.append(Paragraph(_safe(diagnosis), S_BODY))

    if vitals:
        story.append(Paragraph("Vitals Recorded", S_H2))
        items = [f"{k}: <b>{_safe(v)}</b>" for k, v in vitals.items() if v not in (None, "")]
        if items:
            story.append(Paragraph(" &nbsp;·&nbsp; ".join(items), S_BODY))

    # Prescription — the block the chemist reads.
    story.append(Paragraph("Prescription (Rx)", S_H2))
    if medications:
        head = ["#", "Medicine", "Dosage", "Frequency", "Duration"]
        data = [[Paragraph(f"<b>{h}</b>", S_CELL) for h in head]]
        for i, m in enumerate(medications, start=1):
            data.append([
                Paragraph(str(i), S_CELL),
                Paragraph(f"<b>{_safe(m.get('name') or m.get('medication_name'))}</b>", S_CELL),
                Paragraph(_safe(m.get("dosage") or "—"), S_CELL),
                Paragraph(_safe(m.get("frequency") or "—"), S_CELL),
                Paragraph(_safe(m.get("duration") or "—"), S_CELL),
            ])
        t = Table(data, colWidths=[9 * mm, 54 * mm, 30 * mm, 40 * mm, 31 * mm], repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F4F2ED")),
            ("LINEBELOW", (0, 0), (-1, 0), 0.8, _GOLD),
            ("LINEBELOW", (0, 1), (-1, -1), 0.35, _RULE),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(t)
    else:
        story.append(Paragraph("<i>No medication prescribed at this visit.</i>", S_BODY))

    if tests_ordered:
        story.append(Paragraph("Investigations Ordered", S_H2))
        head = ["Test", "Department", "Sample", "Status"]
        data = [[Paragraph(f"<b>{h}</b>", S_CELL) for h in head]]
        for t_ in tests_ordered:
            data.append([
                Paragraph(f"<b>{_safe(t_.get('test_type'))}</b>", S_CELL),
                Paragraph(_safe((t_.get("department") or "").title()), S_CELL),
                Paragraph(_safe((t_.get("sample_type") or "—").title()), S_CELL),
                Paragraph(_safe((t_.get("status") or "ordered").replace("_", " ").title()), S_CELL),
            ])
        t = Table(data, colWidths=[58 * mm, 36 * mm, 34 * mm, 36 * mm], repeatRows=1)
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F4F2ED")),
            ("LINEBELOW", (0, 0), (-1, 0), 0.8, _GOLD),
            ("LINEBELOW", (0, 1), (-1, -1), 0.35, _RULE),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(t)

    if abnormalities:
        block = [Paragraph("AI-Flagged Findings From Records", S_H2)]
        for a in abnormalities:
            block.append(Paragraph(f"• {_safe(a)}", S_BODY))
        block.append(Spacer(1, 3))
        block.append(Paragraph(
            "Flagged automatically by Atlas from this patient's uploaded reports. "
            "Clinical correlation required.", S_SMALL))
        story.append(KeepTogether(block))

    if advice:
        story.append(Paragraph("Advice", S_H2))
        story.append(Paragraph(_safe(advice), S_BODY))

    if follow_up:
        story.append(Paragraph("Follow-Up", S_H2))
        story.append(Paragraph(_safe(follow_up), S_BODY))

    story.append(Spacer(1, 16))
    story.append(HRFlowable(width="40%", thickness=0.6, color=_RULE, spaceAfter=3, hAlign="RIGHT"))
    story.append(Paragraph(f"{_safe(_doctor(doctor_name))}<br/>{_safe(hospital_name)}",
                           ParagraphStyle("sig2", parent=S_SMALL, alignment=2)))

    _doc_template(path, "Consultation Record").build(story, onFirstPage=_footer, onLaterPages=_footer)

    # ── plain text twin, for RAG ──
    lines = [
        "CONSULTATION RECORD",
        f"Hospital: {hospital_name}",
        f"Date: {when}",
        f"Consultant: {_doctor(doctor_name)}" if doctor_name else "",
        f"Patient: {patient.get('name')} ({patient.get('vela_id')}), "
        f"Age {patient.get('age')}, {patient.get('gender')}",
        "",
    ]
    if chief_complaint:
        lines += [f"Presenting complaint: {chief_complaint}", ""]
    if diagnosis:
        lines += [f"Clinical impression / diagnosis: {diagnosis}", ""]
    if vitals:
        lines += ["Vitals: " + ", ".join(f"{k} {v}" for k, v in vitals.items() if v not in (None, "")), ""]

    lines.append("PRESCRIPTION:")
    if medications:
        for m in medications:
            name = m.get("name") or m.get("medication_name")
            lines.append(
                f"  {name} — dosage {m.get('dosage') or 'as directed'}, "
                f"frequency {m.get('frequency') or 'as directed'}, "
                f"duration {m.get('duration') or 'as directed'}"
            )
    else:
        lines.append("  No medication prescribed at this visit.")

    lines.append("")
    lines.append("INVESTIGATIONS ORDERED:")
    if tests_ordered:
        for t_ in tests_ordered:
            lines.append(
                f"  {t_.get('test_type')} ({(t_.get('department') or '').title()} department, "
                f"{t_.get('sample_type') or 'sample'}) — status {t_.get('status') or 'ordered'}"
            )
    else:
        lines.append("  No investigations ordered at this visit.")

    if abnormalities:
        lines += ["", "AI-FLAGGED ABNORMAL FINDINGS FROM PATIENT RECORDS:"]
        lines += [f"  {a}" for a in abnormalities]

    if advice:
        lines += ["", f"Advice: {advice}"]
    if follow_up:
        lines += ["", f"Follow-up: {follow_up}"]

    return path, "\n".join(l for l in lines if l is not None)


def _slug(text: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in (text or "doc")).strip("_").lower()[:40] or "doc"


def _fmt_date(value: str) -> str:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "")).strftime("%d %b %Y")
    except Exception:
        return str(value or datetime.utcnow().strftime("%d %b %Y"))


def wrap_for_console(text: str, width: int = 96) -> str:
    return "\n".join(textwrap.fill(line, width) for line in text.splitlines())

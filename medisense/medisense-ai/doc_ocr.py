"""
Document quality handling for medical record ingestion.

Two goals, both safety-driven:

1. Low-quality phone scans / photos (very common with Indian medical records)
   are preprocessed — deskew, contrast normalisation, upscaling — BEFORE they
   are sent to the vision model, which measurably improves extraction on
   crooked, dim, or small photos.

2. Handwritten content (common in doctor's notes) is NEVER confidently
   transcribed. Automated handwriting OCR is unreliable and, on a medical
   record, a confident-but-wrong transcription is a safety hazard. Instead we
   detect handwriting / low confidence, extract only what is unambiguously
   legible, flag the document for human review, and keep the original image so
   the reviewing doctor can read it themselves and make the final call.

Pure Pillow + NumPy + PyMuPDF (no OpenCV dependency).
"""

from __future__ import annotations
import base64
import io
import json

import numpy as np
from PIL import Image, ImageOps, ImageEnhance, ImageFilter

# Sentinel used in a document's `critical_flags` so the frontend can render a
# prominent "needs doctor review" banner. Kept as a stable string constant.
NEEDS_REVIEW_FLAG = "⚠ NEEDS DOCTOR REVIEW"

_MAX_VISION_SIDE = 2200      # cap the longest side sent to the model
_MIN_UPSCALE_SIDE = 1400     # upscale small images up to this on the long side
_MAX_DISPLAY_SIDE = 1400     # stored display copy (base64) longest side
_MAX_PAGES = 5               # never process more than this many pages


# ── rendering ───────────────────────────────────────────────────────────────

def render_document_to_images(file_bytes: bytes, filename: str) -> list[Image.Image]:
    """Turn an uploaded file (image or PDF) into a list of RGB PIL images."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in ("jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif", "heic"):
        img = Image.open(io.BytesIO(file_bytes))
        return [ImageOps.exif_transpose(img).convert("RGB")]

    # PDF → render each page to a raster (300 DPI-ish via 2x matrix) so that
    # image-only / scanned PDFs (which have no embedded text) become OCR-able.
    import fitz
    images: list[Image.Image] = []
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    for page in doc[:_MAX_PAGES]:
        pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0))
        images.append(Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB"))
    doc.close()
    return images


# ── preprocessing ───────────────────────────────────────────────────────────

def _estimate_skew_angle(gray: np.ndarray) -> float:
    """
    Estimate skew via a projection-profile score over a small angle range.
    The correct rotation maximises the variance of the row-sum profile (text
    rows line up, producing sharp peaks). Coarse search, robust and cheap.
    """
    # binarise: ink (dark) = 1
    thresh = gray < (gray.mean() - 10)
    binary = thresh.astype(np.float32)
    best_angle, best_score = 0.0, -1.0
    for angle in np.arange(-8, 8.5, 1.0):
        rotated = _rotate_array(binary, angle)
        profile = rotated.sum(axis=1)
        score = float(np.var(profile))
        if score > best_score:
            best_score, best_angle = score, angle
    return best_angle


def _rotate_array(arr: np.ndarray, angle: float) -> np.ndarray:
    if abs(angle) < 0.1:
        return arr
    img = Image.fromarray((arr * 255).astype(np.uint8))
    img = img.rotate(angle, resample=Image.BILINEAR, fillcolor=0)
    return np.asarray(img, dtype=np.float32) / 255.0


def preprocess_image(img: Image.Image) -> Image.Image:
    """
    Deskew → grayscale → autocontrast → mild sharpen → upscale-if-small.
    Every step is defensive; on any failure we fall back to the input so a
    preprocessing bug can never block ingestion.
    """
    try:
        work = img
        # Downscale the copy used for skew estimation so the search is fast.
        gray_small = np.asarray(ImageOps.grayscale(
            work.copy().resize((min(work.width, 1000),
                                max(1, int(work.height * (min(work.width, 1000) / work.width)))))
        ), dtype=np.float32)
        angle = _estimate_skew_angle(gray_small)
        if abs(angle) >= 1.0:
            work = work.rotate(angle, resample=Image.BICUBIC,
                               fillcolor=(255, 255, 255), expand=True)

        gray = ImageOps.grayscale(work)
        gray = ImageOps.autocontrast(gray, cutoff=1)
        gray = ImageEnhance.Contrast(gray).enhance(1.4)
        gray = gray.filter(ImageFilter.UnsharpMask(radius=1.4, percent=120, threshold=2))

        long_side = max(gray.width, gray.height)
        if long_side < _MIN_UPSCALE_SIDE:
            scale = _MIN_UPSCALE_SIDE / long_side
            gray = gray.resize((int(gray.width * scale), int(gray.height * scale)),
                               Image.LANCZOS)
        return gray.convert("RGB")
    except Exception as e:
        print(f"⚠️ preprocess_image fell back to original: {e}")
        return img


def _encode_for_vision(img: Image.Image) -> str:
    """Cap size and JPEG-encode → base64 data URL for the vision API."""
    im = img
    long_side = max(im.width, im.height)
    if long_side > _MAX_VISION_SIDE:
        scale = _MAX_VISION_SIDE / long_side
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    im.convert("RGB").save(buf, format="JPEG", quality=82)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def make_display_data_url(img: Image.Image) -> str:
    """Smaller base64 JPEG stored on the document so the UI can show the original."""
    im = img
    long_side = max(im.width, im.height)
    if long_side > _MAX_DISPLAY_SIDE:
        scale = _MAX_DISPLAY_SIDE / long_side
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    im.convert("RGB").save(buf, format="JPEG", quality=70)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


# ── vision extraction (safety-first) ─────────────────────────────────────────

_VISION_SYSTEM = """You are a careful clinical document assistant helping a doctor triage an uploaded medical record image. A wrong transcription on a medical record can harm a patient, so accuracy and honesty about uncertainty matter far more than completeness.

Rules:
- Transcribe ONLY text you can read with high confidence. Do NOT guess.
- If content is HANDWRITTEN, do not attempt a confident transcription. Handwriting OCR is unreliable — capture only words that are unambiguous, wrap any uncertain word in [?], and mark the document as needing human review.
- Extract structured lab `values` ONLY from clearly PRINTED tabular results. Never infer lab values from handwriting or blurry text.
- If the image is too dark, blurry, cropped, or low-resolution to read reliably, say so and request review.

Respond with STRICT JSON, no markdown:
{
  "doc_type": "printed" | "handwritten" | "mixed" | "unreadable",
  "overall_confidence": "high" | "medium" | "low",
  "needs_review": true | false,
  "legible_text": "only text you are confident about; use [?] for uncertain words",
  "values": [ {"test": "...", "result": "...", "unit": "...", "status": "normal|high|low", "reference": "..."} ],
  "critical_flags": ["..."],
  "risk_score": 0,
  "summary": "1-3 sentence plain-language summary of what is legible; if not enough is legible, say that explicitly",
  "review_reason": "why a human should review, or empty string if fully legible printed text"
}

needs_review MUST be true when doc_type is handwritten, mixed, or unreadable, OR overall_confidence is low. When unsure, prefer needs_review=true."""


def vision_extract(openai_client, images: list[Image.Image], filename: str) -> dict:
    """
    Send preprocessed page images to the vision model and return the safety
    structured result. Raises on API failure (caller decides fallback).
    """
    content = [{"type": "text",
                "text": f"Filename: {filename}. Extract per the rules. {len(images)} page(s)."}]
    for im in images[:_MAX_PAGES]:
        content.append({"type": "image_url",
                        "image_url": {"url": _encode_for_vision(im), "detail": "high"}})

    resp = openai_client.chat.completions.create(
        model="gpt-4o",  # vision-capable
        messages=[{"role": "system", "content": _VISION_SYSTEM},
                  {"role": "user", "content": content}],
        response_format={"type": "json_object"},
        max_tokens=2000,
    )
    data = json.loads(resp.choices[0].message.content.strip())

    # Normalise / harden the model output so downstream code can trust it.
    doc_type = str(data.get("doc_type", "printed")).lower()
    confidence = str(data.get("overall_confidence", "low")).lower()
    needs_review = bool(data.get("needs_review", False))
    if doc_type in ("handwritten", "mixed", "unreadable") or confidence == "low":
        needs_review = True
    # Never trust auto-extracted lab values from non-printed / low-confidence docs.
    values = data.get("values") or []
    if doc_type != "printed" or confidence == "low":
        values = []
    return {
        "doc_type": doc_type,
        "overall_confidence": confidence,
        "needs_review": needs_review,
        "legible_text": data.get("legible_text") or "",
        "values": values,
        "critical_flags": data.get("critical_flags") or [],
        "risk_score": int(data.get("risk_score") or 0),
        "summary": data.get("summary") or "",
        "review_reason": data.get("review_reason") or "",
    }

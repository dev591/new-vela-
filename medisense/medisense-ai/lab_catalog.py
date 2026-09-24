"""VELA lab test catalog — the routing intelligence layer.

A doctor says "assign him a lipid profile and a chest x-ray". Those two tests are
run by two different labs, cost different amounts, need different samples and take
different amounts of time. This module is the single source of truth that turns a
free-text test name into that structured reality:

    resolve_test("chest xray") -> {
        "test_type": "Chest X-Ray", "department": "radiology",
        "price": 600.0, "sample_type": "imaging", "tat_minutes": 30, ...
    }

Resolution is deterministic first (exact -> alias -> normalized -> fuzzy) so the
common cases never cost an LLM call and never drift between runs. `main.py` falls
back to the LLM only for names this catalog has never seen.
"""

from __future__ import annotations

import difflib
import re
from typing import Optional

# Departments a lab account can be scoped to. `all` is the super-lab fallback
# (the lab@vela.ai demo login) which sees every department's queue.
DEPARTMENTS = [
    {"id": "pathology", "name": "Pathology", "description": "Blood, urine and fluid analysis"},
    {"id": "radiology", "name": "Radiology", "description": "X-Ray, CT, MRI, ultrasound"},
    {"id": "cardiology", "name": "Cardiology", "description": "ECG, ECHO, stress testing"},
    {"id": "microbiology", "name": "Microbiology", "description": "Cultures and sensitivity"},
    {"id": "histopathology", "name": "Histopathology", "description": "Biopsy and cytology"},
]

DEPARTMENT_IDS = [d["id"] for d in DEPARTMENTS]

# Sentinel used for lab accounts that are not scoped to one department.
ALL_DEPARTMENTS = "all"


def _f(name, unit, lo, hi):
    return {"name": name, "unit": unit, "normal_min": lo, "normal_max": hi}


def _t(name, unit=""):
    """A free-text observation field (no numeric normal range)."""
    return {"name": name, "unit": unit, "normal_min": 0, "normal_max": 0, "text_field": True}


# ── THE CATALOG ────────────────────────────────────────────────────────────────
# price is in INR. tat_minutes is the realistic turnaround used for queue ETAs.
TEST_CATALOG: dict[str, dict] = {
    # ---- PATHOLOGY ----
    "Blood CBC": {
        "department": "pathology",
        "price": 350.0,
        "sample_type": "blood",
        "tat_minutes": 45,
        "aliases": ["cbc", "complete blood count", "blood count", "hemogram", "haemogram", "blood test", "full blood count", "fbc"],
        "fields": [
            _f("Hemoglobin", "g/dL", 12.0, 17.5),
            _f("WBC", "cells/mcL", 4500, 11000),
            _f("Platelets", "cells/mcL", 150000, 400000),
            _f("RBC", "million/mcL", 4.5, 5.9),
            _f("Hematocrit", "%", 41, 53),
            _f("MCV", "fL", 80, 100),
        ],
    },
    "Lipid Profile": {
        "department": "pathology",
        "price": 700.0,
        "sample_type": "blood",
        "tat_minutes": 60,
        "aliases": ["lipid", "lipids", "cholesterol", "cholesterol test", "lipid panel"],
        "fields": [
            _f("Total Cholesterol", "mg/dL", 0, 200),
            _f("LDL", "mg/dL", 0, 100),
            _f("HDL", "mg/dL", 40, 999),
            _f("Triglycerides", "mg/dL", 0, 150),
            _f("VLDL", "mg/dL", 2, 30),
        ],
    },
    "Blood Sugar": {
        "department": "pathology",
        "price": 300.0,
        "sample_type": "blood",
        "tat_minutes": 30,
        "aliases": ["sugar", "glucose", "blood glucose", "diabetes test", "hba1c", "fasting sugar", "rbs", "fbs"],
        "fields": [
            _f("Fasting Glucose", "mg/dL", 70, 100),
            _f("Post Prandial", "mg/dL", 70, 140),
            _f("HbA1c", "%", 4, 5.7),
        ],
    },
    "Kidney Function": {
        "department": "pathology",
        "price": 800.0,
        "sample_type": "blood",
        "tat_minutes": 60,
        "aliases": ["kft", "rft", "renal function", "renal profile", "kidney test", "kidney panel", "creatinine"],
        "fields": [
            _f("Creatinine", "mg/dL", 0.6, 1.2),
            _f("BUN", "mg/dL", 7, 20),
            _f("Uric Acid", "mg/dL", 3.5, 7.2),
            _f("eGFR", "mL/min", 60, 999),
        ],
    },
    "Liver Function": {
        "department": "pathology",
        "price": 850.0,
        "sample_type": "blood",
        "tat_minutes": 60,
        "aliases": ["lft", "liver profile", "liver test", "liver panel", "bilirubin"],
        "fields": [
            _f("SGOT/AST", "U/L", 10, 40),
            _f("SGPT/ALT", "U/L", 7, 56),
            _f("Bilirubin Total", "mg/dL", 0.2, 1.2),
            _f("Alkaline Phosphatase", "U/L", 44, 147),
            _f("Total Protein", "g/dL", 6.3, 8.2),
        ],
    },
    "Thyroid": {
        "department": "pathology",
        "price": 600.0,
        "sample_type": "blood",
        "tat_minutes": 90,
        "aliases": ["tft", "thyroid profile", "thyroid function", "tsh", "t3 t4 tsh"],
        "fields": [
            _f("TSH", "mIU/L", 0.4, 4.0),
            _f("T3", "ng/dL", 80, 200),
            _f("T4", "mcg/dL", 5.0, 12.0),
        ],
    },
    "Urine Routine": {
        "department": "pathology",
        "price": 250.0,
        "sample_type": "urine",
        "tat_minutes": 30,
        "aliases": ["urine", "urine test", "urine analysis", "urinalysis", "urine r/m", "routine urine"],
        "fields": [
            _t("Color"),
            _f("pH", "", 4.5, 8.0),
            _f("Protein", "mg/dL", 0, 8),
            _f("Glucose", "mg/dL", 0, 15),
            _f("WBC", "cells/hpf", 0, 5),
        ],
    },
    "Vitamin D": {
        "department": "pathology",
        "price": 1200.0,
        "sample_type": "blood",
        "tat_minutes": 120,
        "aliases": ["vit d", "vitamin d3", "25 oh vitamin d"],
        "fields": [_f("25-OH Vitamin D", "ng/mL", 30, 100)],
    },
    "Vitamin B12": {
        "department": "pathology",
        "price": 1100.0,
        "sample_type": "blood",
        "tat_minutes": 120,
        "aliases": ["vit b12", "b12", "cobalamin"],
        "fields": [_f("Vitamin B12", "pg/mL", 200, 900)],
    },
    "Electrolytes": {
        "department": "pathology",
        "price": 450.0,
        "sample_type": "blood",
        "tat_minutes": 30,
        "aliases": ["serum electrolytes", "sodium potassium", "na k cl"],
        "fields": [
            _f("Sodium", "mEq/L", 135, 145),
            _f("Potassium", "mEq/L", 3.5, 5.1),
            _f("Chloride", "mEq/L", 98, 107),
        ],
    },
    "Coagulation Profile": {
        "department": "pathology",
        "price": 900.0,
        "sample_type": "blood",
        "tat_minutes": 60,
        "aliases": ["pt inr", "inr", "coagulation", "clotting profile", "aptt"],
        "fields": [
            _f("PT", "seconds", 11, 13.5),
            _f("INR", "", 0.8, 1.2),
            _f("APTT", "seconds", 25, 35),
        ],
    },

    # ---- RADIOLOGY ----
    "Chest X-Ray": {
        "department": "radiology",
        "price": 600.0,
        "sample_type": "imaging",
        "tat_minutes": 30,
        "aliases": ["xray", "x-ray", "chest xray", "cxr", "chest radiograph", "chest film"],
        "fields": [
            _t("Lung Fields"),
            _t("Cardiac Silhouette"),
            _t("Costophrenic Angles"),
            _t("Bony Thorax"),
            _t("Impression"),
        ],
    },
    "CT Scan": {
        "department": "radiology",
        "price": 4500.0,
        "sample_type": "imaging",
        "tat_minutes": 120,
        "aliases": ["ct", "cat scan", "computed tomography", "ct head", "ct abdomen", "ct chest"],
        "fields": [
            _t("Study Region"),
            _t("Contrast Used"),
            _t("Findings"),
            _t("Impression"),
        ],
    },
    "MRI": {
        "department": "radiology",
        "price": 8000.0,
        "sample_type": "imaging",
        "tat_minutes": 180,
        "aliases": ["magnetic resonance", "mri brain", "mri spine", "mri scan"],
        "fields": [
            _t("Study Region"),
            _t("Sequences"),
            _t("Findings"),
            _t("Impression"),
        ],
    },
    "Ultrasound": {
        "department": "radiology",
        "price": 1200.0,
        "sample_type": "imaging",
        "tat_minutes": 45,
        "aliases": ["usg", "sonography", "ultrasonography", "ultrasound abdomen", "sonar"],
        "fields": [
            _t("Study Region"),
            _t("Findings"),
            _t("Impression"),
        ],
    },
    "Mammography": {
        "department": "radiology",
        "price": 2500.0,
        "sample_type": "imaging",
        "tat_minutes": 60,
        "aliases": ["mammogram", "breast screening"],
        "fields": [_t("Breast Density"), _t("Findings"), _t("BI-RADS Category"), _t("Impression")],
    },

    # ---- CARDIOLOGY ----
    "ECG": {
        "department": "cardiology",
        "price": 400.0,
        "sample_type": "procedure",
        "tat_minutes": 20,
        "aliases": ["ekg", "electrocardiogram", "electro cardiogram", "12 lead ecg"],
        "fields": [
            _f("Heart Rate", "bpm", 60, 100),
            _f("PR Interval", "ms", 120, 200),
            _f("QRS Duration", "ms", 80, 100),
            _f("QT Interval", "ms", 350, 440),
            _t("Rhythm"),
        ],
    },
    "Echocardiogram": {
        "department": "cardiology",
        "price": 2500.0,
        "sample_type": "procedure",
        "tat_minutes": 60,
        "aliases": ["echo", "2d echo", "cardiac echo", "echocardiography"],
        "fields": [
            _f("Ejection Fraction", "%", 55, 70),
            _t("Valve Assessment"),
            _t("Wall Motion"),
            _t("Impression"),
        ],
    },
    "TMT": {
        "department": "cardiology",
        "price": 2000.0,
        "sample_type": "procedure",
        "tat_minutes": 90,
        "aliases": ["treadmill test", "stress test", "exercise tolerance test", "ett"],
        "fields": [
            _f("Peak Heart Rate", "bpm", 100, 200),
            _f("Exercise Duration", "minutes", 6, 20),
            _t("ST Changes"),
            _t("Impression"),
        ],
    },

    # ---- MICROBIOLOGY ----
    "Blood Culture": {
        "department": "microbiology",
        "price": 1500.0,
        "sample_type": "blood",
        "tat_minutes": 2880,
        "aliases": ["culture", "blood c/s", "blood culture sensitivity"],
        "fields": [
            _t("Organism Isolated"),
            _t("Colony Count"),
            _t("Sensitive To"),
            _t("Resistant To"),
        ],
    },
    "Urine Culture": {
        "department": "microbiology",
        "price": 900.0,
        "sample_type": "urine",
        "tat_minutes": 2880,
        "aliases": ["urine c/s", "urine culture sensitivity", "uti culture"],
        "fields": [
            _t("Organism Isolated"),
            _t("Colony Count"),
            _t("Sensitive To"),
            _t("Resistant To"),
        ],
    },
    "Sputum AFB": {
        "department": "microbiology",
        "price": 500.0,
        "sample_type": "sputum",
        "tat_minutes": 1440,
        "aliases": ["afb", "tb test", "sputum smear", "acid fast bacilli"],
        "fields": [_t("AFB Result"), _t("Grading"), _t("Remarks")],
    },

    # ---- HISTOPATHOLOGY ----
    "Biopsy": {
        "department": "histopathology",
        "price": 3500.0,
        "sample_type": "tissue",
        "tat_minutes": 4320,
        "aliases": ["histopathology", "tissue biopsy", "hpe", "biopsy examination"],
        "fields": [
            _t("Specimen"),
            _t("Gross Description"),
            _t("Microscopic Description"),
            _t("Diagnosis"),
        ],
    },
    "Pap Smear": {
        "department": "histopathology",
        "price": 1200.0,
        "sample_type": "tissue",
        "tat_minutes": 2880,
        "aliases": ["pap test", "cervical smear", "cytology smear"],
        "fields": [_t("Specimen Adequacy"), _t("Findings"), _t("Bethesda Category")],
    },
}

# Fallback used when a test name matches nothing in the catalog. Pathology is the
# safest default department — it is the one that always exists in a hospital.
UNKNOWN_TEST_DEFAULT = {
    "department": "pathology",
    "price": 500.0,
    "sample_type": "blood",
    "tat_minutes": 60,
    "fields": [
        {"name": "Result Value", "unit": "", "normal_min": 0, "normal_max": 100},
        {"name": "Reference Range", "unit": "", "normal_min": 0, "normal_max": 0, "text_field": True},
        {"name": "Observation", "unit": "", "normal_min": 0, "normal_max": 0, "text_field": True},
    ],
}


def _normalize(text: str) -> str:
    """Lowercase, strip punctuation and collapse whitespace for matching."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower())).strip()


# Alias -> canonical name, built once at import.
_ALIAS_INDEX: dict[str, str] = {}
for _canonical, _entry in TEST_CATALOG.items():
    _ALIAS_INDEX[_normalize(_canonical)] = _canonical
    for _alias in _entry.get("aliases", []):
        _ALIAS_INDEX[_normalize(_alias)] = _canonical


def resolve_test(raw_name: str) -> dict:
    """Turn a free-text test name into a routed, priced catalog entry.

    Always returns a dict — an unrecognized name resolves to a generic pathology
    order with `matched: False` so callers can decide whether to ask the LLM.
    """
    norm = _normalize(raw_name)
    if not norm:
        return {"test_type": (raw_name or "Unknown Test").strip(), "matched": False, **UNKNOWN_TEST_DEFAULT}

    canonical = _ALIAS_INDEX.get(norm)

    # Substring pass: "urgent chest x-ray please" contains a known alias.
    if not canonical:
        hits = [(alias, name) for alias, name in _ALIAS_INDEX.items() if len(alias) >= 3 and alias in norm]
        if hits:
            # Longest alias wins — "urine culture" must beat bare "urine".
            canonical = max(hits, key=lambda h: len(h[0]))[1]

    # Fuzzy pass for typos ("lipd profile").
    if not canonical:
        close = difflib.get_close_matches(norm, list(_ALIAS_INDEX.keys()), n=1, cutoff=0.82)
        if close:
            canonical = _ALIAS_INDEX[close[0]]

    if not canonical:
        return {"test_type": raw_name.strip(), "matched": False, **UNKNOWN_TEST_DEFAULT}

    entry = TEST_CATALOG[canonical]
    return {
        "test_type": canonical,
        "matched": True,
        "department": entry["department"],
        "price": entry["price"],
        "sample_type": entry["sample_type"],
        "tat_minutes": entry["tat_minutes"],
        "fields": entry["fields"],
    }


def resolve_tests(raw_names: list[str]) -> list[dict]:
    """Resolve a list of test names, dropping duplicates that collapse to the same
    canonical test (a doctor saying "CBC and complete blood count" means one test)."""
    resolved: list[dict] = []
    seen: set[str] = set()
    for name in raw_names or []:
        entry = resolve_test(name)
        key = entry["test_type"].lower()
        if key in seen:
            continue
        seen.add(key)
        resolved.append(entry)
    return resolved


def department_for(test_name: str) -> str:
    return resolve_test(test_name)["department"]


def price_for(test_name: str) -> float:
    return resolve_test(test_name)["price"]


def builtin_template(test_name: str) -> Optional[dict]:
    """Field template for a catalog test, or None if the test is not in the catalog."""
    entry = resolve_test(test_name)
    if not entry["matched"]:
        return None
    return {"fields": entry["fields"], "department": entry["department"]}


def catalog_listing() -> list[dict]:
    """Flat, UI-friendly listing of the whole catalog (no template fields)."""
    return [
        {
            "test_type": name,
            "department": entry["department"],
            "price": entry["price"],
            "sample_type": entry["sample_type"],
            "tat_minutes": entry["tat_minutes"],
        }
        for name, entry in sorted(TEST_CATALOG.items(), key=lambda kv: (kv[1]["department"], kv[0]))
    ]

"""Seed three SYNTHETIC patients with several reports each, for the virtual-consultation demo.

All names, ids and numbers are invented (no real people, no phone numbers). The patients belong to
"VELA Prime Medical", not the demo hospital, so a doctor at VELA Care sees them as a patient from another
city. Safe to run twice: existing patients are left alone.

Run:  .venv/bin/python seed_demo_patients.py
"""
import os

from dotenv import load_dotenv
from supabase import create_client

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
db = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def v(test, unit, result, status, ref):
    return {"test": test, "unit": unit, "result": str(result), "status": status, "reference": ref}


N, L, H, C = "Normal", "Low", "High", "Critical"

PATIENTS = [
    {
        "vela_id": "VLA-9001", "name": "Anita Deshmukh", "age": 52, "gender": "Female", "blood_group": "B+",
        "allergies": "None known", "existing_conditions": "Type 2 diabetes, high blood pressure", "risk_score": 38,
        "diagnosis": "Type 2 diabetes, improving",
        "reports": [
            ("Diabetes_Review_Mar_2026.pdf", "2026-03-12", 52, "Diabetes control is poor. HbA1c and fasting sugar are well above target.", ["Poor sugar control"],
             [v("HbA1c", "%", 8.4, H, "4.0 - 5.6"), v("Fasting Glucose", "mg/dL", 168, H, "70 - 100"), v("Creatinine", "mg/dL", 0.9, N, "0.6 - 1.1"), v("LDL Cholesterol", "mg/dL", 142, H, "0 - 100")]),
            ("Diabetes_Review_Jun_2026.pdf", "2026-06-20", 44, "Sugar control is getting better after the medicine change. Cholesterol is still high.", [],
             [v("HbA1c", "%", 7.8, H, "4.0 - 5.6"), v("Fasting Glucose", "mg/dL", 141, H, "70 - 100"), v("Creatinine", "mg/dL", 0.9, N, "0.6 - 1.1"), v("LDL Cholesterol", "mg/dL", 121, H, "0 - 100")]),
            ("Diabetes_Review_Sep_2026.pdf", "2026-09-18", 36, "Steady improvement. Kidney function is normal.", [],
             [v("HbA1c", "%", 7.2, H, "4.0 - 5.6"), v("Fasting Glucose", "mg/dL", 122, H, "70 - 100"), v("Creatinine", "mg/dL", 0.8, N, "0.6 - 1.1"), v("LDL Cholesterol", "mg/dL", 104, H, "0 - 100")]),
        ],
    },
    {
        "vela_id": "VLA-9002", "name": "Mohammed Irfan", "age": 61, "gender": "Male", "blood_group": "O-",
        "allergies": "Sulfa drugs", "existing_conditions": "Chronic kidney disease (stage 3), high blood pressure", "risk_score": 74,
        "diagnosis": "Chronic kidney disease, worsening",
        "reports": [
            ("Kidney_Panel_Apr_2026.pdf", "2026-04-02", 48, "Kidney function is mildly reduced and stable.", [],
             [v("Creatinine", "mg/dL", 1.6, H, "0.7 - 1.3"), v("eGFR", "mL/min", 52, L, "90 - 120"), v("Potassium", "mmol/L", 4.9, N, "3.5 - 5.1"), v("Hemoglobin", "g/dL", 12.1, L, "13.5 - 17.5")]),
            ("Kidney_Panel_Aug_2026.pdf", "2026-08-14", 63, "Kidney function has dropped since April. Potassium is creeping up and anaemia is worsening.", ["Kidney function falling"],
             [v("Creatinine", "mg/dL", 2.0, H, "0.7 - 1.3"), v("eGFR", "mL/min", 41, L, "90 - 120"), v("Potassium", "mmol/L", 5.4, H, "3.5 - 5.1"), v("Hemoglobin", "g/dL", 10.9, L, "13.5 - 17.5")]),
            ("Kidney_Panel_Nov_2026.pdf", "2026-11-03", 78, "Kidney function continues to fall. Potassium is high and needs attention.", ["High potassium", "Kidney function falling"],
             [v("Creatinine", "mg/dL", 2.4, H, "0.7 - 1.3"), v("eGFR", "mL/min", 33, L, "90 - 120"), v("Potassium", "mmol/L", 5.9, C, "3.5 - 5.1"), v("Hemoglobin", "g/dL", 10.1, L, "13.5 - 17.5")]),
        ],
    },
    {
        "vela_id": "VLA-9003", "name": "Priya Nair", "age": 29, "gender": "Female", "blood_group": "A+",
        "allergies": "Penicillin", "existing_conditions": "Iron deficiency anaemia", "risk_score": 22,
        "diagnosis": "Iron deficiency anaemia, recovering",
        "reports": [
            ("Anaemia_Check_Jul_2026.pdf", "2026-07-08", 41, "Low haemoglobin and very low iron stores. Iron treatment started.", ["Low iron stores"],
             [v("Hemoglobin", "g/dL", 8.9, L, "12.0 - 15.5"), v("Ferritin", "ng/mL", 6, L, "15 - 150"), v("TSH", "mIU/L", 2.1, N, "0.4 - 4.0")]),
            ("Anaemia_Check_Sep_2026.pdf", "2026-09-10", 30, "Haemoglobin is improving on iron treatment.", [],
             [v("Hemoglobin", "g/dL", 10.4, L, "12.0 - 15.5"), v("Ferritin", "ng/mL", 14, L, "15 - 150"), v("TSH", "mIU/L", 2.3, N, "0.4 - 4.0")]),
            ("Anaemia_Check_Nov_2026.pdf", "2026-11-05", 18, "Almost back to normal. Iron stores are recovering.", [],
             [v("Hemoglobin", "g/dL", 11.8, L, "12.0 - 15.5"), v("Ferritin", "ng/mL", 38, N, "15 - 150"), v("TSH", "mIU/L", 2.2, N, "0.4 - 4.0")]),
        ],
    },
]


def main():
    home = db.table("vela_hospitals").select("id").eq("name", "VELA Prime Medical").limit(1).execute().data
    hospital_id = home[0]["id"] if home else None
    for p in PATIENTS:
        existing = db.table("patients").select("id").eq("vela_id", p["vela_id"]).execute().data
        if existing:
            print(f"{p['vela_id']} {p['name']}: already there, skipped")
            continue
        row = {k: p[k] for k in ("vela_id", "name", "age", "gender", "blood_group", "allergies", "existing_conditions", "risk_score", "diagnosis")}
        row.update({"hospital_id": hospital_id, "registered_by": "demo_seed", "status": "stable", "language": "English"})
        pid = db.table("patients").insert(row).execute().data[0]["id"]
        for filename, date, risk, summary, flags, values in p["reports"]:
            db.table("documents").insert({
                "patient_id": pid, "filename": filename, "report_date": date, "risk_score": risk,
                "summary": summary, "values": values, "critical_flags": flags,
            }).execute()
        print(f"{p['vela_id']} {p['name']}: added with {len(p['reports'])} reports")


if __name__ == "__main__":
    main()

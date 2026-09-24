import urllib.request
import json
import time

url = "http://localhost:8001/api/voice/query"
session_id = f"test_doc_session_{int(time.time())}"

def make_query(query_text, patient_id=None):
    payload = {
        "query": query_text,
        "patient_id": patient_id,
        "session_id": session_id,
        "user_role": "Doctor"
    }
    
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    
    try:
        with urllib.request.urlopen(req) as response:
            res_body = response.read().decode("utf-8")
            data = json.loads(res_body)
            print(f"\n💬 Query: \"{query_text}\"")
            print(f"🤖 Intent: {data.get('intent')}")
            print(f"🤖 Answer: {data.get('answer')}")
            print("-" * 50)
            return data
    except Exception as e:
        print(f"Error executing query: {e}")
        return None

print("🚀 STARTING ATLAS BATTLE PLAN TESTING SEQUENCE...\n")

# Step 1: Chitchat Greeting
res1 = make_query("Hey Atlas, good morning! Hope you're locked in today.")

# Step 2: Clinical Context Query
res2 = make_query("What was Rajesh Kumar's fasting blood sugar?")
rajesh_patient_id = res2.get("patient_id") if res2 else None

# Step 3: Clinical Pronoun Follow-up Query
res3 = make_query("Wow, is that critical?", patient_id=rajesh_patient_id)

print("\n🎉 TESTING SEQUENCE COMPLETED!")

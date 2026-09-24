from main import supabase, supabase_admin

doctor_id = "f97e9f8d-5c45-4271-99cc-662c2d73107d"

print("🔍 RUNNING NEXT_PATIENT QUERY AUDIT...")

# 1. Query with status = 'waiting' and doctor_id = dr_himanshu
query = supabase_admin.table("tickets").select("*").eq("status", "waiting").eq("doctor_id", doctor_id)
waiting = query.order("queue_position", desc=False).limit(1).execute().data
print(f"Direct Query Result: {waiting}")

# 2. Let's inspect all waiting tickets for this doctor directly
all_waiting = supabase.table("tickets").select("*").eq("doctor_id", doctor_id).eq("status", "waiting").execute().data
print(f"All Waiting count directly: {len(all_waiting)}")

# 3. What if queue_position ordering is causing postgrest to return empty or fail?
query_no_order = supabase_admin.table("tickets").select("*").eq("status", "waiting").eq("doctor_id", doctor_id)
waiting_no_order = query_no_order.limit(1).execute().data
print(f"Query without order: {waiting_no_order}")

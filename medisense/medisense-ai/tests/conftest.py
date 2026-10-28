import os
import sys
import tempfile

# Isolate the local SQLite store (sessions, audit log, lab orders) and keep the
# app importable without touching real services.
_tmp = tempfile.mkdtemp(prefix="vela-tests-")
os.environ["VELA_LOCAL_DB"] = os.path.join(_tmp, "vela_test.db")
os.environ.setdefault("SUPABASE_URL", "http://127.0.0.1:9")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service")
os.environ.setdefault("OPENAI_API_KEY", "test")
os.environ["VELA_AUTH_DISABLED"] = ""
os.environ["DEMO_LOGIN"] = "false"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

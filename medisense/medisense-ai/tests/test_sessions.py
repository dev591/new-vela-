"""Sessions survive restarts, expire, and are revoked on logout."""
import sqlite3
import time

from fastapi.testclient import TestClient

import main

client = TestClient(main.fastapi_app)


def test_token_round_trip_and_hash_only_storage():
    token = main.issue_session_token("patient", "Me", "p-1", vela_id="VLA-1")
    assert main.lookup_session(token)["staff_id"] == "p-1"
    conn = sqlite3.connect(main.LOCAL_DB_PATH)
    stored = [r[0] for r in conn.execute("SELECT token_hash FROM sessions")]
    conn.close()
    assert token not in stored
    assert main._token_hash(token) in stored


def test_expired_token_is_rejected():
    token = main.issue_session_token("doctor", "Dr", "d-1")
    main.local_execute("UPDATE sessions SET expires = ? WHERE token_hash = ?",
                       (time.time() - 1, main._token_hash(token)))
    assert main.lookup_session(token) is None


def test_logout_revokes_token():
    token = main.issue_session_token("patient", "Me", "p-2")
    h = {"Authorization": f"Bearer {token}"}
    assert client.post("/api/auth/logout", headers=h).status_code == 200
    assert main.lookup_session(token) is None
    assert client.get("/api/patients/list", headers=h).status_code == 401


def test_login_routes_are_rate_limited():
    main._rate_hits.clear()
    codes = [client.post("/api/owner/login", json={"email": "x@y.z", "password": "nope"}).status_code
             for _ in range(main.LOGIN_RATE_LIMIT + 2)]
    assert codes[0] == 200
    assert codes[-1] == 429
    main._rate_hits.clear()


def test_owner_login_has_no_hardcoded_fallback():
    main._rate_hits.clear()
    r = client.post("/api/owner/login", json={"email": "dev@vela.ai", "password": "dev1"})
    assert r.json()["status"] == "error"

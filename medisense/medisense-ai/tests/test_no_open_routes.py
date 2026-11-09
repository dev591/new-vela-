"""Every route that is not deliberately public must refuse a request that carries no session.

Static scanners read the route decorators, not the login middleware, so they report routes as "open".
This test calls each route for real, with no token, and fails if anything answers other than 401.
"""
import re

from fastapi.routing import APIRoute
from starlette.testclient import TestClient

import main

# Routes that are open on purpose. Each is explained where it is defined (PUBLIC_API_PATHS in main.py).
DOCS = {"/docs", "/openapi.json", "/redoc", "/docs/oauth2-redirect", "/health"}   # /health is the platform health check


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "x", path)


def test_routes_without_a_session_are_refused():
    client = TestClient(main.fastapi_app, raise_server_exceptions=False)
    answers, open_routes = 0, []
    for route in main.fastapi_app.routes:
        if not isinstance(route, APIRoute) or route.path in main.PUBLIC_API_PATHS or route.path in DOCS:
            continue
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            answers += 1
            status = client.request(method, _concrete(route.path), json={}).status_code
            if status != 401:
                open_routes.append((method, route.path, status))
    assert answers > 100, "the sweep did not find the routes"     # guard against the test silently checking nothing
    assert not open_routes, f"routes that answered without a login: {open_routes}"


def test_the_public_list_is_short_and_known():
    # Adding a public route is a decision: it must show up here in review.
    assert main.PUBLIC_API_PATHS == {
        "/api/network/auth/login", "/api/network/labs/auth/login", "/api/network/doctors/auth/login",
        "/api/staff/login", "/api/manager/login", "/api/owner/login", "/api/patient/login", "/api/health",
        "/api/patient/self-register", "/api/demo/login-patient",
        "/api/frontdesk/transcribe", "/api/frontdesk/checkin", "/api/frontdesk/warm",
    }

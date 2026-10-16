"""ws_origin.py -- Origin allowlist shared by bridge.py, mock_vehicles.py and
tak_bridge.py (stdlib only).

A WebSocket handshake is not covered by the browser's same-origin policy: any
page the operator has open could otherwise connect to ws://localhost:8765 and
arm, steer or land the fleet (Cross-Site WebSocket Hijacking). Browsers always
send an Origin header on a WebSocket handshake, so each server rejects a
handshake whose Origin is not one of the sim's own:

- http(s) on localhost / 127.0.0.1 / [::1], any port (`python -m http.server`);
- "null", what a page opened from file:// sends;
- the GitHub Pages live demo, https://dalailalama.github.io;
- anything added with --allow-origin (repeatable; "*" disables the check).

A handshake with no Origin header at all is a non-browser client (a Python
test or tool) and is allowed: no web page can omit the header.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Iterable, Optional
from urllib.parse import urlsplit

DEFAULT_ALLOWED_ORIGINS = ("null", "https://dalailalama.github.io")
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")


def origin_allowed(origin: Optional[str], extra: Iterable[str] = ()) -> bool:
    """True when a handshake carrying this Origin header may connect."""
    if origin is None:
        return True
    extra = tuple(extra)
    if "*" in extra:
        return True
    origin = origin.strip()
    if origin in DEFAULT_ALLOWED_ORIGINS or origin in extra:
        return True
    try:
        parts = urlsplit(origin)
        host = parts.hostname
        parts.port  # raises ValueError on a malformed port
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and host in LOOPBACK_HOSTS


def make_origin_check(extra: Iterable[str] = (), log=None):
    """process_request hook for websockets.asyncio.server.serve: answers a
    foreign Origin with HTTP 403 before any handler (or vehicle task) runs."""
    extra = tuple(extra)

    def process_request(connection, request):
        origin = request.headers.get("Origin")
        if origin_allowed(origin, extra):
            return None
        if log is not None:
            log(f"rejected WebSocket handshake from Origin {origin!r} (see --allow-origin)")
        return connection.respond(HTTPStatus.FORBIDDEN, "Origin not allowed\n")

    return process_request


def add_origin_argument(parser) -> None:
    parser.add_argument(
        "--allow-origin",
        action="append",
        default=[],
        metavar="ORIGIN",
        help=(
            "Extra web Origin allowed to connect, e.g. https://example.org (repeatable; "
            "'*' allows any). Loopback http(s) origins, file:// ('null') and "
            "https://dalailalama.github.io are always allowed."
        ),
    )

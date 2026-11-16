"""ws_origin.py -- WebSocket handshake gate (Origin allowlist, optional shared
token) shared by bridge.py, mock_vehicles.py and tak_bridge.py (stdlib only).

A WebSocket handshake is not covered by the browser's same-origin policy: any
page the operator has open could otherwise connect to ws://localhost:8765 and
arm, steer or land the fleet (Cross-Site WebSocket Hijacking). Browsers always
send an Origin header on a WebSocket handshake, so each server rejects a
handshake whose Origin is not one of the sim's own:

- http(s) on localhost / 127.0.0.1 / [::1], any port (`python -m http.server`);
- "null", what a page opened from file:// sends (a sandboxed iframe on any
  site sends it too, so use --token if other pages in that browser are
  untrusted);
- the GitHub Pages live demo, https://dalailalama.github.io;
- anything added with --allow-origin (repeatable; "*" disables the check).

A handshake with no Origin header at all is a non-browser client (a Python
test or tool) and is allowed: no web page can omit the header.

The Origin check cannot stop a non-browser client, which can send any Origin
(or none). On a non-loopback bind every host on the network is such a
client, so each server can also require a shared secret: with --token (or
$BRIDGE_TOKEN) a handshake must carry ?token=<secret> in its URL, e.g.
ws://host:8765/?token=..., typed straight into the sim's Bridge URL field,
or it gets HTTP 401. A server bound beyond loopback without a token makes
one up and prints it. ws:// is plaintext either way: beyond a trusted LAN,
tunnel it (SSH, VPN) or put a TLS (wss://) proxy in front.
"""

from __future__ import annotations

import hmac
import ipaddress
import os
import secrets
from http import HTTPStatus
from typing import Iterable, Optional
from urllib.parse import unquote, unquote_plus, urlsplit

DEFAULT_ALLOWED_ORIGINS = ("null", "https://dalailalama.github.io")
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")
TOKEN_ENV = "BRIDGE_TOKEN"


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


def token_matches(path: str, token: str) -> bool:
    """True when the request target's ?token= equals the shared secret
    (constant-time compare).

    A browser sends a typed ?token=a+b as is, so a '+' may be the secret's
    own (base64 secrets carry it) as well as a form-encoded space: the value
    matches under either decoding.
    """
    try:
        query = urlsplit(path or "").query
    except ValueError:
        return False
    given = [""]
    for part in query.split("&"):
        name, _, value = part.partition("=")
        if unquote_plus(name) == "token":
            given = {unquote(value), unquote_plus(value)}
            break
    return any(hmac.compare_digest(g.encode("utf-8"), token.encode("utf-8")) for g in given)


def make_origin_check(extra: Iterable[str] = (), log=None, token: Optional[str] = None):
    """process_request hook for websockets.asyncio.server.serve: answers a
    foreign Origin with HTTP 403, and (when `token` is set) a missing or wrong
    ?token= with HTTP 401, before any handler (or vehicle task) runs."""
    extra = tuple(extra)

    def process_request(connection, request):
        origin = request.headers.get("Origin")
        if not origin_allowed(origin, extra):
            if log is not None:
                log(f"rejected WebSocket handshake from Origin {origin!r} (see --allow-origin)")
            return connection.respond(HTTPStatus.FORBIDDEN, "Origin not allowed\n")
        if token is not None and not token_matches(getattr(request, "path", ""), token):
            if log is not None:
                log("rejected WebSocket handshake without the right ?token= (see --token)")
            return connection.respond(HTTPStatus.UNAUTHORIZED, "missing or wrong token\n")
        return None

    return process_request


def is_loopback(host: Optional[str]) -> bool:
    if host in LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host or "").is_loopback
    except ValueError:
        return False


def resolve_token(token: Optional[str], host: Optional[str], announce) -> Optional[str]:
    """The secret every handshake must carry, or None for none.

    --token wins, then $BRIDGE_TOKEN. A server bound beyond loopback with
    neither gets a generated one: there the Origin check alone stops nothing.
    """
    token = token or os.environ.get(TOKEN_ENV) or None
    if token is None and not is_loopback(host):
        token = secrets.token_urlsafe(16)
        announce(f"bound to {host or 'all interfaces'} without --token: generated one")
    if token is not None:
        announce(f"clients must connect with ?token={token} in the URL, e.g. ws://<host>:<port>/?token={token}")
    return token


def add_origin_argument(parser) -> None:
    """Adds --allow-origin and --token."""
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
    parser.add_argument(
        "--token",
        default=None,
        metavar="SECRET",
        help=(
            f"Shared secret every client must send as ?token=SECRET in its URL (default: ${TOKEN_ENV}; "
            "a non-loopback bind without one generates and prints one)"
        ),
    )

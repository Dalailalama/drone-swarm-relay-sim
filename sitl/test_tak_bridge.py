"""test_tak_bridge.py - tak_bridge.py end to end on loopback.

Starts the real bridge (asyncio websockets API) on free ports with the CoT
"group" pointed at a local UDP socket, then checks that:
1. a CoT <event> line is forwarded as exactly one datagram and a non-event
   line is dropped;
2. a handshake from a foreign web Origin is refused with 403 (CSWSH), while
   the sim's own origin connects;
3. only a well-formed, bounded CoT <event> with uid and type reaches the
   network: junk containing "<event", oversized or DOCTYPE atoms are
   dropped, a send error does not end the session, and the defaults are a
   loopback bind and multicast TTL 1.
"""

from __future__ import annotations

import asyncio
import os
import socket
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import tak_bridge
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus


def free_port(kind=socket.SOCK_STREAM) -> int:
    with socket.socket(socket.AF_INET, kind) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


async def with_bridge(body, extra_args=(), ready_path="") -> None:
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(("127.0.0.1", 0))
    udp.setblocking(False)
    ws_port = free_port()
    argv = sys.argv
    sys.argv = ["tak_bridge.py", "--ws-host", "127.0.0.1", "--ws-port", str(ws_port),
                "--group", "127.0.0.1", "--port", str(udp.getsockname()[1]), "--ttl", "1", *extra_args]
    server = asyncio.create_task(tak_bridge.main())
    uri = f"ws://127.0.0.1:{ws_port}"
    try:
        for _ in range(200):
            try:
                async with connect(uri + ready_path):
                    break
            except OSError:
                await asyncio.sleep(0.01)
        await body(uri, udp)
    finally:
        sys.argv = argv
        server.cancel()
        try:
            await server
        except (asyncio.CancelledError, Exception):
            pass
        udp.close()


async def test_event_lines_forwarded() -> None:
    async def body(uri, udp):
        async with connect(uri, origin="http://localhost:8000") as ws:
            await ws.send('<event version="2.0" uid="DR-1" type="a-f-A"/>\nnot an atom')
            await asyncio.sleep(0.2)
        got = []
        while True:
            try:
                got.append(udp.recv(65536))
            except BlockingIOError:
                break
        assert got == [b'<event version="2.0" uid="DR-1" type="a-f-A"/>'], got

    await with_bridge(body)


async def test_foreign_origin_rejected() -> None:
    async def body(uri, udp):
        try:
            async with connect(uri, origin="https://evil.example"):
                raise AssertionError("a foreign origin was accepted")
        except InvalidStatus as e:
            assert e.response.status_code == 403, e

    await with_bridge(body)


async def test_token_required() -> None:
    async def body(uri, udp):
        for path in ("", "/?token=wrong"):
            try:
                async with connect(uri + path, origin="http://localhost:8000"):
                    raise AssertionError(f"handshake {path!r} without the token was accepted")
            except InvalidStatus as e:
                assert e.response.status_code == 401, e
        async with connect(uri + "/?token=s3cret", origin="http://localhost:8000") as ws:
            await ws.send('<event version="2.0" uid="DR-1" type="a-f-A"/>')
            await asyncio.sleep(0.2)
        assert udp.recv(65536) == b'<event version="2.0" uid="DR-1" type="a-f-A"/>'

    await with_bridge(body, ("--token", "s3cret"), "/?token=s3cret")


ATOM = ('<event version="2.0" uid="DR-1" type="a-f-A-M-H-Q" time="t" start="t" stale="t" how="m-s">'
        '<point lat="1.0" lon="2.0" hae="3.0" ce="15" le="15"/><detail><contact callsign="DR-1"/></detail></event>')


async def test_only_valid_atoms_forwarded() -> None:
    bad = [
        "junk <event this is not xml",
        "rm -rf / ; <event",
        '<event version="2.0" uid="DR-1" type="a-f-A">',                  # not closed
        '<event version="2.0" type="a-f-A"/>',                              # no uid
        '<!DOCTYPE event [<!ENTITY x "y">]><event uid="a" type="b">&x;</event>',
        '<event uid="DR-1" type="a-f-A"><detail remarks="' + "x" * 20000 + '"/></event>',
    ]

    async def body(uri, udp):
        async with connect(uri, origin="http://localhost:8000") as ws:
            await ws.send("\n".join(bad + [ATOM]))
            await asyncio.sleep(0.2)
        got = []
        while True:
            try:
                got.append(udp.recv(65536))
            except BlockingIOError:
                break
        assert got == [ATOM.encode()], got

    await with_bridge(body)
    assert tak_bridge.is_valid_atom(ATOM)
    assert not any(tak_bridge.is_valid_atom(line) for line in bad)


async def test_send_error_keeps_session() -> None:
    class FailingUdp:
        def __init__(self):
            self.sent = []

        def sendto(self, payload, addr):
            if not self.sent:
                self.sent.append(None)
                raise OSError("message too long")
            self.sent.append(payload)

    class Ws:
        remote_address = ("test", 0)

        async def __aiter__(self):
            yield ATOM + "\n" + ATOM

    udp = FailingUdp()
    await tak_bridge.handle_client(Ws(), udp, [("127.0.0.1", 9)])
    assert udp.sent == [None, ATOM.encode()], udp.sent


async def test_safe_defaults_and_frame_cap() -> None:
    args = tak_bridge.parse_args([])
    assert args.ws_host == "localhost" and args.ttl == 1, (args.ws_host, args.ttl)

    async def body(uri, udp):
        async with connect(uri, origin="http://localhost:8000", max_size=None) as ws:
            await ws.send("x" * (tak_bridge.MAX_FRAME_BYTES + 1))
            await ws.wait_closed()
            assert ws.close_code == 1009, ws.close_code

    await with_bridge(body)


SCENARIOS = [
    ("TAK bridge: only well-formed, bounded CoT <event> atoms are forwarded", test_only_valid_atoms_forwarded),
    ("TAK bridge: a failed datagram send does not end the session", test_send_error_keeps_session),
    ("TAK bridge: loopback bind, TTL 1 and a frame size cap by default", test_safe_defaults_and_frame_cap),
    ("TAK bridge: <event> lines forwarded once, other lines dropped", test_event_lines_forwarded),
    ("TAK bridge: foreign web Origin rejected at the handshake", test_foreign_origin_rejected),
    ("TAK bridge: --token required at the handshake", test_token_required),
]


def main() -> int:
    failures = 0
    for name, scenario in SCENARIOS:
        try:
            asyncio.run(scenario())
        except Exception:
            failures += 1
            print(f"FAIL  {name}")
            traceback.print_exc()
        else:
            print(f"PASS  {name}")
    total = len(SCENARIOS)
    print(f"\n{total - failures}/{total} TAK bridge scenarios passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

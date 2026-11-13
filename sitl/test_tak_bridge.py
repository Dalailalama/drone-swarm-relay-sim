"""test_tak_bridge.py - tak_bridge.py end to end on loopback.

Starts the real bridge (asyncio websockets API) on free ports with the CoT
"group" pointed at a local UDP socket, then checks that:
1. a CoT <event> line is forwarded as exactly one datagram and a non-event
   line is dropped;
2. a handshake from a foreign web Origin is refused with 403 (CSWSH), while
   the sim's own origin connects.
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


async def with_bridge(body) -> None:
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(("127.0.0.1", 0))
    udp.setblocking(False)
    ws_port = free_port()
    argv = sys.argv
    sys.argv = ["tak_bridge.py", "--ws-host", "127.0.0.1", "--ws-port", str(ws_port),
                "--group", "127.0.0.1", "--port", str(udp.getsockname()[1]), "--ttl", "1"]
    server = asyncio.create_task(tak_bridge.main())
    uri = f"ws://127.0.0.1:{ws_port}"
    try:
        for _ in range(200):
            try:
                async with connect(uri):
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


SCENARIOS = [
    ("TAK bridge: <event> lines forwarded once, other lines dropped", test_event_lines_forwarded),
    ("TAK bridge: foreign web Origin rejected at the handshake", test_foreign_origin_rejected),
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

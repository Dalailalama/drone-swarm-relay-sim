#!/usr/bin/env python3
"""tak_bridge.py -- browser swarm sim  ->  real ATAK clients.

Receives Cursor-on-Target XML atoms over a WebSocket from the browser sim
(js/tak.js live feed) and re-transmits each atom as a UDP datagram onto the
TAK multicast group every ATAK client listens on by default:

    browser sim  <--WebSocket (CoT XML lines)-->  tak_bridge.py  <--UDP multicast-->  ATAK

Usage:
    python tak_bridge.py [--ws-port 8087] [--group 239.2.3.1] [--port 6969]
                         [--ttl 3] [--unicast HOST:PORT ...]

Only dependency: `websockets` (already in requirements.txt for bridge.py).
ATAK side: add the multicast stream, or point a TAK Client / FOG server at
the same group; nothing to configure on their end beyond the standard CoT
port.
"""

import argparse
import asyncio
import socket

from websockets.server import serve

# TAK's conventional CoT multicast: everyone who matters already listens here.
DEFAULT_GROUP = "239.2.3.1"
DEFAULT_PORT = 6969


def make_udp_sock(ttl: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, ttl)
    return sock


async def handle_client(ws, udp: socket.socket, targets):
    peer = getattr(ws, "remote_address", None) or ("?", "?")
    print(f"[tak_bridge] sim connected from {peer}")
    forwarded = 0
    try:
        async for message in ws:
            # One WS frame may carry one atom or several newline-separated atoms.
            for line in str(message).splitlines():
                line = line.strip()
                if not line or "<event" not in line:
                    continue
                payload = line.encode("utf-8")
                for host, port in targets:
                    udp.sendto(payload, (host, port))
                forwarded += 1
                if forwarded % 100 == 0:
                    print(f"[tak_bridge] forwarded {forwarded} atoms")
    finally:
        print(f"[tak_bridge] sim disconnected ({forwarded} atoms forwarded total)")


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ws-port", type=int, default=8087, help="WebSocket port for the browser sim (default 8087)")
    ap.add_argument("--group", default=DEFAULT_GROUP, help=f"TAK multicast group (default {DEFAULT_GROUP})")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"CoT UDP port (default {DEFAULT_PORT})")
    ap.add_argument("--ttl", type=int, default=3, help="multicast TTL: 1 = same subnet only (default 3)")
    ap.add_argument("--unicast", action="append", default=[], metavar="HOST:PORT",
                    help="also send unicast to HOST:PORT (repeatable); e.g. a FOG server relay")
    args = ap.parse_args()

    targets = [(args.group, args.port)]
    for u in args.unicast:
        host, _, port = u.rpartition(":")
        if host and port.isdigit():
            targets.append((host, int(port)))

    udp = make_udp_sock(args.ttl)
    mode = ", ".join(f"{h}:{p}" for h, p in targets)

    async def handler(ws):
        await handle_client(ws, udp, targets)

    async with serve(handler, "0.0.0.0", args.ws_port):
        print(f"[tak_bridge] WebSocket on :{args.ws_port} -> CoT UDP -> {mode} (ttl {args.ttl})")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

"""mock_vehicles.py - no-firmware stand-in for the real MAVLink bridge.

This server speaks exactly the same browser-facing WebSocket protocol as
bridge.py (see the "goals"/"telemetry"/"status"/"ready" messages below), but
instead of talking to ArduPilot/PX4 SITL over MAVLink it simulates a handful
of simple point-mass vehicles in pure Python.

Why this exists: it lets you verify the *entire* pipeline -- browser sim ->
WebSocket JSON protocol -> "vehicle" position feedback -> browser sim again
-- without ever installing ArduPilot, running SITL, or having pymavlink
available. If the swarm behaves correctly against this mock, the only thing
left to validate on the real path is the MAVLink plumbing in bridge.py
itself.

Coordinate frame (matches bridge.py and the browser sim exactly):
    x = metres East, y = metres South (screen-down positive), alt = metres
    above ground. This module never touches MAVLink/NED at all -- it only
    ever works in this "sim" frame.

Usage:
    python mock_vehicles.py [--host localhost] [--port 8765]

Dependency: `websockets` only (no MAVLink, no pymavlink).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
from dataclasses import dataclass, field

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("mock_vehicles")

# --- simulated flight-dynamics constants -----------------------------------
PHYSICS_HZ = 20.0
PHYSICS_DT = 1.0 / PHYSICS_HZ
TELEMETRY_HZ = 10.0
TELEMETRY_DT = 1.0 / TELEMETRY_HZ

MAX_XY_SPEED = 14.0  # m/s, roughly a small multirotor's max horizontal speed
XY_ACCEL = 4.0  # m/s^2, how fast velocity is allowed to change per tick
ALT_RATE = 3.0  # m/s, vertical ease-toward-goal rate (climb/descend)


@dataclass
class Vehicle:
    """Simple point-mass model of one multirotor in GUIDED-like mode."""

    id: str
    x: float = 0.0
    y: float = 0.0
    alt: float = 0.0
    vx: float = 0.0
    vy: float = 0.0
    goal_x: float = 0.0
    goal_y: float = 0.0
    goal_alt: float = 0.0

    def step(self, dt: float) -> None:
        """Advance the vehicle one physics tick toward its current goal."""
        # --- horizontal motion: accelerate current velocity toward the
        # velocity that would carry us straight at the goal at max speed,
        # clamped by the vehicle's max acceleration. This gives a simple
        # but non-instantaneous, non-teleporting approach to the goal that
        # feels roughly like a multirotor's position controller.
        dx = self.goal_x - self.x
        dy = self.goal_y - self.y
        dist = (dx * dx + dy * dy) ** 0.5

        if dist > 1e-6:
            desired_vx = dx / dist * MAX_XY_SPEED
            desired_vy = dy / dist * MAX_XY_SPEED
        else:
            desired_vx = 0.0
            desired_vy = 0.0

        dvx = desired_vx - self.vx
        dvy = desired_vy - self.vy
        dv_mag = (dvx * dvx + dvy * dvy) ** 0.5
        max_dv = XY_ACCEL * dt
        if dv_mag > max_dv and dv_mag > 1e-9:
            scale = max_dv / dv_mag
            dvx *= scale
            dvy *= scale
        self.vx += dvx
        self.vy += dvy

        # Avoid overshooting/oscillating around the goal: if this tick's
        # displacement would carry us past the goal, just snap to it and
        # stop, rather than integrating straight through and bouncing back.
        step_dist = ((self.vx * dt) ** 2 + (self.vy * dt) ** 2) ** 0.5
        if step_dist >= dist:
            self.x = self.goal_x
            self.y = self.goal_y
            self.vx = 0.0
            self.vy = 0.0
        else:
            self.x += self.vx * dt
            self.y += self.vy * dt

        # --- vertical motion: simple ease-toward-goal at a fixed rate
        # (no acceleration clamp needed here -- climb/descend rate on a
        # real multirotor is already close to a fixed commanded rate).
        alt_diff = self.goal_alt - self.alt
        alt_step = ALT_RATE * dt
        if abs(alt_diff) <= alt_step:
            self.alt = self.goal_alt
        else:
            self.alt += alt_step if alt_diff > 0 else -alt_step

    def set_goal(self, x: float, y: float, alt: float) -> None:
        self.goal_x = x
        self.goal_y = y
        self.goal_alt = alt

    def to_telemetry(self) -> dict:
        return {
            "id": self.id,
            "x": self.x,
            "y": self.y,
            "alt": self.alt,
            "connected": True,
        }


@dataclass
class World:
    """Holds all vehicle state and the connected browser clients.

    This is deliberately module-global-ish state (one World per process):
    vehicle state survives a browser disconnect/reconnect, and only gets
    reset when a fresh "init" message arrives (from any client).
    """

    vehicles: dict[str, Vehicle] = field(default_factory=dict)
    clients: set = field(default_factory=set)
    sim_time: float = 0.0  # seconds, advanced by the physics task's own dt

    def reset(self, count: int, alt: float) -> list[str]:
        """Handle an "init": (re)create N vehicles at the origin."""
        self.vehicles = {}
        ids = []
        for i in range(1, count + 1):
            vid = f"DR-{i}"
            ids.append(vid)
            v = Vehicle(id=vid, x=0.0, y=0.0, alt=0.0)
            # Start climbing immediately: goal x/y stays at the origin,
            # goal alt is the requested cruise altitude.
            v.set_goal(0.0, 0.0, alt)
            self.vehicles[vid] = v
        return ids

    def apply_goals(self, goals: list[dict]) -> None:
        for g in goals:
            vid = g.get("id")
            v = self.vehicles.get(vid)
            if v is None:
                continue  # unknown id: ignore, per protocol
            try:
                v.set_goal(float(g["x"]), float(g["y"]), float(g["alt"]))
            except (KeyError, TypeError, ValueError):
                continue  # malformed goal entry: ignore gracefully

    def physics_tick(self, dt: float) -> None:
        for v in self.vehicles.values():
            v.step(dt)
        self.sim_time += dt

    def telemetry_message(self) -> str:
        return json.dumps(
            {
                "type": "telemetry",
                "t": self.sim_time,
                "vehicles": [v.to_telemetry() for v in self.vehicles.values()],
            }
        )


WORLD = World()


async def physics_loop() -> None:
    """Background task: advance vehicle dynamics at PHYSICS_HZ forever."""
    while True:
        await asyncio.sleep(PHYSICS_DT)
        WORLD.physics_tick(PHYSICS_DT)


async def telemetry_loop() -> None:
    """Background task: broadcast telemetry to all connected clients at TELEMETRY_HZ."""
    while True:
        await asyncio.sleep(TELEMETRY_DT)
        if not WORLD.clients or not WORLD.vehicles:
            continue
        message = WORLD.telemetry_message()
        # broadcast() fans a single message out to every open connection,
        # dropping any that error out (e.g. mid-close) without raising.
        from websockets.asyncio.server import broadcast

        broadcast(WORLD.clients, message)


async def send_status(websocket, msg: str) -> None:
    log.info("status: %s", msg)
    try:
        await websocket.send(json.dumps({"type": "status", "msg": msg}))
    except ConnectionClosed:
        pass


async def handle_message(websocket, raw: str) -> None:
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("ignoring non-JSON message: %r", raw[:200])
        return

    mtype = msg.get("type")

    if mtype == "init":
        count = int(msg.get("count", 0))
        alt = float(msg.get("alt", 50))
        ids = WORLD.reset(count, alt)
        await websocket.send(json.dumps({"type": "ready", "ids": ids}))
        await send_status(websocket, f"mock: {count} vehicles armed, climbing to {alt} m")

    elif mtype == "goals":
        WORLD.apply_goals(msg.get("goals", []))

    else:
        # Unknown message type: ignore gracefully, per protocol.
        log.debug("ignoring unknown message type: %r", mtype)


async def handler(websocket) -> None:
    """WebSocket connection handler (one browser client per connection)."""
    peer = getattr(websocket, "remote_address", None)
    log.info("client connected: %s", peer)
    WORLD.clients.add(websocket)
    try:
        async for raw in websocket:
            await handle_message(websocket, raw)
    except ConnectionClosed:
        pass
    finally:
        WORLD.clients.discard(websocket)
        log.info("client disconnected: %s", peer)
        # Note: vehicle state in WORLD is intentionally left untouched here
        # so a reconnecting browser can resume mid-flight; only a fresh
        # "init" message resets vehicle state.


async def run(host: str, port: int) -> None:
    physics_task = asyncio.create_task(physics_loop())
    telem_task = asyncio.create_task(telemetry_loop())
    try:
        async with serve(handler, host, port) as server:
            log.info("mock vehicle server listening on ws://%s:%s", host, port)
            await asyncio.get_running_loop().create_future()  # run forever
    finally:
        physics_task.cancel()
        telem_task.cancel()
        for t in (physics_task, telem_task):
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Mock vehicle server: simulates simple point-mass drones over the "
            "same WebSocket protocol bridge.py uses for real MAVLink/ArduPilot "
            "vehicles. No MAVLink or firmware required -- useful for testing "
            "the browser swarm sim end-to-end."
        )
    )
    parser.add_argument("--host", default="localhost", help="WebSocket host to bind (default: localhost)")
    parser.add_argument("--port", type=int, default=8765, help="WebSocket port to bind (default: 8765)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        asyncio.run(run(args.host, args.port))
    except KeyboardInterrupt:
        log.info("shutting down (Ctrl+C)")


if __name__ == "__main__":
    main()

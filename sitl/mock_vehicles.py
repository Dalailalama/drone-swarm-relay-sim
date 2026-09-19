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

Init/lifecycle protocol (mirrors bridge.py finding #12/#13 semantics):
    "init" is honoured as an EXPLICIT request: it returns per-vehicle
    entries [{id, ready, state}] where a vehicle is `ready` only after a
    simulated GUIDED/arm/takeoff-climb sequence is confirmed, and any
    vehicle that cannot be armed stays listed with ready:false and state
    "failed:<step>" while its task keeps retrying in the background.

Service protocol (bridge.py "service" message): the only way a vehicle
descends, swaps and relaunches is the explicit browser-driven handshake
    land -> (bridge confirms landed: disarmed + EXTENDED_SYS_STATE landed)
         -> authorize (swap starts) -> complete (swap done)
         -> relaunch (fresh init steps: mode/arm/takeoff re-confirmed)
A vehicle is never rearmed or relaunched outside this handshake.

Usage:
    python mock_vehicles.py [--host localhost] [--port 8765]

Dependency: `websockets` only (no MAVLink, no pymavlink).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Optional

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

# --- init state-machine timing ---
INIT_STEP_TIMEOUT_S = 10.0
STEP_RESEND_DT = 2.0
TAKEOFF_CONFIRM_ALT_M = 1.0
POSITION_STALE_S = 3.0
HEARTBEAT_STALE_S = 3.0

# States are the same protocol strings bridge.py emits.
INIT_WAIT_HEARTBEAT = "wait-heartbeat"
INIT_CONFIRM_MODE = "confirm-mode"
INIT_CONFIRM_ARM = "confirm-arm"
INIT_CONFIRM_TAKEOFF = "confirm-takeoff"
INIT_READY = "ready"
INIT_CONFIRM_ABORT = "confirm-abort"
INIT_ABORT_HOLD = "abort-hold"
FAILED_PREFIX = "failed:"

MAV_CMD_NAV_LAND = 21


def _now() -> float:
    return time.monotonic()


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
    launch_alt: float = 0.0
    takeoff_alt: float = 0.0
    takeoff_climb_m: float = 0.0
    hold_x: Optional[float] = None
    hold_y: Optional[float] = None
    hold_alt: Optional[float] = None
    target_ground_alt: float = 0.0
    origin: dict = field(default_factory=lambda: {"frame": "common-local-origin", "x": 0.0, "y": 0.0, "groundM": 0.0})

    # --- link/bookkeeping state ---
    last_heartbeat: Optional[float] = None
    armed: bool = False
    custom_mode: int = 0
    guided_mode_id: int = 4
    landed: bool = False
    landed_state: Optional[bool] = None
    last_landed: Optional[float] = None
    landed_seq: int = 0
    position_seq: int = 0
    last_position: Optional[float] = None
    init_state: str = INIT_WAIT_HEARTBEAT
    ready: bool = False
    step_started_at: float = 0.0
    step_sent_at: float = 0.0
    failed_at: Optional[float] = None
    service_phase: Optional[str] = None
    service_id: Optional[str] = None
    service_started: float = 0.0
    service_position_seq: int = 0
    service_landed_seq: int = 0
    service_history: set = field(default_factory=set)
    service_action_history: dict = field(default_factory=dict)
    descent_ref_alt: float = 0.0
    last_descent_at: float = 0.0
    climb_ref_alt: float = 0.0

    # --- link/telemetry truth ---
    @property
    def mode_confirmed(self) -> bool:
        return self.custom_mode == self.guided_mode_id

    @property
    def connected(self) -> bool:
        return self.last_heartbeat is not None and (_now() - self.last_heartbeat) < HEARTBEAT_STALE_S

    @property
    def position_age(self) -> Optional[float]:
        return None if self.last_position is None else _now() - self.last_position

    @property
    def position_fresh(self) -> bool:
        age = self.position_age
        return age is not None and 0 <= age < POSITION_STALE_S

    @property
    def landed_age(self) -> Optional[float]:
        return None if self.last_landed is None else _now() - self.last_landed

    @property
    def grounded(self) -> bool:
        return (self.connected and not self.armed and self.position_fresh
                and self.landed is True and self.landed_age is not None
                and 0 <= self.landed_age < POSITION_STALE_S)

    @property
    def service_grounded(self) -> bool:
        return (self.grounded and self.last_heartbeat > self.service_started
                and self.position_seq > self.service_position_seq
                and self.landed_seq > self.service_landed_seq)

    @property
    def airborne(self) -> bool:
        return self.position_fresh and self.alt > self.launch_alt + TAKEOFF_CONFIRM_ALT_M

    def to_telemetry(self) -> dict:
        return {
            "id": self.id,
            "x": self.x,
            "y": self.y,
            "alt": self.alt,
            "connected": self.connected,
            "ready": self.ready,
            "state": self.init_state,
            "armed": self.armed,
            "heartbeatAge": None if self.last_heartbeat is None else _now() - self.last_heartbeat,
            "positionAge": self.position_age,
            "positionSeq": self.position_seq,
            "landed": self.landed,
            "landedAge": self.landed_age,
            "landedSeq": self.landed_seq,
            "serviceId": self.service_id,
            "servicePhase": self.service_phase,
            "origin": self.origin,
        }

    def to_ready_entry(self) -> dict:
        return {"id": self.id, "ready": self.ready, "state": self.init_state}

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

    # --- init state machine ---
    def _enter_step(self, state: str, now: float) -> None:
        self.init_state = state
        self.step_started_at = now
        self.step_sent_at = now
        self.failed_at = None
        self.climb_ref_alt = self.alt

    def _become_ready(self, now: float) -> None:
        self.init_state = INIT_READY
        self.ready = True
        self.failed_at = None
        log.info("vehicle %s: airborne at %.1f m - READY", self.id, self.alt)

    def _fail(self, step: str, now: float) -> None:
        self.init_state = FAILED_PREFIX + step
        self.ready = False
        self.failed_at = now

    def advance_init(self, now: float) -> None:
        """One tick of the per-vehicle init state machine."""
        if self.init_state in (INIT_READY, INIT_ABORT_HOLD, "aborted") or (self.service_phase == "aborted" and self.init_state != INIT_CONFIRM_ABORT):
            return
        if self.init_state == INIT_CONFIRM_ABORT:
            elapsed = now - self.step_started_at
            if self.connected and self.mode_confirmed and self.position_fresh:
                self.hold_x = self.x
                self.hold_y = self.y
                self.hold_alt = self.alt
                self.goal_x = self.x
                self.goal_y = self.y
                self.goal_alt = self.alt
                self.init_state = INIT_ABORT_HOLD
                return
            elif elapsed >= INIT_STEP_TIMEOUT_S:
                self._fail("abort", now)
                self.service_phase = "failed"
                return
            elif (not self.connected or not self.mode_confirmed) and now - self.step_sent_at >= STEP_RESEND_DT:
                self.step_sent_at = now
            return
        if self.service_phase is not None:
            if self.service_phase == "landing":
                if self.service_grounded:
                    self.init_state = "landed"
                    self.service_phase = "landed"
                    self.failed_at = None
                    return
                if self.alt <= self.descent_ref_alt - 0.5:
                    self.descent_ref_alt = self.alt
                    self.last_descent_at = now
                if now - self.last_descent_at >= INIT_STEP_TIMEOUT_S:
                    self._fail("land", now)
                    self.service_phase = "failed"
                return
            elif self.service_phase in ("landed", "swapping", "swapped"):
                pass
            elif self.service_phase == "failed":
                if self.service_grounded:
                    self.init_state = "landed"
                    self.service_phase = "landed"
                    self.failed_at = None
                return
            elif self.service_phase == "relaunch":
                if self.mode_confirmed and self.armed and self.airborne and self.alt >= self.takeoff_alt - TAKEOFF_CONFIRM_ALT_M:
                    self._become_ready(now)
                    self.service_phase = None
                else:
                    if self.alt >= self.climb_ref_alt + 0.5:
                        self.climb_ref_alt = self.alt
                        self.step_started_at = now
                    if now - self.step_started_at >= INIT_STEP_TIMEOUT_S:
                        self._fail("relaunch", now)
                        self.service_phase = "failed"
            return
        if self.init_state.startswith(FAILED_PREFIX):
            if not self.connected:
                return
            if self.service_phase in ("failed", "aborted") or self.init_state == FAILED_PREFIX + "abort":
                return
            cooldown = 0.0 if self.init_state == FAILED_PREFIX + "no-heartbeat" else 5.0
            if self.failed_at is not None and (now - self.failed_at) < cooldown:
                return
            if not self.mode_confirmed:
                self.custom_mode = self.guided_mode_id
            if not self.armed:
                self.service_phase = None
                self._enter_step(INIT_CONFIRM_ARM, now)
                self.armed = True
            elif not self.airborne:
                self.service_phase = None
                self.launch_alt = self.alt
                self._enter_step(INIT_CONFIRM_TAKEOFF, now)
                self.goal_alt = self.takeoff_alt
            else:
                self._become_ready(now)
            return
        if self.init_state == INIT_WAIT_HEARTBEAT:
            self.last_heartbeat = now
            self._enter_step(INIT_CONFIRM_MODE, now)
            return
        if self.init_state == INIT_CONFIRM_MODE:
            self.custom_mode = self.guided_mode_id
            self.armed = True
            self.launch_alt = self.alt
            self._enter_step(INIT_CONFIRM_TAKEOFF, now)
            self.goal_alt = self.takeoff_alt
            return
        if self.init_state == INIT_CONFIRM_TAKEOFF:
            if self.airborne and self.alt >= self.takeoff_alt - TAKEOFF_CONFIRM_ALT_M:
                self._become_ready(now)
            else:
                if self.alt >= self.climb_ref_alt + 0.5:
                    self.climb_ref_alt = self.alt
                    self.step_started_at = now
                if now - self.step_started_at >= INIT_STEP_TIMEOUT_S:
                    self._fail("takeoff", now)
            return

    def service(self, request_id: str, action: str, msg: dict) -> tuple[bool, Optional[str], Optional[str], bool]:
        """Explicit browser-driven lifecycle handshake; returns (accepted, error, code, retryable)."""
        if action == "land":
            if self.service_phase not in (None, "complete"):
                if self.service_id == request_id and self.service_phase == "landing":
                    return True, None, None, False
                return False, f"service busy in phase {self.service_phase}", "SERVICE_BUSY", True
            if not (self.ready and self.init_state == INIT_READY and self.connected
                    and self.position_fresh and self.armed):
                return False, "vehicle not ready to land", "VEHICLE_NOT_READY", True
            self.service_history.add(request_id)
            self.service_id = request_id
            self.service_phase = "landing"
            self.service_started = _now()
            self.service_position_seq = self.position_seq
            self.service_landed_seq = self.landed_seq
            self.descent_ref_alt = self.alt
            self.last_descent_at = _now()
            self.init_state = "landing"
            self.ready = False
            self.goal_x = self.x
            self.goal_y = self.y
            try:
                ground = float(msg.get("groundAlt", 0.0))
            except (TypeError, ValueError):
                ground = 0.0
            self.target_ground_alt = ground
            self.goal_alt = ground
            return True, None, None, False

        if request_id != self.service_id:
            return False, "request ID mismatch or service not active", "INVALID_REQUEST_ID", False

        if action == "authorize":
            if self.service_phase == "landed" and self.service_grounded:
                self.service_phase = self.init_state = "swapping"
                return True, None, None, False
            return False, f"cannot authorize in phase {self.service_phase}", "INVALID_PHASE", True

        if action == "complete":
            if self.service_phase == "swapping" and self.service_grounded:
                self.service_phase = self.init_state = "swapped"
                return True, None, None, False
            return False, f"cannot complete in phase {self.service_phase}", "INVALID_PHASE", True

        if action == "relaunch":
            if not (self.service_phase == "swapped" and self.service_grounded):
                return False, f"cannot relaunch in phase {self.service_phase}", "INVALID_PHASE", True
            try:
                alt = float(msg["alt"])
            except (KeyError, TypeError, ValueError):
                return False, "invalid altitude parameter", "BAD_ALTITUDE", False
            if not math.isfinite(alt) or alt <= TAKEOFF_CONFIRM_ALT_M:
                return False, f"altitude must be > {TAKEOFF_CONFIRM_ALT_M} m", "BAD_ALTITUDE", False
            self.launch_alt = self.alt
            self.takeoff_climb_m = alt
            self.takeoff_alt = self.launch_alt + alt
            self.goal_alt = self.takeoff_alt
            self.service_phase = "relaunch"
            self._enter_step(INIT_CONFIRM_MODE, now=_now())
            self.custom_mode = self.guided_mode_id
            self.armed = True
            return True, None, None, False

        if action == "abort":
            if self.service_phase in ("landing", "landed", "swapping", "swapped", "relaunch", "failed"):
                is_grounded = bool(self.grounded or (self.service_phase in ("landed", "swapping", "swapped") and not self.armed))
                is_airborne = not is_grounded
                now = _now()
                if is_airborne:
                    self.service_phase = "aborted"
                    self.ready = False
                    self.failed_at = None
                    self.step_started_at = now
                    self.step_sent_at = now
                    if not getattr(self, "stuck_mode", False):
                        self.custom_mode = self.guided_mode_id
                    if self.connected and self.mode_confirmed and self.position_fresh:
                        self.hold_x = self.x
                        self.hold_y = self.y
                        self.hold_alt = self.alt
                        self.goal_x = self.x
                        self.goal_y = self.y
                        self.goal_alt = self.alt
                        self.init_state = INIT_ABORT_HOLD
                    else:
                        self.hold_x = None
                        self.hold_y = None
                        self.hold_alt = None
                        self.init_state = INIT_CONFIRM_ABORT
                else:
                    self.service_phase = "aborted"
                    self.init_state = "aborted"
                    self.ready = False
                    self.failed_at = None
                return True, None, None, False
            return False, f"cannot abort in phase {self.service_phase}", "INVALID_PHASE", False

        if action == "resume":
            if self.init_state in (INIT_ABORT_HOLD, INIT_CONFIRM_ABORT) or (self.service_phase == "aborted" and not self.service_grounded and self.armed):
                if self.mode_confirmed and self.position_fresh and self.connected and self.armed:
                    self.service_phase = None
                    self.service_id = None
                    self.init_state = INIT_READY
                    self.ready = True
                    return True, None, None, False
                return False, "vehicle not stabilized in hold", "HOLD_NOT_READY", True
            elif self.service_grounded or self.init_state == "aborted" or self.service_phase == "aborted":
                return False, "cannot resume grounded vehicle; relaunch required", "CANNOT_RESUME_GROUNDED", False
            return False, "vehicle is not in abort-hold", "NOT_IN_HOLD", False

        return False, f"unknown action {action}", "UNKNOWN_ACTION", False


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
    controller: object = None

    def reset(self, count: int, alt: float, origin: dict | None = None) -> list[str]:
        """Handle an "init": (re)create N vehicles at the origin."""
        self.vehicles = {}
        ids = []
        for i in range(1, count + 1):
            vid = f"DR-{i}"
            ids.append(vid)
            v = Vehicle(id=vid, x=0.0, y=0.0, alt=0.0)
            if isinstance(origin, dict):
                v.origin = {
                    "frame": "common-local-origin",
                    "x": float(origin.get("x", 0.0)),
                    "y": float(origin.get("y", 0.0)),
                    "groundM": float(origin.get("groundM", 0.0)),
                }
            v.takeoff_alt = alt
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
            if not (v.ready and v.init_state == INIT_READY and v.connected
                    and v.position_fresh and v.armed and v.service_phase is None):
                continue
            try:
                x, y, alt = float(g["x"]), float(g["y"]), float(g["alt"])
            except (KeyError, TypeError, ValueError):
                continue  # malformed goal entry: ignore gracefully
            v.set_goal(x, y, alt)

    def physics_tick(self, dt: float) -> None:
        now = _now()
        for v in self.vehicles.values():
            v.advance_init(now)
            v.step(dt)
            if v.last_heartbeat is not None:
                v.last_heartbeat = now

            # Touchdown detection using local ground elevation
            if v.service_phase in ("landing", "failed"):
                if abs(v.alt - v.target_ground_alt) <= 0.05:
                    v.alt = v.target_ground_alt
                    if v.armed:
                        v.armed = False
                    if not v.landed:
                        v.landed = True
                        v.last_landed = now
                        v.landed_seq += 1
            elif not v.landed and abs(v.alt - v.target_ground_alt) <= 0.05 and not v.armed:
                v.landed = True
                v.last_landed = now
                v.landed_seq += 1

            # Keep grounded telemetry fresh throughout swap
            if v.landed:
                v.last_landed = now
                v.landed_seq += 1

            if v.armed:
                v.landed = False
                v.last_landed = None

            v.last_position = now
            v.position_seq += 1
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
        if WORLD.controller is not None and WORLD.controller in WORLD.clients \
                and WORLD.controller is not websocket:
            await send_status(websocket, "mock is controlled by another client")
            return
        WORLD.controller = websocket
        count = int(msg.get("count", 0))
        alt = float(msg.get("alt", 50))
        ids = WORLD.reset(count, alt, msg.get("origin"))
        await websocket.send(json.dumps({
            "type": "ready", "ids": ids,
            "vehicles": [WORLD.vehicles[i].to_ready_entry() for i in ids],
        }))
        await send_status(websocket, f"mock: {count} vehicles initializing toward {alt} m")

    elif mtype == "goals":
        if WORLD.controller is not websocket:
            return
        WORLD.apply_goals(msg.get("goals", []))

    elif mtype == "service":
        if WORLD.controller is not websocket:
            return
        vid = msg.get("id")
        v = WORLD.vehicles.get(vid)
        request_id = msg.get("requestId")
        action = msg.get("action")
        if not isinstance(request_id, str) or v is None or not action:
            return

        # Idempotency check: replay previous response if this action was already handled
        history_key = (request_id, action)
        if history_key in v.service_action_history:
            cached_acc, cached_err, cached_code, cached_ret = v.service_action_history[history_key]
            await websocket.send(json.dumps({
                "type": "service_ack",
                "requestId": request_id,
                "id": vid,
                "action": action,
                "accepted": cached_acc,
                "error": cached_err,
                "code": cached_code,
                "retryable": cached_ret,
                "duplicate": True,
            }))
            return

        accepted, err, code, retryable = v.service(request_id, action, msg)
        if accepted:
            v.service_action_history[history_key] = (accepted, err, code, retryable)
        ack_msg = {
            "type": "service_ack",
            "requestId": request_id,
            "id": vid,
            "action": action,
            "accepted": accepted,
            "duplicate": False,
        }
        if err is not None:
            ack_msg["error"] = err
        if code is not None:
            ack_msg["code"] = code
        if not accepted:
            ack_msg["retryable"] = retryable
        await websocket.send(json.dumps(ack_msg))

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
        if WORLD.controller is websocket:
            WORLD.controller = None
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

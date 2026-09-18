"""bridge.py - browser WebSocket <-> ArduPilot/PX4 SITL MAVLink bridge.

This is the "real" half of the pair (see mock_vehicles.py for the
no-firmware stand-in that speaks the identical WebSocket protocol).

Architecture
------------
    browser sim  <--WebSocket(JSON)-->  bridge.py  <--MAVLink/UDP-->  SITL

The browser never speaks MAVLink; it only sends "init"/"goals" and receives
"ready"/"status"/"telemetry" JSON messages (see the protocol docstrings on
each handler below, and README.md for the full table). This module's job is
purely translation + plumbing: JSON goal <-> MAVLink SET_POSITION_TARGET_LOCAL_NED,
and MAVLink LOCAL_POSITION_NED <-> JSON telemetry, per vehicle.

Coordinate frame (shared contract with the browser sim and mock_vehicles.py):
    sim world:  x = metres East, y = metres South (screen-down positive),
                alt = metres above ground.
    MAVLink:    local NED = (North, East, Down), metres.

    sim -> NED:  ned_north = -sim_y ; ned_east = sim_x ; ned_down = -alt
    NED -> sim:  sim_x = ned_east   ; sim_y = -ned_north ; alt = -ned_down

One task per vehicle, one reader per socket (findings #12/#13)
--------------------------------------------------------------
Each vehicle gets exactly ONE asyncio task (`vehicle_task`), started the
moment "init" creates it. That task is the only code that ever reads the
vehicle's MAVLink socket, and it does two things on every poll:

  1. drains `recv_match(blocking=False)` into vehicle state (heartbeat time,
     armed/mode flags, COMMAND_ACKs, LOCAL_POSITION_NED -> sim x/y/alt), so
     telemetry flows from tick one and is NEVER gated on some other
     vehicle's init finishing (finding #13b), and
  2. advances a per-vehicle init state machine off those same messages:

        wait-heartbeat --(HEARTBEAT seen; send SET_MODE GUIDED)-->
        confirm-mode   --(HEARTBEAT.custom_mode == GUIDED id; send arm)-->
        confirm-arm    --(COMMAND_ACK(ARM)=ACCEPTED *and* HEARTBEAT.base_mode
                          & MAV_MODE_FLAG_SAFETY_ARMED; send NAV_TAKEOFF)-->
        confirm-takeoff--(COMMAND_ACK(TAKEOFF)=ACCEPTED, then telemetry alt
                          climbs past TAKEOFF_CONFIRM_ALT_M)--> ready

     Each step re-sends its command every STEP_RESEND_DT and gives up after
     INIT_STEP_TIMEOUT_S, landing in state "failed:<step>". Nothing is ever
     reported as done that wasn't confirmed by an acknowledgement, a
     heartbeat flag or actual measured climb (finding #12).

A failed vehicle's task keeps polling. When its heartbeat (re)appears the
sequence restarts from the earliest *unsatisfied* step, so a SITL instance
that boots long after "ready" was sent still gets armed and taken off with
no new "init" from the browser (finding #13a).

Readiness is reported PER VEHICLE: the "ready" reply keeps the flat `ids`
list the browser needs, and adds `vehicles: [{id, ready, state}]` alongside
it. "status" lines narrate the per-vehicle truth ("arm REJECTED ..."), never
a success that wasn't confirmed.

Flight origin (F05)
-------------------
Every vehicle coordinates travels in the COMMON LOCAL ORIGIN frame the
browser fixes at connect/init time and sends in the "init" message:
telemetry x/y/alt are origin-relative (NED position minus origin XY, -z
minus origin ground height), and outgoing goals are origin-relative too.
The origin is captured ONCE at connect/init -- a movable base or dragged
target never rewrites it -- so the whole pipeline round-trips in one frame
and a landing commanded at a different ground elevation still descends to
ground, not to NED zero.

Landing/swap/relaunch services (F04)
------------------------------------
A vehicle returns to base ONLY through the explicit browser-driven service
handshake, never an implicit setpoint to alt 0: the controller sends
{"type":"service","id","requestId","action":"land"} -> the bridge commands
MAV_CMD_NAV_LAND, flips the vehicle out of `ready` (no more goals), and
waits for fresh disarmed+EXTENDED_SYS_STATE(landed) evidence AFTER the
request (state "landed") -> the browser authorizes the battery swap
("swapping") -> later asks for completion ("swapped") -> finally "relaunch"
re-enters the standard init sequence from GUIDED with a NEW takeoff
altitude, and goals stay suppressed until the full climb is re-confirmed
and the vehicle is ready again. Every step is guarded by
`service_grounded`: fresh heartbeat + fresh position + landed, all newer
than the request, so a low hover, stale samples or a constant-seq heartbeat
can never masquerade as touchdown. Failed arm/takeoff during relaunch keeps
the vehicle parked (failed:<step>); nothing rearms itself outside this
handshake.

Ownership (finding #13c)
------------------------
The socket whose "init" built the current fleet is the controller. While
that socket is open, "init"/"goals" from any other client are refused with a
status line and change nothing -- a second browser tab can watch telemetry
but cannot stomp a flying fleet. When the controller disconnects the fleet
keeps flying and the next "init" from anyone takes over.

Per-vehicle MAVLink connection convention
------------------------------------------
`sim_vehicle.py -I<i> ... --out=udp:127.0.0.1:<PORT>` (see
run_ardupilot_sitl.sh) forwards vehicle i's MAVLink stream to
udp:127.0.0.1:<PORT>. We assume PORT = --mav-base-port + 10*i (default base
14550), which matches the ports printed by run_ardupilot_sitl.sh and is the
conventional spacing ArduPilot's own tooling uses for multi-vehicle SITL
(instance 0 -> 14550, instance 1 -> 14560, ...). This bridge listens with
`udpin:localhost:PORT` for each vehicle -- i.e. *we* are the UDP server and
SITL's --out is the UDP client connecting to us, so no port needs to be open
on the SITL side and NAT/firewall setup stays simple.

Dependencies: `websockets` and `pymavlink` (see requirements.txt).
`pymavlink` is intentionally not installed in every environment this repo
lives in (it's only needed on the box actually running SITL/talking MAVLink);
if the import below fails, run:

    pip install pymavlink

test_bridge.py exercises this module with stub `pymavlink`/`websockets`
modules and a scripted fake autopilot, so the state machine above is
testable (mock-verified) without either dependency or any firmware.
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
from websockets.asyncio.server import broadcast
from websockets.exceptions import ConnectionClosed

# pymavlink is required for all MAVLink communication with ArduPilot/PX4
# SITL (or real autopilots). It is NOT a dependency of mock_vehicles.py.
# If this import fails: `pip install pymavlink` (see requirements.txt).
from pymavlink import mavutil

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bridge")

TELEMETRY_HZ = 10.0
TELEMETRY_DT = 1.0 / TELEMETRY_HZ
POSITION_STALE_S = 3.0
DRAIN_POLL_DT = 0.02  # how often we poll each vehicle's MAVLink socket (non-blocking each time)
HEARTBEAT_STALE_S = 3.0  # a vehicle is "connected" only if heartbeat seen more recently than this
HEARTBEAT_WAIT_TIMEOUT_S = 15.0  # how long the init state machine waits for a vehicle's FIRST heartbeat

# --- init state-machine timing --------------------------------------------
# Every one of these is read from the module namespace at use time (never
# captured in a default argument), so tests can patch them down to keep
# scenarios sub-second.
INIT_STEP_TIMEOUT_S = 10.0  # per step (mode / arm / takeoff): give up after this long unconfirmed
STEP_RESEND_DT = 2.0  # re-send the current step's command this often while unconfirmed
TAKEOFF_CONFIRM_ALT_M = 1.0  # takeoff counts as confirmed only once telemetry shows this much climb
RETRY_COOLDOWN_S = 5.0  # after a failed step, wait this long before retrying a still-connected vehicle
INIT_EXTRA_WAIT_S = 20.0  # "ready" reply waits HEARTBEAT_WAIT_TIMEOUT_S + this for first-pass outcomes
MAX_MSGS_PER_POLL = 200  # bound one poll's work so a flooding link can't starve the event loop

# --- per-vehicle init states ----------------------------------------------
# These strings travel to the browser in the "ready" reply's per-vehicle
# entries, so they are part of the protocol surface: keep them stable.
INIT_WAIT_HEARTBEAT = "wait-heartbeat"
INIT_CONFIRM_MODE = "confirm-mode"
INIT_CONFIRM_ARM = "confirm-arm"
INIT_CONFIRM_TAKEOFF = "confirm-takeoff"
INIT_READY = "ready"
FAILED_PREFIX = "failed:"  # + step name, e.g. "failed:arm", "failed:no-heartbeat"

# --- MAVLink constants that need explaining -------------------------------
#
# SET_POSITION_TARGET_LOCAL_NED's `type_mask` is a bitmask of which of the
# message's fields to *ignore*. We only ever want to command position
# (x, y, z), so we set the bits for velocity (vx,vy,vz), acceleration
# (afx,afy,afz), yaw and yaw_rate to "ignore", leaving position bits clear
# (i.e. "use them"). The value 0b0000111111111000 (= 4088 decimal) is the
# conventional "position-only" mask used throughout the ArduPilot/dronekit
# ecosystem's own example scripts for exactly this purpose.
POSITION_TARGET_TYPEMASK = 0b0000111111111000

# MAV_CMD_SET_MESSAGE_INTERVAL (id 511) lets us ask the autopilot to stream
# LOCAL_POSITION_NED faster than its default rate, so our 10 Hz telemetry
# loop actually has fresh data to send -- and so the takeoff step has real
# altitude to confirm a climb against.  param1 = message id to configure,
# param2 = desired interval in microseconds (0 = default rate, -1 = disable).
MAV_CMD_SET_MESSAGE_INTERVAL = 511
LOCAL_POSITION_NED_INTERVAL_US = int(1_000_000 / TELEMETRY_HZ)

MAVLINK_MSG_ID_EXTENDED_SYS_STATE = 245
EXTENDED_LANDED_STATE_ON_GROUND = 1

# Human-readable COMMAND_ACK results, for status lines. Values are the
# MAV_RESULT enum's; we keep our own table rather than reverse-mapping
# pymavlink's module namespace just to print a word.
MAV_RESULT_NAMES = {
    0: "ACCEPTED",
    1: "TEMPORARILY_REJECTED",
    2: "DENIED",
    3: "UNSUPPORTED",
    4: "FAILED",
    5: "IN_PROGRESS",
    6: "CANCELLED",
}


def _result_name(result: Optional[int]) -> str:
    if result is None:
        return "none"
    return MAV_RESULT_NAMES.get(int(result), f"result {result}")


def _now() -> float:
    """Monotonic seconds for heartbeat/state-machine bookkeeping.

    Inside the event loop this is `loop.time()`; the fallback keeps the
    `connected` property usable from sync test/inspection code (on CPython
    both are `time.monotonic`, so the two never disagree).
    """
    try:
        return asyncio.get_running_loop().time()
    except RuntimeError:  # no running loop (sync caller)
        return time.monotonic()


@dataclass
class Vehicle:
    """State for one autopilot instance the bridge is talking to."""

    id: str
    index: int
    port: int
    conn: "mavutil.mavfile" = None
    takeoff_alt: float = 50.0  # metres; per vehicle, taken from the "init" that created it

    # --- link/telemetry state, updated by this vehicle's drain -------------
    last_heartbeat: Optional[float] = None  # monotonic seconds, or None if never seen
    base_mode: int = 0  # latest HEARTBEAT.base_mode (carries MAV_MODE_FLAG_SAFETY_ARMED)
    custom_mode: Optional[int] = None  # latest HEARTBEAT.custom_mode (ArduPilot flight mode id)
    guided_mode_id: Optional[int] = None  # from conn.mode_mapping()["GUIDED"], resolved after heartbeat
    acks: dict = field(default_factory=dict)  # MAV_CMD id -> latest COMMAND_ACK result
    # Latest known position, already converted into the *sim* coordinate frame.
    x: float = 0.0
    y: float = 0.0
    alt: float = 0.0
    last_position: Optional[float] = None
    position_seq: int = 0
    landed: Optional[bool] = None
    last_landed: Optional[float] = None
    landed_seq: int = 0
    service_id: Optional[str] = None
    service_phase: Optional[str] = None
    service_started: float = 0.0
    service_position_seq: int = 0
    service_landed_seq: int = 0
    service_history: set = field(default_factory=set)
    launch_alt: float = 0.0
    origin: dict = field(default_factory=lambda: {"frame": "common-local-origin", "x": 0.0, "y": 0.0, "groundM": 0.0})

    # --- init state machine ------------------------------------------------
    init_state: str = INIT_WAIT_HEARTBEAT
    ready: bool = False
    step_started_at: float = 0.0  # when the current step was entered
    step_sent_at: float = 0.0  # when the current step's command was last sent
    failed_at: Optional[float] = None  # when the current failure was recorded
    # Set the first time this vehicle reaches a terminal state (ready or
    # failed:*). handle_init waits on these, per vehicle, to decide when the
    # "ready" reply is honest -- it is never cleared afterwards, because a
    # later recovery is reported through status/telemetry, not by rewinding
    # an already-sent reply.
    first_pass_done: asyncio.Event = field(default_factory=asyncio.Event)
    status_ws: object = None  # websocket that ran the init which created this vehicle
    task: object = None  # the asyncio task driving this vehicle

    @property
    def connected(self) -> bool:
        if self.last_heartbeat is None:
            return False
        return (_now() - self.last_heartbeat) < HEARTBEAT_STALE_S

    @property
    def armed(self) -> bool:
        """Armed per the vehicle's own heartbeat, not per our having asked."""
        return bool(int(self.base_mode) & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)

    @property
    def mode_confirmed(self) -> bool:
        """GUIDED per the vehicle's own heartbeat, not per our having asked."""
        if self.guided_mode_id is None or self.custom_mode is None:
            return False
        return int(self.custom_mode) == int(self.guided_mode_id)

    @property
    def position_age(self) -> Optional[float]:
        if self.last_position is None:
            return None
        return _now() - self.last_position

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
            "positionAge": self.position_age,
            "positionSeq": self.position_seq,
            "armed": self.armed,
            "heartbeatAge": None if self.last_heartbeat is None else _now() - self.last_heartbeat,
            "landed": self.landed,
            "landedAge": self.landed_age,
            "landedSeq": self.landed_seq,
            "serviceId": self.service_id,
            "servicePhase": self.service_phase,
            "origin": self.origin,
        }

    def to_ready_entry(self) -> dict:
        """Per-vehicle truth carried alongside `ids` in the "ready" reply."""
        return {"id": self.id, "ready": self.ready, "state": self.init_state}


@dataclass
class State:
    vehicles: dict[str, Vehicle] = field(default_factory=dict)
    clients: set = field(default_factory=set)
    vehicle_tasks: list = field(default_factory=list)
    start_time: float = field(default_factory=time.monotonic)
    # The websocket whose "init" built the current fleet (finding #13c).
    # None means unowned: the next "init" from anyone takes over.
    controller: object = None
    # Serializes "init" handling so two inits can't interleave fleet teardown
    # and setup. Created here, bound to a loop on first use.
    init_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


STATE = State()


# --------------------------------------------------------------------------
# Coordinate conversions (shared contract, see module docstring)
# --------------------------------------------------------------------------

def sim_to_ned(x: float, y: float, alt: float) -> tuple[float, float, float]:
    """sim (x=East, y=South, alt=up) -> MAVLink local NED (North, East, Down)."""
    north = -y
    east = x
    down = -alt
    return north, east, down


def ned_to_sim(north: float, east: float, down: float) -> tuple[float, float, float]:
    """MAVLink local NED -> sim (x=East, y=South, alt=up)."""
    x = east
    y = -north
    alt = -down
    return x, y, alt


# --------------------------------------------------------------------------
# MAVLink sends (all non-blocking UDP writes, safe from the event loop)
# --------------------------------------------------------------------------

def _send_set_mode(vehicle: Vehicle) -> None:
    """Ask for GUIDED via the legacy SET_MODE message.

    ArduCopter (unlike PX4) is most reliably switched into a named flight
    mode via the legacy MAVLink SET_MODE message, using the numeric "custom
    mode" index from the vehicle's *own* mode_mapping() table -- not the
    newer MAV_CMD_DO_SET_MODE command_long, whose custom-mode semantics vary
    more across ArduCopter firmware versions. pymavlink's
    mavutil.mavfile.set_mode() wraps exactly this legacy-message approach,
    which is what mission planners / ArduPilot's own example scripts use.
    """
    vehicle.conn.set_mode(vehicle.guided_mode_id)


def _send_arm(vehicle: Vehicle) -> None:
    """Request arming.

    arducopter_arm() is a small pymavlink convenience wrapper (specific to
    Copter) around sending MAV_CMD_COMPONENT_ARM_DISARM via COMMAND_LONG
    with param1=1 (arm). We deliberately do NOT block on motors_armed_wait()
    -- confirmation comes from the COMMAND_ACK plus the heartbeat's armed
    flag, observed by this vehicle's own drain loop.
    """
    vehicle.conn.arducopter_arm()


def _send_takeoff(vehicle: Vehicle) -> None:
    """MAV_CMD_NAV_TAKEOFF via COMMAND_LONG.

    For ArduCopter, param7 is the target altitude in metres, taken as
    relative to the home/arming position (matches our sim's "alt = height
    above ground" contract). Params 1-6 (pitch, unused x2, yaw, lat, lon)
    are left at 0 to mean "use current heading/position".
    """
    conn = vehicle.conn
    conn.mav.command_long_send(
        conn.target_system,
        conn.target_component,
        mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
        0,  # confirmation
        0, 0, 0, 0,  # param1-4: unused for copter takeoff
        0, 0,  # param5 (lat), param6 (lon): 0 = current position
        vehicle.takeoff_alt,  # param7: target altitude, metres
    )


def _request_position_stream(vehicle: Vehicle) -> None:
    """Ask for faster LOCAL_POSITION_NED.

    Sent as soon as the vehicle is talking to us (not at the end of the
    sequence as before), because the takeoff step confirms a real climb from
    these messages -- waiting until after takeoff would mean confirming
    against the autopilot's slow default rate.
    """
    conn = vehicle.conn
    conn.mav.command_long_send(
        conn.target_system,
        conn.target_component,
        MAV_CMD_SET_MESSAGE_INTERVAL,
        0,
        mavutil.mavlink.MAVLINK_MSG_ID_LOCAL_POSITION_NED,
        LOCAL_POSITION_NED_INTERVAL_US,
        0, 0, 0, 0, 0,
    )
    conn.mav.command_long_send(conn.target_system, conn.target_component,
                               MAV_CMD_SET_MESSAGE_INTERVAL, 0, 245,
                               LOCAL_POSITION_NED_INTERVAL_US, 0, 0, 0, 0, 0)


# --------------------------------------------------------------------------
# Per-vehicle task: drain + init state machine (findings #12, #13a, #13b)
# --------------------------------------------------------------------------

def _drain_messages(vehicle: Vehicle) -> None:
    """Read everything queued on this vehicle's socket into vehicle state.

    `recv_match(blocking=False)` performs a single non-blocking read attempt
    and returns None immediately if nothing is queued, so it's safe to call
    repeatedly from the asyncio loop without a thread executor. This is the
    ONLY reader of the socket -- the init state machine consumes the same
    messages from the fields updated here rather than doing its own reads
    (two readers would steal each other's COMMAND_ACKs).
    """
    conn = vehicle.conn
    if conn is None:
        return
    for _ in range(MAX_MSGS_PER_POLL):
        msg = conn.recv_match(blocking=False)
        if msg is None:
            return
        mtype = msg.get_type()
        if mtype == "HEARTBEAT":
            vehicle.last_heartbeat = _now()
            vehicle.base_mode = int(getattr(msg, "base_mode", 0) or 0)
            custom = getattr(msg, "custom_mode", None)
            vehicle.custom_mode = None if custom is None else int(custom)
        elif mtype == "LOCAL_POSITION_NED":
            x, y, alt = ned_to_sim(msg.x, msg.y, msg.z)
            vehicle.x, vehicle.y, vehicle.alt = x, y, alt
            vehicle.last_position = _now()
            vehicle.position_seq += 1
        elif mtype == "EXTENDED_SYS_STATE":
            vehicle.landed = int(msg.landed_state) == 1
            vehicle.last_landed = _now()
            vehicle.landed_seq += 1
        elif mtype == "COMMAND_ACK":
            vehicle.acks[int(msg.command)] = int(msg.result)


def _ack(vehicle: Vehicle, command: int) -> Optional[int]:
    """Latest COMMAND_ACK result for `command`, or None if unanswered.

    MAV_RESULT_IN_PROGRESS is *not* an answer -- the autopilot is telling us
    it is still working, so we keep waiting instead of declaring failure.
    """
    result = vehicle.acks.get(int(command))
    if result is None:
        return None
    if result == getattr(mavutil.mavlink, "MAV_RESULT_IN_PROGRESS", 5):
        return None
    return result


def _accepted(result: Optional[int]) -> bool:
    return result is not None and result == mavutil.mavlink.MAV_RESULT_ACCEPTED


def _enter_step(vehicle: Vehicle, state: str, now: float) -> None:
    vehicle.init_state = state
    vehicle.step_started_at = now
    vehicle.step_sent_at = now
    vehicle.failed_at = None


async def _enter_confirm_mode(vehicle: Vehicle, now: float) -> None:
    """Resolve the GUIDED mode id and ask for it."""
    if vehicle.guided_mode_id is None:
        try:
            # mode_mapping() needs the heartbeat (it keys off the vehicle
            # type), which is exactly why this runs here and not at connect.
            mapping = vehicle.conn.mode_mapping() or {}
            vehicle.guided_mode_id = mapping["GUIDED"]
        except Exception as exc:
            await _fail(
                vehicle,
                "mode",
                f"vehicle {vehicle.id}: firmware reports no GUIDED mode id ({exc!r}); not arming",
                now,
            )
            return
    _enter_step(vehicle, INIT_CONFIRM_MODE, now)
    _send_set_mode(vehicle)
    _request_position_stream(vehicle)


async def _enter_confirm_arm(vehicle: Vehicle, now: float) -> None:
    # Drop any older ACK for this command so a previous attempt's answer
    # can't be mistaken for this one's.
    vehicle.acks.pop(int(mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM), None)
    _enter_step(vehicle, INIT_CONFIRM_ARM, now)
    _send_arm(vehicle)


async def _enter_confirm_takeoff(vehicle: Vehicle, now: float) -> None:
    vehicle.acks.pop(int(mavutil.mavlink.MAV_CMD_NAV_TAKEOFF), None)
    _enter_step(vehicle, INIT_CONFIRM_TAKEOFF, now)
    _send_takeoff(vehicle)


async def _become_ready(vehicle: Vehicle, now: float) -> None:
    vehicle.init_state = INIT_READY
    vehicle.ready = True
    if vehicle.service_phase == "relaunch":
        vehicle.service_phase = None
    vehicle.failed_at = None
    vehicle.step_started_at = now
    await _vehicle_status(
        vehicle,
        f"vehicle {vehicle.id}: airborne at {vehicle.alt:.1f} m (GUIDED + armed + climbing confirmed) - READY",
    )
    vehicle.first_pass_done.set()


async def _fail(vehicle: Vehicle, step: str, message: str, now: float) -> None:
    """Record a per-step failure. The vehicle's task keeps polling regardless."""
    vehicle.init_state = FAILED_PREFIX + step
    vehicle.ready = False
    vehicle.failed_at = now
    await _vehicle_status(vehicle, message)
    vehicle.first_pass_done.set()


async def _resume_sequence(vehicle: Vehicle, now: float) -> None:
    """Restart the init sequence from the earliest UNSATISFIED step.

    This is finding #13a's independent recovery: a vehicle that missed its
    first pass (late SITL start, transient rejection) is picked up again by
    its own task, with no new "init" from the browser, and without redoing
    steps the vehicle has already reached on its own.
    """
    if not vehicle.mode_confirmed:
        await _vehicle_status(vehicle, f"vehicle {vehicle.id}: retrying init from GUIDED mode request")
        await _enter_confirm_mode(vehicle, now)
    elif not vehicle.armed:
        await _vehicle_status(vehicle, f"vehicle {vehicle.id}: GUIDED confirmed, retrying arm")
        await _enter_confirm_arm(vehicle, now)
    elif not vehicle.airborne:
        await _vehicle_status(vehicle, f"vehicle {vehicle.id}: armed, retrying takeoff to {vehicle.takeoff_alt:g} m")
        await _enter_confirm_takeoff(vehicle, now)
    else:
        await _become_ready(vehicle, now)


async def _recover_if_possible(vehicle: Vehicle, now: float) -> None:
    """Failed state: wait for the vehicle to come back, then resume."""
    if not vehicle.connected:
        return  # nothing to talk to yet; keep polling for a heartbeat
    # A vehicle that only just started talking is retried immediately (that
    # heartbeat IS the thing we were waiting for); anything else backs off,
    # so a vehicle failing its pre-arm checks isn't hammered every 20 ms.
    cooldown = 0.0 if vehicle.init_state == FAILED_PREFIX + "no-heartbeat" else RETRY_COOLDOWN_S
    if vehicle.failed_at is not None and (now - vehicle.failed_at) < cooldown:
        return
    await _resume_sequence(vehicle, now)


async def _advance_init(vehicle: Vehicle) -> None:
    """One tick of the per-vehicle init state machine."""
    now = _now()
    state = vehicle.init_state

    if state == INIT_READY:
        # Confirmed airborne; the task stays alive purely to drain telemetry.
        # A later heartbeat loss is reported through `connected` (the browser
        # has its own freeze/dead ladder for that) and deliberately does NOT
        # re-run the sequence: a vehicle already in the air must not be
        # re-armed or re-commanded to take off.
        return

    if vehicle.service_phase == "landing":
        if vehicle.service_grounded:
            vehicle.init_state = "landed"
            vehicle.service_phase = "landed"
        elif now - vehicle.service_started >= INIT_STEP_TIMEOUT_S:
            await _fail(vehicle, "land", f"vehicle {vehicle.id}: landing unconfirmed", now)
            vehicle.service_phase = "failed"
        return
    if vehicle.service_phase in ("landed", "swapping", "swapped", "failed"):
        return
    if state.startswith(FAILED_PREFIX):
        await _recover_if_possible(vehicle, now)
        return

    elapsed = now - vehicle.step_started_at

    if state == INIT_WAIT_HEARTBEAT:
        if vehicle.connected:
            await _vehicle_status(vehicle, f"vehicle {vehicle.id}: heartbeat OK, requesting GUIDED")
            await _enter_confirm_mode(vehicle, now)
        elif elapsed >= HEARTBEAT_WAIT_TIMEOUT_S:
            await _fail(
                vehicle,
                "no-heartbeat",
                f"vehicle {vehicle.id}: NO heartbeat on udp:{vehicle.port} after {HEARTBEAT_WAIT_TIMEOUT_S:g}s "
                f"- not armed, not airborne (still listening; will run the sequence if it shows up)",
                now,
            )
        return

    if state == INIT_CONFIRM_MODE:
        if vehicle.mode_confirmed:
            await _vehicle_status(vehicle, f"vehicle {vehicle.id}: GUIDED confirmed by heartbeat, arming")
            await _enter_confirm_arm(vehicle, now)
        elif elapsed >= INIT_STEP_TIMEOUT_S:
            await _fail(
                vehicle,
                "mode",
                f"vehicle {vehicle.id}: GUIDED NOT confirmed after {INIT_STEP_TIMEOUT_S:g}s "
                f"(heartbeat still reports mode {vehicle.custom_mode}) - not arming",
                now,
            )
        elif now - vehicle.step_sent_at >= STEP_RESEND_DT:
            _send_set_mode(vehicle)
            vehicle.step_sent_at = now
        return

    if state == INIT_CONFIRM_ARM:
        result = _ack(vehicle, mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM)
        if result is not None and not _accepted(result):
            await _fail(
                vehicle,
                "arm",
                f"vehicle {vehicle.id}: arm REJECTED (pre-arm checks?) - COMMAND_ACK {_result_name(result)}",
                now,
            )
        elif _accepted(result) and vehicle.connected and vehicle.armed:
            await _vehicle_status(
                vehicle,
                f"vehicle {vehicle.id}: armed (ACK + heartbeat armed flag), commanding takeoff to {vehicle.takeoff_alt:g} m",
            )
            await _enter_confirm_takeoff(vehicle, now)
        elif elapsed >= INIT_STEP_TIMEOUT_S:
            await _fail(
                vehicle,
                "arm",
                f"vehicle {vehicle.id}: arm UNCONFIRMED after {INIT_STEP_TIMEOUT_S:g}s "
                f"(ack={_result_name(result)}, heartbeat armed={vehicle.armed}) - not taking off",
                now,
            )
        elif result is None and now - vehicle.step_sent_at >= STEP_RESEND_DT:
            _send_arm(vehicle)  # no answer yet: the request may have been lost on UDP
            vehicle.step_sent_at = now
        return

    if state == INIT_CONFIRM_TAKEOFF:
        result = _ack(vehicle, mavutil.mavlink.MAV_CMD_NAV_TAKEOFF)
        if result is not None and not _accepted(result):
            await _fail(
                vehicle,
                "takeoff",
                f"vehicle {vehicle.id}: takeoff REJECTED - COMMAND_ACK {_result_name(result)}",
                now,
            )
        elif _accepted(result) and vehicle.connected and vehicle.mode_confirmed and vehicle.armed and vehicle.airborne:
            await _become_ready(vehicle, now)
        elif elapsed >= INIT_STEP_TIMEOUT_S:
            await _fail(
                vehicle,
                "takeoff",
                f"vehicle {vehicle.id}: takeoff UNCONFIRMED after {INIT_STEP_TIMEOUT_S:g}s "
                f"(ack={_result_name(result)}, alt {vehicle.alt:.1f} m never passed {TAKEOFF_CONFIRM_ALT_M:g} m)",
                now,
            )
        elif result is None and now - vehicle.step_sent_at >= STEP_RESEND_DT:
            # Only re-send while UNACKNOWLEDGED: re-commanding an accepted
            # takeoff mid-climb would restart it.
            _send_takeoff(vehicle)
            vehicle.step_sent_at = now
        return


async def vehicle_task(vehicle: Vehicle) -> None:
    """The one task that owns a vehicle: drains its socket and drives its init.

    Started immediately by handle_init, so telemetry for a healthy vehicle
    flows while its neighbours are still waiting for heartbeats (finding
    #13b), and never exits on failure -- a failed vehicle is still watched,
    and recovers on its own if it comes back (finding #13a).
    """
    try:
        # udpin: *we* bind and listen; SITL's --out=udp:host:PORT connects to
        # us as the client. This means the bridge can start before SITL does,
        # and no inbound port needs to be opened on the SITL/autopilot side.
        vehicle.conn = mavutil.mavlink_connection(f"udpin:localhost:{vehicle.port}")
    except Exception as exc:
        # Can't even bind (port busy, bad address): there is nothing to poll,
        # so this task has no job. Report it honestly and stop; a fresh
        # "init" is the only thing that can retry the bind.
        log.warning("vehicle %s: MAVLink connect failed: %r", vehicle.id, exc)
        vehicle.init_state = FAILED_PREFIX + "connect"
        vehicle.ready = False
        vehicle.failed_at = _now()
        await _vehicle_status(vehicle, f"vehicle {vehicle.id}: cannot listen on udp:{vehicle.port} ({exc!r})")
        vehicle.first_pass_done.set()
        return

    vehicle.step_started_at = _now()
    vehicle.step_sent_at = vehicle.step_started_at
    await _vehicle_status(vehicle, f"vehicle {vehicle.id}: listening for heartbeat on udp:{vehicle.port} ...")

    while True:
        try:
            _drain_messages(vehicle)
            await _advance_init(vehicle)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive: one bad poll must not kill the vehicle
            log.warning("vehicle %s: poll raised %r (continuing)", vehicle.id, exc)
        await asyncio.sleep(DRAIN_POLL_DT)


# --------------------------------------------------------------------------
# WebSocket protocol handling
# --------------------------------------------------------------------------

async def send_status(websocket, msg: str) -> None:
    log.info("status: %s", msg)
    try:
        await websocket.send(json.dumps({"type": "status", "msg": msg}))
    except ConnectionClosed:
        pass
    except Exception as exc:  # pragma: no cover - a dying socket must not kill a vehicle task
        log.debug("status send failed: %r", exc)


async def _vehicle_status(vehicle: Vehicle, msg: str) -> None:
    """Status from a vehicle task -> whoever is listening, if anyone.

    Vehicle tasks outlive the socket that started them (the fleet keeps
    flying across a browser reload), so the target is resolved per message:
    the initiating client while it is open, else the current controller,
    else nobody (log only).
    """
    ws = vehicle.status_ws
    if ws is None or ws not in STATE.clients:
        ws = STATE.controller if STATE.controller in STATE.clients else None
    if ws is None:
        log.info("status (no client attached): %s", msg)
        return
    await send_status(ws, msg)


def client_connected(websocket) -> None:
    STATE.clients.add(websocket)


def client_disconnected(websocket) -> None:
    """Drop a client; if it was the controller, the fleet becomes unowned.

    The vehicles keep flying (and keep recovering) -- only control changes
    hands, so the next "init" from any client takes over (finding #13c).
    """
    STATE.clients.discard(websocket)
    if STATE.controller is websocket:
        STATE.controller = None
        log.info("controller disconnected: fleet keeps flying, next 'init' takes over")


def _controlled_by_other(websocket) -> bool:
    controller = STATE.controller
    if controller is None or controller is websocket:
        return False
    # A controller whose socket is gone holds nothing (defensive: the
    # handler's finally normally clears it).
    return controller in STATE.clients


def _owns_control(websocket) -> bool:
    return websocket in STATE.clients and STATE.controller is websocket


async def _may_control(websocket, *, acquire: bool = False) -> bool:
    if websocket not in STATE.clients:
        return False
    if _controlled_by_other(websocket):
        await send_status(websocket, "bridge is controlled by another client")
        return False
    if acquire:
        STATE.controller = websocket
    if not _owns_control(websocket):
        await send_status(websocket, "bridge has no controller; send init to acquire control")
        return False
    return True


async def _stop_all_vehicles() -> None:
    """Cancel vehicle tasks and close MAVLink sockets before a re-init."""
    tasks = [t for t in STATE.vehicle_tasks if t is not None]
    for task in tasks:
        task.cancel()
    if tasks:
        # gather(return_exceptions=True) collects the children's cancellations
        # without swallowing a cancellation aimed at *us*.
        await asyncio.gather(*tasks, return_exceptions=True)
    STATE.vehicle_tasks = []
    for v in STATE.vehicles.values():
        if v.conn is not None:
            try:
                v.conn.close()
            except Exception:  # pragma: no cover - best-effort cleanup
                pass
    STATE.vehicles = {}


async def handle_init(websocket, msg: dict, cli_count: Optional[int], base_port: int) -> None:
    """Build the fleet, start one task per vehicle, report per-vehicle readiness.

    Reply: {"type":"ready","ids":[...],"vehicles":[{id, ready, state}, ...]}
    `ids` is kept flat for the browser client; `vehicles` carries the truth
    about what was actually confirmed (finding #12). A vehicle that isn't
    ready is still listed -- it exists, it just isn't flying yet, and its
    task keeps trying.
    """
    async with STATE.init_lock:
        # Re-check ownership inside the lock: another client may have claimed
        # control while this init waited its turn.
        if not await _may_control(websocket, acquire=True) or not _owns_control(websocket):
            return

        count = cli_count if cli_count is not None else int(msg.get("count", 0))
        alt = float(msg.get("alt", 50))
        supplied_origin = msg.get("origin", {"frame": "common-local-origin", "x": 0.0, "y": 0.0, "groundM": 0.0})
        if not isinstance(supplied_origin, dict) or supplied_origin.get("frame") != "common-local-origin":
            return
        if not all(isinstance(supplied_origin.get(k), (int, float)) and math.isfinite(supplied_origin[k])
                   for k in ("x", "y", "groundM")):
            return
        origin = {"frame": "common-local-origin", **{k: float(supplied_origin[k]) for k in ("x", "y", "groundM")}}

        await send_status(websocket, f"bridge: initializing {count} vehicle(s), target alt {alt:g} m")
        if not _owns_control(websocket):
            return

        await _stop_all_vehicles()
        if not _owns_control(websocket):
            return

        ids = []
        vehicles = []
        for i in range(count):
            vid = f"DR-{i + 1}"
            ids.append(vid)
            v = Vehicle(id=vid, index=i, port=base_port + 10 * i, takeoff_alt=alt, status_ws=websocket, origin=dict(origin))
            STATE.vehicles[vid] = v
            vehicles.append(v)

        # Start every vehicle's task NOW, before waiting on anything: each
        # one drains its own socket from its first tick, so a healthy
        # vehicle's telemetry is live while a slow neighbour is still looking
        # for its first heartbeat (finding #13b).
        for v in vehicles:
            v.task = asyncio.create_task(vehicle_task(v))
            STATE.vehicle_tasks.append(v.task)

        # Wait for each vehicle's FIRST-PASS outcome independently. The
        # deadline covers the worst honest case (heartbeat wait + the three
        # confirmation steps); vehicles that finish early don't wait for it.
        deadline = HEARTBEAT_WAIT_TIMEOUT_S + INIT_EXTRA_WAIT_S
        waiters = [asyncio.create_task(v.first_pass_done.wait()) for v in vehicles]
        if waiters:
            _done, pending = await asyncio.wait(waiters, timeout=deadline)
            for w in pending:
                w.cancel()

        if not _owns_control(websocket):
            return
        n_ready = sum(1 for v in vehicles if v.ready)
        detail = ", ".join(f"{v.id}={v.init_state}" for v in vehicles) or "no vehicles"
        await send_status(websocket, f"bridge: {n_ready}/{count} vehicles confirmed ready ({detail})")
        if not _owns_control(websocket):
            return
        await websocket.send(
            json.dumps(
                {
                    "type": "ready",
                    "ids": ids,
                    "vehicles": [v.to_ready_entry() for v in vehicles],
                }
            )
        )


def handle_goals(msg: dict) -> None:
    """Forward each goal to its vehicle as a SET_POSITION_TARGET_LOCAL_NED.

    This is a plain non-blocking UDP send, so it's called synchronously
    (no await needed) straight from the WebSocket message loop. Since the
    browser sends "goals" at ~2 Hz (per protocol), simply re-sending on
    receipt keeps GUIDED mode's position setpoint fresh enough that
    ArduCopter won't consider it stale.

    """
    for g in msg.get("goals", []):
        vid = g.get("id")
        vehicle = STATE.vehicles.get(vid)
        if (vehicle is None or vehicle.conn is None
                or not vehicle.ready or vehicle.init_state != INIT_READY
                or not vehicle.connected or not vehicle.position_fresh
                or not vehicle.mode_confirmed or not vehicle.armed
                or vehicle.service_phase is not None):
            continue
        try:
            x, y, alt = float(g["x"]), float(g["y"]), float(g["alt"])
        except (KeyError, TypeError, ValueError):
            continue  # malformed goal: ignore gracefully

        north, east, down = sim_to_ned(x, y, alt)
        vehicle.conn.mav.set_position_target_local_ned_send(
            0,  # time_boot_ms: unused/advisory, 0 is fine
            vehicle.conn.target_system,
            vehicle.conn.target_component,
            mavutil.mavlink.MAV_FRAME_LOCAL_NED,
            POSITION_TARGET_TYPEMASK,
            north, east, down,  # position
            0, 0, 0,  # velocity (ignored per type_mask)
            0, 0, 0,  # acceleration (ignored per type_mask)
            0, 0,  # yaw, yaw_rate (ignored per type_mask)
        )


async def handle_service(websocket, msg: dict) -> None:
    if not await _may_control(websocket) or not _owns_control(websocket):
        return
    v = STATE.vehicles.get(msg.get("id"))
    request_id = msg.get("requestId")
    action = msg.get("action")
    if v is None or v.conn is None or not isinstance(request_id, str) or not request_id:
        return
    if action == "land":
        if request_id in v.service_history or v.service_phase not in (None, "complete"):
            return
        if not (v.ready and v.init_state == INIT_READY and v.connected and v.position_fresh and v.armed):
            return
        v.service_history.add(request_id)
        v.service_id = request_id
        v.service_phase = "landing"
        v.service_started = _now()
        v.service_position_seq = v.position_seq
        v.service_landed_seq = v.landed_seq
        v.init_state = "landing"
        v.ready = False
        v.conn.mav.command_long_send(v.conn.target_system, v.conn.target_component,
                                     21, 0, 0, 0, 0, 0, 0, 0, 0)
        return
    if request_id != v.service_id:
        return
    if action == "authorize" and v.service_phase == "landed" and v.service_grounded:
        v.service_phase = v.init_state = "swapping"
    elif action == "complete" and v.service_phase == "swapping" and v.service_grounded:
        v.service_phase = v.init_state = "swapped"
    elif action == "relaunch" and v.service_phase == "swapped" and v.service_grounded:
        try:
            alt = float(msg["alt"])
        except (KeyError, ValueError, TypeError):
            return
        if not math.isfinite(alt) or alt <= TAKEOFF_CONFIRM_ALT_M:
            return
        v.launch_alt = v.alt
        v.takeoff_alt = alt
        v.service_phase = "relaunch"
        v.acks.clear()
        await _enter_confirm_mode(v, _now())
    elif action == "abort":
        if v.service_phase in ("landing", "landed", "swapping", "swapped"):
            v.service_phase = None
            v.service_id = None
            v.init_state = FAILED_PREFIX + "service"
            v.ready = False
            v.failed_at = _now()


async def handle_message(websocket, raw: str, cli_count: Optional[int], base_port: int) -> None:
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("ignoring non-JSON message: %r", raw[:200])
        return

    mtype = msg.get("type")
    if mtype == "init":
        await handle_init(websocket, msg, cli_count, base_port)
    elif mtype == "service":
        await handle_service(websocket, msg)
    elif mtype == "goals":
        # Only the controlling client may command the fleet (finding #13c);
        # everyone else can still watch the telemetry broadcast.
        if not await _may_control(websocket) or not _owns_control(websocket):
            return
        handle_goals(msg)
    else:
        # Unknown message type: ignore gracefully, per protocol.
        log.debug("ignoring unknown message type: %r", mtype)


async def telemetry_loop() -> None:
    """Background task: broadcast telemetry to all connected browser clients."""
    while True:
        await asyncio.sleep(TELEMETRY_DT)
        if not STATE.clients or not STATE.vehicles:
            continue
        message = json.dumps(
            {
                "type": "telemetry",
                "t": time.monotonic() - STATE.start_time,
                "vehicles": [v.to_telemetry() for v in STATE.vehicles.values()],
            }
        )
        broadcast(STATE.clients, message)


def make_handler(cli_count: Optional[int], base_port: int):
    async def handler(websocket) -> None:
        peer = getattr(websocket, "remote_address", None)
        log.info("client connected: %s", peer)
        client_connected(websocket)
        try:
            async for raw in websocket:
                await handle_message(websocket, raw, cli_count, base_port)
        except ConnectionClosed:
            pass
        finally:
            client_disconnected(websocket)
            log.info("client disconnected: %s", peer)

    return handler


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

async def run(args: argparse.Namespace) -> None:
    telem_task = asyncio.create_task(telemetry_loop())
    handler = make_handler(args.count, args.mav_base_port)
    try:
        async with serve(handler, args.ws_host, args.ws_port) as server:
            log.info("bridge listening on ws://%s:%s (MAVLink base port %s)", args.ws_host, args.ws_port, args.mav_base_port)
            await asyncio.get_running_loop().create_future()  # run forever
    finally:
        telem_task.cancel()
        for task in STATE.vehicle_tasks:
            task.cancel()
        try:
            await telem_task
        except (asyncio.CancelledError, Exception):
            pass
        for v in STATE.vehicles.values():
            if v.conn is not None:
                try:
                    v.conn.close()
                except Exception:
                    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Bridge between a browser drone-swarm sim (WebSocket/JSON) and "
            "real ArduPilot/PX4 SITL vehicles (MAVLink/UDP). Requires "
            "pymavlink; see requirements.txt."
        )
    )
    parser.add_argument("--ws-host", default="localhost", help="WebSocket host to bind (default: localhost)")
    parser.add_argument("--ws-port", type=int, default=8765, help="WebSocket port to bind (default: 8765)")
    parser.add_argument(
        "--mav-base-port",
        type=int,
        default=14550,
        help=(
            "UDP port for vehicle 0's MAVLink connection; vehicle i uses "
            "mav-base-port + 10*i, matching `sim_vehicle.py -I<i>` output "
            "port conventions (default: 14550)"
        ),
    )
    parser.add_argument(
        "--count",
        type=int,
        default=None,
        help="Number of vehicles to expect; if omitted, taken from each 'init' message's count field",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        log.info("shutting down (Ctrl+C)")


if __name__ == "__main__":
    main()

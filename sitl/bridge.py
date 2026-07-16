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
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import json
import logging
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
DRAIN_POLL_DT = 0.02  # how often we poll each vehicle's MAVLink socket (non-blocking each time)
HEARTBEAT_STALE_S = 3.0  # a vehicle is "connected" only if heartbeat seen more recently than this
HEARTBEAT_WAIT_TIMEOUT_S = 15.0  # how long we wait for a vehicle's first heartbeat during init

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
# loop actually has fresh data to send. param1 = message id to configure,
# param2 = desired interval in microseconds (0 = default rate, -1 = disable).
MAV_CMD_SET_MESSAGE_INTERVAL = 511
LOCAL_POSITION_NED_INTERVAL_US = int(1_000_000 / TELEMETRY_HZ)


@dataclass
class Vehicle:
    """State for one autopilot instance the bridge is talking to."""

    id: str
    index: int
    port: int
    conn: "mavutil.mavfile" = None
    last_heartbeat: Optional[float] = None  # asyncio loop time, or None if never seen
    # Latest known position, already converted into the *sim* coordinate frame.
    x: float = 0.0
    y: float = 0.0
    alt: float = 0.0

    @property
    def connected(self) -> bool:
        if self.last_heartbeat is None:
            return False
        return (asyncio.get_event_loop().time() - self.last_heartbeat) < HEARTBEAT_STALE_S

    def to_telemetry(self) -> dict:
        return {
            "id": self.id,
            "x": self.x,
            "y": self.y,
            "alt": self.alt,
            "connected": self.connected,
        }


@dataclass
class State:
    vehicles: dict[str, Vehicle] = field(default_factory=dict)
    clients: set = field(default_factory=set)
    drain_tasks: list = field(default_factory=list)
    start_time: float = field(default_factory=time.monotonic)


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
# MAVLink setup / control helpers
# --------------------------------------------------------------------------

def _blocking_wait_heartbeat(conn: "mavutil.mavfile", timeout: float):
    """Runs in a thread executor -- mavutil's wait_heartbeat polls/blocks."""
    return conn.wait_heartbeat(timeout=timeout)


def _set_guided_and_arm_and_takeoff(conn: "mavutil.mavfile", alt: float) -> None:
    """Send the GUIDED/arm/takeoff sequence for one already-connected vehicle.

    These are all simple fire-and-forget MAVLink sends over UDP (no blocking
    socket reads), so unlike wait_heartbeat this is safe to call directly
    from the asyncio event loop.
    """
    # --- 1. Mode: GUIDED ---------------------------------------------------
    # ArduCopter (unlike PX4) is most reliably switched into a named flight
    # mode via the legacy MAVLink SET_MODE message, using the numeric
    # "custom mode" index from the vehicle's *own* mode_mapping() table --
    # not the newer MAV_CMD_DO_SET_MODE command_long, whose custom-mode
    # semantics vary more across ArduCopter firmware versions. pymavlink's
    # mavutil.mavfile.set_mode() wraps exactly this legacy-message approach,
    # which is what mission planners / ArduPilot's own example scripts use.
    mode_id = conn.mode_mapping()["GUIDED"]
    conn.set_mode(mode_id)

    # --- 2. Arm --------------------------------------------------------
    # arducopter_arm() is a small pymavlink convenience wrapper (specific to
    # Copter) around sending MAV_CMD_COMPONENT_ARM_DISARM via COMMAND_LONG
    # with param1=1 (arm). We don't block on motors_armed_wait() here to
    # keep init fast; arming failure (e.g. pre-arm checks) will simply show
    # up as the vehicle not climbing, visible via telemetry.
    conn.arducopter_arm()

    # --- 3. Takeoff ------------------------------------------------------
    # MAV_CMD_NAV_TAKEOFF via COMMAND_LONG. For ArduCopter, param7 is the
    # target altitude in metres, taken as relative to the home/arming
    # position (matches our sim's "alt = height above ground" contract).
    # Params 1-6 (pitch, unused x2, yaw, lat, lon) are left at 0 to mean
    # "use current heading/position".
    conn.mav.command_long_send(
        conn.target_system,
        conn.target_component,
        mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
        0,  # confirmation
        0, 0, 0, 0,  # param1-4: unused for copter takeoff
        0, 0,  # param5 (lat), param6 (lon): 0 = current position
        alt,  # param7: target altitude, metres
    )

    # --- 4. Ask for faster LOCAL_POSITION_NED so telemetry has fresh data --
    conn.mav.command_long_send(
        conn.target_system,
        conn.target_component,
        MAV_CMD_SET_MESSAGE_INTERVAL,
        0,
        mavutil.mavlink.MAVLINK_MSG_ID_LOCAL_POSITION_NED,
        LOCAL_POSITION_NED_INTERVAL_US,
        0, 0, 0, 0, 0,
    )


async def connect_vehicle(vehicle: Vehicle, websocket) -> None:
    """Open the UDP MAVLink connection for one vehicle and run its init sequence.

    Never raises on failure to heartbeat -- the vehicle is simply left with
    last_heartbeat=None (i.e. connected=False) and everything else keeps
    working, per the "graceful degradation" requirement.
    """
    # udpin: *we* bind and listen; SITL's --out=udp:host:PORT connects to us
    # as the client. This means the bridge can start before SITL does, and
    # no inbound port needs to be opened on the SITL/autopilot side.
    vehicle.conn = mavutil.mavlink_connection(f"udpin:localhost:{vehicle.port}")

    loop = asyncio.get_running_loop()
    await send_status(websocket, f"vehicle {vehicle.id}: waiting for heartbeat on udp:{vehicle.port} ...")
    try:
        hb = await loop.run_in_executor(
            None, functools.partial(_blocking_wait_heartbeat, vehicle.conn, HEARTBEAT_WAIT_TIMEOUT_S)
        )
    except Exception as exc:  # pragma: no cover - defensive, e.g. socket errors
        log.warning("vehicle %s: heartbeat wait raised %r", vehicle.id, exc)
        hb = None

    if hb is None:
        await send_status(websocket, f"vehicle {vehicle.id}: no heartbeat after {HEARTBEAT_WAIT_TIMEOUT_S}s, giving up (will keep listening)")
        return

    vehicle.last_heartbeat = loop.time()
    await send_status(websocket, f"vehicle {vehicle.id}: heartbeat OK, arming + takeoff")

    try:
        _set_guided_and_arm_and_takeoff(vehicle.conn, alt=vehicle_takeoff_alt(vehicle))
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("vehicle %s: arm/takeoff sequence raised %r", vehicle.id, exc)

    await send_status(websocket, f"vehicle {vehicle.id}: GUIDED + armed, takeoff commanded")


# The requested takeoff altitude from "init" is stashed here so
# connect_vehicle() (called per-vehicle) can read it without threading an
# extra parameter through everything above it.
_LAST_INIT_ALT = 50.0


def vehicle_takeoff_alt(_vehicle: Vehicle) -> float:
    return _LAST_INIT_ALT


async def drain_vehicle(vehicle: Vehicle) -> None:
    """Continuously drain one vehicle's incoming MAVLink queue.

    Updates `vehicle.last_heartbeat` and `vehicle.x/y/alt` (converted to sim
    frame) as new messages arrive. `recv_match(blocking=False)` performs a
    single non-blocking read attempt and returns None immediately if nothing
    is queued, so it's safe to call repeatedly from the asyncio loop without
    a thread executor.
    """
    loop = asyncio.get_running_loop()
    while True:
        conn = vehicle.conn
        if conn is not None:
            while True:
                msg = conn.recv_match(blocking=False)
                if msg is None:
                    break
                mtype = msg.get_type()
                if mtype == "HEARTBEAT":
                    vehicle.last_heartbeat = loop.time()
                elif mtype == "LOCAL_POSITION_NED":
                    x, y, alt = ned_to_sim(msg.x, msg.y, msg.z)
                    vehicle.x, vehicle.y, vehicle.alt = x, y, alt
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


def _stop_all_vehicles() -> None:
    """Cancel drain tasks and close MAVLink sockets before a re-init."""
    for task in STATE.drain_tasks:
        task.cancel()
    STATE.drain_tasks = []
    for v in STATE.vehicles.values():
        if v.conn is not None:
            try:
                v.conn.close()
            except Exception:  # pragma: no cover - best-effort cleanup
                pass
    STATE.vehicles = {}


async def handle_init(websocket, msg: dict, cli_count: Optional[int], base_port: int) -> None:
    global _LAST_INIT_ALT

    count = cli_count if cli_count is not None else int(msg.get("count", 0))
    alt = float(msg.get("alt", 50))
    _LAST_INIT_ALT = alt

    await send_status(websocket, f"bridge: initializing {count} vehicle(s), target alt {alt} m")

    _stop_all_vehicles()

    ids = []
    for i in range(count):
        vid = f"DR-{i + 1}"
        ids.append(vid)
        STATE.vehicles[vid] = Vehicle(id=vid, index=i, port=base_port + 10 * i)

    # Connect + arm/takeoff all vehicles concurrently rather than one at a
    # time, so a slow/missing vehicle doesn't stall the others' startup.
    await asyncio.gather(*(connect_vehicle(v, websocket) for v in STATE.vehicles.values()))

    # Start per-vehicle telemetry drain tasks now that connections exist.
    STATE.drain_tasks = [asyncio.create_task(drain_vehicle(v)) for v in STATE.vehicles.values()]

    n_connected = sum(1 for v in STATE.vehicles.values() if v.connected)
    await send_status(websocket, f"bridge: {n_connected}/{count} vehicles connected")
    await websocket.send(json.dumps({"type": "ready", "ids": ids}))


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
        if vehicle is None or vehicle.conn is None:
            continue  # unknown id, or vehicle never connected: ignore
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


async def handle_message(websocket, raw: str, cli_count: Optional[int], base_port: int) -> None:
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("ignoring non-JSON message: %r", raw[:200])
        return

    mtype = msg.get("type")
    if mtype == "init":
        await handle_init(websocket, msg, cli_count, base_port)
    elif mtype == "goals":
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
        STATE.clients.add(websocket)
        try:
            async for raw in websocket:
                await handle_message(websocket, raw, cli_count, base_port)
        except ConnectionClosed:
            pass
        finally:
            STATE.clients.discard(websocket)
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
        for task in STATE.drain_tasks:
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

"""test_bridge.py - mock-level tests for bridge.py's per-vehicle init machine.

Run it directly (no pytest, no dependencies, no firmware):

    python sitl/test_bridge.py            # from the repo root
    python test_bridge.py                 # from this folder
    python sitl/test_bridge.py --verbose  # keep the bridge's own log output

SCOPE, stated plainly: this is MOCK verification only. Nothing here talks to
ArduPilot, SITL, MAVLink or a real socket -- `pymavlink` and `websockets` are
replaced by stub modules injected into sys.modules *before* bridge.py is
imported, and each "vehicle" is a scripted fake autopilot that answers
whatever the bridge sends it. It proves the bridge's protocol/state-machine
behaviour (findings #12 and #13), NOT that any aircraft flies.

Scenarios
---------
1. happy path + a slow neighbour: both vehicles confirmed ready, per-vehicle
   fields in the "ready" reply, arm/takeoff COMMAND_ACKs consumed, and the
   healthy vehicle's telemetry flowing while the slow one is still waiting
   for its first heartbeat (drains are not gated on init - finding #13b).
2. arm rejected: ready:false, state "failed:arm", a status line that says
   REJECTED, and a "ready" reply that still lists the vehicle (not ready).
2b. takeoff ACCEPTED but no climb: still not ready ("failed:takeoff") -- an
   acknowledgement alone is not evidence that anything left the ground.
3. no heartbeat during init: "failed:no-heartbeat" in the reply, then a LATE
   heartbeat + ACKs recover the vehicle to ready with NO new "init"
   (finding #13a).
4. ownership: a second client's "init" while the controller's socket is open
   is refused and changes nothing; after the controller disconnects, that
   same client's "init" takes over (finding #13c).
5. ownership of goals: a non-controller's "goals" are not forwarded to any
   vehicle; the controller's are, in the documented NED frame.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import traceback
import types
from collections import deque
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

VERBOSE = "--verbose" in sys.argv or "-v" in sys.argv


# ==========================================================================
# Stub MAVLink: a fake connection whose recv_match() pops a queue the test
# fills, and which records every send.
# ==========================================================================

# MAVLink enum values used by the bridge (real numbers from the MAVLink
# common dialect, so the stub can't drift into agreeing with a typo).
MAV_CMD_NAV_TAKEOFF = 22
MAV_CMD_NAV_LAND = 21
MAV_CMD_COMPONENT_ARM_DISARM = 400
MAV_CMD_SET_MESSAGE_INTERVAL = 511
MAV_RESULT_ACCEPTED = 0
MAV_RESULT_DENIED = 2
MAV_RESULT_IN_PROGRESS = 5
MAV_MODE_FLAG_SAFETY_ARMED = 128
MAVLINK_MSG_ID_LOCAL_POSITION_NED = 32
MAV_FRAME_LOCAL_NED = 1
GUIDED_MODE_ID = 4  # ArduCopter's GUIDED custom_mode


class FakeMsg:
    """A MAVLink message: a type name plus whatever fields it carries."""

    def __init__(self, mtype: str, **fields):
        self._mtype = mtype
        for k, v in fields.items():
            setattr(self, k, v)

    def get_type(self) -> str:
        return self._mtype

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<{self._mtype} {self.__dict__}>"


def hb_msg(armed: bool = False, custom_mode: int = 0) -> FakeMsg:
    return FakeMsg(
        "HEARTBEAT",
        base_mode=(MAV_MODE_FLAG_SAFETY_ARMED if armed else 0),
        custom_mode=custom_mode,
    )


def ack_msg(command: int, result: int = MAV_RESULT_ACCEPTED) -> FakeMsg:
    return FakeMsg("COMMAND_ACK", command=command, result=result)


def pos_msg(north: float, east: float, down: float) -> FakeMsg:
    return FakeMsg("LOCAL_POSITION_NED", x=north, y=east, z=down)


def ext_state_msg(landed_state: int = 1) -> FakeMsg:
    return FakeMsg("EXTENDED_SYS_STATE", landed_state=landed_state)


class FakeMav:
    """The `.mav` send interface of a pymavlink connection."""

    def __init__(self, conn: "FakeConn"):
        self.conn = conn

    def command_long_send(self, target_system, target_component, command, confirmation, *params):
        if command == MAV_CMD_NAV_TAKEOFF:
            self.conn.sent.append(("takeoff", params[6]))  # param7 = target altitude
        elif command == MAV_CMD_NAV_LAND:
            self.conn.sent.append(("land", params))
        elif command == MAV_CMD_SET_MESSAGE_INTERVAL:
            self.conn.sent.append(("msg_interval", (params[0], params[1])))
        else:  # pragma: no cover - the bridge sends nothing else
            self.conn.sent.append((f"cmd{command}", params))

    def set_position_target_local_ned_send(
        self, time_boot_ms, target_system, target_component, frame, type_mask,
        north, east, down, vx, vy, vz, afx, afy, afz, yaw, yaw_rate,
    ):
        self.conn.sent.append(("setpoint", {"north": north, "east": east, "down": down,
                                            "frame": frame, "mask": type_mask}))


class FakeConn:
    """Stand-in for mavutil.mavlink_connection()'s return value."""

    def __init__(self, device: str):
        self.device = device
        self.inbox: deque = deque()  # messages the "vehicle" has sent us
        self.sent: list = []         # (kind, detail) of everything the bridge sent
        self.closed = False
        self.target_system = 1
        self.target_component = 1
        self.mode_map = {"STABILIZE": 0, "GUIDED": GUIDED_MODE_ID, "LOITER": 5}
        self.mav = FakeMav(self)

    # --- what the bridge calls -------------------------------------------
    def recv_match(self, blocking=False, **kwargs):
        assert blocking is False, "the bridge must never block the event loop on a socket read"
        if self.inbox:
            return self.inbox.popleft()
        return None

    def mode_mapping(self):
        return dict(self.mode_map)

    def set_mode(self, mode_id):
        self.sent.append(("set_mode", mode_id))

    def arducopter_arm(self):
        self.sent.append(("arm", None))

    def close(self):
        self.closed = True

    # --- what the test calls ---------------------------------------------
    def push(self, msg: FakeMsg) -> None:
        self.inbox.append(msg)

    def kinds(self) -> list:
        return [kind for kind, _ in self.sent]

    def count(self, kind: str) -> int:
        return sum(1 for k, _ in self.sent if k == kind)

    def details(self, kind: str) -> list:
        return [detail for k, detail in self.sent if k == kind]


CONNS: dict[str, FakeConn] = {}


def fake_mavlink_connection(device, *args, **kwargs) -> FakeConn:
    conn = CONNS.get(device)
    if conn is None:
        conn = FakeConn(device)
        CONNS[device] = conn
    return conn


def conn_for(port: int) -> FakeConn:
    """The connection the bridge will get (or already got) for `port`."""
    return fake_mavlink_connection(f"udpin:localhost:{port}")


class ConnectionClosed(Exception):
    """Stub of websockets.exceptions.ConnectionClosed."""


BROADCASTS: list = []


def _install_stubs() -> None:
    """Inject stub `pymavlink` and `websockets` modules before importing bridge."""
    mavlink = types.SimpleNamespace(
        MAV_CMD_NAV_TAKEOFF=MAV_CMD_NAV_TAKEOFF,
        MAV_CMD_COMPONENT_ARM_DISARM=MAV_CMD_COMPONENT_ARM_DISARM,
        MAV_RESULT_ACCEPTED=MAV_RESULT_ACCEPTED,
        MAV_RESULT_IN_PROGRESS=MAV_RESULT_IN_PROGRESS,
        MAV_MODE_FLAG_SAFETY_ARMED=MAV_MODE_FLAG_SAFETY_ARMED,
        MAVLINK_MSG_ID_LOCAL_POSITION_NED=MAVLINK_MSG_ID_LOCAL_POSITION_NED,
        MAV_FRAME_LOCAL_NED=MAV_FRAME_LOCAL_NED,
    )
    mavutil = types.ModuleType("pymavlink.mavutil")
    mavutil.mavlink = mavlink
    mavutil.mavlink_connection = fake_mavlink_connection
    mavutil.mavfile = FakeConn  # only referenced as a string annotation
    pymavlink = types.ModuleType("pymavlink")
    pymavlink.__path__ = []
    pymavlink.mavutil = mavutil
    sys.modules["pymavlink"] = pymavlink
    sys.modules["pymavlink.mavutil"] = mavutil

    def serve(*args, **kwargs):  # pragma: no cover - the socket server isn't exercised
        raise NotImplementedError("serve() is out of scope for the mock tests")

    def broadcast(clients, message):
        BROADCASTS.append(message)
        for client in list(clients):
            client.messages.append(message)

    ws_server = types.ModuleType("websockets.asyncio.server")
    ws_server.serve = serve
    ws_server.broadcast = broadcast
    ws_asyncio = types.ModuleType("websockets.asyncio")
    ws_asyncio.__path__ = []
    ws_asyncio.server = ws_server
    ws_exceptions = types.ModuleType("websockets.exceptions")
    ws_exceptions.ConnectionClosed = ConnectionClosed
    websockets = types.ModuleType("websockets")
    websockets.__path__ = []
    websockets.asyncio = ws_asyncio
    websockets.exceptions = ws_exceptions
    sys.modules["websockets"] = websockets
    sys.modules["websockets.asyncio"] = ws_asyncio
    sys.modules["websockets.asyncio.server"] = ws_server
    sys.modules["websockets.exceptions"] = ws_exceptions


_install_stubs()

import bridge  # noqa: E402  (must follow the stub injection)

if not VERBOSE:
    logging.getLogger("bridge").setLevel(logging.CRITICAL)


# ==========================================================================
# Test doubles for the browser side and the vehicle side
# ==========================================================================

class FakeWebsocket:
    """Collects everything the bridge sends this client."""

    def __init__(self, name: str):
        self.name = name
        self.messages: list = []  # raw JSON strings (direct sends and broadcasts)
        self.closed = False

    async def send(self, raw: str) -> None:
        if self.closed:
            raise ConnectionClosed(self.name)
        self.messages.append(raw)

    # --- assertions helpers ----------------------------------------------
    def of_type(self, mtype: str) -> list:
        out = []
        for raw in self.messages:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:  # pragma: no cover
                continue
            if msg.get("type") == mtype:
                out.append(msg)
        return out

    def statuses(self) -> list:
        return [m["msg"] for m in self.of_type("status")]

    def said(self, needle: str) -> bool:
        return any(needle in s for s in self.statuses())

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<FakeWebsocket {self.name}>"


class FakeAutopilot:
    """A scripted vehicle: on each tick it answers whatever the bridge sent.

    Everything is driven by explicit ticks and queued messages -- there are
    no wall-clock waits in the vehicle model, so the scenarios stay
    deterministic. `gate` (if given) holds the whole vehicle silent until the
    test opens it, which is how "slow to boot" and "starts long after init"
    are expressed.
    """

    TICK_DT = 0.005

    def __init__(
        self,
        conn: FakeConn,
        *,
        gate: asyncio.Event = None,
        heartbeats: bool = True,
        accept_mode: bool = True,
        arm_result: int = MAV_RESULT_ACCEPTED,
        takeoff_result: int = MAV_RESULT_ACCEPTED,
        climbs: bool = True,
        climb_per_tick: float = 0.6,
        north: float = 0.0,
        east: float = 0.0,
        target_alt: float = 30.0,
    ):
        self.conn = conn
        self.gate = gate
        self.heartbeats = heartbeats
        self.accept_mode = accept_mode
        self.arm_result = arm_result
        self.takeoff_result = takeoff_result
        self.climbs = climbs
        self.climb_per_tick = climb_per_tick
        self.north = north
        self.east = east
        self.target_alt = target_alt

        self.armed = False
        self.mode = 0
        self.alt = 0.0
        self.climbing = False
        self.ticks = 0
        self._seen = 0

    def tick(self) -> None:
        self.ticks += 1
        while self._seen < len(self.conn.sent):
            kind, detail = self.conn.sent[self._seen]
            self._seen += 1
            if kind == "set_mode":
                if self.accept_mode:
                    self.mode = detail
            elif kind == "arm":
                self.conn.push(ack_msg(MAV_CMD_COMPONENT_ARM_DISARM, self.arm_result))
                if self.arm_result == MAV_RESULT_ACCEPTED:
                    self.armed = True
            elif kind == "takeoff":
                self.conn.push(ack_msg(MAV_CMD_NAV_TAKEOFF, self.takeoff_result))
                if self.takeoff_result == MAV_RESULT_ACCEPTED and self.climbs:
                    self.climbing = True
        if self.climbing and self.alt < self.target_alt:
            self.alt = min(self.target_alt, self.alt + self.climb_per_tick)
        if self.heartbeats:
            self.conn.push(hb_msg(armed=self.armed, custom_mode=self.mode))
        self.conn.push(pos_msg(self.north, self.east, -self.alt))

    async def run(self, stop: asyncio.Event) -> None:
        if self.gate is not None:
            await self.gate.wait()
        while not stop.is_set():
            self.tick()
            await asyncio.sleep(self.TICK_DT)


# ==========================================================================
# Harness helpers
# ==========================================================================

class Harness:
    """Per-scenario bridge reset + task bookkeeping."""

    def __init__(self):
        CONNS.clear()
        BROADCASTS.clear()
        bridge.STATE = bridge.State()  # fresh vehicles/clients/controller/lock per scenario
        # Patch the module's timing constants down so scenarios stay short.
        # These are the failure-path bounds; the happy paths are event-driven
        # and never wait for them.
        bridge.DRAIN_POLL_DT = 0.005
        bridge.TELEMETRY_DT = 0.01
        bridge.HEARTBEAT_STALE_S = 1.0
        bridge.HEARTBEAT_WAIT_TIMEOUT_S = 2.0
        bridge.INIT_STEP_TIMEOUT_S = 1.0
        bridge.STEP_RESEND_DT = 0.5
        bridge.RETRY_COOLDOWN_S = 5.0
        bridge.INIT_EXTRA_WAIT_S = 2.0
        self.stop = asyncio.Event()
        self.tasks: list = []

    def autopilot(self, port: int, **kwargs) -> FakeAutopilot:
        ap = FakeAutopilot(conn_for(port), **kwargs)
        self.tasks.append(asyncio.create_task(ap.run(self.stop)))
        return ap

    def telemetry(self) -> None:
        self.tasks.append(asyncio.create_task(bridge.telemetry_loop()))

    def client(self, name: str) -> FakeWebsocket:
        ws = FakeWebsocket(name)
        bridge.client_connected(ws)
        return ws

    def init(self, ws: FakeWebsocket, count: int, alt: float, base_port: int = 14550) -> asyncio.Task:
        """Send an "init" through the real message dispatcher, concurrently."""
        raw = json.dumps({"type": "init", "count": count, "alt": alt})
        return asyncio.create_task(bridge.handle_message(ws, raw, None, base_port))

    async def close(self) -> None:
        self.stop.set()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await bridge._stop_all_vehicles()


async def wait_until(pred, timeout: float = 3.0, tick: float = 0.005) -> bool:
    """Poll `pred` until true. The timeout is a hang guard, not a delay."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        if pred():
            return True
        await asyncio.sleep(tick)
    return bool(pred())


def vehicle(vid: str):
    return bridge.STATE.vehicles[vid]


def ready_entry(reply: dict, vid: str) -> dict:
    for entry in reply["vehicles"]:
        if entry["id"] == vid:
            return entry
    raise AssertionError(f"{vid} missing from ready reply {reply}")


async def ready_reply(ws: FakeWebsocket, init_task: asyncio.Task, timeout: float = 5.0) -> dict:
    await asyncio.wait_for(init_task, timeout)
    replies = ws.of_type("ready")
    assert replies, f"{ws.name} never got a 'ready' reply"
    return replies[-1]


# ==========================================================================
# Scenario 1 - happy path, per-vehicle readiness, drains not gated on init
# ==========================================================================

async def scenario_happy_path() -> None:
    h = Harness()
    ws = h.client("browser-1")
    h.telemetry()

    ap1 = h.autopilot(14550, east=12.0, north=-8.0, target_alt=30.0)  # healthy
    slow_gate = asyncio.Event()
    h.autopilot(14560, gate=slow_gate, target_alt=30.0)  # silent until the test says go

    init_task = h.init(ws, count=2, alt=30.0)

    assert await wait_until(lambda: len(bridge.STATE.vehicles) == 2), "init must build the fleet first"
    assert await wait_until(lambda: vehicle("DR-1").ready), "healthy vehicle never reached ready"

    # --- finding #13b: DR-1 is flying and streaming while DR-2 hasn't even
    # produced a heartbeat, and the init reply is still outstanding. The short
    # timeout matters: telemetry must not merely arrive eventually, it must
    # arrive while the slow vehicle is STILL unresolved.
    assert await wait_until(lambda: len(ws.of_type("telemetry")) >= 3, timeout=0.5), (
        "telemetry must flow while a neighbour is still initializing"
    )
    assert not init_task.done(), "'ready' must not be sent before the slow vehicle resolves"
    assert vehicle("DR-2").init_state == bridge.INIT_WAIT_HEARTBEAT, vehicle("DR-2").init_state
    assert not vehicle("DR-2").ready

    telem = ws.of_type("telemetry")[-1]
    assert set(telem) == {"type", "t", "vehicles"}, telem  # browser (external.js) reads m.t / m.vehicles
    assert isinstance(telem["t"], float)
    by_id = {v["id"]: v for v in telem["vehicles"]}
    assert set(by_id) == {"DR-1", "DR-2"}, by_id
    assert set(by_id["DR-1"]) == {
        "id", "x", "y", "alt", "connected", "ready", "state", "positionAge", "positionSeq",
        "armed", "heartbeatAge", "landed", "landedAge", "landedSeq", "serviceId",
        "servicePhase", "origin",
    }, by_id["DR-1"]
    assert by_id["DR-1"]["ready"] is True and by_id["DR-1"]["state"] == "ready"
    assert 0 <= by_id["DR-1"]["positionAge"] < bridge.POSITION_STALE_S
    assert by_id["DR-1"]["positionSeq"] > 0
    assert by_id["DR-2"]["ready"] is False and by_id["DR-2"]["state"] == "wait-heartbeat"
    assert by_id["DR-2"]["positionAge"] is None and by_id["DR-2"]["positionSeq"] == 0
    assert by_id["DR-1"]["connected"] is True
    assert by_id["DR-1"]["alt"] > 1.0, by_id["DR-1"]
    assert abs(by_id["DR-1"]["x"] - 12.0) < 1e-9 and abs(by_id["DR-1"]["y"] - 8.0) < 1e-9, by_id["DR-1"]
    assert by_id["DR-2"]["connected"] is False, by_id["DR-2"]

    # --- readiness was CONFIRMED, not assumed (finding #12) ---------------
    c1 = conn_for(14550)
    assert c1.count("set_mode") == 1 and c1.details("set_mode") == [GUIDED_MODE_ID], c1.sent
    assert c1.count("arm") == 1, c1.sent
    assert c1.count("takeoff") == 1, c1.sent
    assert c1.details("takeoff") == [30.0], c1.sent
    assert c1.count("msg_interval") == 2 and (32, 100000) in c1.details("msg_interval") \
        and (245, 100000) in c1.details("msg_interval"), c1.sent
    kinds = c1.kinds()
    assert kinds.index("set_mode") < kinds.index("arm") < kinds.index("takeoff"), kinds
    v1 = vehicle("DR-1")
    assert v1.acks[MAV_CMD_COMPONENT_ARM_DISARM] == MAV_RESULT_ACCEPTED, v1.acks
    assert v1.acks[MAV_CMD_NAV_TAKEOFF] == MAV_RESULT_ACCEPTED, v1.acks
    assert v1.armed and v1.mode_confirmed and v1.airborne
    assert ap1.armed and ap1.mode == GUIDED_MODE_ID

    # --- now let the slow vehicle boot; it must finish on its own ---------
    slow_gate.set()
    reply = await ready_reply(ws, init_task)

    assert reply["ids"] == ["DR-1", "DR-2"], reply  # browser compat: flat id list kept
    assert ready_entry(reply, "DR-1") == {"id": "DR-1", "ready": True, "state": "ready"}, reply
    assert ready_entry(reply, "DR-2") == {"id": "DR-2", "ready": True, "state": "ready"}, reply
    assert ws.said("DR-1: airborne"), ws.statuses()
    assert ws.said("2/2 vehicles confirmed ready"), ws.statuses()
    assert bridge.STATE.controller is ws

    await h.close()


# ==========================================================================
# Scenario 2 - arm rejected: reported as not ready, and said out loud
# ==========================================================================

async def scenario_arm_rejected() -> None:
    h = Harness()
    ws = h.client("browser-1")

    h.autopilot(14550, target_alt=25.0)  # DR-1 healthy
    h.autopilot(14560, arm_result=MAV_RESULT_DENIED, climbs=False)  # DR-2 refuses to arm

    init_task = h.init(ws, count=2, alt=25.0)
    reply = await ready_reply(ws, init_task)

    good = ready_entry(reply, "DR-1")
    bad = ready_entry(reply, "DR-2")
    assert good == {"id": "DR-1", "ready": True, "state": "ready"}, reply
    assert bad["ready"] is False, reply
    assert "arm" in bad["state"], reply  # "failed:arm"
    assert bad["state"].startswith(bridge.FAILED_PREFIX), reply
    assert reply["ids"] == ["DR-1", "DR-2"], reply  # still listed, just not ready

    assert ws.said("DR-2: arm REJECTED"), ws.statuses()
    assert ws.said("DENIED"), ws.statuses()
    assert not ws.said("DR-2: airborne"), ws.statuses()
    assert ws.said("1/2 vehicles confirmed ready"), ws.statuses()

    # A vehicle that never armed is never taken off.
    c2 = conn_for(14560)
    assert c2.count("arm") >= 1, c2.sent
    assert c2.count("takeoff") == 0, c2.sent
    assert vehicle("DR-2").ready is False

    await h.close()


# ==========================================================================
# Scenario 2b - takeoff acknowledged but the vehicle never leaves the ground
# ==========================================================================

async def scenario_takeoff_never_climbs() -> None:
    h = Harness()
    ws = h.client("browser-1")
    bridge.INIT_STEP_TIMEOUT_S = 0.3  # the climb never comes; fail that step quickly

    # Arms, ACCEPTs the takeoff command... and sits on the ground.
    ap = h.autopilot(14550, climbs=False)

    reply = await ready_reply(ws, h.init(ws, count=1, alt=35.0))

    entry = ready_entry(reply, "DR-1")
    assert entry["ready"] is False, reply
    assert entry["state"] == bridge.FAILED_PREFIX + "takeoff", reply
    assert ap.armed, "the arm step itself succeeded"
    assert conn_for(14550).count("takeoff") == 1, conn_for(14550).sent
    assert vehicle("DR-1").acks[MAV_CMD_NAV_TAKEOFF] == MAV_RESULT_ACCEPTED, "the ACK was accepted..."
    assert vehicle("DR-1").alt == 0.0, "...but nothing climbed"
    assert ws.said("DR-1: takeoff UNCONFIRMED"), ws.statuses()
    assert not ws.said("DR-1: airborne"), ws.statuses()

    await h.close()


# ==========================================================================
# Scenario 3 - no heartbeat during init, then independent late recovery
# ==========================================================================

async def scenario_late_vehicle_recovers() -> None:
    h = Harness()
    ws = h.client("browser-1")
    h.telemetry()
    bridge.HEARTBEAT_WAIT_TIMEOUT_S = 0.1  # fail the first pass quickly
    bridge.INIT_EXTRA_WAIT_S = 0.5

    conn_for(14550)  # the socket exists; nothing is ever sent on it (yet)
    init_task = h.init(ws, count=1, alt=20.0)
    reply = await ready_reply(ws, init_task)

    entry = ready_entry(reply, "DR-1")
    assert entry["ready"] is False, reply
    assert entry["state"] == bridge.FAILED_PREFIX + "no-heartbeat", reply
    assert ws.said("DR-1: NO heartbeat"), ws.statuses()
    assert conn_for(14550).count("arm") == 0, "nothing may be commanded to a silent vehicle"
    assert ws.said("0/1 vehicles confirmed ready"), ws.statuses()
    assert await wait_until(lambda: any(
        m["vehicles"][0].get("state") == "failed:no-heartbeat"
        for m in ws.of_type("telemetry")
    ))
    telem = ws.of_type("telemetry")[-1]["vehicles"][0]
    assert telem["ready"] is False and telem["state"] == "failed:no-heartbeat"
    assert telem["positionAge"] is None and telem["positionSeq"] == 0, telem

    # --- finding #13a: the vehicle boots LATE. No new "init" is sent; the
    # vehicle's own task must notice the heartbeat and run the sequence.
    n_init_msgs = len(ws.of_type("ready"))
    ap = h.autopilot(14550, target_alt=20.0)

    assert await wait_until(lambda: vehicle("DR-1").ready), (
        f"late vehicle never recovered (state={vehicle('DR-1').init_state})"
    )
    assert ap.armed and ap.mode == GUIDED_MODE_ID
    assert conn_for(14550).count("takeoff") == 1, conn_for(14550).sent
    assert conn_for(14550).details("takeoff") == [20.0]  # per-vehicle alt, not a global
    assert vehicle("DR-1").init_state == bridge.INIT_READY
    assert await wait_until(lambda: any(
        m["vehicles"][0].get("ready") is True
        for m in ws.of_type("telemetry")
    ))
    telem = ws.of_type("telemetry")[-1]["vehicles"][0]
    assert telem["ready"] is True and telem["state"] == "ready"
    assert 0 <= telem["positionAge"] < bridge.POSITION_STALE_S
    assert telem["positionSeq"] > 0
    assert len(ws.of_type("ready")) == n_init_msgs, "recovery must not fake a second 'ready' reply"
    assert ws.said("DR-1: airborne"), ws.statuses()

    await h.close()


# ==========================================================================
# Scenario 4 - a second client cannot stomp the controller's fleet
# ==========================================================================

async def scenario_second_client_blocked() -> None:
    h = Harness()
    ws1 = h.client("browser-1")
    h.autopilot(14550, target_alt=40.0)

    reply1 = await ready_reply(ws1, h.init(ws1, count=1, alt=40.0))
    assert ready_entry(reply1, "DR-1")["ready"] is True, reply1
    assert bridge.STATE.controller is ws1
    fleet_before = dict(bridge.STATE.vehicles)
    v1_before = fleet_before["DR-1"]

    # --- an unrelated browser tab tries to re-init the fleet mid-flight ---
    ws2 = h.client("browser-2")
    await bridge.handle_message(ws2, json.dumps({"type": "init", "count": 3, "alt": 5}), None, 14550)

    assert ws2.said("bridge is controlled by another client"), ws2.statuses()
    assert not ws2.of_type("ready"), "a refused init must not get a ready reply"
    assert list(bridge.STATE.vehicles) == ["DR-1"], bridge.STATE.vehicles
    assert bridge.STATE.vehicles["DR-1"] is v1_before, "the flying fleet was rebuilt"
    assert v1_before.ready and v1_before.takeoff_alt == 40.0
    assert conn_for(14550).closed is False
    assert bridge.STATE.controller is ws1

    # --- the controller goes away: the fleet keeps flying, control frees up
    bridge.client_disconnected(ws1)
    assert bridge.STATE.controller is None
    assert bridge.STATE.vehicles["DR-1"] is v1_before

    h.autopilot(14560, target_alt=15.0)
    reply2 = await ready_reply(ws2, h.init(ws2, count=2, alt=15.0))
    assert bridge.STATE.controller is ws2
    assert reply2["ids"] == ["DR-1", "DR-2"], reply2
    assert ready_entry(reply2, "DR-1")["ready"] is True, reply2
    assert ready_entry(reply2, "DR-2")["ready"] is True, reply2
    assert bridge.STATE.vehicles["DR-1"] is not v1_before, "takeover must rebuild the fleet"
    assert bridge.STATE.vehicles["DR-1"].takeoff_alt == 15.0

    await h.close()


# ==========================================================================
# Scenario 5 - goals are only accepted from the controlling client
# ==========================================================================

async def scenario_goals_ownership() -> None:
    h = Harness()
    ws1 = h.client("browser-1")
    h.autopilot(14550, target_alt=50.0)
    await ready_reply(ws1, h.init(ws1, count=1, alt=50.0))

    c1 = conn_for(14550)
    ws2 = h.client("browser-2")
    goals = json.dumps({"type": "goals", "goals": [{"id": "DR-1", "x": 10.0, "y": 4.0, "alt": 25.0}]})

    await bridge.handle_message(ws2, goals, None, 14550)
    assert c1.count("setpoint") == 0, c1.details("setpoint")
    assert ws2.said("bridge is controlled by another client"), ws2.statuses()

    # The controller's identical message IS forwarded, in the documented frame.
    await bridge.handle_message(ws1, goals, None, 14550)
    assert c1.count("setpoint") == 1, c1.details("setpoint")
    sp = c1.details("setpoint")[0]
    assert sp["north"] == -4.0 and sp["east"] == 10.0 and sp["down"] == -25.0, sp
    assert sp["frame"] == MAV_FRAME_LOCAL_NED and sp["mask"] == bridge.POSITION_TARGET_TYPEMASK, sp

    bridge.client_disconnected(ws1)
    ws3 = h.client("browser-3")
    for watcher in (ws2, ws3):
        await bridge.handle_message(watcher, goals, None, 14550)
        assert c1.count("setpoint") == 1, c1.details("setpoint")
        assert bridge.STATE.controller is None
    assert bridge.STATE.vehicles["DR-1"].conn is c1

    await ready_reply(ws2, h.init(ws2, count=1, alt=50.0))
    await bridge.handle_message(ws3, goals, None, 14550)
    assert c1.count("setpoint") == 1, c1.details("setpoint")
    await bridge.handle_message(ws2, goals, None, 14550)
    assert bridge.STATE.controller is ws2
    assert c1.count("setpoint") == 2, c1.details("setpoint")

    await h.close()


# ==========================================================================
# Runner
# ==========================================================================

class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


async def dispatch_goals(ws):
    await bridge.handle_message(ws, json.dumps({
        "type": "goals",
        "goals": [{"id": "DR-1", "x": 10.0, "y": 4.0, "alt": 25.0}],
    }), None, 14550)


def current_vehicle():
    conn = conn_for(14550)
    v = bridge.Vehicle(id="DR-1", index=0, port=14550, conn=conn,
                       guided_mode_id=GUIDED_MODE_ID)
    bridge.STATE.vehicles[v.id] = v
    conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
    conn.push(pos_msg(-8.0, 12.0, -30.0))
    bridge._drain_messages(v)
    v.ready = True
    v.init_state = bridge.INIT_READY
    return v

async def scenario_goal_safety_gates():
    h = Harness()
    ws = h.client("controller")
    await h.init(ws, count=0, alt=30.0)
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        conn = v.conn
        await dispatch_goals(ws)
        assert conn.count("setpoint") == 1
        for state in (bridge.INIT_WAIT_HEARTBEAT, bridge.INIT_CONFIRM_MODE,
                      bridge.INIT_CONFIRM_ARM, bridge.INIT_CONFIRM_TAKEOFF,
                      "failed:arm", "failed:takeoff", "failed:no-heartbeat"):
            v.init_state = state
            v.ready = False
            await dispatch_goals(ws)
            assert conn.count("setpoint") == 1, f"goal escaped during {state}"
        v.init_state = bridge.INIT_READY
        await dispatch_goals(ws)
        assert conn.count("setpoint") == 1, "ready flag required"
        v.ready = True
        v.init_state = bridge.INIT_CONFIRM_TAKEOFF
        await dispatch_goals(ws)
        assert conn.count("setpoint") == 1, "READY state required"
        v.init_state = bridge.INIT_READY
        for field, value in (("last_heartbeat", None), ("base_mode", 0),
                             ("custom_mode", 5), ("custom_mode", None),
                             ("guided_mode_id", None), ("conn", None)):
            original = getattr(v, field)
            setattr(v, field, value)
            await dispatch_goals(ws)
            assert conn.count("setpoint") == 1, f"goal escaped with {field}={value}"
            setattr(v, field, original)
        clock.now = bridge.HEARTBEAT_STALE_S
        conn.push(pos_msg(-8.0, 12.0, -30.0))
        bridge._drain_messages(v)
        await dispatch_goals(ws)
        assert conn.count("setpoint") == 1, "stale heartbeat allowed a goal"
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        bridge._drain_messages(v)
        await dispatch_goals(ws)
        assert conn.count("setpoint") == 2
        clock.now += bridge.POSITION_STALE_S
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        bridge._drain_messages(v)
        assert v.connected
        await dispatch_goals(ws)
        assert conn.count("setpoint") == 2, "fresh heartbeat concealed stale position"
        conn.push(pos_msg(-8.0, 12.0, -30.0))
        bridge._drain_messages(v)
        await dispatch_goals(ws)
        assert conn.count("setpoint") == 3
        v.last_position = None
        await dispatch_goals(ws)
        assert conn.count("setpoint") == 3, "never-seen position allowed a goal"
        assert conn.details("setpoint")[-1] == {
            "north": -4.0, "east": 10.0, "down": -25.0,
            "frame": MAV_FRAME_LOCAL_NED, "mask": bridge.POSITION_TARGET_TYPEMASK,
        }
        v.service_phase = "landing"
        await dispatch_goals(ws)
        assert conn.count("setpoint") == 3, "goals must stop during a landing service"
    await h.close()


async def scenario_position_receipt_clock():
    h = Harness()
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = bridge.Vehicle(id="DR-1", index=0, port=14550, conn=conn_for(14550))
        assert v.to_telemetry().get("positionAge", "missing") is None
        assert v.to_telemetry()["positionSeq"] == 0
        assert not v.position_fresh
        v.alt = 30.0
        assert not v.airborne, "cached altitude without a sample is not airborne evidence"
        v.conn.push(hb_msg())
        v.conn.push(ack_msg(MAV_CMD_NAV_TAKEOFF))
        bridge._drain_messages(v)
        assert v.last_position is None
        assert v.to_telemetry()["positionSeq"] == 0
        v.conn.push(pos_msg(-8.0, 12.0, -30.0))
        bridge._drain_messages(v)
        assert v.last_position == 0.0
        assert v.position_fresh and v.airborne
        first = v.to_telemetry()
        assert first["positionAge"] == 0.0 and first["positionSeq"] == 1
        assert (first["x"], first["y"], first["alt"]) == (12.0, 8.0, 30.0)
        clock.now = bridge.POSITION_STALE_S - 0.01
        assert v.position_fresh
        clock.now = bridge.POSITION_STALE_S
        v.conn.push(hb_msg())
        v.conn.push(ack_msg(MAV_CMD_NAV_TAKEOFF))
        bridge._drain_messages(v)
        assert v.connected and not v.position_fresh and not v.airborne
        stale = v.to_telemetry()
        assert stale["positionAge"] == bridge.POSITION_STALE_S
        assert stale["positionSeq"] == 1 and v.last_position == 0.0
        assert v.to_telemetry() == stale, "serialization must not advance the sample"
        for _ in range(2):
            v.conn.push(pos_msg(-8.0, 12.0, -30.0))
        bridge._drain_messages(v)
        assert v.position_fresh and v.airborne
        assert v.to_telemetry()["positionSeq"] == 3
        assert v.to_telemetry()["positionAge"] == 0.0
    await h.close()


async def scenario_stale_climb_cannot_confirm():
    h = Harness()
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        clock.now = 10.0
        v.conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        v.conn.push(ack_msg(MAV_CMD_NAV_TAKEOFF))
        bridge._drain_messages(v)
        v.ready = False
        v.init_state = bridge.INIT_CONFIRM_TAKEOFF
        v.step_started_at = clock.now
        v.step_sent_at = clock.now
        await bridge._advance_init(v)
        assert not v.ready, "stale climb confirmed takeoff"
        v.init_state = "failed:takeoff"
        v.failed_at = 0.0
        await bridge._advance_init(v)
        assert not v.ready and v.init_state == bridge.INIT_CONFIRM_TAKEOFF
        v.conn.push(ack_msg(MAV_CMD_NAV_TAKEOFF))
        v.conn.push(pos_msg(0.0, 0.0, -30.0))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.ready and v.init_state == bridge.INIT_READY
    await h.close()


async def scenario_init_disconnect_races():
    for phase in ("lock", "status", "stop", "first-pass", "summary"):
        h = Harness()
        ws = h.client("departing")
        watcher = h.client("watcher")
        entered = asyncio.Event()
        release = asyncio.Event()
        original_send = ws.send
        original_stop = bridge._stop_all_vehicles

        async def send(raw):
            msg = json.loads(raw)
            should_pause = msg["type"] == "status" and (
                (phase == "status" and "initializing" in msg["msg"])
                or (phase == "summary" and "confirmed ready" in msg["msg"]))
            if should_pause:
                entered.set()
                await release.wait()
            await original_send(raw)

        async def stop():
            await original_stop()
            if phase == "stop":
                entered.set()
                await release.wait()

        ws.send = send
        with patch.object(bridge, "_stop_all_vehicles", stop):
            if phase == "lock":
                await bridge.STATE.init_lock.acquire()
            task = h.init(ws, count=1 if phase == "first-pass" else 0, alt=30.0)
            if phase == "lock":
                await asyncio.sleep(0)
            elif phase == "first-pass":
                assert await wait_until(lambda: "DR-1" in bridge.STATE.vehicles)
            else:
                await asyncio.wait_for(entered.wait(), 1.0)
            bridge.client_disconnected(ws)
            await dispatch_goals(watcher)
            assert bridge.STATE.controller is None, phase
            if phase == "lock":
                bridge.STATE.init_lock.release()
            elif phase == "first-pass":
                vehicle("DR-1").first_pass_done.set()
            release.set()
            await asyncio.wait_for(task, 1.0)
            assert bridge.STATE.controller is None, f"departed client acquired during {phase}"
            assert not ws.of_type("ready"), f"departed client got ready during {phase}"
            if phase in ("lock", "status", "stop"):
                assert not bridge.STATE.vehicles and not bridge.STATE.vehicle_tasks, phase
        await ready_reply(watcher, h.init(watcher, count=0, alt=30.0))
        assert bridge.STATE.controller is watcher
        await h.close()


async def scenario_controller_checks_after_awaits():
    h = Harness()
    first = h.client("first-watcher")
    second = h.client("second-watcher")
    await bridge.STATE.init_lock.acquire()
    first_init = h.init(first, count=0, alt=30.0)
    second_init = h.init(second, count=0, alt=30.0)
    await asyncio.sleep(0)
    bridge.STATE.init_lock.release()
    await asyncio.gather(first_init, second_init)
    assert bridge.STATE.controller is first
    assert first.of_type("ready") and not second.of_type("ready")
    assert second.said("bridge is controlled by another client")
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        original_check = bridge._may_control

        async def check(ws, **kwargs):
            allowed = await original_check(ws, **kwargs)
            await asyncio.sleep(0)
            bridge.client_disconnected(ws)
            return allowed

        with patch.object(bridge, "_may_control", check):
            await dispatch_goals(first)
        assert v.conn.count("setpoint") == 0, "dispatcher used ownership from before await"
        assert bridge.STATE.controller is None
    await h.close()


async def scenario_disconnected_controller_rejected():
    h = Harness()
    ws = h.client("departing")
    await h.init(ws, count=0, alt=30.0)
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        bridge.STATE.clients.discard(ws)
        await dispatch_goals(ws)
        assert v.conn.count("setpoint") == 0, "controller identity without membership allowed goals"
        await h.init(ws, count=0, alt=30.0)
        assert bridge.STATE.vehicles.get(v.id) is v, "disconnected init rebuilt fleet"
    await h.close()


async def scenario_origin_round_trip():
    """F05: goals go out origin-relative and positions come back origin-relative."""
    h = Harness()
    ws = h.client("controller")
    await h.init(ws, count=0, alt=30.0)
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        v.origin = {"frame": "common-local-origin", "x": 1000.0, "y": 500.0, "groundM": 250.0}
        await bridge.handle_message(ws, json.dumps({
            "type": "goals",
            "goals": [{"id": "DR-1", "x": 10.0, "y": 4.0, "alt": 25.0}],
        }), None, 14550)
        assert v.conn.details("setpoint") == [{
            "north": -4.0, "east": 10.0, "down": -25.0,
            "frame": MAV_FRAME_LOCAL_NED, "mask": bridge.POSITION_TARGET_TYPEMASK,
        }], v.conn.details("setpoint")
        v.conn.push(pos_msg(-8.0, 12.0, -280.0))
        bridge._drain_messages(v)
        telem = v.to_telemetry()
        assert (telem["x"], telem["y"], telem["alt"]) == (12.0, 8.0, 280.0), telem
        assert telem["origin"] == v.origin
    await h.close()


async def scenario_land_service_handshake():
    """F04: the explicit land->landed->swap->relaunch machine on the bridge."""
    h = Harness()
    ws = h.client("controller")
    await h.init(ws, count=0, alt=30.0)
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        conn = v.conn
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-1", "action": "land",
        }), None, 14550)
        assert conn.details("land") == [(0, 0, 0, 0, 0, 0, 0)], conn.sent
        assert v.service_phase == "landing" and not v.ready and v.init_state == "landing"
        await dispatch_goals(ws)
        assert conn.count("setpoint") == 0, "a landing vehicle must not receive goals"
        fresh = 0.0
        landed_seen = False
        while clock.now - fresh < bridge.INIT_STEP_TIMEOUT_S:
            clock.now += 0.1
            conn.push(hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
            conn.push(pos_msg(0.0, 0.0, -0.2))
            conn.push(ext_state_msg(1))
            bridge._drain_messages(v)
            await bridge._advance_init(v)
            if v.service_phase == "landed":
                landed_seen = True
                break
        assert landed_seen and v.service_phase == "landed" and v.init_state == "landed", v.service_phase
        fresh = clock.now
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-1", "action": "authorize",
        }), None, 14550)
        assert v.service_phase == "swapping" and v.init_state == "swapping"
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-1", "action": "complete",
        }), None, 14550)
        assert v.service_phase == "swapped" and v.init_state == "swapped"
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-1", "action": "relaunch",
            "alt": 45.0,
        }), None, 14550)
        assert v.service_phase == "relaunch" and v.init_state == bridge.INIT_CONFIRM_MODE
        assert v.takeoff_alt == 45.0 and v.launch_alt == 0.2
        clock.now += 0.1
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == bridge.INIT_CONFIRM_ARM, v.init_state
        clock.now += 0.1
        conn.push(ack_msg(MAV_CMD_COMPONENT_ARM_DISARM))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == bridge.INIT_CONFIRM_TAKEOFF, v.init_state
        clock.now += 0.1
        conn.push(ack_msg(MAV_CMD_NAV_TAKEOFF))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert not v.ready and v.init_state == bridge.INIT_CONFIRM_TAKEOFF, "no climb, no ready"
        clock.now += 0.1
        conn.push(pos_msg(0.0, 0.0, -1.5))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.ready and v.init_state == bridge.INIT_READY, v.init_state
        assert v.service_phase is None, f"relaunch left phase {v.service_phase}; goals would be blocked forever"
        await dispatch_goals(ws)
        assert conn.count("setpoint") == 1, "post-relaunch vehicle must accept mission goals again"
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-2", "action": "land",
        }), None, 14550)
        assert v.service_phase == "landing", "a fresh request id after completion must be accepted"
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-2", "action": "land",
        }), None, 14550)
        assert v.service_phase == "landing", "a replayed request id re-ran the service"
    await h.close()


async def scenario_service_gates_fraud():
    """F04: hover, missing landed bit, stale samples and bad relaunch are refused."""
    h = Harness()
    ws = h.client("controller")
    await h.init(ws, count=0, alt=30.0)
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        conn = v.conn
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-1", "action": "land",
        }), None, 14550)
        assert v.service_phase == "landing"
        clock.now = 0.5
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, -0.2))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.service_phase == "landing", "disarmed evidence is required"
        clock.now = 0.5
        conn.push(hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, -0.2))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.service_phase == "landing", "EXTENDED_SYS_STATE landed is required"
        clock.now = 0.6
        conn.push(hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, -0.2))
        conn.push(ext_state_msg(1))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.service_phase == "landed", v.service_phase
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-1", "action": "authorize",
        }), None, 14550)
        assert v.service_phase == "swapping"
        clock.now = 0.6 + bridge.HEARTBEAT_STALE_S + bridge.POSITION_STALE_S
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-1", "action": "complete",
        }), None, 14550)
        assert v.service_phase == "swapping", "stale samples confirmed a swap step"
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-1", "action": "relaunch",
            "alt": 40.0,
        }), None, 14550)
        assert v.service_phase == "swapping", "stale samples authorized a relaunch"
        clock.now += 0.1
        conn.push(hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, -0.2))
        conn.push(ext_state_msg(1))
        bridge._drain_messages(v)
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-1", "action": "relaunch",
            "alt": 0.0,
        }), None, 14550)
        assert v.service_phase == "swapping", "a zero-alt relaunch must be refused"
    await h.close()


SCENARIOS = [
    ("F02: queued init and dispatcher recheck ownership after awaits", scenario_controller_checks_after_awaits),
    ("F01: dispatcher gates goals on readiness and current vehicle evidence", scenario_goal_safety_gates),
    ("F03: position receipt age and sequence are independent of heartbeat and broadcasts", scenario_position_receipt_clock),
    ("F03: stale climb cannot confirm takeoff or late recovery", scenario_stale_climb_cannot_confirm),
    ("F04: explicit land/landed/swap/relaunch service handshake is the only rearm path", scenario_land_service_handshake),
    ("F04: hover, missing landed bit, stale samples and bad relaunch are refused", scenario_service_gates_fraud),
    ("F05: goals leave origin-relative and positions return origin-relative", scenario_origin_round_trip),
    ("F02: disconnect at init await boundaries cannot acquire or reply", scenario_init_disconnect_races),
    ("F02: disconnected controller identity cannot command or init", scenario_disconnected_controller_rejected),
    ("happy path: both vehicles confirmed ready, telemetry flows during a slow neighbour's init", scenario_happy_path),
    ("arm rejected: reported not-ready with an honest status, takeoff never commanded", scenario_arm_rejected),
    ("takeoff ACKed but no climb: not ready, reported as failed:takeoff", scenario_takeoff_never_climbs),
    ("late vehicle: no-heartbeat in the reply, then recovers to ready with no new init", scenario_late_vehicle_recovers),
    ("ownership: a second client's init is refused while the controller is connected", scenario_second_client_blocked),
    ("ownership: goals from a non-controller are not forwarded", scenario_goals_ownership),
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
    print(f"\n{total - failures}/{total} scenarios passed (mock only: no MAVLink, no SITL, no flight)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

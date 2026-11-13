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

import argparse
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

    def __init__(self, mtype: str, src: tuple = (1, 1), **fields):
        self._mtype = mtype
        self._src = src  # (sysid, compid): the vehicle's autopilot by default
        for k, v in fields.items():
            setattr(self, k, v)

    def get_type(self) -> str:
        return self._mtype

    def get_srcSystem(self) -> int:
        return self._src[0]

    def get_srcComponent(self) -> int:
        return self._src[1]

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<{self._mtype} {self.__dict__}>"


def hb_msg(armed: bool = False, custom_mode: int = 0) -> FakeMsg:
    return FakeMsg(
        "HEARTBEAT",
        base_mode=(MAV_MODE_FLAG_SAFETY_ARMED if armed else 0),
        custom_mode=custom_mode,
        type=2,       # MAV_TYPE_QUADROTOR
        autopilot=3,  # MAV_AUTOPILOT_ARDUPILOTMEGA
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

    def heartbeat_send(self, mav_type, autopilot, base_mode, custom_mode, system_status, *rest):
        self.conn.sent.append(("gcs_heartbeat", (mav_type, autopilot, system_status)))


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
        MAV_CMD_NAV_LAND=MAV_CMD_NAV_LAND,
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
        climb_per_tick: float = 5.0,  # a 50 m takeoff in ~10 ticks: fast even on a loaded CI runner
        north: float = 0.0,
        east: float = 0.0,
        target_alt: float = None,
        drop_lands: int = 0,  # this many NAV_LANDs are "lost on UDP": no ACK, no descent
    ):
        self.conn = conn
        self.drop_lands = drop_lands
        self.gate = gate
        self.heartbeats = heartbeats
        self.accept_mode = accept_mode
        self.arm_result = arm_result
        self.takeoff_result = takeoff_result
        self.climbs = climbs
        self.climb_per_tick = climb_per_tick
        self.north = north
        self.east = east
        # Like ArduCopter, a takeoff climbs to param7 above where it armed;
        # `target_alt`, if given, caps the climb (a vehicle that stalls).
        self.cap_alt = target_alt
        self.commanded_alt = 0.0

        self.armed = False
        self.mode = 0
        self.alt = 0.0
        self.climbing = False
        self.landing = False  # NAV_LAND accepted: descend, disarm on the ground
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
                    self.landing = False
            elif kind == "takeoff":
                self.conn.push(ack_msg(MAV_CMD_NAV_TAKEOFF, self.takeoff_result))
                if self.takeoff_result == MAV_RESULT_ACCEPTED and self.climbs:
                    self.climbing = True
                    self.commanded_alt = self.alt + float(detail)
            elif kind == "land":
                if self.drop_lands > 0:
                    self.drop_lands -= 1
                    continue
                self.conn.push(ack_msg(MAV_CMD_NAV_LAND))
                self.landing, self.climbing = True, False
        target = self.commanded_alt if self.cap_alt is None else min(self.commanded_alt, self.cap_alt)
        if self.climbing and self.alt < target:
            self.alt = min(target, self.alt + self.climb_per_tick)
        if self.landing:
            self.alt = max(0.0, self.alt - self.climb_per_tick)
            if self.alt == 0.0:
                self.armed = False
        if self.heartbeats:
            self.conn.push(hb_msg(armed=self.armed, custom_mode=self.mode))
        self.conn.push(pos_msg(self.north, self.east, -self.alt))
        if self.landing and not self.armed:
            self.conn.push(ext_state_msg(1))

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

    def init(self, ws: FakeWebsocket, count: int, alt: float, base_port: int = 14550,
             cli_count: int = None) -> asyncio.Task:
        """Send an "init" through the real message dispatcher, concurrently.
        The task ends once the init's "ready" reply (sent from a task of its
        own, see bridge._reply_ready) is out or abandoned."""
        raw = json.dumps({"type": "init", "count": count, "alt": alt})

        async def run():
            reply = await bridge.handle_message(ws, raw, cli_count, base_port)
            if reply is not None:
                await asyncio.gather(reply, return_exceptions=True)
        return asyncio.create_task(run())

    async def close(self) -> None:
        self.stop.set()
        if bridge.STATE.init_reply is not None:
            self.tasks.append(bridge.STATE.init_reply)
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
    seen = len(ws.of_type("telemetry"))  # frames from before DR-1 went ready don't count
    assert await wait_until(lambda: len(ws.of_type("telemetry")) >= max(3, seen + 1), timeout=0.5), (
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
    # A takeover is not a teardown: the flying DR-1 is kept as it is, never
    # re-armed or re-commanded to take off (python-sitl/reinit-rearms-parked-vehicle).
    assert bridge.STATE.vehicles["DR-1"] is v1_before, "takeover rebuilt a flying vehicle"
    assert v1_before.takeoff_alt == 40.0 and conn_for(14550).count("takeoff") == 1, conn_for(14550).kinds()

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
    # ArduPilot's documented position-only mask: ignore vx..afz (8..256) and
    # yaw/yaw_rate (1024, 2048), keep x/y/z, and leave FORCE_SET (512) clear.
    assert sp["mask"] == 0b110111111000 == 3576 and not sp["mask"] & 512, sp

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
        v.conn.push(pos_msg(0.0, 0.0, -v.takeoff_alt))  # a fresh sample AT the takeoff altitude (#12)
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
        original_retire = bridge._retire_vehicles

        async def send(raw):
            msg = json.loads(raw)
            should_pause = msg["type"] == "status" and (
                (phase == "status" and "initializing" in msg["msg"])
                or (phase == "summary" and "confirmed ready" in msg["msg"]))
            if should_pause:
                entered.set()
                await release.wait()
            await original_send(raw)

        async def retire(keep):
            await original_retire(keep)
            if phase == "stop":
                entered.set()
                await release.wait()

        ws.send = send
        with patch.object(bridge, "_retire_vehicles", retire):
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
        assert abs(v.takeoff_alt - 45.2) < 1e-6 and v.launch_alt == 0.2 and v.takeoff_climb_m == 45.0
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
        assert not v.ready and v.init_state == bridge.INIT_CONFIRM_TAKEOFF, "lift-off is not the relaunch altitude (#12)"
        clock.now += 0.1
        conn.push(pos_msg(0.0, 0.0, -v.takeoff_alt))
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


async def scenario_c03_landing_rejection_and_descent_timeout_recovery():
    """C03: landing command rejection, descent noise rejection, and late touchdown recovery."""
    h = Harness()
    ws = h.client("controller")
    await h.init(ws, count=0, alt=30.0)
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        conn = v.conn
        # 1. Landing command rejection
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-rej", "action": "land",
        }), None, 14550)
        assert v.service_phase == "landing"
        conn.push(ack_msg(MAV_CMD_NAV_LAND, MAV_RESULT_DENIED))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.service_phase == "failed" and v.init_state == "failed:land", "rejected land command must fail immediately"

        # 2. Descent progress noise rejection (< 0.5m does not reset descent timer)
        v.init_state = bridge.INIT_READY
        v.ready = True
        v.service_phase = None
        v.service_id = None
        v.alt = 30.0
        v.acks.clear()
        clock.now = 10.0
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, -30.0))
        bridge._drain_messages(v)
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-desc", "action": "land",
        }), None, 14550)
        assert v.service_phase == "landing"
        clock.now = 15.0
        # Descent of only 0.2m (noise)
        v.alt = 29.8
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, -29.8))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.last_descent_at == 10.0, "sub-0.5m descent must not update last_descent_at"

        # Timeout expires after 10s from last_descent_at
        clock.now = 20.1
        await bridge._advance_init(v)
        assert v.service_phase == "failed", "lack of descent progress must fail landing"

        # 3. Late touchdown recovery: confirmed landed while failed recovers to landed
        clock.now = 25.0
        conn.push(hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, 0.0))
        conn.push(ext_state_msg(1))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.service_phase == "landed" and v.init_state == "landed", "late touchdown must recover failed service to landed"
    await h.close()


async def scenario_c04_airborne_and_grounded_abort():
    """C04: airborne abort holds in GUIDED without arming/takeoff, resumes; grounded abort never auto-arms."""
    h = Harness()
    ws = h.client("controller")
    await h.init(ws, count=0, alt=30.0)
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        conn = v.conn
        # 1. Airborne abort
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ab1", "action": "land",
        }), None, 14550)
        clock.now = 0.5
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(-8.0, 12.0, -20.0))
        bridge._drain_messages(v)
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ab1", "action": "abort",
        }), None, 14550)
        # The GUIDED heartbeat predates the abort (NAV_LAND may already have
        # switched to LAND): no hold until a newer heartbeat confirms GUIDED.
        assert v.init_state == bridge.INIT_CONFIRM_ABORT, f"stale heartbeat must not confirm abort, got {v.init_state}"
        modes_before = conn.count("set_mode")
        for t in (0.8, 1.1, 1.4):  # the request was lost: the vehicle keeps reporting LAND
            clock.now = t
            conn.push(hb_msg(armed=True, custom_mode=9))
            conn.push(pos_msg(-8.0, 12.0, -19.0))
            bridge._drain_messages(v)
            await bridge._advance_init(v)
            assert v.init_state == bridge.INIT_CONFIRM_ABORT, v.init_state
        assert conn.count("set_mode") > modes_before, "GUIDED must be re-requested while unconfirmed"
        clock.now = 1.6
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == bridge.INIT_ABORT_HOLD, f"expected abort-hold, got {v.init_state}"
        # A later heartbeat out of GUIDED loses the hold: back to confirming.
        clock.now = 1.8
        conn.push(hb_msg(armed=True, custom_mode=9))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == bridge.INIT_CONFIRM_ABORT, v.init_state
        clock.now = 2.0
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == bridge.INIT_ABORT_HOLD, v.init_state
        assert v.service_phase == "aborted"
        assert not v.ready

        # Ensure hold setpoint was dispatched
        assert conn.count("setpoint") >= 1

        # ...and re-sent at most every STEP_RESEND_DT, not on every 20 ms
        # poll (an identical target at 50/s floods a telemetry radio)
        holds = conn.count("setpoint")
        hold_at = clock.now  # the hold (and its first target) began on this tick
        for _ in range(10):
            await bridge._advance_init(v)
        assert conn.count("setpoint") == holds, f"hold target re-sent {conn.count('setpoint') - holds}x within one poll window"
        clock.now = hold_at + bridge.STEP_RESEND_DT
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(-8.0, 12.0, -20.0))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        await bridge._advance_init(v)
        assert conn.count("setpoint") == holds + 1, "the hold target is refreshed once per STEP_RESEND_DT"

        # While in abort-hold, regular goals are ignored
        sent_before = len(conn.sent)
        await dispatch_goals(ws)
        assert len(conn.sent) == sent_before, "goals must be ignored in abort-hold"

        # Advance time: abort-hold must never enter automatic arming or takeoff
        clock.now = 15.0
        await bridge._advance_init(v)
        assert v.init_state == bridge.INIT_ABORT_HOLD

        # Resume from airborne hold with fresh link/telemetry
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, -20.0))
        bridge._drain_messages(v)
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ab1", "action": "resume",
        }), None, 14550)
        assert v.init_state == bridge.INIT_READY and v.ready and v.service_phase is None

        # Now goals are accepted again
        await dispatch_goals(ws)
        assert len(conn.sent) > sent_before, "goals must be accepted after resume"

        # 1b. Airborne abort below origin (-5m)
        v.init_state = "landing"
        v.service_phase = "landing"
        v.service_id = "svc-ab-low"
        v.launch_alt = 0.0
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, 5.0))  # down = 5.0 -> alt = -5.0
        conn.push(ext_state_msg(2))  # in-air
        bridge._drain_messages(v)
        conn.sent.clear()
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ab-low", "action": "abort",
        }), None, 14550)
        clock.now += 0.1
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == bridge.INIT_ABORT_HOLD, f"armed vehicle at -5m must abort to hold, got {v.init_state}"
        assert v.service_phase == "aborted"
        assert conn.count("setpoint") >= 1

        # 1c. Low hover abort (+0.1m)
        v.init_state = "landing"
        v.service_phase = "landing"
        v.service_id = "svc-ab-hover"
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, -0.1))  # down = -0.1 -> alt = +0.1
        conn.push(ext_state_msg(2))  # in-air
        bridge._drain_messages(v)
        conn.sent.clear()
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ab-hover", "action": "abort",
        }), None, 14550)
        clock.now += 0.1
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == bridge.INIT_ABORT_HOLD, "low hover armed vehicle must abort to hold"

        # 1d. Abort with stale position (W07): never command stale target; wait for fresh sample
        v.init_state = "landing"
        v.service_phase = "landing"
        v.service_id = "svc-ab-stale"
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(ext_state_msg(2))  # in-air
        bridge._drain_messages(v)
        v.last_position = clock.now - 10.0  # stale
        conn.sent.clear()
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ab-stale", "action": "abort",
        }), None, 14550)
        assert v.init_state == bridge.INIT_CONFIRM_ABORT, f"expected confirm-abort on stale pos, got {v.init_state}"
        assert conn.count("setpoint") == 0, "must not emit setpoint from expired coordinates"

        # Fresh telemetry arrives: captures hold target and enters abort-hold
        clock.now += 0.1
        conn.push(pos_msg(-20.0, 15.0, -18.0))  # north=-20, east=15, down=-18 -> (x=15, y=20, alt=18)
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == bridge.INIT_ABORT_HOLD
        assert conn.count("setpoint") == 1
        sp1 = conn.details("setpoint")[0]
        assert sp1["north"] == -20.0 and sp1["east"] == 15.0 and sp1["down"] == -18.0

        # Further ticks retain the captured hold target despite drift (the
        # target is refreshed once per STEP_RESEND_DT, not on every poll)
        clock.now += bridge.STEP_RESEND_DT
        conn.push(pos_msg(-19.0, 16.0, -18.2))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert conn.count("setpoint") == 2
        sp2 = conn.details("setpoint")[1]
        assert sp2["north"] == -20.0 and sp2["east"] == 15.0 and sp2["down"] == -18.0, "hold target must be retained"

        # 1e. Abort mode unconfirmed timeout (W08)
        v.init_state = "landing"
        v.service_phase = "landing"
        v.service_id = "svc-ab-unconfirmed"
        conn.push(hb_msg(armed=True, custom_mode=9))  # non-GUIDED mode
        conn.push(ext_state_msg(2))
        conn.push(pos_msg(0.0, 0.0, -20.0))
        bridge._drain_messages(v)
        conn.sent.clear()
        ws.messages.clear()
        abort_req = {"type": "service", "id": "DR-1", "requestId": "svc-ab-unconfirmed", "action": "abort"}
        await bridge.handle_message(ws, json.dumps(abort_req), None, 14550)
        assert v.init_state == bridge.INIT_CONFIRM_ABORT
        assert conn.count("setpoint") == 0, "must not command hold before GUIDED confirmation"
        # Resend interval (STEP_RESEND_DT = 0.5s in test harness); the margin
        # keeps the accumulated float clock from landing a hair short of it.
        clock.now += bridge.STEP_RESEND_DT + 1e-6
        conn.push(hb_msg(armed=True, custom_mode=9))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert conn.count("set_mode") >= 2
        assert conn.count("setpoint") == 0
        # Timeout after INIT_STEP_TIMEOUT_S (1.0s in test harness)
        clock.now += 0.6
        conn.push(hb_msg(armed=True, custom_mode=9))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == "failed:abort"
        assert v.service_phase == "failed"
        assert conn.count("setpoint") == 0
        # Duplicate abort during failure returns cached accepted response
        await bridge.handle_message(ws, json.dumps(abort_req), None, 14550)
        ack = json.loads(ws.messages[-1])
        assert ack["action"] == "abort" and ack["accepted"] is True and ack["duplicate"] is True

        # 1f. Abort mode confirmed late (W08)
        v.init_state = "landing"
        v.service_phase = "landing"
        v.service_id = "svc-ab-late"
        conn.push(hb_msg(armed=True, custom_mode=9))
        conn.push(ext_state_msg(2))
        conn.push(pos_msg(5.0, 10.0, -15.0))
        bridge._drain_messages(v)
        conn.sent.clear()
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ab-late", "action": "abort",
        }), None, 14550)
        assert v.init_state == bridge.INIT_CONFIRM_ABORT
        assert conn.count("setpoint") == 0
        clock.now += 0.2
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(5.0, 10.0, -15.0))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == bridge.INIT_ABORT_HOLD
        assert conn.count("setpoint") == 1
        sp_late = conn.details("setpoint")[0]
        assert sp_late["north"] == 5.0 and sp_late["east"] == 10.0 and sp_late["down"] == -15.0

        # 1g. Abort with expired heartbeat (W10): fresh position cannot confirm without fresh heartbeat
        v.init_state = "landing"
        v.service_phase = "landing"
        v.service_id = "svc-ab-stale-hb"
        v.ready = False
        conn.sent.clear()
        ws.messages.clear()
        v.last_heartbeat = clock.now - 10.0
        v.custom_mode = GUIDED_MODE_ID
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ab-stale-hb", "action": "abort",
        }), None, 14550)
        assert v.init_state == bridge.INIT_CONFIRM_ABORT
        conn.push(pos_msg(-80.0, 120.0, -10.0))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == bridge.INIT_CONFIRM_ABORT
        assert not v.connected
        assert v.position_fresh
        assert conn.count("setpoint") == 0, "must not emit setpoints with expired heartbeat"

        # Fresh heartbeat arrives: abort confirms to hold
        clock.now += 0.1
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == bridge.INIT_ABORT_HOLD
        assert v.connected
        assert conn.count("setpoint") == 1
        sp_hb = conn.details("setpoint")[0]
        assert sp_hb["north"] == -80.0 and sp_hb["east"] == 120.0 and sp_hb["down"] == -10.0

        # 2. Grounded abort: aborting a grounded swap never arms
        v.init_state = "swapping"
        v.service_phase = "swapping"
        v.service_id = "svc-ab2"
        v.alt = 0.0
        v.last_landed = clock.now
        v.landed_seq += 1
        conn.push(hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, 0.0))
        conn.push(ext_state_msg(1))
        bridge._drain_messages(v)
        arm_cmds_before = [s for s in conn.sent if s[0] == f"cmd{MAV_CMD_COMPONENT_ARM_DISARM}"]
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ab2", "action": "abort",
        }), None, 14550)
        assert v.init_state == "aborted" and v.service_phase == "aborted"

        # Advance init past timeout
        for t in range(20):
            clock.now += 1.0
            await bridge._advance_init(v)
        arm_cmds_after = [s for s in conn.sent if s[0] == f"cmd{MAV_CMD_COMPONENT_ARM_DISARM}"]
        assert len(arm_cmds_after) == len(arm_cmds_before), "grounded abort must NEVER issue arm commands"
    await h.close()


async def scenario_c01_relaunch_datum_elevated_and_sunken():
    """C01: relaunch targets climb above local touchdown altitude (AGL to origin-relative)."""
    h = Harness()
    ws = h.client("controller")
    await h.init(ws, count=0, alt=30.0)
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        conn = v.conn
        # 1. Elevated landing site (+15m)
        v.init_state = "swapped"
        v.service_phase = "swapped"
        v.service_id = "svc-elev"
        clock.now = 5.0
        conn.push(hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, -15.0))  # down = -15 -> alt = +15
        conn.push(ext_state_msg(1))
        bridge._drain_messages(v)
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-elev", "action": "relaunch",
            "alt": 50.0,
        }), None, 14550)
        assert v.launch_alt == 15.0
        assert v.takeoff_climb_m == 50.0
        assert v.takeoff_alt == 65.0, f"expected 65m origin-relative, got {v.takeoff_alt}"

        # 2. Sunken landing site (-10m)
        v.init_state = "swapped"
        v.service_phase = "swapped"
        v.service_id = "svc-sunk"
        clock.now = 10.0
        conn.push(hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, 10.0))  # down = 10 -> alt = -10
        conn.push(ext_state_msg(1))
        bridge._drain_messages(v)
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-sunk", "action": "relaunch",
            "alt": 50.0,
        }), None, 14550)
        assert v.launch_alt == -10.0
        assert v.takeoff_climb_m == 50.0
        assert v.takeoff_alt == 40.0, f"expected 40m origin-relative, got {v.takeoff_alt}"
    await h.close()


async def scenario_c05_service_ack_and_idempotency():
    """C05: machine-readable ACKs and idempotent duplicate handling."""
    h = Harness()
    ws = h.client("controller")
    await h.init(ws, count=0, alt=30.0)
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        conn = v.conn
        ws.messages.clear()
        # First land request
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ack-1", "action": "land",
        }), None, 14550)
        assert v.service_phase == "landing"
        assert len(ws.messages) == 1
        ack1 = json.loads(ws.messages[0])
        assert ack1["type"] == "service_ack" and ack1["accepted"] is True and ack1["duplicate"] is False

        # Duplicate land request
        sent_cmds_before = len(conn.sent)
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ack-1", "action": "land",
        }), None, 14550)
        assert len(ws.messages) == 2
        ack2 = json.loads(ws.messages[1])
        assert ack2["type"] == "service_ack" and ack2["accepted"] is True and ack2["duplicate"] is True
        assert len(conn.sent) == sent_cmds_before, "duplicate request must not re-send MAVLink commands"

        # Invalid action rejection with code
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ack-1", "action": "bogus_action",
        }), None, 14550)
        assert len(ws.messages) == 3
        ack3 = json.loads(ws.messages[2])
        assert ack3["type"] == "service_ack" and ack3["accepted"] is False and "code" in ack3

        # W01: retryable rejection must NOT be cached permanently
        # Send complete while not grounded
        v.service_phase = "swapping"
        v.service_id = "svc-w01"
        v.service_started = clock.now
        v.service_position_seq = v.position_seq
        v.service_landed_seq = v.landed_seq
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(ext_state_msg(2))  # in-air
        bridge._drain_messages(v)
        ws.messages.clear()
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-w01", "action": "complete",
        }), None, 14550)
        assert len(ws.messages) == 1
        ack_rej = json.loads(ws.messages[0])
        assert ack_rej["accepted"] is False and ack_rej["retryable"] is True and ack_rej["code"] == "INVALID_PHASE"

        # Vehicle state recovers with fresh grounded evidence
        clock.now += 1.0
        conn.push(hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, 0.0))
        conn.push(ext_state_msg(1))  # landed
        bridge._drain_messages(v)
        # Retry with IDENTICAL requestId
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-w01", "action": "complete",
        }), None, 14550)
        assert len(ws.messages) == 2
        ack_ok = json.loads(ws.messages[1])
        assert ack_ok["accepted"] is True and ack_ok["duplicate"] is False, "retried request must succeed once preconditions are met"

        # Duplicate send of accepted request is idempotently deduplicated
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-w01", "action": "complete",
        }), None, 14550)
        assert len(ws.messages) == 3
        ack_dup = json.loads(ws.messages[2])
        assert ack_dup["accepted"] is True and ack_dup["duplicate"] is True
    await h.close()


async def scenario_acceptance_runner_real_command():
    """#7: the acceptance runner's real-mode server command must parse with bridge.py's CLI."""
    import run_acceptance

    captured = {}

    class _Proc:
        def poll(self):
            return None

    def _popen(cmd, **_kwargs):
        captured["cmd"] = list(cmd)
        return _Proc()

    import tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as tmp:
        runner = run_acceptance.AcceptanceRunner(mode="real", count=3, port=8799, logs_dir=Path(tmp))
        with patch.object(run_acceptance.subprocess, "Popen", _popen), \
                patch.object(run_acceptance.time, "sleep", lambda _s: None):
            runner.start_server()
        runner._server_log.close()
    cmd = captured["cmd"]
    assert cmd[1].endswith("bridge.py"), cmd
    try:
        with patch.object(sys, "argv", ["bridge.py"] + cmd[2:]):
            args = bridge.parse_args()
    except SystemExit as exc:
        raise AssertionError(f"bridge.py rejects the runner's real-mode arguments {cmd[2:]} (exit {exc.code})")
    assert args.ws_port == 8799 and args.count == 3, args


async def scenario_acceptance_runner_logs_dir_flag():
    """CI uploads failure diagnostics from a temp dir: --logs-dir must reach the runner."""
    import run_acceptance
    import tempfile
    from pathlib import Path

    captured = {}

    class _Runner:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        async def execute(self):
            return None

    def _run(coro):
        coro.close()
        return type("Report", (), {"overall_status": "passed"})()

    with tempfile.TemporaryDirectory() as tmp:
        with patch.object(run_acceptance, "AcceptanceRunner", _Runner), \
                patch.object(run_acceptance.asyncio, "run", _run), \
                patch.object(sys, "argv", ["run_acceptance.py", "--mode", "mock", "--logs-dir", tmp]):
            try:
                rc = run_acceptance.main()
            except SystemExit as exc:
                raise AssertionError(f"run_acceptance.py rejects --logs-dir (exit {exc.code})")
    assert rc == 0, rc
    assert captured.get("logs_dir") == Path(tmp), captured


def _fake_clock_patches(run_acceptance, clock):
    async def _sleep(dt):
        clock[0] += dt
    return (patch.object(run_acceptance.time, "time", lambda: clock[0]),
            patch.object(run_acceptance.asyncio, "sleep", _sleep))


async def scenario_acceptance_runner_slow_server_start():
    """#11: a server that needs ~10 s to start listening is still reached."""
    import run_acceptance

    clock = [0.0]

    async def _connect(_uri):
        if clock[0] < 10.0:
            raise ConnectionRefusedError("not listening yet")
        return "ws"

    runner = run_acceptance.AcceptanceRunner(mode="real", count=3, port=8799)
    p_time, p_sleep = _fake_clock_patches(run_acceptance, clock)
    with p_time, p_sleep, patch.object(run_acceptance.websockets, "connect", _connect, create=True):
        ws = await runner.connect_ws()
    assert ws == "ws", ws


async def scenario_acceptance_runner_dead_server_reported():
    """#11: a server that died is reported at once, with its own output."""
    import tempfile
    import run_acceptance

    clock = [0.0]

    async def _connect(_uri):
        raise ConnectionRefusedError("nobody home")

    class _Dead:
        def poll(self):
            return 1

    runner = run_acceptance.AcceptanceRunner(mode="real", count=3, port=8799)
    runner.server_process = _Dead()
    with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False) as f:
        f.write("Traceback (most recent call last):\nOSError: [Errno 98] boom: address already in use\n")
    runner.server_log_path = f.name
    p_time, p_sleep = _fake_clock_patches(run_acceptance, clock)
    try:
        with p_time, p_sleep, patch.object(run_acceptance.websockets, "connect", _connect, create=True):
            await runner.connect_ws()
    except RuntimeError as exc:
        assert "boom" in str(exc), exc
        assert clock[0] < 1.0, f"took {clock[0]:.1f}s to notice the dead server"
    else:
        raise AssertionError("a dead server must raise")
    finally:
        os.unlink(f.name)


# ==========================================================================
# #12 - "ready" means the takeoff altitude was reached (docs/PROTOCOL.md:
# takeoff ACK + climb >= takeoff_alt - 1 m). Real ArduCopter SITL showed the
# bridge declaring READY at 1.0 m, so goals flew at ground level.
# ==========================================================================

async def scenario_ready_needs_takeoff_altitude():
    h = Harness()
    ws = h.client("browser-1")
    h.telemetry()
    bridge.INIT_STEP_TIMEOUT_S = 5.0  # a hover must not trip the step timeout during the check
    ap = h.autopilot(14550, target_alt=3.0)  # lifts off, then holds at 3 m
    init_task = h.init(ws, count=1, alt=30.0)
    assert await wait_until(lambda: "DR-1" in bridge.STATE.vehicles and vehicle("DR-1").alt >= 3.0 - 1e-6), "setup: the vehicle lifts off"
    await asyncio.sleep(0.2)
    v = vehicle("DR-1")
    assert not v.ready and v.init_state == bridge.INIT_CONFIRM_TAKEOFF, (v.ready, v.init_state, v.alt)
    assert not ws.said("READY"), ws.statuses()
    ap.cap_alt = None  # let it finish the climb
    await ready_reply(ws, init_task)
    assert vehicle("DR-1").ready and vehicle("DR-1").alt >= 29.0, (vehicle("DR-1").ready, vehicle("DR-1").alt)
    await h.close()


async def scenario_long_climb_not_timed_out():
    """A 40 m takeoff climbing 0.6 m per 0.25 s (~16 s) against a 1 s step
    timeout: steady progress keeps the step alive, and READY waits for 39 m.
    Driven on a fake clock so machine load can't make it flaky."""
    h = Harness()
    clock = Clock()
    bridge.INIT_STEP_TIMEOUT_S = 1.0
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        conn = v.conn
        v.takeoff_alt = 40.0
        clock.now = 10.0
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, 0.0))  # on the ground
        bridge._drain_messages(v)
        v.ready = False
        await bridge._enter_confirm_takeoff(v, clock.now)
        conn.push(ack_msg(MAV_CMD_NAV_TAKEOFF))
        alt, ready_at = 0.0, None
        while clock.now < 60.0:
            clock.now += 0.25
            alt = min(40.0, alt + 0.6)
            conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
            conn.push(pos_msg(0.0, 0.0, -alt))
            bridge._drain_messages(v)
            await bridge._advance_init(v)
            assert not v.init_state.startswith(bridge.FAILED_PREFIX), f"failed mid-climb at {alt:.1f} m: {v.init_state}"
            if v.ready:
                ready_at = alt
                break
        assert ready_at is not None and ready_at >= 39.0, f"READY at {ready_at} m of a 40 m takeoff"
    await h.close()


async def scenario_stalled_climb_fails_takeoff():
    h = Harness()
    ws = h.client("browser-1")
    bridge.INIT_STEP_TIMEOUT_S = 0.3
    h.autopilot(14550, target_alt=5.0)  # climbs to 5 m of 30 and stalls
    reply = await ready_reply(ws, h.init(ws, count=1, alt=30.0))
    entry = ready_entry(reply, "DR-1")
    assert entry["ready"] is False and entry["state"] == bridge.FAILED_PREFIX + "takeoff", reply
    assert ws.said("DR-1: takeoff UNCONFIRMED"), ws.statuses()
    await h.close()


async def scenario_recovery_below_takeoff_alt_climbs_first():
    h = Harness()
    ws = h.client("browser-1")
    h.telemetry()
    bridge.INIT_STEP_TIMEOUT_S = 0.3
    bridge.RETRY_COOLDOWN_S = 0.1
    ap = h.autopilot(14550, target_alt=5.0)  # the first climb stalls at 5 m
    h.init(ws, count=1, alt=30.0)
    assert await wait_until(lambda: ws.said("DR-1: takeoff UNCONFIRMED"), timeout=5.0), ws.statuses()
    # Recovery of an airborne vehicle 25 m short: climb by setpoint (ArduCopter
    # refuses NAV_TAKEOFF in flight), and no READY until the altitude is there.
    conn = conn_for(14550)
    assert await wait_until(lambda: any(abs(d["down"] + 30.0) < 1e-6 for d in conn.details("setpoint")), timeout=3.0), conn.sent
    assert not vehicle("DR-1").ready, vehicle("DR-1").init_state
    assert conn.count("takeoff") == 1, conn.sent
    ap.cap_alt = None
    assert await wait_until(lambda: vehicle("DR-1").ready, timeout=5.0), (vehicle("DR-1").init_state, ws.statuses())
    assert vehicle("DR-1").alt >= 29.0, vehicle("DR-1").alt
    await h.close()


async def scenario_foreign_origin_rejected() -> None:
    """The bridge's serve() refuses a handshake from another web origin (CSWSH)
    with HTTP 403 before any handler runs; the sim's own origins still pass."""
    captured = {}

    def fake_serve(handler, host, port, **kwargs):
        captured.update(kwargs)
        raise RuntimeError("stop after capturing serve() kwargs")

    class Req:
        def __init__(self, origin):
            self.headers = {} if origin is None else {"Origin": origin}

    class Conn:
        def respond(self, status, body):
            return (int(status), body)

    real_serve = bridge.serve
    bridge.serve = fake_serve
    try:
        args = argparse.Namespace(count=None, mav_base_port=14550, ws_host="localhost", ws_port=0, allow_origin=[])
        try:
            await bridge.run(args)
        except RuntimeError:
            pass
    finally:
        bridge.serve = real_serve
    check = captured.get("process_request")
    assert check is not None, f"serve() got no origin check: {captured}"
    for origin in ("https://evil.example", "http://localhost.evil.example:8000"):
        resp = check(Conn(), Req(origin))
        assert resp is not None and resp[0] == 403, (origin, resp)
    for origin in ("http://localhost:8000", "http://127.0.0.1:8000", "null", "https://dalailalama.github.io", None):
        assert check(Conn(), Req(origin)) is None, origin


async def scenario_token_gate() -> None:
    """With --token (or a non-loopback bind, which generates one) a handshake
    must carry ?token=: the Origin check cannot stop a non-browser client,
    and on a LAN bind every host is one. A loopback bind stays tokenless."""
    captured, announced = {}, []

    def fake_serve(handler, host, port, **kwargs):
        captured.update(kwargs)
        raise RuntimeError("stop after capturing serve() kwargs")

    class Req:
        def __init__(self, path, origin=None):
            self.path = path
            self.headers = {} if origin is None else {"Origin": origin}

    class Conn:
        def respond(self, status, body):
            return (int(status), body)

    async def check_for(host, token):
        captured.clear()
        args = argparse.Namespace(count=None, mav_base_port=14550, ws_host=host, ws_port=0,
                                  allow_origin=[], token=token)
        try:
            await bridge.run(args)
        except RuntimeError:
            pass
        return captured["process_request"]

    real_serve = bridge.serve
    bridge.serve = fake_serve
    try:
        with patch.dict(os.environ, {"BRIDGE_TOKEN": ""}), \
                patch.object(bridge.log, "warning", lambda msg, *a: announced.append(msg % a if a else msg)):
            check = await check_for("localhost", "s3cret")
            for path, origin in (("/", None), ("/?token=wrong", None), ("/?token=", "http://localhost:8000")):
                assert check(Conn(), Req(path, origin))[0] == 401, (path, origin)
            assert check(Conn(), Req("/?token=s3cret", "https://evil.example"))[0] == 403
            assert check(Conn(), Req("/?token=s3cret", "http://localhost:8000")) is None
            assert check(Conn(), Req("/?a=1&token=s3cret")) is None

            announced.clear()
            check = await check_for("0.0.0.0", None)
            assert check(Conn(), Req("/"))[0] == 401, "a LAN bind without --token must still need a token"
            token = next(m.split("?token=")[1].split()[0] for m in announced if "?token=" in m)
            assert len(token) >= 16 and check(Conn(), Req(f"/?token={token}")) is None, announced

            check = await check_for("localhost", None)
            assert check(Conn(), Req("/", "http://localhost:8000")) is None, "loopback default needs no token"
    finally:
        bridge.serve = real_serve


async def scenario_token_plus_typed_as_is() -> None:
    """A base64 secret (`openssl rand -base64`) often holds '+', and a browser
    sends a typed ?token=a+b as is: reading that '+' as a form-encoded space
    answered the exact secret with 401. Percent-encoded and form-encoded
    spellings of the secret still match; a different secret still does not."""

    class Req:
        def __init__(self, path):
            self.path = path
            self.headers = {"Origin": "http://localhost:8000"}

    class Conn:
        def respond(self, status, body):
            return (int(status), body)

    check = bridge.make_origin_check((), None, "Zm9v+YmFy/cXV4==")
    for path in ("/?token=Zm9v+YmFy/cXV4==", "/?token=Zm9v%2BYmFy%2FcXV4%3D%3D", "/?a=1&token=Zm9v+YmFy/cXV4=="):
        assert check(Conn(), Req(path)) is None, path
    for path in ("/?token=Zm9v%20YmFy/cXV4==", "/?token=Zm9vYmFy/cXV4==", "/?token=Zm9v"):
        assert check(Conn(), Req(path))[0] == 401, path
    check = bridge.make_origin_check((), None, "two words")
    for path in ("/?token=two%20words", "/?token=two+words"):
        assert check(Conn(), Req(path)) is None, path


async def scenario_init_count_bounded() -> None:
    """An init's count comes off the network: a huge one is clamped (with a
    status) instead of building a vehicle and UDP task per requested unit."""
    h = Harness()
    ws = h.client("browser-1")
    task = h.init(ws, count=5000, alt=40.0)
    try:
        assert await wait_until(lambda: len(bridge.STATE.vehicles) > 0), "init built no vehicles"
        assert len(bridge.STATE.vehicles) <= 256, len(bridge.STATE.vehicles)
        assert ws.said("exceeds limit"), ws.statuses()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await h.close()


async def scenario_malformed_messages_keep_connection() -> None:
    """Shape-invalid JSON is logged and skipped; it must not end the
    connection (1011) and with it drop the controller."""
    h = Harness()

    class StreamWebsocket(FakeWebsocket):
        def __init__(self, name, raws):
            super().__init__(name)
            self.raws = raws

        async def __aiter__(self):
            for raw in self.raws:
                yield raw
            await wait_until(lambda: self.of_type("ready"), timeout=1.0)  # stay connected for the reply

    bad = ["[]", "42", '{"type":"goals","goals":[1]}', '{"type":"goals","goals":null}',
           '{"type":"init","count":"three"}', '{"type":"service","id":["DR-1"],"requestId":"r","action":"land"}']
    ws = StreamWebsocket("browser-1", bad + [json.dumps({"type": "init", "count": 0, "alt": 40.0})])
    try:
        await bridge.make_handler(None, 14550)(ws)
        assert ws.of_type("ready"), f"the init after the malformed messages was never handled: {ws.messages}"
    finally:
        await h.close()


async def scenario_init_does_not_block_controller() -> None:
    """handle_init used to hold the controller's message loop until every
    vehicle's first pass was decided (up to 35 s): its services and 2 Hz goals
    queued behind it and websockets' keepalive closed the socket (1011). A
    service sent while the init waits is now answered at once."""
    h = Harness()

    class StreamWebsocket(FakeWebsocket):
        def __init__(self, name, raws):
            super().__init__(name)
            self.raws = raws

        async def __aiter__(self):
            for raw in self.raws:
                yield raw
                await asyncio.sleep(0.02)
            await wait_until(lambda: self.of_type("service_ack"), timeout=1.0)

    ws = StreamWebsocket("browser-1", [
        json.dumps({"type": "init", "count": 1, "alt": 30.0}),
        json.dumps({"type": "service", "id": "DR-1", "requestId": "svc-1", "action": "land"}),
    ])
    with patch.object(bridge, "HEARTBEAT_WAIT_TIMEOUT_S", 60.0):  # DR-1 never boots: its first pass stays open
        handler = asyncio.create_task(bridge.make_handler(None, 14550)(ws))
        try:
            assert await wait_until(lambda: ws.of_type("service_ack"), timeout=1.0), \
                f"the service request waited behind the init: {ws.statuses()}"
            ack = ws.of_type("service_ack")[0]
            assert ack["accepted"] is False and ack["code"] == "VEHICLE_NOT_READY", ack
            assert not ws.of_type("ready"), "the ready reply must still wait for DR-1's first pass"
        finally:
            handler.cancel()
            await asyncio.gather(handler, return_exceptions=True)
            await h.close()


async def scenario_malformed_init_refused_without_control() -> None:
    """An init with a malformed origin, count or alt is refused with a status
    line before it can take control: it used to make its sender the
    controller and then return without a word (or raise)."""
    h = Harness()
    ws = h.client("browser-1")
    for bad in [
        {"count": 1, "alt": 30.0, "origin": {"frame": "common-local-origin", "x": 0.0, "y": 0.0, "groundM": None}},
        {"count": 1, "alt": 30.0, "origin": "here"},
        {"count": "three", "alt": 30.0},
        {"count": 1, "alt": 0.5},
        {"count": 1, "alt": "high"},
    ]:
        ws.messages.clear()
        await bridge.handle_message(ws, json.dumps({"type": "init", **bad}), None, 14550)
        assert bridge.STATE.controller is None, f"a malformed init took control: {bad}"
        assert not bridge.STATE.vehicles and ws.said("bridge: init refused"), (bad, ws.statuses())
    other = h.client("browser-2")
    await ready_reply(other, h.init(other, count=0, alt=30.0))
    assert bridge.STATE.controller is other, "a well-formed init from another client is still free to take over"
    await h.close()


async def scenario_gcs_heartbeat_sent() -> None:
    """The bridge is the vehicle's GCS: once it has heard the vehicle it sends a
    GCS HEARTBEAT (~1 Hz), so ArduPilot's GCS-loss failsafe can engage when
    the bridge dies. Without one, gcs_last_seen_ms stays 0 and it never does."""
    h = Harness()
    ws = h.client("browser-1")
    h.autopilot(14550, target_alt=30.0)
    init_task = h.init(ws, count=1, alt=30.0)
    try:
        assert await wait_until(lambda: conn_for(14550).count("gcs_heartbeat") >= 1, timeout=3.0), \
            f"no GCS HEARTBEAT sent to the vehicle: {conn_for(14550).kinds()}"
        mav_type, autopilot, state = conn_for(14550).details("gcs_heartbeat")[0]
        assert (mav_type, autopilot, state) == (6, 8, 4), "MAV_TYPE_GCS / MAV_AUTOPILOT_INVALID / MAV_STATE_ACTIVE"
    finally:
        init_task.cancel()
        await asyncio.gather(init_task, return_exceptions=True)
        await h.close()


async def scenario_foreign_mavlink_source_ignored() -> None:
    """ArduPilot routes a GCS's (Mission Planner, MAVProxy) HEARTBEAT and
    COMMAND_ACKs onto the bridge's link; they must not overwrite the
    vehicle's armed/mode state or answer the bridge's commands."""
    conn = FakeConn("udpin:localhost:14990")
    v = bridge.Vehicle(id="DR-1", index=0, port=14990, conn=conn)
    conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
    bridge._drain_messages(v)
    assert v.base_mode & MAV_MODE_FLAG_SAFETY_ARMED and v.custom_mode == GUIDED_MODE_ID
    seen = v.last_heartbeat
    gcs_hb = FakeMsg("HEARTBEAT", src=(255, 190), base_mode=0, custom_mode=0, type=6, autopilot=8)
    conn.push(gcs_hb)
    conn.push(FakeMsg("HEARTBEAT", src=(2, 1), base_mode=0, custom_mode=0, type=2, autopilot=3))
    conn.push(FakeMsg("COMMAND_ACK", src=(255, 190), command=MAV_CMD_NAV_LAND, result=4))
    conn.push(FakeMsg("LOCAL_POSITION_NED", src=(2, 1), x=900.0, y=900.0, z=-5.0))
    bridge._drain_messages(v)
    assert v.base_mode & MAV_MODE_FLAG_SAFETY_ARMED, "a GCS/other-vehicle heartbeat disarmed the vehicle's state"
    assert v.custom_mode == GUIDED_MODE_ID, "a foreign heartbeat changed the vehicle's mode"
    assert v.last_heartbeat == seen, "a foreign heartbeat refreshed the vehicle's link"
    assert MAV_CMD_NAV_LAND not in v.acks, "a GCS's COMMAND_ACK answered the bridge's command"
    assert v.last_position is None, "another system's position was taken as the vehicle's"
    conn.push(ack_msg(MAV_CMD_NAV_LAND))
    bridge._drain_messages(v)
    assert v.acks.get(MAV_CMD_NAV_LAND) == MAV_RESULT_ACCEPTED


async def scenario_ready_revoked_on_autopilot_mode_change():
    """READY is revoked when the vehicle's own heartbeats leave GUIDED or disarm (failsafe)."""
    h = Harness()
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        conn = v.conn
        # One odd heartbeat is not enough evidence...
        clock.now = 1.0
        conn.push(hb_msg(armed=True, custom_mode=6))  # RTL
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.ready and v.init_state == bridge.INIT_READY, v.init_state
        # ...two consecutive ones are.
        clock.now = 2.0
        conn.push(hb_msg(armed=True, custom_mode=6))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        telem = v.to_telemetry()
        assert telem["ready"] is False, telem
        assert telem["state"] == "mode-lost:6", telem
        sets_before = conn.count("set_mode")
        # The autopilot (or pilot) took over: the bridge never re-requests GUIDED.
        clock.now = 30.0
        await bridge._advance_init(v)
        assert conn.count("set_mode") == sets_before and conn.count("arm") == 0, conn.sent
        # Landed and disarmed by its own failsafe: reported as such.
        for t in (31.0, 32.0):
            clock.now = t
            conn.push(hb_msg(armed=False, custom_mode=9))
            conn.push(ext_state_msg(1))
            bridge._drain_messages(v)
            await bridge._advance_init(v)
        assert v.to_telemetry()["state"] == "disarmed", v.init_state
        assert not v.ready
    await h.close()


async def scenario_px4_reported_unsupported():
    """A PX4 heartbeat fails as unsupported-autopilot (ArduCopter only), never retried."""
    h = Harness()
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        conn = conn_for(14550)
        conn.mode_map = {"MANUAL": 65536, "OFFBOARD": 393216, "RTL": 84148224}  # px4_map: no GUIDED
        v = bridge.Vehicle(id="DR-1", index=0, port=14550, conn=conn)
        bridge.STATE.vehicles[v.id] = v
        conn.push(FakeMsg("HEARTBEAT", base_mode=0, custom_mode=0, autopilot=12))  # MAV_AUTOPILOT_PX4
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == "failed:unsupported-autopilot", v.init_state
        assert not v.ready
        clock.now = 60.0
        conn.push(FakeMsg("HEARTBEAT", base_mode=0, custom_mode=0, autopilot=12))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == "failed:unsupported-autopilot", v.init_state
        assert conn.count("set_mode") == 0 and conn.count("arm") == 0, conn.sent
    await h.close()


async def scenario_relaunch_failure_stays_parked():
    """A relaunch whose arm is denied parks the vehicle (service 'failed'); the bridge never re-arms it itself."""
    h = Harness()
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        conn = conn_for(14550)
        v = bridge.Vehicle(id="DR-1", index=0, port=14550, conn=conn, guided_mode_id=GUIDED_MODE_ID)
        bridge.STATE.vehicles[v.id] = v
        conn.push(hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(0.0, 0.0, 0.0))
        bridge._drain_messages(v)
        v.service_id, v.service_phase, v.takeoff_alt = "svc-1", "relaunch", 20.0
        await bridge._enter_confirm_arm(v, clock.now)
        conn.push(ack_msg(MAV_CMD_COMPONENT_ARM_DISARM, MAV_RESULT_DENIED))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.init_state == "failed:arm", v.init_state
        for step in range(1, 40):  # 20 s, well past RETRY_COOLDOWN_S, link healthy
            clock.now = step * 0.5
            conn.push(hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
            conn.push(pos_msg(0.0, 0.0, 0.0))
            bridge._drain_messages(v)
            await bridge._advance_init(v)
        assert conn.count("arm") == 1, conn.sent
        assert v.service_phase == "failed" and not v.ready, (v.service_phase, v.init_state)
    await h.close()


async def scenario_reinit_airborne_no_takeoff():
    """Init of a vehicle already flying at the takeoff altitude: no NAV_TAKEOFF (ArduCopter refuses it in flight)."""
    h = Harness()
    ws = h.client("browser-1")
    h.telemetry()
    ap = h.autopilot(14550, takeoff_result=4)  # MAV_RESULT_FAILED, as ArduCopter answers a takeoff in flight
    ap.alt, ap.armed, ap.mode = 30.0, True, GUIDED_MODE_ID
    reply = await ready_reply(ws, h.init(ws, count=1, alt=30.0))
    assert ready_entry(reply, "DR-1") == {"id": "DR-1", "ready": True, "state": "ready"}, (reply, ws.statuses())
    assert conn_for(14550).count("takeoff") == 0, conn_for(14550).sent
    await h.close()


async def _service(ws, action: str, request_id: str = "svc-1", vid: str = "DR-1", **extra) -> None:
    await bridge.handle_message(ws, json.dumps({
        "type": "service", "id": vid, "requestId": request_id, "action": action, **extra,
    }), None, 14550)


async def scenario_reinit_keeps_parked_vehicle():
    """An init (reset button, selector change, reconnect) must not arm a
    vehicle parked mid battery swap: it stays parked, its state is named in
    the ready reply, and only the service handshake relaunches it."""
    h = Harness()
    ws = h.client("browser-1")
    h.telemetry()
    ap = h.autopilot(14550)
    conn = conn_for(14550)
    reply = await ready_reply(ws, h.init(ws, count=1, alt=30.0))
    assert ready_entry(reply, "DR-1")["ready"] is True, reply
    v = vehicle("DR-1")
    await _service(ws, "land")
    assert await wait_until(lambda: v.service_phase == "landed", timeout=5.0), (v.service_phase, v.init_state)
    await _service(ws, "authorize")
    assert v.service_phase == "swapping" and not ap.armed, v.service_phase
    arms, takeoffs = conn.count("arm"), conn.count("takeoff")

    reply = await ready_reply(ws, h.init(ws, count=1, alt=30.0))
    await asyncio.sleep(0.3)  # a rebuilt vehicle would be through GUIDED and arming by now
    assert conn.count("arm") == arms and conn.count("takeoff") == takeoffs, conn.kinds()[-12:]
    assert bridge.STATE.vehicles["DR-1"] is v and v.service_phase == "swapping", (v.service_phase, v.init_state)
    assert not ap.armed and ap.alt == 0.0
    assert ready_entry(reply, "DR-1") == {"id": "DR-1", "ready": False, "state": "swapping"}, reply

    # The handshake itself still finishes the swap and relaunches it.
    await _service(ws, "complete")
    await _service(ws, "relaunch", alt=20.0)
    assert await wait_until(lambda: v.ready, timeout=5.0), (v.service_phase, v.init_state)
    assert v.service_phase is None and conn.count("arm") == arms + 1
    await h.close()


async def scenario_reinit_keeps_position_seq():
    """positionSeq never restarts on an init: a watcher tab only takes a fix as
    new when its seq beats the largest it has seen, so a restart froze it."""
    h = Harness()
    ws = h.client("browser-1")
    h.autopilot(14550)
    h.autopilot(14560)
    await ready_reply(ws, h.init(ws, count=2, alt=30.0))
    v1, v2 = vehicle("DR-1"), vehicle("DR-2")
    seq1 = v1.position_seq
    assert seq1 > 0
    await ready_reply(ws, h.init(ws, count=2, alt=30.0))
    assert vehicle("DR-1") is v1 and v1.position_seq >= seq1, (v1.position_seq, seq1)
    await ready_reply(ws, h.init(ws, count=1, alt=30.0))  # DR-2 leaves the fleet...
    seq2 = v2.position_seq
    await ready_reply(ws, h.init(ws, count=2, alt=30.0))  # ...and comes back
    assert vehicle("DR-2").position_seq >= seq2 > 0, (vehicle("DR-2").position_seq, seq2)
    await h.close()


async def scenario_shrinking_init_lands_dropped_vehicle():
    """An init that drops an airborne vehicle commands it to LAND and keeps
    watching it until it is down: closing its socket instead left it holding
    its last GUIDED target forever, unmonitored."""
    h = Harness()
    ws = h.client("browser-1")
    h.autopilot(14550)
    ap2 = h.autopilot(14560, climb_per_tick=1.0)
    await ready_reply(ws, h.init(ws, count=2, alt=30.0))
    v2, conn2 = vehicle("DR-2"), conn_for(14560)
    assert v2.ready and ap2.armed

    reply = await ready_reply(ws, h.init(ws, count=1, alt=30.0))
    assert reply["ids"] == ["DR-1"] and "DR-2" not in bridge.STATE.vehicles, reply
    assert conn2.count("land") == 1, conn2.kinds()[-8:]
    assert not conn2.closed and not v2.task.done(), "the dropped vehicle was abandoned in the air"
    assert ws.said("DR-2: left the fleet while armed"), ws.statuses()
    assert await wait_until(lambda: v2.task.done(), timeout=5.0), (v2.service_phase, v2.init_state, ap2.alt)
    assert conn2.closed and not ap2.armed and ap2.alt == 0.0
    assert "DR-2" not in bridge.STATE.retiring and v2.task not in bridge.STATE.vehicle_tasks
    assert ws.said("DR-2: landed and disarmed after leaving the fleet"), ws.statuses()
    await h.close()


async def scenario_cli_count_override_reported():
    """`bridge.py --count 3` under a 10-drone sim: the bridge says its --count
    overrides the init's 10, so the operator knows 7 drones have no vehicle."""
    h = Harness()
    ws = h.client("browser-1")
    for port in (14550, 14560, 14570):
        h.autopilot(port)
    reply = await ready_reply(ws, h.init(ws, count=10, alt=30.0, cli_count=3))
    assert reply["ids"] == ["DR-1", "DR-2", "DR-3"], reply
    assert ws.said("--count 3 overrides the 10 vehicles this init asked for"), ws.statuses()
    await h.close()


async def scenario_land_resent_until_acked():
    """NAV_LAND used to be sent once: a lost datagram left the landing to time
    out (failed:land) with the vehicle hovering over the pad. It is re-sent
    every STEP_RESEND_DT until the autopilot ACKs it."""
    h = Harness()
    ws = h.client("browser-1")
    h.autopilot(14550, drop_lands=1)
    await ready_reply(ws, h.init(ws, count=1, alt=30.0))
    v, conn = vehicle("DR-1"), conn_for(14550)
    await _service(ws, "land")
    assert await wait_until(lambda: conn.count("land") >= 2, timeout=2 * bridge.STEP_RESEND_DT + 0.2), \
        (conn.kinds()[-6:], v.init_state)
    assert await wait_until(lambda: v.service_phase == "landed", timeout=5.0), (v.service_phase, v.init_state)
    assert conn.count("land") == 2, "NAV_LAND kept being re-sent after the ACK"
    await h.close()


async def scenario_failed_landing_can_be_retried():
    """A landing the autopilot rejected leaves the vehicle hovering in service
    phase 'failed': a land under a new request id is accepted (it used to be
    SERVICE_BUSY forever), while a grounded or disarmed vehicle is not."""
    h = Harness()
    ws = h.client("controller")
    await h.init(ws, count=0, alt=30.0)
    clock = Clock()
    with patch.object(bridge, "_now", clock):
        v = current_vehicle()
        conn = v.conn
        await _service(ws, "land", "svc-1")
        conn.push(ack_msg(MAV_CMD_NAV_LAND, MAV_RESULT_DENIED))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert v.service_phase == "failed" and v.init_state == "failed:land", (v.service_phase, v.init_state)
        clock.now += 0.1
        conn.push(hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        conn.push(pos_msg(-8.0, 12.0, -30.0))
        bridge._drain_messages(v)
        await _service(ws, "land", "svc-2")
        ack = ws.of_type("service_ack")[-1]
        assert ack["accepted"] is True and ack["requestId"] == "svc-2", ack
        assert v.service_phase == "landing" and v.service_id == "svc-2" and conn.count("land") == 2
    await h.close()


SCENARIOS = [
    ("NAV_LAND is re-sent until the autopilot ACKs it", scenario_land_resent_until_acked),
    ("a failed landing can be retried under a new request id", scenario_failed_landing_can_be_retried),
    ("--count overriding the init's count is reported in a status line", scenario_cli_count_override_reported),
    ("an init that drops an airborne vehicle lands it and watches it down", scenario_shrinking_init_lands_dropped_vehicle),
    ("re-init keeps a vehicle parked mid-swap parked; only the handshake relaunches it", scenario_reinit_keeps_parked_vehicle),
    ("re-init keeps positionSeq increasing, also for an id that leaves and returns", scenario_reinit_keeps_position_seq),
    ("A2: init of an airborne vehicle at altitude is READY without NAV_TAKEOFF", scenario_reinit_airborne_no_takeoff),
    ("A2: a failed relaunch stays parked and is never re-armed by the bridge", scenario_relaunch_failure_stays_parked),
    ("A2: a PX4 vehicle is reported unsupported, not failed:mode, and never retried", scenario_px4_reported_unsupported),
    ("A2: READY revoked when an autopilot failsafe leaves GUIDED or disarms", scenario_ready_revoked_on_autopilot_mode_change),
    ("#12: not READY at lift-off; READY at the takeoff altitude", scenario_ready_needs_takeoff_altitude),
    ("#12: a long steady climb is not failed by the step timeout", scenario_long_climb_not_timed_out),
    ("#12: a climb stalled below takeoff altitude fails the takeoff step", scenario_stalled_climb_fails_takeoff),
    ("#12: recovery below takeoff altitude climbs by setpoint before READY", scenario_recovery_below_takeoff_alt_climbs_first),
    ("#7: acceptance runner's real-mode command is accepted by bridge.py's CLI", scenario_acceptance_runner_real_command),
    ("CI: acceptance runner's --logs-dir reaches the runner", scenario_acceptance_runner_logs_dir_flag),
    ("#11: acceptance runner waits for a slow-starting server", scenario_acceptance_runner_slow_server_start),
    ("#11: acceptance runner reports a dead server at once, with its output", scenario_acceptance_runner_dead_server_reported),
    ("C03: landing rejection, descent progress noise rejection, late touchdown recovery", scenario_c03_landing_rejection_and_descent_timeout_recovery),
    ("C04: airborne abort holds without arming/takeoff, resumes; grounded abort never arms", scenario_c04_airborne_and_grounded_abort),
    ("C01: relaunch datum conversion at elevated and sunken landing sites", scenario_c01_relaunch_datum_elevated_and_sunken),
    ("C05: machine-readable ACKs and idempotent duplicate suppression", scenario_c05_service_ack_and_idempotency),
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
    ("CSWSH: a foreign web Origin is refused at the handshake", scenario_foreign_origin_rejected),
    ("CSWSH: --token (or a LAN bind) requires ?token= at the handshake", scenario_token_gate),
    ("CSWSH: a --token holding '+' matches when typed as is", scenario_token_plus_typed_as_is),
    ("init: a huge vehicle count is clamped", scenario_init_count_bounded),
    ("malformed messages are skipped without dropping the connection", scenario_malformed_messages_keep_connection),
    ("a malformed init is refused with a status before it can take control", scenario_malformed_init_refused_without_control),
    ("the bridge sends a GCS HEARTBEAT once it hears the vehicle", scenario_gcs_heartbeat_sent),
    ("an init waiting on first passes does not block the controller's messages", scenario_init_does_not_block_controller),
    ("MAVLink from a GCS or another system id is ignored", scenario_foreign_mavlink_source_ignored),
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

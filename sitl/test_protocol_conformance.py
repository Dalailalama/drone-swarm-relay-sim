"""test_protocol_conformance.py - Dual-implementation Protocol Conformance Battery.

Verifies that both sitl/bridge.py and sitl/mock_vehicles.py adhere to the
exact same wire protocol, state transitions, freshness rules, and ACK contracts
defined in docs/PROTOCOL.md.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "sitl"))

import test_bridge as tb
import mock_vehicles as mv
bridge = tb.bridge

GUIDED_MODE_ID = tb.GUIDED_MODE_ID

failures: list[str] = []
# Every service_ack either server sent during the scenarios below; checked
# against the PROTOCOL.md examples at the end.
seen_acks: list[tuple[str, dict]] = []


def assert_conform(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


def doc_examples() -> dict[str, list[dict]]:
    """The fenced ```json wire examples in docs/PROTOCOL.md, keyed by "type"
    (a block without a "type", i.e. the origin object, is keyed "origin")."""
    text = (ROOT / "docs" / "PROTOCOL.md").read_text(encoding="utf-8")
    out: dict[str, list[dict]] = {}
    for block in re.findall(r"```json\n(.*?)```", text, re.S):
        obj = json.loads(block)
        out.setdefault(obj.get("type", "origin"), []).append(obj)
    return out


def note_acks(who: str, raw_messages: list[str]) -> None:
    for raw in raw_messages:
        m = json.loads(raw)
        if m.get("type") == "service_ack":
            seen_acks.append((who, m))


async def test_bridge_conformance() -> None:
    h = tb.Harness()
    ws = h.client("conformance-test")
    clock = tb.Clock()

    with patch.object(bridge, "_now", clock), \
            patch.object(bridge, "HEARTBEAT_STALE_S", 3.0), \
            patch.object(bridge, "POSITION_STALE_S", 3.0), \
            patch.object(bridge, "INIT_STEP_TIMEOUT_S", 10.0), \
            patch.object(bridge, "STEP_RESEND_DT", 2.0):

        # 1. Init schema conformity
        init_task = h.init(ws, count=0, alt=30.0)
        await init_task
        assert_conform(len(ws.messages) >= 1, "Bridge: no ready reply sent")
        ready_msg = json.loads(ws.messages[-1])
        assert_conform(ready_msg.get("type") == "ready", "Bridge: reply type != ready")
        assert_conform("vehicles" in ready_msg and "ids" in ready_msg,
                       "Bridge: missing keys in ready message")
        doc = doc_examples()
        assert_conform(set(ready_msg) == set(doc["ready"][0]),
                       f"Bridge: ready keys {sorted(ready_msg)} != PROTOCOL.md {sorted(doc['ready'][0])}")

        v = tb.current_vehicle()
        conn = v.conn
        ws.messages.clear()

        # Telemetry envelope and per-vehicle keys, from the real broadcast loop.
        bridge._drain_messages(v)
        doc_telem = doc["telemetry"][0]
        assert_conform(set(v.to_ready_entry()) == set(doc["ready"][0]["vehicles"][0]),
                       "Bridge: ready vehicle entry keys differ from PROTOCOL.md")
        h.telemetry()
        sent = []
        for _ in range(50):
            await asyncio.sleep(0.01)
            sent = [m for m in map(json.loads, ws.messages + tb.BROADCASTS) if m.get("type") == "telemetry"]
            if sent:
                break
        h.tasks.pop().cancel()
        ws.messages.clear()
        assert_conform(bool(sent), "Bridge: no telemetry broadcast")
        if sent:
            telem = sent[0]
            assert_conform(set(telem) == set(doc_telem),
                           f"Bridge: telemetry envelope {sorted(telem)} != PROTOCOL.md {sorted(doc_telem)}")
            assert_conform(set(telem["vehicles"][0]) == set(doc_telem["vehicles"][0]),
                           "Bridge: telemetry vehicle keys differ from PROTOCOL.md: "
                           f"{sorted(set(telem['vehicles'][0]) ^ set(doc_telem['vehicles'][0]))}")

        # 2. Service ACK and duplicate deduplication
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "req-conf-1", "action": "land",
            "groundAlt": 0.0
        }), None, 14550)
        assert_conform(len(ws.messages) == 1, "Bridge: missing service_ack")
        ack1 = json.loads(ws.messages[-1])
        assert_conform(ack1["type"] == "service_ack" and ack1["accepted"] is True and ack1["duplicate"] is False,
                       "Bridge: land ack schema mismatch")

        # Duplicate
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "req-conf-1", "action": "land"
        }), None, 14550)
        ack2 = json.loads(ws.messages[-1])
        assert_conform(ack2["accepted"] is True and ack2["duplicate"] is True,
                       "Bridge: duplicate ack mismatch")
        # A rejection: "authorize" while still landing (no touchdown yet).
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "req-conf-2", "action": "authorize"
        }), None, 14550)
        assert_conform(json.loads(ws.messages[-1])["accepted"] is False,
                       "Bridge: authorize before touchdown was accepted")
        note_acks("Bridge", ws.messages)

        # 3. Abort with expired heartbeat qualification
        v.init_state = "landing"
        v.service_phase = "landing"
        v.service_id = "req-conf-ab"
        v.ready = False
        v.last_heartbeat = clock.now - 10.0
        conn.sent.clear()
        ws.messages.clear()
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "req-conf-ab", "action": "abort"
        }), None, 14550)
        assert_conform(v.init_state == bridge.INIT_CONFIRM_ABORT, "Bridge: abort with stale hb must enter confirm-abort")
        conn.push(tb.pos_msg(-80.0, 120.0, -10.0))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert_conform(v.init_state == bridge.INIT_CONFIRM_ABORT and conn.count("setpoint") == 0,
                       "Bridge: must not command hold while heartbeat is expired")

        # Fresh heartbeat confirms hold
        clock.now += 0.1
        conn.push(tb.hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        assert_conform(v.init_state == bridge.INIT_ABORT_HOLD and conn.count("setpoint") == 1,
                       "Bridge: fresh heartbeat must confirm abort-hold")

        # 4. Relaunch datum conversion (elevated +15m)
        v.init_state = "swapped"
        v.service_phase = "swapped"
        v.service_id = "req-conf-rel"
        clock.now += 1.0
        conn.push(tb.hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
        conn.push(tb.pos_msg(0.0, 0.0, -15.0))  # alt = +15m
        conn.push(tb.ext_state_msg(1))
        bridge._drain_messages(v)
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "req-conf-rel", "action": "relaunch", "alt": 40.0
        }), None, 14550)
        assert_conform(v.launch_alt == 15.0 and v.takeoff_alt == 55.0,
                       f"Bridge: relaunch datum expected 55.0m, got {v.takeoff_alt}")
        note_acks("Bridge", ws.messages)

    await h.close()


class MockWebSocket:
    def __init__(self):
        self.sent: list[str] = []

    async def send(self, data: str) -> None:
        self.sent.append(data)


async def test_mock_conformance() -> None:
    clock = [1000.0]
    ws = MockWebSocket()
    with patch.object(mv, "_now", lambda: clock[0]):
        world = mv.WORLD
        world.reset(1, 30.0)
        world.controller = ws
        world.clients = {ws}
        v = world.vehicles["DR-1"]
        v.ready = True
        v.init_state = mv.INIT_READY
        v.armed = True
        v.custom_mode = v.guided_mode_id
        v.last_heartbeat = clock[0]
        v.last_position = clock[0]
        v.position_seq = 1
        v.alt = 30.0

        # 1. State schema
        doc = doc_examples()
        doc_telem = doc["telemetry"][0]
        envelope = json.loads(world.telemetry_message())
        assert_conform(set(envelope) == set(doc_telem),
                       f"Mock: telemetry envelope {sorted(envelope)} != PROTOCOL.md {sorted(doc_telem)}")
        telem = v.to_telemetry()
        assert_conform(set(telem) == set(doc_telem["vehicles"][0]),
                       "Mock: telemetry vehicle keys differ from PROTOCOL.md: "
                       f"{sorted(set(telem) ^ set(doc_telem['vehicles'][0]))}")
        assert_conform(set(v.to_ready_entry()) == set(doc["ready"][0]["vehicles"][0]),
                       "Mock: ready vehicle entry keys differ from PROTOCOL.md")
        # The documented init example is accepted and answered with the documented ready.
        init_ws = MockWebSocket()
        world.controller = None
        await mv.handle_message(init_ws, json.dumps(doc["init"][0]))
        ready = [m for m in map(json.loads, init_ws.sent) if m.get("type") == "ready"]
        assert_conform(len(ready) == 1 and set(ready[0]) == set(doc["ready"][0]),
                       "Mock: ready reply to the PROTOCOL.md init example differs from the documented keys")
        assert_conform(world.vehicles["DR-1"].origin == doc["init"][0].get("origin"),
                       "Mock: origin from the PROTOCOL.md init example not adopted")
        world.reset(1, 30.0)
        world.controller = ws
        v = world.vehicles["DR-1"]
        v.ready = True
        v.init_state = mv.INIT_READY
        v.armed = True
        v.custom_mode = v.guided_mode_id
        v.last_heartbeat = clock[0]
        v.last_position = clock[0]
        v.position_seq = 1
        v.alt = 30.0

        # 2. Duplicate handling & ACK
        await mv.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "req-m-1", "action": "land",
            "groundAlt": 0.0
        }))
        assert_conform(len(ws.sent) == 1, "Mock: missing service_ack")
        ack1 = json.loads(ws.sent[-1])
        assert_conform(ack1["type"] == "service_ack" and ack1["accepted"] is True and ack1["duplicate"] is False,
                       "Mock: land ack schema mismatch")

        # Duplicate
        await mv.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "req-m-1", "action": "land"
        }))
        ack2 = json.loads(ws.sent[-1])
        assert_conform(ack2["accepted"] is True and ack2["duplicate"] is True,
                       "Mock: duplicate ack mismatch")
        await mv.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "req-m-2", "action": "authorize"
        }))
        assert_conform(json.loads(ws.sent[-1])["accepted"] is False,
                       "Mock: authorize before touchdown was accepted")
        note_acks("Mock", ws.sent)

        # 3. Abort with expired heartbeat qualification
        v.service_phase = "landing"
        v.service_id = "req-m-ab"
        v.ready = False
        v.armed = True
        v.custom_mode = v.guided_mode_id
        v.last_heartbeat = clock[0] - 10.0
        v.last_position = clock[0]
        v.position_seq += 1
        ws.sent.clear()
        await mv.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "req-m-ab", "action": "abort"
        }))
        assert_conform(v.init_state == mv.INIT_CONFIRM_ABORT and v.hold_alt is None,
                       "Mock: abort with stale hb must enter confirm-abort with no hold target")
        v.advance_init(clock[0])
        assert_conform(v.init_state == mv.INIT_CONFIRM_ABORT and v.hold_alt is None,
                       "Mock: tick without fresh heartbeat must remain in confirm-abort")

        # Fresh heartbeat confirms hold
        clock[0] += 0.1
        v.last_heartbeat = clock[0]
        v.advance_init(clock[0])
        assert_conform(v.init_state == mv.INIT_ABORT_HOLD and v.hold_alt is not None,
                       "Mock: fresh heartbeat must confirm abort-hold")

        # 4. Relaunch datum conversion (elevated +15m)
        v.alt = 15.0
        v.target_ground_alt = 15.0
        v.landed = True
        v.armed = False
        v.last_landed = clock[0]
        v.service_phase = "swapped"
        v.service_id = "req-m-rel"
        v.service_started = clock[0] - 1.0
        v.last_heartbeat = clock[0]
        v.position_seq += 1
        v.landed_seq += 1
        v.service_position_seq = v.position_seq - 1
        v.service_landed_seq = v.landed_seq - 1
        await mv.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "req-m-rel", "action": "relaunch", "alt": 40.0
        }))
        assert_conform(v.launch_alt == 15.0 and v.takeoff_alt == 55.0,
                       f"Mock: relaunch datum expected 55.0m, got {v.takeoff_alt}")
        note_acks("Mock", ws.sent)


def test_service_ack_keys_match_doc() -> None:
    """Every ack either server sent above carries the keys of the accepted
    PROTOCOL.md example and none outside the union of the examples."""
    acks = doc_examples()["service_ack"]
    assert_conform(len(acks) >= 2, "PROTOCOL.md: needs accepted and rejected service_ack examples")
    required = set(acks[0])
    allowed = set().union(*acks)
    assert_conform({who for who, _ in seen_acks} == {"Bridge", "Mock"}, "acks not captured from both servers")
    for who, ack in seen_acks:
        keys = set(ack)
        assert_conform(required <= keys <= allowed,
                       f"{who}: service_ack keys {sorted(keys)} outside PROTOCOL.md "
                       f"(required {sorted(required)}, allowed {sorted(allowed)})")
        if not ack["accepted"]:
            assert_conform("retryable" in ack, f"{who}: rejected service_ack lacks retryable")
    dups = {who: sorted(ack) for who, ack in seen_acks if ack["duplicate"]}
    assert_conform(dups.get("Bridge") == dups.get("Mock"),
                   f"duplicate-replay ack keys differ between the servers: {dups}")


async def test_ready_means_takeoff_altitude() -> None:
    """#12: READY only at the takeoff altitude (PROTOCOL.md: climb >= takeoff_alt - 1 m),
    in both implementations and on both the first pass and the recovery path.
    The bridge used to say READY at 1 m, which real ArduCopter SITL exposed."""
    clock = [2000.0]
    with patch.object(bridge, "_now", lambda: clock[0]):
        bv = bridge.Vehicle(id="DR-1", index=0, port=14550, takeoff_alt=30.0)
        bv.last_position = clock[0]
        bv.alt = 2.0
        assert_conform(bv.airborne and not bv.at_takeoff_alt,
                       "Bridge: 2 m of a 30 m takeoff counts as the takeoff altitude")
        bv.alt = 29.5
        assert_conform(bv.at_takeoff_alt, "Bridge: 29.5 m of a 30 m takeoff not accepted")

    with patch.object(mv, "_now", lambda: clock[0]):
        mv.WORLD = mv.World()  # an init keeps a listed vehicle: start from an empty fleet
        mv.WORLD.reset(1, 30.0)
        m = mv.WORLD.vehicles["DR-1"]
        m.armed = True
        m.custom_mode = m.guided_mode_id
        m.last_heartbeat = m.last_position = clock[0]
        m.position_seq = 1
        m.alt = 2.0
        m._enter_step(mv.INIT_CONFIRM_TAKEOFF, clock[0])
        m.advance_init(clock[0])
        assert_conform(not m.ready, "Mock: READY at 2 m of a 30 m takeoff")
        # Recovery of a vehicle already airborne but short of the altitude.
        m.init_state, m.ready, m.failed_at = mv.FAILED_PREFIX + "takeoff", False, clock[0] - 60.0
        m.alt = 5.0
        m.advance_init(clock[0])
        assert_conform(not m.ready and m.init_state == mv.INIT_CONFIRM_TAKEOFF,
                       f"Mock: recovery at 5 m of 30 m went {m.init_state!r}, ready={m.ready}")
        m.alt = 29.5
        m.advance_init(clock[0])
        assert_conform(m.ready, "Mock: 29.5 m of a 30 m takeoff not READY")


async def test_grounded_abort_exits_by_relaunch() -> None:
    """land -> landed -> abort (grounded) parks the vehicle in 'aborted', and
    resume answers "relaunch required": relaunch must then be accepted, in
    both implementations. It was refused (INVALID_PHASE), as were complete
    and land, so the only way out was an init."""
    h = tb.Harness()
    ws = h.client("conformance-abort")
    await h.init(ws, count=0, alt=30.0)
    clock = tb.Clock()

    async def service(action, **extra):
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "svc-ga", "action": action, **extra}), None, 14550)
        return json.loads(ws.messages[-1])

    with patch.object(bridge, "_now", clock):
        v = tb.current_vehicle()
        conn = v.conn
        await service("land")
        for _ in range(5):
            clock.now += 0.1
            conn.push(tb.hb_msg(armed=False, custom_mode=GUIDED_MODE_ID))
            conn.push(tb.pos_msg(0.0, 0.0, -0.2))
            conn.push(tb.ext_state_msg(1))
            bridge._drain_messages(v)
            await bridge._advance_init(v)
        assert_conform(v.service_phase == "landed", f"Bridge: grounded-abort setup never landed ({v.service_phase})")
        assert_conform((await service("abort"))["accepted"] and v.init_state == "aborted",
                       f"Bridge: grounded abort not parked in 'aborted' ({v.init_state})")
        assert_conform((await service("resume")).get("code") == "CANNOT_RESUME_GROUNDED",
                       "Bridge: resume of a grounded abort must say relaunch is required")
        ack = await service("relaunch", alt=20.0)
        assert_conform(ack["accepted"] and v.service_phase == "relaunch" and v.init_state == bridge.INIT_CONFIRM_MODE,
                       f"Bridge: relaunch after a grounded abort refused: {ack}")
    await h.close()

    clock = [3000.0]
    with patch.object(mv, "_now", lambda: clock[0]):
        world = mv.World()
        world.reset(1, 30.0)
        m = world.vehicles["DR-1"]
        for _ in range(1000):
            clock[0] += 0.05
            world.physics_tick(0.05)
            if m.ready:
                break
        m.service("svc-ga", "land", {"groundAlt": 0.0})
        for _ in range(1000):
            clock[0] += 0.05
            world.physics_tick(0.05)
            if m.service_phase == "landed":
                break
        assert_conform(m.service_phase == "landed", f"Mock: grounded-abort setup never landed ({m.service_phase})")
        assert_conform(m.service("svc-ga", "abort", {})[0] and m.init_state == "aborted",
                       f"Mock: grounded abort not parked in 'aborted' ({m.init_state})")
        assert_conform(m.service("svc-ga", "resume", {})[2] == "CANNOT_RESUME_GROUNDED",
                       "Mock: resume of a grounded abort must say relaunch is required")
        clock[0] += 0.05
        world.physics_tick(0.05)
        acc, err, code, _ = m.service("svc-ga", "relaunch", {"alt": 20.0})
        assert_conform(acc and m.service_phase == "relaunch",
                       f"Mock: relaunch after a grounded abort refused: {code} {err}")


async def test_shared_semantics() -> None:
    """Behaviour the mock used to fake, run identically against both servers:
    a re-init keeps an airborne vehicle where it is; a relaunch whose arm is
    refused parks the vehicle (failed:arm, then back to 'landed' on the
    ground, never re-armed or climbing); an abort whose GUIDED request is
    refused never reports abort-hold (failed:abort instead)."""
    # --- bridge -----------------------------------------------------------
    h = tb.Harness()
    ws = h.client("conformance-semantics")
    ap = h.autopilot(14550)
    await h.init(ws, count=1, alt=30.0)
    v = bridge.STATE.vehicles["DR-1"]
    ap.north, ap.east = -40.0, 25.0
    await tb.wait_until(lambda: (v.x, v.y) == (25.0, 40.0))
    await h.init(ws, count=1, alt=30.0)
    await asyncio.sleep(0.1)
    assert_conform(bridge.STATE.vehicles["DR-1"] is v and v.ready and (v.x, v.y) == (25.0, 40.0)
                   and tb.conn_for(14550).count("takeoff") == 1,
                   f"Bridge: re-init moved or re-launched an airborne vehicle ({v.x}, {v.y}, {v.init_state})")
    await h.close()

    h = tb.Harness()
    ws = h.client("conformance-semantics")
    await h.init(ws, count=0, alt=30.0)
    clock = tb.Clock()

    async def service(action, request_id, **extra):
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": request_id, "action": action, **extra}), None, 14550)
        return json.loads(ws.messages[-1])

    def tick(armed, mode, down=-0.2, step=0.1):
        clock.now += step
        conn.push(tb.hb_msg(armed=armed, custom_mode=mode))
        conn.push(tb.pos_msg(0.0, 0.0, down))
        if not armed:
            conn.push(tb.ext_state_msg(1))
        bridge._drain_messages(v)

    with patch.object(bridge, "_now", clock):
        v = tb.current_vehicle()
        conn = v.conn
        v.service_id, v.service_phase, v.init_state, v.ready = "svc-arm", "swapped", "swapped", False
        tick(False, GUIDED_MODE_ID)
        assert_conform((await service("relaunch", "svc-arm", alt=20.0))["accepted"], "Bridge: relaunch setup refused")
        tick(False, GUIDED_MODE_ID)
        await bridge._advance_init(v)
        conn.push(tb.ack_msg(tb.MAV_CMD_COMPONENT_ARM_DISARM, tb.MAV_RESULT_DENIED))
        states = set()
        for _ in range(30):
            tick(False, GUIDED_MODE_ID, step=0.5)
            await bridge._advance_init(v)
            states.add(v.init_state)
        assert_conform("failed:arm" in states and v.service_phase in ("failed", "landed") and not v.ready
                       and conn.count("arm") == 1 and conn.count("takeoff") == 0,
                       f"Bridge: refused relaunch arm not parked ({sorted(states)}, {v.service_phase}, "
                       f"arms={conn.count('arm')})")

        v = tb.current_vehicle()
        await service("land", "svc-guided")
        tick(True, 9, down=-20.0)  # ArduCopter switched to LAND (9) and will not leave it
        await service("abort", "svc-guided")
        states = set()
        for _ in range(30):
            tick(True, 9, down=-20.0, step=0.5)
            await bridge._advance_init(v)
            states.add(v.init_state)
        assert_conform(bridge.INIT_ABORT_HOLD not in states and "failed:abort" in states,
                       f"Bridge: abort with GUIDED refused went {sorted(states)}")
    await h.close()

    # --- mock -------------------------------------------------------------
    clock = [5000.0]
    with patch.object(mv, "_now", lambda: clock[0]):
        world = mv.World()

        def run(pred, n=1000):
            for _ in range(n):
                clock[0] += 0.05
                world.physics_tick(0.05)
                if pred():
                    return True
            return False

        world.reset(1, 30.0)
        m = world.vehicles["DR-1"]
        run(lambda: m.ready)
        world.apply_goals([{"id": "DR-1", "x": 25.0, "y": 40.0, "alt": 30.0}])
        run(lambda: (m.x, m.y) == (25.0, 40.0))
        world.reset(1, 30.0)
        run(lambda: False, n=20)
        assert_conform(world.vehicles["DR-1"] is m and m.ready and (m.x, m.y) == (25.0, 40.0),
                       f"Mock: re-init moved an airborne vehicle ({m.x}, {m.y}, {m.init_state})")

        m.service("svc-arm", "land", {"groundAlt": 0.0})
        run(lambda: m.service_phase == "landed")
        m.service("svc-arm", "authorize", {})
        m.service("svc-arm", "complete", {})
        m.arm_refused = True
        acc, *_ = m.service("svc-arm", "relaunch", {"alt": 20.0})
        states = set()
        for _ in range(60):
            clock[0] += 0.05
            world.physics_tick(0.05)
            states.add(m.init_state)
        assert_conform(acc and "failed:arm" in states and m.service_phase in ("failed", "landed")
                       and not m.armed and not m.ready and m.alt == 0.0,
                       f"Mock: refused relaunch arm not parked ({sorted(states)}, {m.service_phase}, alt {m.alt})")

        world.reset(0, 30.0)
        world.reset(1, 30.0)
        m = world.vehicles["DR-1"]
        run(lambda: m.ready)
        m.service("svc-guided", "land", {"groundAlt": 0.0})
        run(lambda: False, n=5)
        m.stuck_mode = True
        m.service("svc-guided", "abort", {})
        states = set()
        for _ in range(300):
            clock[0] += 0.05
            world.physics_tick(0.05)
            states.add(m.init_state)
        assert_conform(mv.INIT_ABORT_HOLD not in states and "failed:abort" in states,
                       f"Mock: abort with GUIDED refused went {sorted(states)}")


def main() -> int:
    print("Testing Protocol Conformance across Bridge and Mock implementations...")
    asyncio.run(test_bridge_conformance())
    asyncio.run(test_mock_conformance())
    asyncio.run(test_ready_means_takeoff_altitude())
    asyncio.run(test_grounded_abort_exits_by_relaunch())
    asyncio.run(test_shared_semantics())
    test_service_ack_keys_match_doc()

    if failures:
        print(f"FAILED ({len(failures)} conformance errors):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS: Both Bridge and Mock implementations conform identically to docs/PROTOCOL.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())

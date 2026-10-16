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


def main() -> int:
    print("Testing Protocol Conformance across Bridge and Mock implementations...")
    asyncio.run(test_bridge_conformance())
    asyncio.run(test_mock_conformance())
    asyncio.run(test_ready_means_takeoff_altitude())
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

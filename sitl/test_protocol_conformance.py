"""test_protocol_conformance.py - Dual-implementation Protocol Conformance Battery.

Verifies that both sitl/bridge.py and sitl/mock_vehicles.py adhere to the
exact same wire protocol, state transitions, freshness rules, and ACK contracts
defined in docs/PROTOCOL.md.
"""
from __future__ import annotations

import asyncio
import json
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


def assert_conform(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)


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

        v = tb.current_vehicle()
        conn = v.conn
        ws.messages.clear()

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
        telem = v.to_telemetry()
        expected_keys = {"id", "x", "y", "alt", "ready", "state", "connected", "positionAge", "positionSeq", "servicePhase"}
        assert_conform(expected_keys.issubset(set(telem.keys())), "Mock: telemetry schema missing keys")

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

    if failures:
        print(f"FAILED ({len(failures)} conformance errors):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS: Both Bridge and Mock implementations conform identically to docs/PROTOCOL.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())

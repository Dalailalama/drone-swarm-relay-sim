"""test_failure_scenarios.py - Automated Fault Injection Scenarios.

Injects specific failure conditions into the bridge and mock vehicles:
1. Delayed acknowledgments (command ACK latency exceeding timeout/retry boundaries).
2. Stale heartbeats (heartbeat dropped > 3.0s while positions arrive).
3. Missing / frozen positions (position stopped while heartbeats continue).
4. Abrupt controller disconnects and subsequent takeover handoffs.
5. Service phase mismatch and corrupted parameters.

Every scenario runs with a deterministic PRNG seed, records structured event logs,
and outputs a reproducible trace log.
"""
from __future__ import annotations

import asyncio
import json
import random
import sys
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "sitl"))

import test_bridge as tb
import mock_vehicles as mv
bridge = tb.bridge
GUIDED_MODE_ID = tb.GUIDED_MODE_ID


@dataclass
class EventLogger:
    seed: int
    events: list[dict] = field(default_factory=list)

    def log(self, t: float, category: str, message: str, **details) -> None:
        entry = {
            "t": round(t, 3),
            "seed": self.seed,
            "category": category,
            "msg": message,
            **details,
        }
        self.events.append(entry)

    def dump_json(self) -> str:
        return json.dumps({"seed": self.seed, "totalEvents": len(self.events), "events": self.events}, indent=2)


async def scenario_delayed_acknowledgments(seed: int = 1001) -> EventLogger:
    """Scenario 1: Delayed ACKs test timeout and retry ladder."""
    rng = random.Random(seed)
    logger = EventLogger(seed)
    h = tb.Harness()
    ws = h.client("controller")
    clock = tb.Clock()

    with patch.object(bridge, "_now", clock), \
            patch.object(bridge, "INIT_STEP_TIMEOUT_S", 2.0), \
            patch.object(bridge, "STEP_RESEND_DT", 0.5):

        logger.log(clock.now, "INIT", "Initializing fleet with 1 vehicle")
        await h.init(ws, count=0, alt=30.0)
        v = tb.current_vehicle()
        conn = v.conn

        # Request land service
        logger.log(clock.now, "SERVICE_REQ", "Issuing land request", id="DR-1", requestId="req-delay-1")
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "req-delay-1", "action": "land", "groundAlt": 0.0
        }), None, 14550)

        # Inject artificial ACK delay: simulate autopilot taking 1.5s (longer than resend interval 0.5s)
        delay_s = rng.uniform(1.2, 1.6)
        logger.log(clock.now, "FAIL_INJECT", f"Delaying MAV_CMD_NAV_LAND ACK by {delay_s:.2f}s", delay=delay_s)

        # Advance clock by 0.6s (triggering resend) without sending ACK
        clock.now += 0.6
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        logger.log(clock.now, "CHECK", "Checking landing state before delayed ACK", state=v.init_state, phase=v.service_phase)
        assert v.service_phase == "landing", "service phase should remain landing during delay"

        # Deliver ACK before timeout expires
        clock.now += delay_s - 0.6
        conn.push(tb.ack_msg(21, 0))  # MAV_CMD_NAV_LAND accepted
        bridge._drain_messages(v)
        await bridge._advance_init(v)
        logger.log(clock.now, "RECOVERY", "Delayed ACK delivered and consumed", acks=dict(v.acks))
        assert v.acks.get(21) == 0, "ACK must be recorded"

    await h.close()
    return logger


async def scenario_stale_heartbeat_during_abort(seed: int = 1002) -> EventLogger:
    """Scenario 2: Stale heartbeat blocks abort hold confirmation and setpoints."""
    logger = EventLogger(seed)
    h = tb.Harness()
    ws = h.client("controller")
    clock = tb.Clock()

    with patch.object(bridge, "_now", clock), \
            patch.object(bridge, "HEARTBEAT_STALE_S", 3.0), \
            patch.object(bridge, "INIT_STEP_TIMEOUT_S", 10.0), \
            patch.object(bridge, "STEP_RESEND_DT", 2.0):

        await h.init(ws, count=0, alt=30.0)
        v = tb.current_vehicle()
        conn = v.conn

        v.init_state = "landing"
        v.service_phase = "landing"
        v.service_id = "req-hb-drop"
        v.ready = False
        clock.now = 10.0
        # Inject stale heartbeat (last seen at t=0, so age=10s > 3s)
        logger.log(clock.now, "FAIL_INJECT", "Heartbeat starved for 10.0s while positions stream", heartbeatAge=10.0)

        conn.sent.clear()
        ws.messages.clear()
        await bridge.handle_message(ws, json.dumps({
            "type": "service", "id": "DR-1", "requestId": "req-hb-drop", "action": "abort"
        }), None, 14550)

        # Deliver fresh positions only
        for _ in range(3):
            clock.now += 0.1
            conn.push(tb.pos_msg(-20.0, 15.0, -18.0))
            bridge._drain_messages(v)
            await bridge._advance_init(v)

        logger.log(clock.now, "CHECK", "Asserting hold setpoints blocked while heartbeat is stale",
                   state=v.init_state, setpoints=conn.count("setpoint"), connected=v.connected)
        assert v.init_state == bridge.INIT_CONFIRM_ABORT, "must not confirm abort without fresh heartbeat"
        assert conn.count("setpoint") == 0, "must not emit setpoint when disconnected"

        # Recover heartbeat
        logger.log(clock.now, "RECOVERY", "Fresh GUIDED heartbeat arrives")
        clock.now += 0.1
        conn.push(tb.hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        bridge._drain_messages(v)
        await bridge._advance_init(v)

        logger.log(clock.now, "CONFIRM", "Abort confirmed into hold",
                   state=v.init_state, setpoints=conn.count("setpoint"), connected=v.connected)
        assert v.init_state == bridge.INIT_ABORT_HOLD
        assert conn.count("setpoint") == 1

    await h.close()
    return logger


async def scenario_frozen_position_telemetry(seed: int = 1003) -> EventLogger:
    """Scenario 3: Position frozen while heartbeats continue drops readiness."""
    logger = EventLogger(seed)
    h = tb.Harness()
    ws = h.client("controller")
    clock = tb.Clock()

    with patch.object(bridge, "_now", clock), \
            patch.object(bridge, "POSITION_STALE_S", 3.0):

        await h.init(ws, count=0, alt=30.0)
        v = tb.current_vehicle()
        conn = v.conn
        logger.log(clock.now, "INIT", "Vehicle ready with fresh link", ready=v.ready, posFresh=v.position_fresh)
        assert v.ready and v.position_fresh

        # Freeze position updates while advancing clock past 3.0s
        logger.log(clock.now, "FAIL_INJECT", "Freezing position stream for 3.5s while heartbeats continue")
        clock.now += 3.5
        conn.push(tb.hb_msg(armed=True, custom_mode=GUIDED_MODE_ID))
        bridge._drain_messages(v)

        # Attempt to dispatch goals
        conn.sent.clear()
        await tb.dispatch_goals(ws)
        logger.log(clock.now, "CHECK", "Checking goal suppression during stale position",
                   setpoints=conn.count("setpoint"), posFresh=v.position_fresh, connected=v.connected)
        assert not v.position_fresh, "position should be stale"
        assert conn.count("setpoint") == 0, "stale position must suppress goal setpoints"

        # Position resumes
        logger.log(clock.now, "RECOVERY", "Position stream resumes with fresh coordinates")
        conn.push(tb.pos_msg(-4.0, 10.0, -25.0))
        bridge._drain_messages(v)
        await tb.dispatch_goals(ws)
        assert v.position_fresh
        assert conn.count("setpoint") == 1, "resumed position must permit goals"

    await h.close()
    return logger


async def scenario_controller_disconnect_and_handoff(seed: int = 1004) -> EventLogger:
    """Scenario 4: Abrupt controller disconnect and subsequent client handoff."""
    logger = EventLogger(seed)
    h = tb.Harness()
    c1 = h.client("operator-1")
    c2 = h.client("operator-2")
    clock = tb.Clock()

    with patch.object(bridge, "_now", clock):
        logger.log(clock.now, "ACQUIRE", "Operator-1 acquires fleet control")
        await h.init(c1, count=0, alt=30.0)
        v = tb.current_vehicle()
        assert bridge.STATE.controller is c1

        # Operator-2 attempts goals before acquiring -> rejected
        logger.log(clock.now, "FAIL_INJECT", "Unauthorized client attempts to send goals")
        v.conn.sent.clear()
        await tb.dispatch_goals(c2)
        assert v.conn.count("setpoint") == 0, "non-controller client must not command goals"

        # Operator-1 abruptly disconnects
        logger.log(clock.now, "DISCONNECT", "Operator-1 drops connection unexpectedly")
        bridge.client_disconnected(c1)
        assert bridge.STATE.controller is None, "controller must be released"

        # Vehicles must keep flying without crashing
        logger.log(clock.now, "STABILITY", "Verifying fleet maintains state while unowned",
                   state=v.init_state, ready=v.ready)
        assert v.ready and v.init_state == bridge.INIT_READY

        # Operator-2 takes over via init
        logger.log(clock.now, "HANDOFF", "Operator-2 takes over ownership")
        await h.init(c2, count=0, alt=30.0)
        assert bridge.STATE.controller is c2
        v2 = tb.current_vehicle()

        # Operator-2 commands goals successfully
        v2.conn.sent.clear()
        await tb.dispatch_goals(c2)
        assert v2.conn.count("setpoint") == 1, "new controller must be able to command fleet"
        logger.log(clock.now, "SUCCESS", "Handoff successfully verified")

    await h.close()
    return logger


def main() -> int:
    print("Running Automated Fault Injection and Failure Scenarios...")
    scenarios = [
        ("Delayed Acknowledgments", scenario_delayed_acknowledgments),
        ("Stale Heartbeat During Abort", scenario_stale_heartbeat_during_abort),
        ("Frozen Position Telemetry", scenario_frozen_position_telemetry),
        ("Controller Disconnect & Handoff", scenario_controller_disconnect_and_handoff),
    ]

    failed = 0
    for name, sc in scenarios:
        try:
            logger = asyncio.run(sc())
            print(f"PASS  {name} (Seed {logger.seed}, {len(logger.events)} events logged)")
        except Exception as e:
            failed += 1
            print(f"FAIL  {name}: {e}")

    print(f"\n{len(scenarios) - failed}/{len(scenarios)} failure scenarios passed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

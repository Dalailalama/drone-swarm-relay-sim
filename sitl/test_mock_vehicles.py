"""test_mock_vehicles.py - unit tests for mock_vehicles.py executable mock.

Tests:
1. Startup, physics tick, and telemetry schema (no crash on landed, heartbeatAge present).
2. Origin coordinates: non-zero origin is not double-offset in apply_goals.
3. Elevated (+15m) and sunken (-10m) landing, touchdown, and relaunch datum conversion.
4. Slow healthy descent (>10s), stalled descent timeout, and late touchdown recovery.
5. Continuous 90-second swap telemetry freshness (service_grounded remains True).
6. Airborne abort-to-hold, goal masking, resume, and grounded abort.
7. Machine-readable service ACKs, retryable rejection recovery, and duplicate suppression.
8. Two consecutive complete service cycles on the same vehicle.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import mock_vehicles
from mock_vehicles import (
    INIT_ABORT_HOLD,
    INIT_CONFIRM_ABORT,
    INIT_CONFIRM_MODE,
    INIT_CONFIRM_TAKEOFF,
    INIT_READY,
    Vehicle,
    World,
)


class Clock:
    def __init__(self, start: float = 1000.0):
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


CLOCK = Clock(1000.0)
mock_vehicles._now = CLOCK

_orig_physics_tick = World.physics_tick


def _test_physics_tick(self, dt: float) -> None:
    CLOCK.advance(dt)
    _orig_physics_tick(self, dt)


World.physics_tick = _test_physics_tick


class MockWebSocket:
    def __init__(self):
        self.sent: list[str] = []

    async def send(self, data: str) -> None:
        self.sent.append(data)


async def test_startup_physics_telemetry():
    """Verify first physics tick does not crash and telemetry schema is complete."""
    w = World()
    ids = w.reset(2, alt=40.0)
    assert ids == ["DR-1", "DR-2"]
    v1 = w.vehicles["DR-1"]

    # First physics tick: must not crash on landed attribute
    w.physics_tick(0.05)
    assert hasattr(v1, "landed")
    assert hasattr(v1, "heartbeatAge") or "heartbeatAge" in v1.to_telemetry()

    # Step init until ready
    for _ in range(300):
        w.physics_tick(0.05)
        if v1.ready:
            break
    assert v1.ready and v1.init_state == INIT_READY, f"expected ready, got {v1.init_state}"

    # Telemetry schema check
    telem = json.loads(w.telemetry_message())
    assert telem["type"] == "telemetry"
    v_telem = telem["vehicles"][0]
    required_fields = [
        "id", "x", "y", "alt", "connected", "ready", "state", "armed",
        "heartbeatAge", "positionAge", "positionSeq", "landed", "landedAge",
        "landedSeq", "serviceId", "servicePhase", "origin",
    ]
    for field in required_fields:
        assert field in v_telem, f"missing field {field} in telemetry"


async def test_origin_coordinates_not_double_offset():
    """Verify apply_goals treats coordinates as origin-relative (no double offset)."""
    w = World()
    origin = {"frame": "common-local-origin", "x": 100.0, "y": 200.0, "groundM": 50.0}
    ids = w.reset(1, alt=30.0, origin=origin)
    v = w.vehicles["DR-1"]
    for _ in range(300):
        w.physics_tick(0.05)
        if v.ready:
            break
    assert v.ready

    # Browser sends goals: x=10, y=20, alt=30
    w.apply_goals([{"id": "DR-1", "x": 10.0, "y": 20.0, "alt": 30.0}])
    assert v.goal_x == 10.0, f"goal_x should be 10.0, got {v.goal_x}"
    assert v.goal_y == 20.0, f"goal_y should be 20.0, got {v.goal_y}"
    assert v.goal_alt == 30.0, f"goal_alt should be 30.0, got {v.goal_alt}"


async def test_elevated_and_sunken_landing_and_relaunch():
    """Test landing on elevated (+15m) and sunken (-10m) sites, and datum conversion on relaunch."""
    w = World()
    w.reset(1, alt=30.0)
    v = w.vehicles["DR-1"]
    for _ in range(300):
        w.physics_tick(0.05)
        if v.ready:
            break
    assert v.ready

    # 1. Landing on elevated pad (+15m)
    acc, err, code, ret = v.service("svc-elev", "land", {"groundAlt": 15.0})
    assert acc and v.service_phase == "landing"
    assert v.target_ground_alt == 15.0

    # Let vehicle descend to touchdown
    for _ in range(300):
        w.physics_tick(0.05)
        if v.service_phase == "landed":
            break
    assert v.service_phase == "landed" and v.landed and not v.armed
    assert abs(v.alt - 15.0) <= 0.05

    # Swap authorization & completion
    acc, _, _, _ = v.service("svc-elev", "authorize", {})
    assert acc and v.service_phase == "swapping"
    acc, _, _, _ = v.service("svc-elev", "complete", {})
    assert acc and v.service_phase == "swapped"

    # Relaunch with 50m AGL requested
    acc, _, _, _ = v.service("svc-elev", "relaunch", {"alt": 50.0})
    assert acc and v.service_phase == "relaunch"
    assert v.launch_alt == 15.0
    assert v.takeoff_climb_m == 50.0
    assert v.takeoff_alt == 65.0, f"expected 65m, got {v.takeoff_alt}"

    # Let vehicle climb to ready and reach target altitude
    for _ in range(500):
        w.physics_tick(0.05)
        if v.ready and abs(v.alt - 65.0) <= 0.05:
            break
    assert v.ready and v.service_phase is None
    assert abs(v.alt - 65.0) <= 0.05

    # 2. Landing on sunken pad (-10m)
    acc, _, _, _ = v.service("svc-sunk", "land", {"groundAlt": -10.0})
    assert acc and v.service_phase == "landing"
    for _ in range(600):
        w.physics_tick(0.05)
        if v.service_phase == "landed":
            break
    assert v.service_phase == "landed" and v.landed and not v.armed
    assert abs(v.alt - (-10.0)) <= 0.05

    v.service("svc-sunk", "authorize", {})
    v.service("svc-sunk", "complete", {})
    acc, _, _, _ = v.service("svc-sunk", "relaunch", {"alt": 50.0})
    assert acc and v.launch_alt == -10.0 and v.takeoff_alt == 40.0


async def test_slow_healthy_descent_stalled_timeout_and_late_recovery():
    """Verify healthy slow descent (>10s) succeeds, stalled descent times out, and late touchdown recovers."""
    CLOCK.t = 1000.0
    w = World()
    w.reset(1, alt=100.0)
    v = w.vehicles["DR-1"]
    for _ in range(800):
        w.physics_tick(0.05)
        if v.ready and abs(v.alt - 100.0) <= 0.05:
            break
    assert v.ready and abs(v.alt - 100.0) <= 0.05

    # 1. Slow healthy descent from 100m to 0m (takes ~33.3 seconds > 10s timeout)
    acc, _, _, _ = v.service("svc-slow", "land", {"groundAlt": 0.0})
    assert acc and v.service_phase == "landing"
    start_t = CLOCK()

    for _ in range(800):
        w.physics_tick(0.05)
        if v.service_phase == "landed":
            break
    elapsed = CLOCK() - start_t
    assert elapsed > 10.0, f"expected descent > 10s, took {elapsed:.1f}s"
    assert v.service_phase == "landed" and v.landed and not v.armed
    assert abs(v.alt - 0.0) <= 0.05

    # Complete cycle to ready again at 30m
    v.service("svc-slow", "authorize", {})
    v.service("svc-slow", "complete", {})
    v.service("svc-slow", "relaunch", {"alt": 30.0})
    for _ in range(300):
        w.physics_tick(0.05)
        if v.ready:
            break
    assert v.ready

    # 2. Stalled descent: starts landing, then descent stalls for > 10 seconds
    acc, _, _, _ = v.service("svc-stall", "land", {"groundAlt": 0.0})
    assert acc and v.service_phase == "landing"
    for _ in range(40):
        w.physics_tick(0.05)
    assert v.alt < 28.0 and v.service_phase == "landing"

    # Settle goal at current altitude to stop descent
    v.goal_alt = v.alt
    w.physics_tick(0.05)
    # Advance clock beyond 10s timeout without descent progress
    CLOCK.advance(10.5)
    w.physics_tick(0.05)
    assert v.service_phase == "failed" and v.init_state == "failed:land"

    # 3. Late touchdown recovery: while in 'failed' phase, touchdown is finally achieved
    v.target_ground_alt = 0.0
    v.goal_alt = 0.0
    v.alt = 0.0
    w.physics_tick(0.05)
    w.physics_tick(0.05)
    assert v.landed and not v.armed
    assert v.service_phase == "landed" and v.init_state == "landed" and v.failed_at is None


async def test_90_second_swap_telemetry_freshness():
    """Verify landed, position, and heartbeat freshness persist across the entire 90s swap."""
    w = World()
    w.reset(1, alt=30.0)
    v = w.vehicles["DR-1"]
    for _ in range(300):
        w.physics_tick(0.05)
        if v.ready:
            break

    v.service("svc-fresh", "land", {"groundAlt": 0.0})
    for _ in range(300):
        w.physics_tick(0.05)
        if v.service_phase == "landed":
            break
    assert v.service_phase == "landed" and v.service_grounded

    v.service("svc-fresh", "authorize", {})
    assert v.service_phase == "swapping"

    # Simulate 90 seconds (1800 ticks at 0.05s) of sitting on the pad
    for _ in range(1800):
        w.physics_tick(0.05)
        assert v.service_grounded, "freshness checks expired during the 90-second swap"
        assert v.position_fresh, "position became stale during swap"
        assert v.landed, "landed flag cleared during swap"
        assert v.landed_age is not None and v.landed_age < 0.5, f"landedAge too old: {v.landed_age}"

    # Complete swap after 90 seconds
    acc, _, _, _ = v.service("svc-fresh", "complete", {})
    assert acc and v.service_phase == "swapped"


async def test_airborne_and_grounded_abort():
    """Test airborne abort-to-hold, ignoring goals, and resuming; test grounded abort never arms."""
    CLOCK.t = 1000.0
    w = World()
    w.reset(1, alt=30.0)
    v = w.vehicles["DR-1"]
    for _ in range(300):
        w.physics_tick(0.05)
        if v.ready:
            break

    # 1. Airborne abort below launch elevation (-5m while descending toward sunken pad at -10m)
    acc, _, _, _ = v.service("svc-ab1", "land", {"groundAlt": -10.0})
    assert acc and v.service_phase == "landing"
    for _ in range(300):
        w.physics_tick(0.05)
        if v.alt <= -5.0:
            break
    assert v.service_phase == "landing" and v.alt <= -5.0

    acc, _, _, _ = v.service("svc-ab1", "abort", {})
    assert acc and v.init_state == INIT_ABORT_HOLD and v.service_phase == "aborted"
    hold_alt = v.alt
    assert abs(hold_alt - (-5.0)) <= 0.2

    # Goals must be ignored while in abort-hold
    w.apply_goals([{"id": "DR-1", "x": 50.0, "y": 50.0, "alt": 50.0}])
    assert v.goal_alt == hold_alt

    # Advance time: verify no arming/takeoff or descent, stays in abort-hold
    for _ in range(100):
        w.physics_tick(0.05)
    assert v.init_state == INIT_ABORT_HOLD and not v.ready and v.alt == hold_alt

    # Resume airborne vehicle
    acc, _, _, _ = v.service("svc-ab1", "resume", {})
    assert acc and v.init_state == INIT_READY and v.ready and v.service_phase is None

    # Goals accepted again
    w.apply_goals([{"id": "DR-1", "x": 50.0, "y": 50.0, "alt": 50.0}])
    assert v.goal_alt == 50.0

    # 2. Low hover abort (+0.1m, armed)
    v.alt = 0.1
    v.armed = True
    v.landed = False
    v.service_phase = "landing"
    v.service_id = "svc-ab-hover"
    acc, _, _, _ = v.service("svc-ab-hover", "abort", {})
    assert acc and v.init_state == INIT_ABORT_HOLD and v.service_phase == "aborted"
    assert v.hold_alt == 0.1
    v.service("svc-ab-hover", "resume", {})
    assert v.ready

    # 2b. Stale position abort (W07): enters confirm-abort, holds no position until fresh sample arrives
    v.alt = 25.0
    v.service_phase = "landing"
    v.service_id = "svc-ab-stale"
    v.last_position = CLOCK() - 10.0  # stale
    acc, _, _, _ = v.service("svc-ab-stale", "abort", {})
    assert acc and v.init_state == INIT_CONFIRM_ABORT and v.service_phase == "aborted"
    assert v.hold_alt is None, "must not capture hold target from expired coordinates"
    # Fresh telemetry arrives: captures hold target
    v.last_position = CLOCK()
    v.advance_init(CLOCK())
    assert v.init_state == INIT_ABORT_HOLD
    assert v.hold_alt == 25.0
    v.service("svc-ab-stale", "resume", {})
    assert v.ready

    # 2c. Mode unconfirmed abort timeout (W08)
    v.alt = 20.0
    v.service_phase = "landing"
    v.service_id = "svc-ab-unconf"
    v.stuck_mode = True
    v.custom_mode = 9  # non-GUIDED
    acc, _, _, _ = v.service("svc-ab-unconf", "abort", {})
    assert acc and v.init_state == INIT_CONFIRM_ABORT
    # Advance clock past 10s timeout
    CLOCK.advance(10.5)
    v.advance_init(CLOCK())
    assert v.init_state == "failed:abort" and v.service_phase == "failed"
    # Cannot resume from failed state
    acc, _, _, _ = v.service("svc-ab-unconf", "resume", {})
    assert not acc

    # 2d. Heartbeat expired abort (W10): fresh position cannot confirm without fresh heartbeat
    v.alt = 20.0
    v.custom_mode = v.guided_mode_id
    v.stuck_mode = False
    v.service_phase = "landing"
    v.service_id = "svc-ab-stale-hb"
    v.ready = False
    v.armed = True
    v.last_position = CLOCK()
    v.position_seq += 1
    v.x, v.y = 120.0, 80.0
    v.last_heartbeat = CLOCK() - 10.0  # stale heartbeat
    acc, _, _, _ = v.service("svc-ab-stale-hb", "abort", {})
    assert acc and v.init_state == INIT_CONFIRM_ABORT and v.service_phase == "aborted"
    assert v.hold_alt is None, "must not capture hold target when heartbeat is expired"
    assert not v.connected
    assert v.position_fresh
    v.advance_init(CLOCK())
    assert v.init_state == INIT_CONFIRM_ABORT and v.hold_alt is None

    # Fresh heartbeat arrives
    v.last_heartbeat = CLOCK()
    v.advance_init(CLOCK())
    assert v.init_state == INIT_ABORT_HOLD
    assert v.hold_x == 120.0 and v.hold_y == 80.0 and v.hold_alt == 20.0
    acc, _, _, _ = v.service("svc-ab-stale-hb", "resume", {})
    assert acc and v.ready

    # 3. Grounded abort
    v.stuck_mode = False
    v.custom_mode = v.guided_mode_id
    v.service_phase = None
    v.init_state = INIT_READY
    v.ready = True
    v.armed = True
    v.last_heartbeat = CLOCK()
    v.last_position = CLOCK()
    v.alt = 30.0
    v.service("svc-ab2", "land", {"groundAlt": 0.0})
    for _ in range(400):
        w.physics_tick(0.05)
        if v.service_phase == "landed":
            break
    assert v.service_phase == "landed" and not v.armed
    v.service("svc-ab2", "authorize", {})
    assert v.service_phase == "swapping"

    acc, _, _, _ = v.service("svc-ab2", "abort", {})
    assert acc and v.init_state == "aborted" and v.service_phase == "aborted"

    # Physics ticks: vehicle must NEVER arm or take off
    for _ in range(200):
        w.physics_tick(0.05)
        assert not v.armed
        assert v.alt == 0.0
        assert v.init_state == "aborted"


async def test_service_acks_and_idempotency():
    """Test machine-readable ACKs, retryable rejection recovery, and duplicate suppression."""
    CLOCK.t = 1000.0
    w = mock_vehicles.WORLD
    ws = MockWebSocket()
    w.reset(1, alt=30.0)
    w.controller = ws
    w.clients.add(ws)
    v = w.vehicles["DR-1"]

    # 1. Temporary rejection is NOT permanently cached (W01)
    # Vehicle is climbing, not ready yet (v.ready == False)
    assert not v.ready
    await mock_vehicles.handle_message(ws, json.dumps({
        "type": "service", "id": "DR-1", "requestId": "req-100", "action": "land",
    }))
    assert len(ws.sent) == 1
    ack_rej = json.loads(ws.sent[0])
    assert ack_rej["type"] == "service_ack" and ack_rej["accepted"] is False
    assert ack_rej["code"] == "VEHICLE_NOT_READY" and ack_rej["retryable"] is True
    assert ("req-100", "land") not in v.service_action_history

    # Step vehicle until ready
    for _ in range(300):
        w.physics_tick(0.05)
        if v.ready:
            break
    assert v.ready

    # Send SAME request ID and action: should NOT return cached rejection, should succeed!
    await mock_vehicles.handle_message(ws, json.dumps({
        "type": "service", "id": "DR-1", "requestId": "req-100", "action": "land",
    }))
    assert len(ws.sent) == 2
    ack1 = json.loads(ws.sent[1])
    assert ack1["type"] == "service_ack" and ack1["accepted"] is True and ack1["duplicate"] is False
    assert ("req-100", "land") in v.service_action_history

    # Send duplicate land action: cached accepted response is replayed
    await mock_vehicles.handle_message(ws, json.dumps({
        "type": "service", "id": "DR-1", "requestId": "req-100", "action": "land",
    }))
    assert len(ws.sent) == 3
    ack2 = json.loads(ws.sent[2])
    assert ack2["type"] == "service_ack" and ack2["accepted"] is True and ack2["duplicate"] is True

    # Invalid action
    await mock_vehicles.handle_message(ws, json.dumps({
        "type": "service", "id": "DR-1", "requestId": "req-100", "action": "invalid_cmd",
    }))
    assert len(ws.sent) == 4
    ack3 = json.loads(ws.sent[3])
    assert ack3["accepted"] is False and "code" in ack3


async def test_two_consecutive_complete_service_cycles():
    """Run two full back-to-back service cycles (land -> swap -> relaunch -> ready)."""
    CLOCK.t = 1000.0
    w = World()
    w.reset(1, alt=30.0)
    v = w.vehicles["DR-1"]
    for _ in range(300):
        w.physics_tick(0.05)
        if v.ready:
            break
    assert v.ready

    for cycle in (1, 2):
        rid = f"cycle-{cycle}"
        # Land
        acc, _, _, _ = v.service(rid, "land", {"groundAlt": 0.0})
        assert acc
        for _ in range(400):
            w.physics_tick(0.05)
            if v.service_phase == "landed":
                break
        assert v.service_phase == "landed"

        # Swap
        acc, _, _, _ = v.service(rid, "authorize", {})
        assert acc and v.service_phase == "swapping"
        for _ in range(50):
            w.physics_tick(0.05)
        acc, _, _, _ = v.service(rid, "complete", {})
        assert acc and v.service_phase == "swapped"

        # Relaunch
        acc, _, _, _ = v.service(rid, "relaunch", {"alt": 30.0})
        assert acc and v.service_phase == "relaunch"
        for _ in range(500):
            w.physics_tick(0.05)
            if v.ready:
                break
        assert v.ready and v.service_phase is None, f"cycle {cycle} failed to complete relaunch"


SCENARIOS = [
    ("Mock: startup, physics tick, and telemetry schema", test_startup_physics_telemetry),
    ("Mock: origin coordinates not double-offset in apply_goals", test_origin_coordinates_not_double_offset),
    ("Mock: elevated and sunken landing, touchdown, and relaunch datum conversion", test_elevated_and_sunken_landing_and_relaunch),
    ("Mock: slow healthy descent, stalled descent timeout, and late touchdown recovery", test_slow_healthy_descent_stalled_timeout_and_late_recovery),
    ("Mock: continuous 90-second swap telemetry freshness", test_90_second_swap_telemetry_freshness),
    ("Mock: airborne abort-to-hold, goal masking, resume, and grounded abort", test_airborne_and_grounded_abort),
    ("Mock: service ACKs, retryable rejection recovery, and duplicate suppression", test_service_acks_and_idempotency),
    ("Mock: two consecutive complete service cycles", test_two_consecutive_complete_service_cycles),
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
    print(f"\n{total - failures}/{total} mock scenarios passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

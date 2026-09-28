#!/usr/bin/env python3
"""run_acceptance.py - Repeatable real-SITL and mock acceptance runner.

Automates the end-to-end acceptance sequence against docs/PROTOCOL.md:
1. Starts the server: mock_vehicles.py, or (real mode) bridge.py talking to
   ArduPilot SITL instances that must already be running
   (sitl/run_ardupilot_sitl.sh).
2. Initializes the fleet and verifies every vehicle reports READY only at
   its takeoff altitude (climb >= alt - 1 m).
3. Sends waypoints and verifies every vehicle actually flies to its goal.
4. Verifies telemetry stays fresh (position age, heartbeat age, advancing
   position sequence).
5. Commands abort-to-hold during a landing and verifies hold + resume.
6. Commands landing and tracks descent to confirmed touchdown.
7. Runs the battery-swap handshake (authorize -> complete).
8. Relaunches and verifies the climb back to the relaunch altitude.
9. Keeps failure logs, the server's own output and a JSON report.

Usage:
    python sitl/run_acceptance.py [--mode mock|real|auto] [--count 3] [--port 8769]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import websockets

ROOT = Path(__file__).resolve().parent.parent
SITL_DIR = ROOT / "sitl"


@dataclass
class StepRecord:
    name: str
    status: str  # "passed" | "failed" | "running"
    duration_s: float = 0.0
    details: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


@dataclass
class AcceptanceReport:
    timestamp: str
    mode: str
    fleet_count: int
    overall_status: str  # "passed" | "failed"
    duration_s: float
    steps: List[StepRecord] = field(default_factory=list)
    failure_reason: Optional[str] = None
    messages_exchanged: int = 0


class AcceptanceRunner:
    def __init__(self, mode: str = "auto", count: int = 3, port: int = 8769,
                 alt_m: float = 15.0, timeout_s: float = 60.0,
                 report_path: Optional[Path] = None, logs_dir: Optional[Path] = None):
        self.requested_mode = mode
        self.count = count
        self.port = port
        self.alt_m = alt_m
        self.timeout_s = timeout_s
        self.report_path = report_path or (SITL_DIR / "acceptance_report.json")
        self.logs_dir = logs_dir or (SITL_DIR / "logs")
        self.logs_dir.mkdir(parents=True, exist_ok=True)

        self.server_process: Optional[subprocess.Popen] = None
        # Server output goes to a file, never an unread PIPE: a chatty bridge
        # would fill the pipe buffer and block mid-run (#11).
        self.server_log_path: Optional[str] = None
        self._server_log = None
        self.sitl_processes: List[subprocess.Popen] = []
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.message_history: List[Dict[str, Any]] = []
        self.steps: List[StepRecord] = []
        self.effective_mode = "mock"

    def log(self, msg: str) -> None:
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] [ACCEPTANCE] {msg}", flush=True)

    def determine_mode(self) -> str:
        if self.requested_mode in ("mock", "real"):
            return self.requested_mode
        # auto-detect
        has_sim_vehicle = shutil.which("sim_vehicle.py") is not None
        if has_sim_vehicle and sys.platform.startswith("linux"):
            return "real"
        return "mock"

    def start_server(self) -> None:
        self.effective_mode = self.determine_mode()
        self.log(f"Starting server in '{self.effective_mode}' mode on port {self.port}…")

        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"

        if self.effective_mode == "mock":
            cmd = [sys.executable, str(SITL_DIR / "mock_vehicles.py"), "--port", str(self.port)]
        else:
            # Real SITL bridge
            bridge_script = SITL_DIR / "bridge.py"
            cmd = [sys.executable, str(bridge_script), "--ws-port", str(self.port), "--count", str(self.count)]
        self.server_log_path = str(self.logs_dir / f"server_{self.effective_mode}_{int(time.time())}.log")
        self._server_log = open(self.server_log_path, "w", encoding="utf-8")
        self.server_process = subprocess.Popen(
            cmd,
            stdout=self._server_log,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )

        # Give server time to bind port
        time.sleep(1.0)
        if self.server_process.poll() is not None:
            raise RuntimeError(f"Server process failed to start: {self.server_output_tail()}")

    def server_output_tail(self, limit: int = 2000) -> str:
        if not self.server_log_path:
            return ""
        try:
            with open(self.server_log_path, encoding="utf-8", errors="replace") as f:
                return f.read()[-limit:].strip()
        except OSError:
            return ""

    def stop_all(self) -> None:
        self.log("Tearing down processes…")
        if self.server_process:
            try:
                self.server_process.terminate()
                self.server_process.wait(timeout=2.0)
            except Exception:
                self.server_process.kill()
            self.server_process = None
        if self._server_log:
            self._server_log.close()
            self._server_log = None

        for proc in self.sitl_processes:
            try:
                proc.terminate()
                proc.wait(timeout=2.0)
            except Exception:
                proc.kill()
        self.sitl_processes.clear()

    async def connect_ws(self, timeout_s: float = 30.0) -> websockets.WebSocketClientProtocol:
        """Connect once the server listens (#11).

        bridge.py imports pymavlink before it listens, which took 8.4 s from a
        slow filesystem, so allow `timeout_s` — but stop at once, with the
        server's own output, if its process has died.
        """
        uri = f"ws://127.0.0.1:{self.port}"
        deadline = time.time() + timeout_s
        while True:
            proc = self.server_process
            if proc is not None and proc.poll() is not None:
                raise RuntimeError(f"server exited before accepting connections: {self.server_output_tail()}")
            try:
                ws = await websockets.connect(uri)
                self.log(f"Connected to {uri}")
                return ws
            except Exception:
                if time.time() >= deadline:
                    raise ConnectionError(f"Failed to connect to {uri} within {timeout_s:g}s")
                await asyncio.sleep(0.5)

    async def send_json(self, msg: Dict[str, Any]) -> None:
        assert self.ws is not None
        payload = json.dumps(msg)
        await self.ws.send(payload)
        self.message_history.append({"dir": "out", "t": time.time(), "msg": msg})

    async def recv_json(self, timeout: float = 10.0) -> Dict[str, Any]:
        assert self.ws is not None
        raw = await asyncio.wait_for(self.ws.recv(), timeout=timeout)
        parsed = json.loads(raw)
        self.message_history.append({"dir": "in", "t": time.time(), "msg": parsed})
        return parsed

    async def recv_until(self, want, timeout: float, what: str) -> Dict[str, Any]:
        """Read messages until `want(msg)` holds.

        Advisory `status` (and any other traffic) may arrive at any time per
        docs/PROTOCOL.md, so it is skipped rather than failing the step (#10).
        """
        deadline = time.time() + timeout
        last = None
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise AssertionError(f"no {what} within {timeout:g}s (last message: {last})")
            try:
                msg = await self.recv_json(timeout=remaining)
            except (asyncio.TimeoutError, TimeoutError):
                raise AssertionError(f"no {what} within {timeout:g}s (last message: {last})")
            if want(msg):
                return msg
            last = msg

    async def wait_telemetry(self, pred, timeout: float, what: str) -> Dict[str, Dict[str, Any]]:
        """Wait for a telemetry frame whose vehicles (keyed by id) satisfy `pred`."""
        latest: Dict[str, Dict[str, Any]] = {}

        def ok(m: Dict[str, Any]) -> bool:
            if m.get("type") != "telemetry":
                return False
            latest.clear()
            latest.update({v.get("id"): v for v in m.get("vehicles", [])})
            return bool(pred(latest))

        try:
            await self.recv_until(ok, timeout, what)
        except AssertionError:
            snap = {k: {f: v.get(f) for f in ("x", "y", "alt", "ready", "state", "servicePhase")} for k, v in latest.items()}
            raise AssertionError(f"no telemetry showing {what} within {timeout:g}s; last: {json.dumps(snap)}")
        return dict(latest)

    async def run_step(self, name: str, coro) -> StepRecord:
        self.log(f"Starting step: {name}")
        step = StepRecord(name=name, status="running")
        self.steps.append(step)
        t0 = time.perf_counter()
        try:
            details = await coro()
            step.duration_s = round(time.perf_counter() - t0, 3)
            step.status = "passed"
            step.details = details or {}
            self.log(f"Step '{name}' PASSED in {step.duration_s}s")
            return step
        except Exception as ex:
            step.duration_s = round(time.perf_counter() - t0, 3)
            step.status = "failed"
            step.error = str(ex)
            self.log(f"Step '{name}' FAILED: {ex}")
            raise

    async def execute(self) -> AcceptanceReport:
        t_start = time.time()
        start_mono = time.perf_counter()
        failure_reason = None

        try:
            self.start_server()
            self.ws = await self.connect_ws()

            # Step 1: Initialize vehicles
            async def step_init():
                await self.send_json({"type": "init", "count": self.count, "alt": self.alt_m})
                # bridge.py answers after its init gather (up to
                # HEARTBEAT_WAIT_TIMEOUT_S + INIT_EXTRA_WAIT_S = 35 s), with
                # advisory status messages ahead of the reply.
                ready_msg = await self.recv_until(lambda m: m.get("type") == "ready", 45.0, "'ready' reply")
                ids = ready_msg.get("ids", [])
                if len(ids) != self.count:
                    raise AssertionError(f"Expected {self.count} vehicle ids, got {ids}")
                return {"readyIds": ids}

            await self.run_step("1. Initialize fleet", step_init)

            ids = [f"DR-{i+1}" for i in range(self.count)]

            # Step 2: READY must mean the takeoff altitude was reached
            # (PROTOCOL.md: climb >= alt - 1 m). Real ArduCopter SITL showed
            # the bridge saying READY at 1 m (#12), which a flag-only check missed.
            async def step_takeoff():
                vs = await self.wait_telemetry(
                    lambda by: all(by.get(i, {}).get("ready") for i in ids), 60.0, "every vehicle READY")
                alts = {i: round(vs[i].get("alt") or 0.0, 1) for i in ids}
                low = {i: a for i, a in alts.items() if a < self.alt_m - 1.0}
                if low:
                    raise AssertionError(f"READY below the {self.alt_m:g} m takeoff altitude: {low}")
                return {"readyCount": len(ids), "altitudesM": alts}

            await self.run_step("2. Arming and takeoff to altitude", step_takeoff)

            # Step 3: every vehicle must actually fly to its waypoint, not just
            # have one sent. Goals are re-sent at ~2 Hz like the browser does.
            async def step_waypoints():
                goals = [{"id": f"DR-{i+1}", "x": 100.0 * (i + 1), "y": 30.0, "alt": self.alt_m}
                         for i in range(self.count)]

                def off(by, g):
                    v = by[g["id"]]
                    return math.hypot((v.get("x") or 0.0) - g["x"], (v.get("y") or 0.0) - g["y"])

                start = await self.wait_telemetry(lambda by: all(g["id"] in by for g in goals), 5.0, "every vehicle")
                deadline = time.time() + 90.0
                while True:
                    await self.send_json({"type": "goals", "goals": goals})
                    try:
                        end = await self.wait_telemetry(
                            lambda by: all(g["id"] in by and off(by, g) <= 8.0 for g in goals), 0.5,
                            "every vehicle within 8 m of its goal")
                        break
                    except AssertionError:
                        if time.time() >= deadline:
                            raise
                return {"goals": len(goals),
                        "startOffM": {g["id"]: round(off(start, g), 1) for g in goals},
                        "endOffM": {g["id"]: round(off(end, g), 1) for g in goals}}

            await self.run_step("3. Waypoint navigation to the goals", step_waypoints)

            # Step 4: telemetry freshness — positions and heartbeats keep
            # arriving (the sequence advances, ages stay small).
            async def step_telemetry_check():
                first = await self.wait_telemetry(lambda by: all(i in by for i in ids), 3.0, "every vehicle")
                await asyncio.sleep(1.0)
                later = await self.wait_telemetry(
                    lambda by: all(i in by and (by[i].get("positionSeq") or 0) > (first[i].get("positionSeq") or 0)
                                   for i in ids), 3.0, "an advancing position sequence")
                stale = {i: (later[i].get("positionAge"), later[i].get("heartbeatAge")) for i in ids
                         if not ((later[i].get("positionAge") is not None and later[i]["positionAge"] < 1.0)
                                 and (later[i].get("heartbeatAge") is None or later[i]["heartbeatAge"] < 1.5))}
                if stale:
                    raise AssertionError(f"stale telemetry (positionAge, heartbeatAge): {stale}")
                return {"positionAgeS": {i: round(later[i]["positionAge"], 2) for i in ids}}

            await self.run_step("4. Telemetry freshness", step_telemetry_check)

            async def service(target_id: str, request_id: str, action: str, **extra) -> Dict[str, Any]:
                await self.send_json({"type": "service", "id": target_id, "requestId": request_id,
                                      "action": action, **extra})
                ack = await self.recv_until(
                    lambda m: (m.get("type") == "service_ack" and m.get("requestId") == request_id
                               and m.get("action") == action), 5.0, f"{action} ack")
                if not ack.get("accepted"):
                    raise AssertionError(f"{action} rejected: {ack}")
                return ack

            # Step 5: abort a landing mid-descent. The vehicle must reach a
            # CONFIRMED hold (state abort-hold; confirm-abort only means the
            # request is pending) and resume all the way back to READY.
            async def step_abort_hold():
                target_id = "DR-1"
                req_id_1 = "svc-trans-1"
                await service(target_id, req_id_1, "land", groundAlt=0.0)
                ack = await service(target_id, req_id_1, "abort")
                await self.wait_telemetry(
                    lambda by: target_id in by and by[target_id].get("state") == "abort-hold", 15.0,
                    f"{target_id} in a confirmed abort-hold")
                await service(target_id, req_id_1, "resume")
                vs = await self.wait_telemetry(
                    lambda by: target_id in by and by[target_id].get("ready"), 30.0,
                    f"{target_id} READY again after resume")
                return {"abortedVehicle": target_id, "ack": ack,
                        "resumedAltM": round(vs[target_id].get("alt") or 0.0, 1)}

            await self.run_step("5. Abort-to-hold and resume verification", step_abort_hold)

            # Step 6: land to a confirmed touchdown. ArduCopter descends at
            # 1.5 m/s to 10 m and 0.5 m/s below, so a 15 m landing alone takes
            # ~25 s: keep waiting while the descent progresses (the bridge's
            # own rule, >= 0.5 m per window) under a hard cap; fail on a stall.
            service_tx = "svc-trans-2"
            async def step_land():
                target_id = "DR-1"
                await service(target_id, service_tx, "land", groundAlt=0.0)
                t0 = progress_at = time.time()
                start_alt = ref_alt = None
                while True:
                    try:
                        vs = await self.wait_telemetry(lambda by: target_id in by, 2.0, target_id)
                    except AssertionError:
                        vs = {}
                    v = vs.get(target_id, {})
                    if v.get("servicePhase") == "landed":
                        return {"landedVehicle": target_id, "fromAltM": round(start_alt or 0.0, 1),
                                "landingS": round(time.time() - t0, 1)}
                    alt = v.get("alt")
                    if alt is not None:
                        start_alt = alt if start_alt is None else start_alt
                        if ref_alt is None or alt <= ref_alt - 0.5:
                            ref_alt, progress_at = alt, time.time()
                    if time.time() - progress_at > 15.0:
                        raise AssertionError(f"{target_id} descent stalled at {alt} m (phase {v.get('servicePhase')})")
                    if time.time() - t0 > 180.0:
                        raise AssertionError(f"{target_id} not landed after 180 s (alt {alt} m)")

            await self.run_step("6. Controlled descent and landing", step_land)

            # Step 7: Battery Swap Cycle (authorize -> complete)
            async def step_battery_swap():
                target_id = "DR-1"
                await self.send_json({"type": "service", "id": target_id, "requestId": service_tx, "action": "authorize"})
                ack_auth = None
                deadline = time.time() + 5.0
                while time.time() < deadline:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "service_ack" and msg.get("requestId") == service_tx and msg.get("action") == "authorize":
                        ack_auth = msg
                        break
                if not ack_auth or not ack_auth.get("accepted"):
                    raise AssertionError(f"Swap authorize rejected or missing ack: {ack_auth}")

                # Verify transition to swapping
                swapping = False
                deadline = time.time() + 5.0
                while time.time() < deadline:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "telemetry":
                        v = next((x for x in msg.get("vehicles", []) if x.get("id") == target_id), None)
                        if v and v.get("servicePhase") == "swapping":
                            swapping = True
                            break
                if not swapping:
                    raise AssertionError(f"Vehicle {target_id} failed to enter swapping phase")

                # Complete swap
                await self.send_json({"type": "service", "id": target_id, "requestId": service_tx, "action": "complete"})
                ack_comp = None
                deadline = time.time() + 5.0
                while time.time() < deadline:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "service_ack" and msg.get("requestId") == service_tx and msg.get("action") == "complete":
                        ack_comp = msg
                        break
                if not ack_comp or not ack_comp.get("accepted"):
                    raise AssertionError(f"Swap complete rejected or missing ack: {ack_comp}")

                # Verify transition to swapped
                swapped = False
                deadline = time.time() + 5.0
                while time.time() < deadline:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "telemetry":
                        v = next((x for x in msg.get("vehicles", []) if x.get("id") == target_id), None)
                        if v and v.get("servicePhase") == "swapped":
                            swapped = True
                            break
                if not swapped:
                    raise AssertionError(f"Vehicle {target_id} failed to enter swapped phase")

                return {"swapAcknowledged": True, "targetId": target_id}

            await self.run_step("7. Battery swap servicing", step_battery_swap)

            # Step 8: relaunch climbs back up. PROTOCOL.md's `alt` is the climb
            # above the touchdown point, so it is measured from where the
            # vehicle actually sits, and READY must wait for it (#12).
            async def step_relaunch():
                target_id = "DR-1"
                climb_m = 20.0
                before = await self.wait_telemetry(lambda by: target_id in by, 3.0, target_id)
                pad_alt = before[target_id].get("alt") or 0.0
                await self.send_json({
                    "type": "service",
                    "id": target_id,
                    "requestId": service_tx,
                    "action": "relaunch",
                    "alt": climb_m,
                })
                ack = await self.recv_until(
                    lambda m: (m.get("type") == "service_ack" and m.get("requestId") == service_tx
                               and m.get("action") == "relaunch"), 5.0, "relaunch ack")
                if not ack.get("accepted"):
                    raise AssertionError(f"Relaunch rejected: {ack}")
                vs = await self.wait_telemetry(
                    lambda by: (target_id in by and by[target_id].get("ready")
                                and (by[target_id].get("alt") or 0.0) >= pad_alt + climb_m - 1.0),
                    60.0, f"{target_id} READY {climb_m:g} m above its pad")
                return {"relaunchedVehicle": target_id, "padAltM": round(pad_alt, 2),
                        "altM": round(vs[target_id].get("alt") or 0.0, 1)}

            await self.run_step("8. Relaunch and climb to the relaunch altitude", step_relaunch)

            overall_status = "passed"
            self.log("ALL ACCEPTANCE STEPS PASSED SUCCESSFULLY!")

        except Exception as ex:
            overall_status = "failed"
            failure_reason = str(ex)
            self.log(f"ACCEPTANCE SUITE FAILED: {ex}")
            self.save_failure_artifacts(ex)
        finally:
            if self.ws:
                try:
                    await self.ws.close()
                except Exception:
                    pass
            self.stop_all()

        duration = round(time.perf_counter() - start_mono, 3)
        report = AcceptanceReport(
            timestamp=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t_start)),
            mode=self.effective_mode,
            fleet_count=self.count,
            overall_status=overall_status,
            duration_s=duration,
            steps=self.steps,
            failure_reason=failure_reason,
            messages_exchanged=len(self.message_history),
        )

        with open(self.report_path, "w", encoding="utf-8") as f:
            json.dump(asdict(report), f, indent=2)
        self.log(f"Saved acceptance report to {self.report_path}")
        return report

    def save_failure_artifacts(self, ex: Exception) -> None:
        self.log("Saving failure diagnostics and logs…")
        fail_log = self.logs_dir / f"acceptance_failure_{int(time.time())}.log"
        with open(fail_log, "w", encoding="utf-8") as f:
            f.write(f"ACCEPTANCE TEST FAILURE\nTime: {time.asctime()}\nError: {ex}\n\n")

            if self.server_log_path:
                f.write(f"=== SERVER OUTPUT (tail of {self.server_log_path}) ===\n")
                f.write(self.server_output_tail(20000) + "\n")

            f.write("\n=== MESSAGE STREAM TRACE ===\n")
            for entry in self.message_history[-100:]:
                f.write(f"[{entry['t']:.3f}] {entry['dir'].upper()}: {json.dumps(entry['msg'])}\n")
        self.log(f"Wrote failure log to {fail_log}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Repeatable real-SITL & mock acceptance runner")
    parser.add_argument("--mode", choices=["mock", "real", "auto"], default="auto",
                        help="Execution mode: mock (pure python), real (ArduPilot SITL), or auto")
    parser.add_argument("--count", type=int, default=3, help="Number of vehicles")
    parser.add_argument("--port", type=int, default=8769, help="WebSocket port")
    parser.add_argument("--alt", type=float, default=15.0, help="Target altitude in metres")
    parser.add_argument("--report", type=Path, default=None, help="Path to write JSON acceptance report")

    args = parser.parse_args()
    runner = AcceptanceRunner(
        mode=args.mode,
        count=args.count,
        port=args.port,
        alt_m=args.alt,
        report_path=args.report,
    )

    report = asyncio.run(runner.execute())
    return 0 if report.overall_status == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())

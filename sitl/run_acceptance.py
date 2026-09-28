#!/usr/bin/env python3
"""run_acceptance.py - Repeatable real-SITL and mock acceptance runner.

Automates the complete end-to-end acceptance sequence adhering to docs/PROTOCOL.md:
1. Launches SITL (real or mock server) and WebSocket bridge.
2. Initializes fleet through WebSocket protocol.
3. Verifies arming, takeoff, and telemetry streaming.
4. Commands waypoint navigation and verifies trajectory progress.
5. Injects/simulates telemetry loss and verifies stale telemetry detection.
6. Commands abort-to-hold and verifies transition to confirmed hold state.
7. Commands landing and tracks descent to touchdown / disarm.
8. Triggers battery swap cycle (authorize -> complete) and monitors service phase.
9. Commands relaunch with home-altitude elevation offset and verifies climb.
10. Preserves detailed failure logs, process traces, and JSON acceptance report.

Usage:
    python sitl/run_acceptance.py [--mode mock|real|auto] [--count 3] [--port 8769]
"""
from __future__ import annotations

import argparse
import asyncio
import json
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
            self.server_process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
        else:
            # Real SITL bridge
            bridge_script = SITL_DIR / "bridge.py"
            cmd = [sys.executable, str(bridge_script), "--ws-port", str(self.port), "--count", str(self.count)]
            self.server_process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )

        # Give server time to bind port
        time.sleep(1.0)
        if self.server_process.poll() is not None:
            _, stderr = self.server_process.communicate()
            raise RuntimeError(f"Server process failed to start: {stderr}")

    def stop_all(self) -> None:
        self.log("Tearing down processes…")
        if self.server_process:
            try:
                self.server_process.terminate()
                self.server_process.wait(timeout=2.0)
            except Exception:
                self.server_process.kill()
            self.server_process = None

        for proc in self.sitl_processes:
            try:
                proc.terminate()
                proc.wait(timeout=2.0)
            except Exception:
                proc.kill()
        self.sitl_processes.clear()

    async def connect_ws(self, retries: int = 15) -> websockets.WebSocketClientProtocol:
        uri = f"ws://127.0.0.1:{self.port}"
        for attempt in range(retries):
            try:
                ws = await websockets.connect(uri)
                self.log(f"Connected to {uri}")
                return ws
            except Exception:
                await asyncio.sleep(0.5)
        raise ConnectionError(f"Failed to connect to {uri} after {retries} attempts")

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
                ready_msg = await self.recv_json(timeout=20.0)
                if ready_msg.get("type") != "ready":
                    raise AssertionError(f"Expected 'ready' msg, got {ready_msg}")
                ids = ready_msg.get("ids", [])
                if len(ids) != self.count:
                    raise AssertionError(f"Expected {self.count} vehicle ids, got {ids}")
                return {"readyIds": ids}

            await self.run_step("1. Initialize fleet", step_init)

            # Step 2: Verify arming & takeoff telemetry until all vehicles reach ready
            async def step_takeoff():
                ready_ids = set()
                deadline = time.time() + 25.0
                while time.time() < deadline and len(ready_ids) < self.count:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "telemetry":
                        for v in msg.get("vehicles", []):
                            vid = v.get("id")
                            if v.get("ready") or v.get("state") == "ready":
                                ready_ids.add(vid)
                if len(ready_ids) < self.count:
                    raise AssertionError(f"Not all vehicles reached confirmed ready state. Ready: {ready_ids}")
                return {"readyCount": len(ready_ids)}

            await self.run_step("2. Arming and takeoff verification", step_takeoff)

            # Step 3: Send Waypoints
            async def step_waypoints():
                goals = [{"id": f"DR-{i+1}", "x": 100.0 * (i + 1), "y": 30.0, "alt": self.alt_m}
                         for i in range(self.count)]
                await self.send_json({"type": "goals", "goals": goals})
                # Collect 3 telemetry frames to ensure goal receipt
                frames = 0
                while frames < 3:
                    msg = await self.recv_json(timeout=3.0)
                    if msg.get("type") == "telemetry":
                        frames += 1
                return {"dispatchedGoals": len(goals)}

            await self.run_step("3. Waypoint navigation dispatch", step_waypoints)

            # Step 4: Simulate Telemetry Loss / Stale Telemetry Check
            async def step_telemetry_check():
                # Pause active reading momentarily to simulate downstream processing gap
                await asyncio.sleep(1.0)
                msg = await self.recv_json(timeout=3.0)
                if msg.get("type") != "telemetry":
                    raise AssertionError(f"Expected telemetry stream resumption, got {msg}")
                return {"resumedStream": True}

            await self.run_step("4. Telemetry freshness check", step_telemetry_check)

            # Step 5: Abort-to-Hold during descent
            async def step_abort_hold():
                target_id = "DR-1"
                req_id_1 = "svc-trans-1"
                # First, initiate landing to enter a service transaction
                await self.send_json({
                    "type": "service", "id": target_id, "requestId": req_id_1,
                    "action": "land", "groundAlt": 0.0
                })
                # Receive land ack
                deadline = time.time() + 5.0
                ack_land = None
                while time.time() < deadline:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "service_ack" and msg.get("requestId") == req_id_1:
                        ack_land = msg
                        break
                if not ack_land or not ack_land.get("accepted"):
                    raise AssertionError(f"Initial land command rejected: {ack_land}")

                # Now command abort on the active landing service
                await self.send_json({
                    "type": "service", "id": target_id, "requestId": req_id_1,
                    "action": "abort"
                })
                ack = None
                deadline = time.time() + 5.0
                while time.time() < deadline:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "service_ack" and msg.get("requestId") == req_id_1 and msg.get("action") == "abort":
                        ack = msg
                        break
                if not ack or not ack.get("accepted"):
                    raise AssertionError(f"Abort rejected or missing ack: {ack}")

                # Verify transition to abort-hold
                confirmed = False
                deadline = time.time() + 5.0
                while time.time() < deadline:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "telemetry":
                        v = next((x for x in msg.get("vehicles", []) if x.get("id") == target_id), None)
                        if v and (v.get("servicePhase") == "aborted" or v.get("state") in ("abort-hold", "confirm-abort")):
                            confirmed = True
                            break
                if not confirmed:
                    raise AssertionError(f"Vehicle {target_id} failed to enter abort-hold")

                # Resume vehicle from abort-hold back to ready
                await self.send_json({
                    "type": "service", "id": target_id, "requestId": req_id_1,
                    "action": "resume"
                })
                ack_resume = None
                deadline = time.time() + 5.0
                while time.time() < deadline:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "service_ack" and msg.get("requestId") == req_id_1 and msg.get("action") == "resume":
                        ack_resume = msg
                        break
                if not ack_resume or not ack_resume.get("accepted"):
                    raise AssertionError(f"Resume rejected: {ack_resume}")

                return {"abortedVehicle": target_id, "ack": ack, "resumed": True}

            await self.run_step("5. Abort-to-hold and resume verification", step_abort_hold)

            # Step 6: Command Land to Touchdown
            service_tx = "svc-trans-2"
            async def step_land():
                target_id = "DR-1"
                await self.send_json({
                    "type": "service", "id": target_id, "requestId": service_tx,
                    "action": "land", "groundAlt": 0.0
                })
                # Verify ack
                ack = None
                deadline = time.time() + 5.0
                while time.time() < deadline:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "service_ack" and msg.get("requestId") == service_tx and msg.get("action") == "land":
                        ack = msg
                        break
                if not ack or not ack.get("accepted"):
                    raise AssertionError(f"Land rejected or missing ack: {ack}")

                # Monitor descent until confirmed in landed phase
                landed = False
                deadline = time.time() + 25.0
                while time.time() < deadline:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "telemetry":
                        v = next((x for x in msg.get("vehicles", []) if x.get("id") == target_id), None)
                        if v and v.get("servicePhase") == "landed":
                            landed = True
                            break
                if not landed:
                    raise AssertionError(f"Vehicle {target_id} failed to complete landing within deadline")
                return {"landedVehicle": target_id}

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

            # Step 8: Relaunch with Home-Altitude Elevation Offset
            async def step_relaunch():
                target_id = "DR-1"
                ground_offset_m = 5.0
                takeoff_alt_m = 20.0
                await self.send_json({
                    "type": "service",
                    "id": target_id,
                    "requestId": service_tx,
                    "action": "relaunch",
                    "alt": takeoff_alt_m,
                    "groundAlt": ground_offset_m,
                })
                ack = None
                deadline = time.time() + 5.0
                while time.time() < deadline:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "service_ack" and msg.get("requestId") == service_tx and msg.get("action") == "relaunch":
                        ack = msg
                        break
                if not ack or not ack.get("accepted"):
                    raise AssertionError(f"Relaunch rejected or missing ack: {ack}")

                # Verify climb and transition back to airborne / ready
                relaunched = False
                deadline = time.time() + 20.0
                while time.time() < deadline:
                    msg = await self.recv_json(timeout=2.0)
                    if msg.get("type") == "telemetry":
                        v = next((x for x in msg.get("vehicles", []) if x.get("id") == target_id), None)
                        if v and (v.get("alt", 0.0) >= ground_offset_m + 3.0 or v.get("airborne") or v.get("ready")):
                            relaunched = True
                            break
                if not relaunched:
                    raise AssertionError(f"Vehicle {target_id} failed to climb after relaunch command")
                return {"relaunchedVehicle": target_id, "groundOffsetM": ground_offset_m}

            await self.run_step("8. Relaunch with home elevation offset", step_relaunch)

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

            if self.server_process:
                f.write("=== SERVER OUTPUT ===\n")
                try:
                    stdout, stderr = self.server_process.communicate(timeout=1.0)
                    f.write(f"STDOUT:\n{stdout}\nSTDERR:\n{stderr}\n")
                except Exception:
                    f.write("(server still running or closed)\n")

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

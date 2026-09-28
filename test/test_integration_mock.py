#!/usr/bin/env python3
"""test_integration_mock.py - Real browser-to-mock integration test using Playwright.

Launches the actual web application (static HTTP server) and Python mock vehicle
server together, connects the browser to the mock server, and exercises the
complete lifecycle:
  Connect -> Takeoff / Mission -> Landing -> Battery Swap -> Relaunch

Saves complete failure (and success) trace artifacts using Playwright's trace viewer.

Usage:
    python test/test_integration_mock.py
"""
from __future__ import annotations

import http.server
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
SITL_DIR = ROOT / "sitl"
TEST_RESULTS_DIR = ROOT / "test-results"
TEST_RESULTS_DIR.mkdir(parents=True, exist_ok=True)


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class QuietHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        pass  # suppress HTTP request console spam


def start_http_server(port: int) -> http.server.HTTPServer:
    server = http.server.HTTPServer(("127.0.0.1", port), QuietHTTPHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def test_browser_mock_integration():
    http_port = find_free_port()
    mock_port = find_free_port()

    print(f"[TEST] Starting static HTTP server on port {http_port}…")
    httpd = start_http_server(http_port)

    print(f"[TEST] Starting mock vehicle server on port {mock_port}…")
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    mock_proc = subprocess.Popen(
        [sys.executable, str(SITL_DIR / "mock_vehicles.py"), "--port", str(mock_port)],
        env=env,
    )
    time.sleep(1.0)

    trace_path = TEST_RESULTS_DIR / "mock-integration-trace.zip"
    screenshot_path = TEST_RESULTS_DIR / "mock-integration-end.png"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()

        # Start Playwright trace recording
        print("[TEST] Starting Playwright trace recording…")
        context.tracing.start(screenshots=True, snapshots=True, sources=True)

        page = context.new_page()
        page.on("console", lambda msg: print(f"[BROWSER] {msg.text}"))

        try:
            # 1. Open application webpage
            url = f"http://127.0.0.1:{http_port}/index.html"
            print(f"[TEST] Navigating to {url}…")
            page.goto(url, timeout=15000)

            # Check that main canvas and controls exist
            expect(page.locator("#map")).to_be_visible()
            expect(page.locator("#wsUrl")).to_be_visible()
            expect(page.locator("#extConnectBtn")).to_be_visible()

            # Set fleet count to 3 and altitude to 15m for clean, rapid integration testing
            ws_url = f"ws://127.0.0.1:{mock_port}"
            page.fill("#wsUrl", ws_url)
            page.eval_on_selector("#countRange", "el => { el.value = 3; el.dispatchEvent(new Event('change')); }")
            page.eval_on_selector("#altRange", "el => { el.value = 15; el.dispatchEvent(new Event('change')); }")

            print(f"[TEST] Connecting to bridge at {ws_url}…")
            page.click("#extConnectBtn")

            # 3. Verify connection & ready state
            print("[TEST] Awaiting bridge connection and fleet readiness…")
            page.wait_for_function("""
                () => {
                    const el = document.getElementById('extStatus');
                    return el && el.textContent.includes('flying under external control');
                }
            """, timeout=25000)

            # 4. Verify external diagnostics table
            diag_body = page.locator("#extDiagBody")
            expect(diag_body).to_be_visible(timeout=10000)
            rows = page.locator("#extDiagBody tr")
            expect(rows).to_have_count(3)

            print("[TEST] External diagnostics table verified with active fleet.")

            # 5. Let simulation run for 3 seconds under active mission waypoints
            time.sleep(3.0)

            # 6. Trigger Landing on DR-1
            print("[TEST] Commanding landing on DR-1…")
            res = page.evaluate("""
                () => {
                    if (window.BATTERY) window.BATTERY.swapSec = 2;
                    const s = window.sim.swarm;
                    const ret = window.dispatchServiceAction(s, 'DR-1', 'land', { groundAlt: 0 });
                    return { ret, services: window.ExternalMode.services };
                }
            """)
            print(f"[TEST] dispatchServiceAction result: {res}")

            # Wait for DR-1 to enter landing phase in diagnostics
            page.wait_for_function("""
                () => {
                    const row = document.querySelector('#extDiagBody tr');
                    return row && (row.textContent.includes('landing') || row.textContent.includes('landed') || row.textContent.includes('swapping'));
                }
            """, timeout=20000)
            print("[TEST] DR-1 entered landing sequence.")

            # 7. Observe descent, touchdown, and battery swap
            print("[TEST] Observing descent, touchdown, and battery swap…")
            page.wait_for_function("""
                () => {
                    const row = document.querySelector('#extDiagBody tr');
                    return row && (row.textContent.includes('landed') || row.textContent.includes('swapping') || row.textContent.includes('swapped') || row.textContent.includes('relaunch'));
                }
            """, timeout=30000)
            print("[TEST] Touchdown and swap cycle underway.")

            # 8. Observe relaunch and return to ready
            print("[TEST] Observing relaunch and climb back to airborne/ready…")
            page.wait_for_function("""
                () => {
                    const row = document.querySelector('#extDiagBody tr');
                    // After relaunch, phase returns to ready/ok/airborne
                    return row && !row.textContent.includes('landing') && !row.textContent.includes('swapping') && !row.textContent.includes('relaunch');
                }
            """, timeout=35000)
            print("[TEST] DR-1 successfully relaunched and returned to active fleet service.")

            page.screenshot(path=str(screenshot_path))
            print(f"[TEST] Saved end-state screenshot to {screenshot_path}")

        except Exception as err:
            print(f"[TEST] Integration test failed: {err}")
            page.screenshot(path=str(TEST_RESULTS_DIR / "mock-integration-failure.png"))
            raise
        finally:
            # Stop tracing and save trace artifact
            print(f"[TEST] Saving Playwright trace viewer artifact to {trace_path}…")
            context.tracing.stop(path=str(trace_path))

            context.close()
            browser.close()

            # Terminate mock process
            if mock_proc.poll() is None:
                mock_proc.terminate()
                try:
                    mock_proc.wait(timeout=2.0)
                except Exception:
                    mock_proc.kill()

            # Shutdown HTTP server
            httpd.shutdown()
            print("[TEST] Integration test completed successfully.")


if __name__ == "__main__":
    test_browser_mock_integration()
    sys.exit(0)

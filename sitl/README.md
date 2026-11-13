[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-dawgog-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/dawgog) https://buymeacoffee.com/dawgog

# drone/sitl — browser swarm sim <-> real/mock vehicles bridge

This folder lets a browser-based drone-swarm command-and-control sim command
**real (or mock) autopilot vehicles**, instead of moving drones itself.

## Architecture

```
 browser sim  <--WebSocket (JSON)-->  Python bridge process  <--MAVLink/UDP-->  ArduCopter SITL
```

In "external vehicle" mode, the browser sim stops simulating drone motion
itself. Instead:

- it sends each drone a **goal** position (`goals` message), and
- it receives back each drone's **actual** position (`telemetry` message)
  from whichever server is on the other end of the WebSocket.

Browsers can't speak UDP/MAVLink directly, so a Python process bridges the
two: it terminates the WebSocket connection from the browser on one side,
and (for the real path) talks MAVLink/UDP to ArduCopter SITL on the
other.

The real bridge supports **ArduCopter only**. Its init sequence needs the
`GUIDED` mode, which PX4 does not have (PX4 would need `OFFBOARD` with a
continuous setpoint stream), so a vehicle whose heartbeat says PX4 is
reported as `failed:unsupported-autopilot` and is never armed or retried.

Two servers implement the exact same WebSocket protocol, so the browser sim
doesn't need to know or care which one it's talking to:

| File | Role |
|---|---|
| `mock_vehicles.py` | No-firmware stand-in. Pure Python, simulates simple point-mass vehicles. Verifies the whole browser <-> protocol <-> vehicle pipeline without needing ArduPilot at all. |
| `bridge.py` | The real bridge. Talks MAVLink/UDP to ArduCopter SITL (or real ArduCopter vehicles) via `pymavlink`. |

## Running

### (A) MOCK — no firmware needed

```
python mock_vehicles.py
```

(Optionally `--host` / `--port`, defaults `localhost:8765`.)

Then open the browser sim, enable **external-vehicle mode**, and point it at
`ws://localhost:8765`. This exercises the complete pipeline — WebSocket
protocol, goal delivery, telemetry streaming, reconnect handling — with pure
Python physics standing in for real vehicles. `pymavlink` is **not** needed
for this path; `mock_vehicles.py` only depends on `websockets`.

### (B) REAL — ArduPilot SITL on a Linux box

On a Linux machine with ArduPilot already cloned/built:

```
./run_ardupilot_sitl.sh 3
```

This launches 3 ArduCopter SITL instances (instance numbers `0..2`), each
forwarding its MAVLink stream to a distinct UDP port for the bridge to
listen on. See the script's comments for prerequisites and the port
convention (`14550 + 10*i`).

In another terminal on the same box:

```
pip install -r requirements.txt
python bridge.py --count 3
```

Then point the browser sim (external-vehicle mode) at `ws://localhost:8765`.
The bridge binds `localhost` by default; for a browser on another machine
start it with `--ws-host 0.0.0.0` and connect with the token it prints
(see [Connecting safely](#connecting-safely)). The bridge will, per vehicle: wait for a
MAVLink heartbeat, switch it to `GUIDED` mode, arm it, command takeoff to
the requested altitude, then forward `goals` as MAVLink position setpoints
and stream back `telemetry` from the vehicle's real position.

`--count` overrides the count in the browser's `init` (the bridge says so in
a `status` line). If the browser runs a bigger swarm, its extra drones have
no vehicle on the bridge and are marked down at once, and readiness reads
N/M against the browser's count, so set the browser's drone count to match.

While it holds a vehicle the bridge sends it a 1 Hz GCS `HEARTBEAT`
(system id 255), so ArduCopter's GCS-loss failsafe can engage if the bridge
dies. That failsafe is off unless `FS_GCS_ENABLE` is set on the vehicle;
set it (and its action) if a dead bridge should trigger RTL or LAND instead
of leaving the vehicle holding its last target. MAVLink from anything other
than the vehicle's own autopilot (for example a GCS sharing the SITL link)
is ignored.

`pymavlink` is only required for this real path — see `requirements.txt`.

### Connecting safely

All three servers (`bridge.py`, `mock_vehicles.py`, `tak_bridge.py`) share
the handshake gate in `ws_origin.py`:

- **Origin check.** A WebSocket handshake from a web page on another origin
  gets HTTP 403, so a page open in your browser cannot arm or steer the
  fleet. Always allowed: http(s) on `localhost` / `127.0.0.1` / `[::1]` (any
  port), `file://` pages (Origin `null`), the GitHub Pages demo
  (`https://dalailalama.github.io`), and clients that send no Origin header
  (Python tools). Add more with the repeatable `--allow-origin ORIGIN`;
  `--allow-origin '*'` turns the check off. Allowing `null` also admits
  sandboxed iframes on any site.
- **Token.** `--token SECRET` (or `$BRIDGE_TOKEN`) makes every client
  connect with `?token=SECRET` in its URL, e.g.
  `ws://<box>:8765/?token=SECRET` typed into the sim's Bridge URL field;
  anything else gets HTTP 401. A server bound beyond loopback without a
  token generates one and prints it.
- **Bind address.** All three bind `localhost` by default. `bridge.py` and
  `tak_bridge.py` take `--ws-host`, `mock_vehicles.py` takes `--host`.
  `ws://` is plaintext: beyond a trusted LAN, use an SSH or VPN tunnel or a
  TLS (`wss://`) proxy.

### (C) MOCK-LEVEL TESTS for the bridge itself — nothing installed

```
python -B sitl/test_bridge.py
python -B sitl/test_mock_vehicles.py
python -B sitl/test_protocol_conformance.py
python -B sitl/test_failure_scenarios.py
python -B sitl/test_tak_bridge.py
python -B sitl/run_acceptance.py --mode mock --report acceptance_mock.json
```

These are the suites CI runs. `test_bridge.py` drives `bridge.py`'s
per-vehicle init state machine against stub `pymavlink`/`websockets` modules
and a scripted fake autopilot: no firmware, no sockets, plain asserts (exit
code 0/1). It covers confirmed readiness, arm rejection, a takeoff that is
ACKed but never climbs, a vehicle that boots long after `ready` was sent,
and the controller-ownership rules. `test_mock_vehicles.py` covers the mock
server, `test_protocol_conformance.py` checks both servers against
`docs/PROTOCOL.md`, and `test_failure_scenarios.py` injects faults (late
ACKs, stale heartbeats, frozen positions, controller handoffs, service
phase mismatches). `test_tak_bridge.py` runs `tak_bridge.py` on loopback
(one CoT `<event>` line becomes one datagram, a foreign Origin gets 403).
`run_acceptance.py --mode mock` runs the full acceptance sequence (READY, waypoints, abort/resume, landing,
battery swap) against `mock_vehicles.py`; `--mode real` runs it against
SITL started with `run_ardupilot_sitl.sh`. All of this proves
protocol/state-machine behaviour only — **not** that anything flies.

## What the real bridge confirms before saying "ready"

Each vehicle gets one asyncio task that is the sole reader of its MAVLink
socket. That task streams telemetry from its first poll (a slow vehicle
never delays anyone else's) and drives this sequence, per vehicle:

| Step | Confirmed by |
|---|---|
| `wait-heartbeat` | a HEARTBEAT arriving on that vehicle's UDP port |
| `confirm-mode` | HEARTBEAT `custom_mode` == the firmware's own `GUIDED` id |
| `confirm-arm` | `COMMAND_ACK(MAV_CMD_COMPONENT_ARM_DISARM)` = ACCEPTED **and** HEARTBEAT `base_mode` carrying `MAV_MODE_FLAG_SAFETY_ARMED` |
| `confirm-takeoff` | `COMMAND_ACK(MAV_CMD_NAV_TAKEOFF)` = ACCEPTED **and** `LOCAL_POSITION_NED` showing the vehicle climbed to within 1 m of the takeoff altitude (`alt >= takeoff_alt - 1`) |

Nothing is reported as done that wasn't confirmed this way. A step that
times out leaves the vehicle in `failed:<step>` (`failed:no-heartbeat`,
`failed:mode`, `failed:arm`, `failed:takeoff`), which is what the `ready`
reply reports for it — while its task keeps polling and restarts the
sequence from the earliest unsatisfied step if the vehicle later shows up.
A PX4 vehicle (`failed:unsupported-autopilot`) is the exception: it is never
retried.

READY is also revoked when the vehicle's own heartbeats show it left
`GUIDED` (state `mode-lost:<custom_mode>`) or disarmed (state `disarmed`),
for example after an autopilot failsafe or a pilot takeover. The bridge
never re-commands a vehicle out of these states. A failed relaunch parks
the vehicle (service phase `failed`, then `landed` once it is confirmed on
the ground) instead of retrying.

**Init**: an `init` with a non-numeric count or altitude, an altitude of
1 m or less, or a malformed origin is refused with a `status` line and does
not take control. The count is clamped to 256 vehicles. A later `init`
(reset, selector change, reconnect) does not rebuild the fleet: vehicles
still listed keep flying, and a vehicle the new count drops is commanded to
LAND if it was armed and watched until it is down. The `ready` reply comes
from a background task, so goals and services are answered while vehicles
boot.

**Ownership**: the socket whose `init` took control of the fleet controls
it. While that socket is open, `init`/`goals` from any other client are
refused with a `status` line and change nothing. If the controller
disconnects the fleet keeps flying and the next `init` from anyone takes
over.

## Coordinate frame contract

Shared by the browser sim, `mock_vehicles.py`, and `bridge.py`:

- **sim world** (what the browser and both servers' WebSocket messages use):
  metres, `x` = East, `y` = South (screen-down positive), `alt` = metres
  above the origin ground elevation (`origin.groundM`, sent in `init`).
  Positions on the wire are origin-relative; the browser adds the origin
  back. `alt` equals height above ground only over flat terrain.
- **MAVLink** (what `bridge.py` speaks to SITL, internally — never exposed
  over the WebSocket): local NED (North, East, Down), metres.

Mapping:

```
sim -> NED:  ned_north = -sim_y ; ned_east = sim_x ; ned_down = -alt
NED -> sim:  sim_x = ned_east   ; sim_y = -ned_north ; alt = -ned_down
```

## WebSocket protocol

JSON text messages. Both `mock_vehicles.py` and `bridge.py` implement the
**server** side; the browser sim is the **client**. Unknown message types
are ignored gracefully by both servers. Vehicle IDs are `"DR-1".."DR-N"`.

The message set (`init` with `origin`, `goals`, `service`, `ready`,
`telemetry`, `service_ack`, `status`), the per-vehicle telemetry fields the
browser requires (including `positionSeq`/`positionAge` before it sends
goals and `landedSeq`/`landedAge` before it confirms a touchdown) and the
battery-swap/abort handshakes are specified in
[`docs/PROTOCOL.md`](../docs/PROTOCOL.md); `test_protocol_conformance.py`
checks both servers against its examples.

## Files

- `mock_vehicles.py` — mock WebSocket server, pure-Python point-mass vehicle
  physics. Only dependency: `websockets`.
- `bridge.py` — real WebSocket <-> MAVLink/UDP bridge. Depends on
  `websockets` and `pymavlink`.
- `test_bridge.py` — mock-level tests for `bridge.py` (stubbed MAVLink and
  WebSocket layers; no dependencies, no firmware). `python test_bridge.py`.
- `test_mock_vehicles.py` — tests for `mock_vehicles.py`.
- `test_protocol_conformance.py` — runs the same checks against both
  servers and compares their messages with `docs/PROTOCOL.md`.
- `test_failure_scenarios.py` — fault-injection scenarios for both servers.
- `test_tak_bridge.py` — loopback tests for `tak_bridge.py`: CoT forwarding
  and the Origin check. Needs `websockets`.
- `run_acceptance.py` — end-to-end acceptance runner, `--mode mock` (CI)
  or `--mode real` against running SITL; `--report` writes a JSON report.
- `tak_bridge.py` — separate relay from the browser's Cursor-on-Target
  live feed (`js/tak.js`) to ATAK clients over UDP multicast; unrelated to
  the vehicle protocol. Multicast TTL defaults to 1 (same subnet; raise
  `--ttl` only for routed multicast). Lines that are not a well-formed CoT
  `<event>` (uid and type, at most 16 KiB, no DOCTYPE) are dropped.
- `ws_origin.py` — shared Origin allowlist (stdlib only) that `bridge.py`,
  `mock_vehicles.py` and `tak_bridge.py` use to reject WebSocket handshakes
  from foreign web pages (cross-site WebSocket hijacking). Local origins,
  `file://` and the GitHub Pages demo are allowed; add more with
  `--allow-origin`.
- `requirements.txt` — Python dependencies for `bridge.py` (and
  `mock_vehicles.py`, which only needs the `websockets` half of it).
- `run_ardupilot_sitl.sh` — convenience launcher for N ArduCopter SITL
  instances on a Linux box with ArduPilot set up. Not needed for the mock
  path.

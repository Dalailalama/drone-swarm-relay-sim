[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-dawgog-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/dawgog) https://buymeacoffee.com/dawgog

# drone/sitl — browser swarm sim <-> real/mock vehicles bridge

This folder lets a browser-based drone-swarm command-and-control sim command
**real (or mock) autopilot vehicles**, instead of moving drones itself.

## Architecture

```
 browser sim  <--WebSocket (JSON)-->  Python bridge process  <--MAVLink/UDP-->  ArduPilot/PX4 SITL
```

In "external vehicle" mode, the browser sim stops simulating drone motion
itself. Instead:

- it sends each drone a **goal** position (`goals` message), and
- it receives back each drone's **actual** position (`telemetry` message)
  from whichever server is on the other end of the WebSocket.

Browsers can't speak UDP/MAVLink directly, so a Python process bridges the
two: it terminates the WebSocket connection from the browser on one side,
and (for the real path) talks MAVLink/UDP to ArduPilot/PX4 SITL on the
other.

Two servers implement the exact same WebSocket protocol, so the browser sim
doesn't need to know or care which one it's talking to:

| File | Role |
|---|---|
| `mock_vehicles.py` | No-firmware stand-in. Pure Python, simulates simple point-mass vehicles. Verifies the whole browser <-> protocol <-> vehicle pipeline without needing ArduPilot/PX4 at all. |
| `bridge.py` | The real bridge. Talks MAVLink/UDP to ArduPilot/PX4 SITL (or real vehicles) via `pymavlink`. |

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

Then point the browser sim (external-vehicle mode) at
`ws://<that box's address>:8765`. The bridge will, per vehicle: wait for a
MAVLink heartbeat, switch it to `GUIDED` mode, arm it, command takeoff to
the requested altitude, then forward `goals` as MAVLink position setpoints
and stream back `telemetry` from the vehicle's real position.

`pymavlink` is only required for this real path — see `requirements.txt`.

### (C) MOCK-LEVEL TESTS for the bridge itself — nothing installed

```
python sitl/test_bridge.py
```

Runs `bridge.py`'s per-vehicle init state machine against stub
`pymavlink`/`websockets` modules and a scripted fake autopilot: no firmware,
no sockets, no dependencies, plain asserts (exit code 0/1). It covers
confirmed readiness, arm rejection, a takeoff that is ACKed but never
climbs, a vehicle that boots long after `ready` was sent, and the
controller-ownership rules. It proves protocol/state-machine behaviour only
— **not** that anything flies.

## What the real bridge confirms before saying "ready"

Each vehicle gets one asyncio task that is the sole reader of its MAVLink
socket. That task streams telemetry from its first poll (a slow vehicle
never delays anyone else's) and drives this sequence, per vehicle:

| Step | Confirmed by |
|---|---|
| `wait-heartbeat` | a HEARTBEAT arriving on that vehicle's UDP port |
| `confirm-mode` | HEARTBEAT `custom_mode` == the firmware's own `GUIDED` id |
| `confirm-arm` | `COMMAND_ACK(MAV_CMD_COMPONENT_ARM_DISARM)` = ACCEPTED **and** HEARTBEAT `base_mode` carrying `MAV_MODE_FLAG_SAFETY_ARMED` |
| `confirm-takeoff` | `COMMAND_ACK(MAV_CMD_NAV_TAKEOFF)` = ACCEPTED **and** `LOCAL_POSITION_NED` showing the vehicle above 1 m |

Nothing is reported as done that wasn't confirmed this way. A step that
times out leaves the vehicle in `failed:<step>` (`failed:no-heartbeat`,
`failed:mode`, `failed:arm`, `failed:takeoff`), which is what the `ready`
reply reports for it — while its task keeps polling and restarts the
sequence from the earliest unsatisfied step if the vehicle later shows up.

**Ownership**: the socket whose `init` built the current fleet controls it.
While that socket is open, `init`/`goals` from any other client are refused
with a `status` line and change nothing. If the controller disconnects the
fleet keeps flying and the next `init` from anyone takes over.

## Coordinate frame contract

Shared by the browser sim, `mock_vehicles.py`, and `bridge.py`:

- **sim world** (what the browser and both servers' WebSocket messages use):
  metres, `x` = East, `y` = South (screen-down positive), `alt` = height
  above ground in metres.
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

| Direction | Message | Meaning |
|---|---|---|
| client -> server | `{"type":"init","count":N,"alt":50}` | Spawn/prepare `N` vehicles at the origin, target altitude in metres. |
| server -> client | `{"type":"ready","ids":["DR-1",...,"DR-N"]}` | Reply to `init` once vehicles are prepared (or connection attempts have resolved, for the real bridge). |
| server -> client | `bridge.py` adds `"vehicles":[{"id":"DR-1","ready":true,"state":"ready"}, ...]` to that same `ready` message | Per-vehicle truth: `ready` is true only for confirmed GUIDED + armed + climbing vehicles, `state` is the init-machine state (`ready` or `failed:<step>`). `ids` still lists every vehicle, ready or not; clients that only read `ids` are unaffected. |
| client -> server | `{"type":"goals","goals":[{"id":"DR-1","x":<m East>,"y":<m South>,"alt":<m>}, ...]}` | Commanded setpoints for each drone. Sent ~2 Hz by the browser. |
| server -> client | `{"type":"telemetry","t":<server seconds>,"vehicles":[{"id":"DR-1","x":<m East>,"y":<m South>,"alt":<m>,"connected":true}, ...]}` | Actual positions. Streamed ~10 Hz. |
| server -> client | `{"type":"status","msg":"..."}` | Human-readable status lines (arming, takeoff, connection issues, etc). |

## Files

- `mock_vehicles.py` — mock WebSocket server, pure-Python point-mass vehicle
  physics. Only dependency: `websockets`.
- `bridge.py` — real WebSocket <-> MAVLink/UDP bridge. Depends on
  `websockets` and `pymavlink`.
- `test_bridge.py` — mock-level tests for `bridge.py` (stubbed MAVLink and
  WebSocket layers; no dependencies, no firmware). `python test_bridge.py`.
- `requirements.txt` — Python dependencies for `bridge.py` (and
  `mock_vehicles.py`, which only needs the `websockets` half of it).
- `run_ardupilot_sitl.sh` — convenience launcher for N ArduCopter SITL
  instances on a Linux box with ArduPilot set up. Not needed for the mock
  path.

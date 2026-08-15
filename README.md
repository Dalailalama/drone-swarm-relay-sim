# Drone swarm relay simulator

**[▶ Live demo](https://dalailalama.github.io/drone-swarm-relay-sim/)** — no
install, runs in your browser.

A browser-based simulation of a drone swarm that keeps itself connected to its
operator by **turning its own members into a self-healing radio relay mesh** —
the way a flock of birds would solve a comms problem. Fly the mission far
enough away and drones peel off to bridge the link; kill a relay and the
swarm heals; drop an interference source and the swarm maps the dead zone and
routes around it; run a battery down and drones excuse themselves and fly home.

## The real-world problem

Whenever a team of drones has to work somewhere **without communications
infrastructure** — and the distance, terrain, or radio interference keeps
breaking the link to the operator — you have this project's problem. It shows
up everywhere:

- **Disaster response & search-and-rescue** — earthquakes, floods, wildfires,
  avalanches: cell towers are down or mountains block the signal, and a
  self-relaying swarm has to search while staying linked to the command post.
- **Wildfire & infrastructure monitoring** — persistent overwatch across
  ridgelines and valleys that shadow radio; relays keep the cameras connected.
- **Long linear inspection** — power lines, pipelines, railways, borders,
  coastlines: a moving relay chain keeps beyond-line-of-sight drones online.
- **Conservation & anti-poaching** — vast parks with zero infrastructure.
- **Mining, ports, large industrial sites** — exactly where "never-break" mesh
  radios (Rajant, Silvus) are already deployed.
- **Contested / degraded-comms operations** — the hardest version of the same
  problem, where the interference is deliberate.

The common thread: **keep the swarm connected across distance, terrain, and
interference, using the drones themselves as the network.** This simulator
lets you design and stress-test that — against real radio hardware specs,
real terrain, and real interference — before spending a cent on drones.

No build step, no dependencies. Open `index.html` from any static server.
(UI typeface — IBM Plex Mono — loads from Google Fonts and degrades
gracefully to your system monospace offline.)

```
python -m http.server 8000
# then open http://localhost:8000
```

## Why it's interesting

Most swarm demos are animations: an all-knowing script moves dots around.
This one is a **distributed system**. There are three separate worlds that
only communicate through simulated radio packets:

- **Truth** — actual positions, batteries, and RF physics
- **C2's beliefs** — built *only* from telemetry packets that physically
  arrived, hop by hop, at the ground station
- **Each drone's beliefs** — the last order packet it received, and how long
  ago it last heard from C2

Every command and telemetry report is a packet that routes through the relay
chain with real per-hop airtime, gets lost to fading, and simply never
arrives if no route exists. When you kill a mid-chain relay, C2 doesn't
"know" — it notices the telemetry silence a few seconds later, strikes the
drone off its roster, and re-plans with whatever it can still reach.
Chains heal end-to-end without any component having the full picture.

### The fallback engine (link recovery, both sides)

Link loss is recovered from **both ends**, using each side's memory of where
the link last worked:

- **Drone side** — every drone stamps the position where the last command
  physically reached it. On link timeout it runs a ladder: *hold → retreat
  to that last-link point and listen → fall back one radio-range step toward
  base and listen again → third strike → only then RTL home.* Three attempts
  before the mission position is abandoned — base is the last resort, not
  the first one.
- **C2 side** — the ground station remembers where every lost drone was
  last heard (rendered as dashed ghost markers). After a grace period it
  dispatches a rescue drone toward that point — held one link-length from
  the nearest connected node, so the searcher itself stays reachable. When
  the lost drone's telemetry reappears through the extended coverage, both
  are re-tasked and the mission resumes where it left off.

Rescuers chain off each other (up to three deep): the first anchors on the
nearest connected node, each next one on the rescuer before it, and the
tentacle crawls toward the lost group's last-known position with every
member tethered as it goes.

### The commitment rule

Methodology borrowed from [MIT ACL's FASTER
planner](https://github.com/mit-acl/faster) (not its code): *never commit to
a plan unless a backup plan provably closes.* FASTER applies it to
trajectories in unknown terrain; here it's applied to energy. Before a drone
adopts any in-flight tasking — relay slot, rescue point, new mission target —
it checks that flying there still leaves enough battery to get home against
the current wind, with pessimism margin and reserve intact. If not, it
declines the order, keeps flying its current (already-vetted) one, and
reports the refusal; C2 benches it for a while and elects a drone that can
actually afford the job. A drone that says yes has proven it can also say
goodbye safely.

### The tether rule

The swarm's most bird-like behavior: **no drone ever outruns its link.**
C2 names each drone's upstream chain neighbor in every order; the drone
tracks that neighbor's beacon RSSI (smoothed), and as the measured margin
sinks toward a floor it stops extending — and below the floor it closes
back in. Retreats and homeward flights are never blocked; the tether only
stops you from flying *away* from your own connectivity. Deployment
becomes a caterpillar unroll — the flock waits for the chain instead of
sprinting into blackout — and in bad RF the chain compresses automatically,
spacing itself by measured link quality instead of planned geometry.

Measured effect: launch-phase dark time drops to zero, and the urban
scenario at 50 m AGL goes from ~15% link uptime (swarm repeatedly marooned
in street canyons) to 100%, with the mission still reaching its target.

### Corridor transit

Second borrowing from FASTER's methodology (safe corridors): far transits
converge onto the base→target spine — where the relay chain lives — and
travel along it, peeling off only for the final hop. A toggle in Mission
setup switches it off for comparison.

Measured honestly: in today's obstacle-free world this changes transit
paths but rarely changes connectivity. Two emergent reasons: when the
mission retargets, the relays re-slot along the rotating line, so the whole
swarm sweeps together and escorts itself; and every drone is a mesh node,
so group transits carry their own coverage. Corridors start earning their
keep when transits are solo and the world has radio dead zones — i.e. once
terrain and the learned RF coverage map (roadmap) exist, corridors will
bend around *measured* dead zones instead of following a straight spine.
Same dependency as FASTER itself: corridors need a map to matter.

## The radio model (and its honesty)

Every radio preset is a real product with datasheet numbers — TX power,
receiver sensitivity, frequency, air rate, and the vendor's claimed
line-of-sight range (sources in [RADIOS.md](RADIOS.md)).

Free-space path loss alone would predict absurd ranges (a 100 mW SiK radio
"reaches" 290 km in free space; in the field it does 300 m near the ground).
So the model uses **log-distance path loss with a per-radio exponent
calibrated so the link margin hits exactly 0 dB at the vendor's rated LOS
range**. That single fitted parameter absorbs ground reflection, Fresnel
losses, and antenna reality. On top of that sit:

- **Log-normal shadowing** — an Ornstein-Uhlenbeck dB offset per link
  (σ = 2.5 dB open field → 6.5 dB urban), so links breathe and flicker
- **Packet error curve** — success probability is logistic in margin
  (50% at +2 dB, ~95% at +6 dB), with per-hop link-layer retries
- **3D slant range** and a **4/3-Earth radio horizon** — beyond
  `4.12(√h₁+√h₂) km` the planet blocks the link no matter the power
- **Shared-channel contention** — every transmission (and retry) occupies
  the one frequency; C2 traffic overhead visibly eats chain throughput
- **Regulatory duty cycle** (EU868 LoRa preset) — throttles telemetry and
  command rates; failsafe timeouts scale to match, like PX4's `COM_DL_LOSS_T`

**What this is:** a planning-grade sandbox whose numbers stay anchored to
real hardware behavior. **What this is not:** an RF certification tool. The
calibrated exponent is a modeling choice, stated here so you can judge it.

## The energy model

No endurance sliders. Airframes are defined by mass, rotor disc area, and
battery watt-hours; hover power comes from actuator-disc momentum theory at
a lumped 0.55 powertrain efficiency, forward flight adds a cubic drag term,
and endurance *emerges* — within a couple of minutes of the real aircraft
each preset is modeled on (sub-250 g micro ≈ 36 min, 450-class ≈ 22 min,
endurance X8 ≈ 46 min). Drones run wind-aware smart-RTH: energy to get home
is continuously re-estimated, and they leave while they still can.

Wind is a ground-frame/air-frame split: speed limits and power draw are paid
in airspeed, so holding a relay slot in a 10 m/s wind costs real watts, and
a 16 m/s gale blows a 14 m/s quad backwards.

## Terrain and the learned coverage map

Terrain (Mission setup → Terrain) is a fractal-noise heightfield — endless
seeded rolling hills and valleys, sampled analytically at any point — plus
procedural city districts: street grids of low-rise blocks with a
scattering of 60-140 m towers. Radio links need genuine line of sight over
both (with a Fresnel clearance that tapers at the antennas). Drones fly
terrain-following (AGL), so ridges between valleys cut links even though
nobody crashes; buildings taller than the flight altitude are no-fly boxes
the drones steer around (they carry a terrain database, like real
autopilots — and so does C2, which never plans a relay slot inside a
tower). Try the urban preset at 50 m AGL, watch the swarm suffer in the
street canyons, then raise the altitude slider over the low-rise — measured
uptime goes from ~15% to 100%, which is exactly how real urban BVLOS works.

The **3D view** button (header) switches to a FASTER-style perspective
render — shaded terrain mesh, extruded buildings, drones on altitude stems,
link lines colored by health. Drag to orbit, wheel to zoom.

What no terrain database can predict is the *RF shadow* — the region where
hops between valid positions still die because the hill cuts the ray. That
part the swarm has to learn: while disconnected, every drone's black box
logs where the silence happened; on reconnect the samples upload, and C2
paints a coverage grid — green where packets provably arrived, red where
drones sat in silence, unpainted where nobody has checked (FASTER's
known-free / unknown / occupied space, in radio form). Relay slots that
land in measured-bad cells get sidestepped to the nearest trusted cell —
so after a few minutes of honest struggle, the chain physically bends
around the hill and stays connected.

Measured in the ridge scenario: ~8 sim-minutes of failures while the map
fills in, then a bent chain (relays up to ~100 m off-spine) holding 100%
uptime. The heatmap overlay (Coverage map toggle) shows the whole thing
happening.

And the chain itself is **path-planned**: C2 runs A* over everything it
legitimately knows — terrain obstacles from its elevation database plus
measured-bad coverage cells — places relay slots along the resulting path,
then LOS-validates every adjacent hop against the terrain model and adds a
relay ON a ridge rather than accept a dead hop across it. Chains snake
around cities and over hills instead of dying on straight lines. (Measured:
the mixed-terrain low-altitude scenario goes from a chain that breaks in
steady state to 95% uptime with the flock on target, using one extra
densified relay along a path 1.1× the straight-line distance.)

## Real places (OpenStreetMap import)

Terrain → **Real area (OpenStreetMap)** turns the sim loose on actual
geography: type a place name ("Connaught Place Delhi", "Shibuya") or paste
`lat, lon` from any map app, pick a radius, and Load. The sim fetches the
real building footprints and heights for that spot from the public Overpass
API and drops the swarm over them — same LOS physics, same routing, same 3D
view, but over the city you actually care about: your neighbourhood, a
disaster-response sector, an inspection corridor.

Honesty notes, because the physics depends on them: OSM building heights are
used when surveyed, estimated from floor counts when not (the UI shows the
split); a small staging clearing is carved at the GCS and objective; very
dense fetches keep the largest 6,000 buildings (the UI says when); ground
under a real city is flat in this version. Needs internet (this is the one
feature that does); saved scenarios store the coordinates and re-fetch on
load. Building data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors (ODbL).

## Things to try

1. **Kill a relay** (click it, then *Kill*) — watch C2 lose telemetry,
   re-plan, and the chain heal.
2. **Switch radio to LoRa EU868** — kilometres of range, but the duty cycle
   stretches command rounds to ~40 s and the swarm gets visibly sluggish.
3. **Set environment to Urban** — usable range collapses to 20%, links
   flicker, more relays get pulled off the mission.
4. **RFD900x at 30 m altitude vs 120 m** — the radio horizon, not the power
   budget, is the binding constraint at 40 km scale.
5. **Crank wind to 12 m/s** — upwind legs crawl, relays burn battery holding
   station, RTB triggers early.

## Architecture

```
js/radios.js     radio presets (datasheet values + sources) & link physics
js/airframes.js  airframe presets & momentum-theory energy model
js/net.js        packet network: routing, per-hop airtime, fading, retries
js/swarm.js      C2 planner, drone onboard logic, failsafes, motion
js/render.js     canvas map: links, packets, range rings, wind, scale bar
js/main.js       UI wiring, sim loop, camera
test/            physics unit tests (node --test)
```

Plain ES5-ish JavaScript, zero dependencies, deterministic under a seeded
RNG (same seed → bit-identical run, which is what makes the tests possible).

## Tests

```
node --test
```

## Interference / RF denial

Add an **interference source** (the Interference panel) and drag it onto the
map. It raises the noise floor in an area — modelling anything from congested
urban spectrum or a downed tower to deliberate jamming — propagating with the
same path loss and terrain shadowing as any signal. Because it feeds straight
into the link-margin model, everything else reacts on its own: the coverage
map paints the dead zone red, the tether keeps drones from flying blind into
it, and the routing bends the chain around it. Tune each source's power, or
switch it off, to sweep the whole range from a mild noisy environment to a
total denial. A localized source the swarm skirts and still completes the
mission; a source blocking the only corridor is the honest failure — the
swarm maps it, holds its connected frontier, and reports it.

## Scenario save/load and after-action reports

- **Save/Load scenario** serializes every setting plus placed interference
  sources to a JSON file, so a study or demo is reproducible and shareable.
- **After-action report** exports a Markdown mission summary — did the link
  hold, how many relays and failsafes, what dead zones were mapped, packet
  loss, interference survived — the artifact a planner or customer actually
  wants out of a run (clearly marked as a simulation result, not flight data).

## Packet capture

Tick the "Packet capture" box (Mission setup) to record every network event —
sends, per-hop forwards with their retry count and link margin, deliveries,
drops (no-route or link-fail), and broadcast receptions. "Export capture"
downloads it as JSONL (one JSON event per line), a portable trace any tool
can parse — think tcpdump for the mesh. Schema is documented at the top of
[js/net.js](js/net.js) (`exportCaptureJSONL`).

## Flying real autopilots (SITL bridge)

The swarm logic here can command actual autopilot firmware instead of the
built-in physics. In "external vehicle" mode the browser keeps running every
bit of its C2 logic — planning, ETX routing, the tether, coverage learning —
but the drones are flown by ArduPilot/PX4 SITL (or a mock), reached over a
WebSocket bridge:

```
browser sim  <--WebSocket-->  bridge.py  <--MAVLink/UDP-->  SITL
```

Positions come back from the vehicles; C2's relay goals go out as MAVLink
guided-mode setpoints. It's the same code that runs the pure sim — only the
motion is externalized. See [sitl/README.md](sitl/README.md). You can try the
whole pipeline with **zero firmware** using the mock vehicle server
(`python sitl/mock_vehicles.py`, then "Fly via bridge" in the sim).

## Where this is going

This isn't just a toy — it's the working prototype of a real, globally useful
capability: keeping drone teams connected without infrastructure. Two detailed
two-year plans lay out the path:

- **[Plan A — simulation-only](PLAN-A-SIMULATION-ONLY.md)** — grow the project
  into a fundable, revenue-earning simulation product using only a laptop
  (no hardware, ~$0). Start this today.
- **[Plan B — with hardware](PLAN-B-WITH-HARDWARE.md)** — once funded, take it
  to real drones and flight-validated pilots for real customers.

Near-term simulation roadmap:

- Per-vehicle wind and sensor noise injected from the sim into SITL
- Hardware-in-the-loop: swap SITL for a real flight controller on the bench

## License

MIT — see [LICENSE](LICENSE).

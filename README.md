# Drone swarm relay simulator

A browser-based simulation of a drone swarm that keeps itself connected to a
ground station by **turning its own members into radio relays** — the way a
flock of birds would solve a comms problem. Fly the mission far enough away
and drones peel off to bridge the link; kill a relay and the swarm heals;
run the battery down and drones excuse themselves and fly home.

No build step, no dependencies. Open `index.html` from any static server.

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

Current limitation, stated plainly: the rescue tentacle extends one hop
beyond the existing network. Multi-hop rescue chains are on the roadmap.

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

## Roadmap

- Corridor routing through the learned coverage map (bend transits around
  measured dead zones, not just relay slots)
- Broadcast C2 mode (one packet orders the whole swarm — what LoRa C2
  actually does)
- Spare drones auto-launching to replace battery-RTB relays
- Packet capture export for protocol debugging
- PX4/ArduPilot SITL bridge: same planner, real autopilot firmware

## License

MIT — see [LICENSE](LICENSE).

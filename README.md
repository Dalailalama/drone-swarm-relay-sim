[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-dawgog-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/dawgog) https://buymeacoffee.com/dawgog

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
Nothing is fetched from a third party on load: the UI uses your system
monospace font (IBM Plex only if it is installed locally), and basemap tiles
and OpenStreetMap lookups happen only when you use those features. The page
carries a Content-Security-Policy `<meta>` (if your server also sends a CSP
header, the browser applies both); WebSockets may go to any `ws:`/`wss:`
host so remote SITL and TAK bridges work.

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
  the first one. Each point is flown by the drone's own navigation belief,
  and an attempt that cannot reach its point (inside a tower, say) expires
  after twice its straight-line transit time plus the listening time. A
  drone that reaches its last-known home with the link still dead lands
  there; the ground crew swaps its battery only if the base really is there
  (if the operator moved in radio silence, it stays landed).
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
declines the order, keeps flying its current one while that one still
closes (if neither closes, it takes the cheaper of the two), and reports the
refusal; C2 benches it for a while and elects a drone that can
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

Measured effect when the tether was introduced: launch-phase dark time
dropped to zero, and the urban scenario at 50 m AGL went from ~15% link
uptime (swarm repeatedly marooned in street canyons) to 100%, with the
mission still reaching its target. Later radio-preset, Fresnel-clearance and
planner changes move these numbers, so re-measure before quoting them.

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

## Tier-1 capabilities (the DDIL edition)

Six features that map this sim onto funded-RFP language — all software-only,
all tested:

- **Heterogeneous swarms** — mix airframes AND radios in one mission
  (*Mixed fleet* in Mission setup): an endurance relay wing on long-range
  radios holds the backhaul while tactical drones fly the objective on cheap
  short-range hardware. Link budgets between different radios are computed per
  direction from each transmitter's own power and calibration, over one
  shared path-loss exponent per link (the larger of the two range fits, so
  the path stays reciprocal; a jammer reaching either end uses the same one);
  band- or protocol-incompatible nodes simply cannot hear each other (radios
  link only when they share a preset's `air` protocol key, e.g. SiK and
  RFD900x). C2 elects wing units for relay duty, keeps
  them off rescue tasking, and always plans a *tactical-tail slot* so the
  short-legged flock can actually hang off the chain. The panel caps the wing
  at fleet size minus one, so at least one tactical drone always flies.
- **GPS-denied navigation** (*Interference → Add GPS outage*) — inside a
  denial zone drones fly on dead reckoning: their believed position integrates
  airspeed with Ornstein-Uhlenbeck drift, they steer by that belief (and miss
  slots by exactly their nav error), and telemetry poisons C2's picture of
  where they are. The planner hedges: relay slots sidestep zones it cannot
  trust positions in, and C2 reads each report's GNSS flag, so a
  dead-reckoned position paints no coverage, calls off no search, anchors no
  rescue chain and earns no election credit, and a drone lost there is
  marked uncertain.
- **Anti-jam spectrum agility + LPI/LPD** (*Mission setup*) — anti-jam /
  agile presets (FHSS for ELRS; interference avoidance and cancellation for
  Silvus and Doodle Mesh Rider) shed an assumed processing gain of 12–16 dB
  when agility is on (a modelling estimate: no vendor publishes such a
  figure, see [RADIOS.md](RADIOS.md)); LPI waveforms trade 3 dB of link
  budget for 6 dB of denial rejection; denial zones visibly shrink for agile
  chains; link uptime is measured so recovery is a number, not an adjective.
- **Payload/video backhaul** (*Mission setup → Video backhaul*) — streamed
  chunks are real packets paying real airtime on the one shared channel.
  C2 grants ONE streamer at a time in round-robin turns delivered inside order
  packets; chunk delivery/loss is accounted, the fleet panel marks who holds
  the channel, and video visibly starves C2 traffic (and vice versa).
- **DDIL scenario pack** (*Scenario → dropdown*) — five one-click seeded
  scenarios: GPS-denied crossing, jammed corridor on an agile MANET,
  intermittent urban canyons, duty-cycle-limited LoRa with a starving video
  scheduler, and the full combination (mixed fleet + jammer + GNSS denial +
  LPI + payload). Each is plain JSON-shaped data — save/load compatible.
- **Sim-to-real calibration loop** (*Calibration section*) — feed any CSV log
  of RSSI vs distance from real hardware (`dist,rssi` or `x,y[,z],rssi`;
  headers may carry units such as `distance_m` or `RSSI (dBm)`, positions may
  be `east`/`north`, cells may be quoted). Distances are metres and RSSI must
  be dBm: device-scale RSSI such as MAVLink `RADIO_STATUS` 0..254 is refused.
  Least squares fits the path-loss exponent and reference power with
  RMSE/R² and n ± its 95% interval, re-derives a field-calibrated radio
  preset whose model exponent equals your measurement, and emits a Markdown
  validation report with per-band residuals. A fit is refused when the
  distances span less than half a decade, the 95% interval on n is wider
  than ±0.5, n is outside 1.2–6.5, or the 1 m power is outside −120 to
  +40 dBm. Rows with a distance but no RSSI (blank, `lost`, `nan`, `-`) are
  lost packets, fitted as censored below the radio's sensitivity, which
  removes the edge-of-range bias; a log that drops lost packets cannot be
  corrected, so keep them (or fit only distances with reliable reception).
  This is the loop that turns the simulator from plausible into validated.

## Tier-2 capabilities (the moat)

Five features that make this hard to copy — all software-only, all tested:

- **Vertical mission library** (*Mission library* section) — one-click
  templates for the industries this sells into: SAR grid search, wildfire
  front overwatch, pipeline linear inspection, convoy escort, perimeter
  patrol. Each carries an operator checklist. Two of them MOVE: in **convoy
  escort** the ground station itself drives at road speed while the chain
  re-plans live behind it; in **wildfire** the objective drifts downwind and
  the flock follows.
- **Red-team adversary mode** (*Interference → Red-team mode*) — interference
  sources direction-find the swarm's own transmissions (sensor-honest: no
  god view, just a radio receiver; each fix is a noisy bearing at an
  RSSI-estimated range) and crawl toward the recency-weighted
  traffic centroid at limited ground speed. A denial zone that hunts. C2
  does not see the hunters move either: it plans against where they were
  placed and learns of a move only through coverage (lost telemetry,
  black-box uploads). Uptime with hunting vs static jammers is measurable;
  the report accounts for how far the adversary moved.
- **ATAK / TAK integration** (*ATAK / TAK section*) — exports the live common
  operating picture as Cursor-on-Target atoms: every drone (`a-f-A-M-H-Q`),
  the command post, the objective (`b-m-p-w` waypoint), and denial/GNSS-dead
  zones as drawn circles (`u-d-c-c`), each marked `how="m-s"` (simulated).
  Uids are `<prefix>-GCS`, `<prefix>-DR-n`, `<prefix>-TGT`, `<prefix>-JX-n`
  and `<prefix>-GZ-n`; the prefix is a random per-page `SIM-xxxxxx`, editable
  in the TAK panel's *UID prefix* field, so two pages never overwrite each
  other's marks. Download a
  snapshot `.xml`, or stream live (5 s cadence) through `sitl/tak_bridge.py`
  onto TAK's UDP multicast (`239.2.3.1:6969`) where real ATAK clients
  subscribe. Import someone else's CoT marks onto the map (named from their
  `<contact callsign>`; they survive a relaunch); one click turns
  any mark into the mission objective. Georeferencing reuses a loaded OSM
  area's exact anchor, or an operator origin; TAK, OSM and the basemap share
  one WGS-84 local projection, under 1 m of error within about 3 km of the
  anchor, and longitudes wrap at the antimeridian.
- **Scale: 100+ nodes** — drone slider to 120. Unicast traffic to and from
  C2 uses one C2-rooted shortest-path tree refreshed on a 0.5 s cadence
  (and rebuilt when a node dies or launches) instead of a Dijkstra per
  packet, and separation runs on a uniform neighbor grid. `npm run bench`
  regenerates `bench/BASELINE.md` — committed numbers so performance
  regressions diff in review. The committed baseline predates several core
  changes and no longer reproduces (see its header); re-run it before
  quoting a figure. At scale the binding constraint is the shared channel,
  honestly.
- **Batch Monte Carlo + REST API** — `node tools/batch.js --config
  batch/example.json` sweeps parameter cells across seeds and emits a
  Markdown report plus raw CSV. Each metric (link uptime, control-packet
  drop, video chunk loss, C2 contact %) is printed as mean [95% CI on the
  mean, Student t] with its n, plus observed min/max below 20 runs and
  sample p05/p95 from 20 runs; a single run prints `n=1, no interval`.
  Packet drop counts control traffic only (telemetry, commands, acks and
  broadcast order reach); video has its own loss column. A batch is capped
  at 200 runs, 20 distinct seeds per cell and a work budget (chain batches
  for more). Same engine served over zero-dependency HTTP:
  `node tools/server.js` (binds `127.0.0.1`; `--host <addr>` exposes it, and
  then only behind an authenticating reverse proxy; requests carrying a
  browser `Origin` get 403 unless allowed), then `POST /api/batch`. The
  bundled example is an altitude sweep over a modelled city (SiK radios on
  the suburban clutter factor, 45/90/140 m AGL) to copy for your own study;
  it is a template, not a result.
  `node tools/compare.js` runs two or more scenarios on identical seeds and
  prints objective uptime, fleet contact and arrival side by side.

## The radio model (and its honesty)

Every radio preset is a real product with datasheet numbers — TX power,
receiver sensitivity, frequency, air rate, and the vendor's claimed
line-of-sight range — where the vendor publishes them. Fields that are
estimates (for example Doodle's RF figures, the MANET ranges and air rates,
and every anti-jam `hopGainDb`) are marked *(estimate)* in
[RADIOS.md](RADIOS.md), next to the sources.

Free-space path loss alone would predict absurd ranges (a 100 mW SiK radio
"reaches" ~73 km in free space; in the field it does 300 m near the ground).
So the model uses **log-distance path loss with a per-radio exponent
calibrated so the link margin hits exactly 0 dB at the vendor's rated LOS
range**. That single fitted parameter absorbs ground reflection, Fresnel
losses, and antenna reality. On top of that sit:

- **Log-normal shadowing** — an Ornstein-Uhlenbeck dB offset per link
  (σ = 2.5 dB open field → 6.5 dB urban), so links breathe and flicker
- **Packet error curve** — success probability is logistic in margin
  (~16% at 0 dB, 50% at +2 dB, ~97% at +6 dB), with per-hop link-layer
  retries; at 0 dB or below nothing is delivered. Datasheet sensitivity is
  quoted at a low error rate, so the rated range is the model's ~84%-loss
  edge ([RADIOS.md](RADIOS.md))
- **Interference** — a source's ERP is converted to EIRP and adds to the
  receiver's noise in milliwatts, against a per-preset required
  signal-to-interference ratio ([MODEL.md](MODEL.md) §3.3)
- **3D slant range** and a **4/3-Earth radio horizon** — beyond
  `4.12(√h₁+√h₂) km` the planet blocks the link no matter the power
- **Shared-channel contention** — every transmission (and retry) occupies
  the one frequency; C2 traffic overhead visibly eats chain throughput.
  Each channel is one perfectly serialized swarm-wide timeline: there are no
  collisions, but no spatial reuse either
- **Regulatory duty cycle** (EU868 LoRa preset) — throttles telemetry and
  command rates; failsafe timeouts scale to match, like PX4's `COM_DL_LOSS_T`

**What this is:** a planning-grade sandbox whose numbers stay anchored to
real hardware behavior. **What this is not:** an RF certification tool. The
calibrated exponent is a modeling choice, stated here so you can judge it.

## The energy model

No endurance sliders. Airframes are defined by mass, rotor disc area, drag
area and battery watt-hours; hover power comes from actuator-disc momentum
theory over a lumped powertrain efficiency (0.55 by default; the micro
carries 0.24, fitted to its reference aircraft), and forward flight is
level-flight momentum theory: induced power falls with airspeed while
parasite drag on each preset's drag area rises with its cube. Endurance
*emerges*: on the usable pack, about 24 min of hover for the sub-250 g micro
(the DJI Mini 4 Pro's published 30 min on the full pack), 22 min for the
450-class and 36 min for the endurance X8. Only the micro is fitted to a real
aircraft; the q450 and X8 are class-typical estimates. Drones run wind-aware
smart-RTH: energy to get home is continuously re-estimated, and they leave
while they still can.

The battery model is deliberately simple: a constant-energy pack, of which
80% of the nominal watt-hours is usable (100% on screen is that 80%), and a
drone that runs the usable energy out is down. Smart-RTH keeps a reserve of
7% of usable energy and bills the home leg at maximum-speed power with a 1.3
margin. Voltage sag, C-rate, temperature and ageing are not modeled (see
[MODEL.md](MODEL.md) §5 and §7).

Wind is a ground-frame/air-frame split: speed limits and power draw are paid
in airspeed, so wind changes power in both directions (moderate airspeed
lowers it below hover; it climbs toward maximum speed), and a 16 m/s gale
blows a 14 m/s quad backwards.

## Terrain and the learned coverage map

Terrain (Mission setup → Terrain) is a fractal-noise heightfield — endless
seeded rolling hills and valleys, sampled analytically at any point — plus
procedural city districts: street grids of low-rise blocks with a
scattering of 60-140 m towers. Radio links need genuine line of sight over
both (a clearance of 0.6 of the first Fresnel zone at the link frequency,
shrinking to zero at the antennas; the test is pass/fail, with no partial
diffraction loss). Drones fly
terrain-following (AGL), so ridges between valleys cut links even though
nobody crashes; buildings taller than the flight altitude are no-fly boxes
the drones steer around (they carry a terrain database, like real
autopilots — and so does C2, which never plans a relay slot inside a
tower). Try the urban preset at 50 m AGL, watch the swarm suffer in the
street canyons, then raise the altitude slider over the low-rise and
compare. For short-range radios height is a trade, not a cure: it clears
roofs, but it also lengthens every slant range, so measure it for your
radio rather than assume it (an older version of this README quoted ~15% to
100% uptime; that figure predates later radio, Fresnel and planner changes).

The **3D view** button (header) switches to a FASTER-style perspective
render — shaded terrain mesh, extruded buildings, drones on altitude stems,
link lines colored by health, plus GPS-denied zones, C2's ghosts of lost
drones, TAK marks, packets on the air and (with *Coverage map* checked) the
coverage map, capped to the 1,500 cells nearest the camera aim. Drag to
orbit, wheel to zoom.

**Controls.** On the map a tap selects and a drag moves: pressing on the
target, C2, a source or a zone grabs it only once the pointer has moved a
few pixels. From the keyboard, Tab to a fleet-list row and press Enter or
Space to select it; with the map focused, arrows pan (orbit in 3D), + and −
zoom, `[` and `]` select the previous or next drone, N cycles through RF
sources and GPS zones, Escape clears that selection, Shift+arrows move the
selected source or zone (or the objective when none is selected) and
Alt+arrows move C2. Keyboard moves are recorded in the capture like drags.
At high time scales each frame steps for at most 10 ms; when the CPU cannot
keep up, the clock readout appends the rate actually achieved (for example
`T+04:10 · 23×`).

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

And it's map-first: with a real area loaded, the 2D canvas stops being an
abstract dark plane and renders the *actual map* — the OpenStreetMap
standard tile style from `tile.openstreetmap.org`, streets and parks and
block layout — with the swarm, relay chain, coverage and interference drawn
on top, the way a professional ground-control station does it. Pan and zoom
(mouse or pinch) work on the map itself. The map is the picture; the
fetched buildings remain the physics — a river on the tile does not block
radio, and we don't pretend it does. (CARTO's raster basemaps now need an
API key and are no longer used.)

Honesty notes, because the physics depends on them: OSM building heights are
used when surveyed, estimated from floor counts when not (the UI shows the
split); each building is its footprint's minimum-area rectangle, turned to
match it, and multipolygon building relations give one box per outer ring
(courtyards ignored); LOS uses the turned box, while flight avoidance uses
the axis-aligned box around it, which is conservative; a small staging
clearing is carved at the GCS and objective; very dense fetches keep the
largest 6,000 buildings (the UI says when); ground under a real city is flat
in this version. Needs internet (this is the one feature that does); saved
scenarios store the coordinates and re-fetch on load. Building data and map
tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors (ODbL).

Data sources and usage policies: tiles are used under the OSMF
[Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/),
which needs a valid Referer, so serve the page over http(s) (for example
`python -m http.server`); a page opened from `file://` sends none and its
tiles may be refused. Place search uses
[Nominatim](https://operations.osmfoundation.org/policies/nominatim/): the
app spaces requests at least 1.1 s apart and caches searches per page.
Buildings come from the public Overpass API; the app pauses about 30 s on a
server that answers 429, 406 or 504 and tries the next. Heavy users should
run their own instances (the endpoints are set at the top of `js/osm.js`,
and the CSP in `index.html` must allow them).

## Things to try

1. **Kill a relay** (click it, then *Kill*) — watch C2 lose telemetry,
   re-plan, and the chain heal.
1. **Drag the operator** (the C2 marker) — the chain re-plans live and pulls
   extra relays as you walk away from the flock. Teleport it far beyond radio
   range and you'll honestly lose contact: nobody in the flock can know where
   C2 went without a link to hear it from.
2. **Switch radio to LoRa EU868** — kilometres of range, but the duty cycle
   stretches command rounds to ~40 s and the swarm gets visibly sluggish.
3. **Set environment to Urban** — usable range collapses to 20%, links
   flicker, more relays get pulled off the mission.
4. **RFD900x at 30 m altitude vs 120 m** — the radio horizon, not the power
   budget, is the binding constraint at 40 km scale.
5. **Crank wind to 12 m/s** — upwind legs crawl, relays burn battery holding
   station, RTB triggers early.
6. **Load *Full DDIL* from the Scenario dropdown** — mixed fleet, jammer,
   GNSS denial over the objective, LPI waveforms, and a 300 kbps video feed
   all fighting for one channel. Then toggle LPI off mid-run and watch the
   jammer's denial zone grow. (Its RFD900x radios have no agility gain, so
   the spectrum-agility toggle changes nothing here; try that one on
   *Disrupted*, whose Doodle Mesh Rider chain has it.)
7. **Enable *Mixed fleet*** — an X8 relay wing on RFD900x radios holds the
   long backhaul while SiK-equipped micros work the target; kill a wing relay
   and watch C2 re-elect another *wing* unit, not a tactical one. The
   planner covers the micros' hop at the objective end of the chain, not
   their transit to it, so a far objective can still leave short-range
   micros out of reach.
8. **Add a GPS outage over the objective** — drones cross on dead reckoning,
   miss their slots by tens of metres, and C2's picture of them drifts with
   them. Toggle the zone off and navigation snaps back.
9. **Load *Convoy escort* from the Mission library** — the C2 marker drives
   itself across the map at road speed while the relay wing re-forms behind
   it. This is the demo clip.
10. **Switch on *Red-team mode*** with two jammers placed — they stop sitting
   still and start hunting whoever transmits.
11. **Run a batch study** — `node tools/batch.js --config batch/example.json`
    and read the Markdown report it writes; or serve the same thing as an
    API: `node tools/server.js`, `curl -X POST localhost:8090/api/batch -d @batch/example.json`.

## Architecture

```
js/radios.js     radio presets (datasheet values + sources) & link physics
js/terrain.js    fractal heightfield, procedural city, LOS / Fresnel test
js/osm.js        OpenStreetMap building import + the shared WGS-84 projection
js/tiles.js      OpenStreetMap raster basemap under the 2D map
js/airframes.js  airframe presets & momentum-theory energy model
js/fleet.js      heterogeneous fleets: mixed-band per-direction link budgets
js/gpsnav.js     GPS-denied dead-reckoning belief model
js/net.js        packet network: routing, per-hop airtime, fading, retries
js/swarm.js      C2 planner, drone onboard logic, failsafes, motion
js/replay.js     replays a packet capture from seed + settings + user actions
js/render.js     canvas map: links, packets, range rings, wind, scale bar
js/view3d.js     hand-rolled 3D perspective view (no WebGL)
js/external.js   external vehicle mode: browser side of the SITL bridge
js/scenarios.js  DDIL scenario pack (bundled one-click demos)
js/missions.js   vertical mission library (SAR/wildfire/pipeline/convoy/perimeter)
js/adversary.js  red-team mode: DF-hunting interference sources
js/tak.js        ATAK/TAK Cursor-on-Target export + import
js/calibrate.js  sim-to-real loop: CSV ingest, path-loss fit, validation
js/batchstats.js Monte Carlo aggregation (distributions per cell)
js/main.js       UI wiring, sim loop, camera
sitl/            MAVLink bridge, mock vehicles, TAK multicast bridge (tak_bridge.py)
tools/           batch engine CLI (batch.js), REST API server (server.js),
                 scenario comparison dashboard (compare.js)
bench/           scale benchmark suite + committed BASELINE.md
test/            physics + integration tests (npm test)
```

Modern JavaScript (ES2020: `??`, arrow functions, object spread) with no
transpiler, so it needs a current browser (roughly Chrome 80, Firefox 72 or
Safari 13.1 and later). Zero dependencies, deterministic under a seeded RNG
(same seed → bit-identical run, which is what makes the tests possible).

## Tests

```
npm test
```

`npm test` runs `node --test "test/*.test.js"` and needs Node 22 or later
(CI runs 22.x and 24.x). A bare `node --test` also picks up the helpers in
`test/helpers/` and reports two extra tests. [CONTRIBUTING.md](CONTRIBUTING.md)
lists the Python suites and the other pre-PR checks.

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
  A loaded file is validated in full before anything changes: unknown env,
  airframe, terrain or radio ids (a radio id is accepted when the file's own
  `radioPreset`/`relayRadioPreset` defines it), malformed numbers, and bad
  jammer or zone entries are rejected with one alert.
- **After-action report** exports a Markdown mission summary — did the link
  hold, how many relays and failsafes, what dead zones were mapped, packet
  loss, interference survived — the artifact a planner or customer actually
  wants out of a run (clearly marked as a simulation result, not flight data).

## Packet capture

Tick the "Packet capture" box (Mission setup) to record network events —
sends, per-hop forwards with their retry count and link margin, deliveries,
drops (with one of ten reasons: no-route, queue-latency, link-fail,
ttl-expired, dead-src, dead-dst, bcast-superseded, bcast-backlog,
bcast-suppressed, bcast-miss), and broadcast receptions. The capture is a
rolling window of the last 4,000 events, not the whole run; its header
(format version 3) reports `firstSeq`, `totalEvents` and `truncated`.
"Export capture" downloads it as JSONL (one JSON event per line), a
portable trace any tool can parse — think tcpdump for the mesh. Schema is
documented at the top of [js/net.js](js/net.js) (`exportCaptureJSONL`).

The header also carries the seed, the settings and every user action from
t=0 (recorded even while capture is off; `captureStartT` says when packet
events begin), so "Replay capture…" can regenerate the run. It runs in the
background with progress on the button, then logs whether the replay
reproduced the capture's deliveries (`matches` or `DIVERGES from`, with
both counts and the time window). It is a parity check, not a visual
replay; the replayed state is kept on `window.sim.lastReplay`.

## Physics, Protocol & Model Specifications

- **[Physical & Mathematical Model (MODEL.md)](MODEL.md)** — Coordinate systems, RF propagation equations, packet error rate sigmoids, actuator disk momentum theory, wind-adjusted smart-RTH, and model boundaries.
- **[Browser-Bridge Wire Protocol (docs/PROTOCOL.md)](docs/PROTOCOL.md)** — JSON WebSocket wire specification, state transitions, freshness requirements, machine-readable service ACKs, and idempotent deduplication.

## Flying real autopilots (SITL bridge)

The swarm logic here can command actual autopilot firmware instead of the
built-in physics. In "external vehicle" mode the browser keeps running every
bit of its C2 logic — planning, ETX routing, the tether, coverage learning —
but the drones are flown by ArduCopter SITL (or a mock), reached over a
WebSocket bridge (the bridge refuses PX4: it needs ArduCopter's `GUIDED`
mode):

```
browser sim  <--WebSocket-->  bridge.py  <--MAVLink/UDP-->  SITL
```

Positions come back from the vehicles; C2's relay goals go out as MAVLink
guided-mode setpoints. It's the same code that runs the pure sim — only the
motion is externalized. See [sitl/README.md](sitl/README.md).

- **Executable mock pipeline**: Test the complete WebSocket protocol, goal
  delivery, telemetry streaming, abort-to-hold, landing, and battery swap
  with **zero firmware** via `python sitl/mock_vehicles.py`.
- **Automated acceptance runner**: Run end-to-end flight, landing, swap, and
  relaunch verification with `python sitl/run_acceptance.py`.
- **Real ArduPilot SITL**: Real SITL flight requires a Linux ArduPilot
  environment (`./run_ardupilot_sitl.sh` and `python sitl/bridge.py`).
- **CI**: every push to `main` and every pull request to `main` runs the
  JavaScript suite plus the Python bridge, executable-mock,
  protocol-conformance, failure-scenario and TAK-bridge suites and the mock
  acceptance run. These are mock-level checks; real SITL flight is not part
  of CI. A Playwright browser-to-mock end-to-end test is opt-in (the manual
  "Browser E2E" workflow; see [CONTRIBUTING.md](CONTRIBUTING.md)).

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

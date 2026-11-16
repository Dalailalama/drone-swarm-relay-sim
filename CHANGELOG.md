# Changelog

Notable changes, newest first. The project has no tagged release yet; when
one is cut, its version and date go in a heading here and in
`CITATION.cff`. Per-finding detail (evidence, regression test, commit) for
the review and audit work lives in [REVIEW-FIXES.md](REVIEW-FIXES.md).

## Unreleased

Audit and review hardening (2026-10-16 to 2026-11-13), grouped by area;
the commit messages carry the per-finding detail.

### C2 planner

- The relay planner sizes the chain to the route instead of a fixed 12-slot
  cap, caps it at the fleet less one mission drone, and warns with the
  number of drones a route really needs; C2 never conscripts the last drone
  in contact that is still flying the mission.
- When the route search fails, C2 releases every relay instead of leaving
  one to make up a straight-line slot inside the blockage.
- With the base and the objective in one planning cell, the plan still runs
  base to objective, so a mixed fleet keeps its tactical-tail slot.
- A failed chain plan is searched again as soon as spectrum agility, LPI,
  the chain radio, environment, altitude or spacing changes, instead of
  being held for up to 60 s.
- With LPI on, hop planning pays the waveform's 3 dB cost, so relays are
  spaced to keep the full fade reserve.
- C2 announces its telemetry and command cadence in every order and
  broadcast table, sizes the telemetry interval on the fleet manifest, and
  keeps timing staleness on the longer interval for three periods after a
  replan shortens it, so drones pacing on the old cadence are not booked
  lost.
- C2 treats silence from a drone it last heard as RTB or landed as
  expected, instead of booking it lost and sending rescuers.
- A rescue chain grows a link only once its current tip has reached its
  goal and is still short of the lost group.
- A drone's decline reaches C2 (latched, with a per-drone count in
  telemetry) and C2 benches each decline exactly once; a battery swap
  clears it.
- C2 reads the telemetry GNSS flag: a dead-reckoned report paints no
  coverage, calls off no search, anchors no rescue chain and earns no
  election credit, and a drone lost there is marked uncertain.
- In red-team mode C2 plans against hostile emitters where they were
  reported and learns of a move only through lost telemetry and dead-zone
  uploads.
- A relay radio or airframe that no drone flies (wing 0) no longer changes
  C2's routes or adds a second C2 broadcast, so such a run replays exactly.

### Drone onboard

- Onboard feasibility, smart-RTH, corridor routing and the tether plan from
  the drone's own nav belief and last-known base instead of true position
  and the live base (true wind is kept, as a stated simplification).
- GNSS-denied dead reckoning integrates airspeed plus the wind estimate
  frozen when the fix was lost, so a wind change during the outage becomes
  nav error.
- The link-loss ladder sets its points and judges arrival on the nav
  belief, and a relink point the drone cannot reach expires after a transit
  allowance sized on the ground speed the wind leaves along the leg.
- At each relink point the drone listens for three announced order rounds,
  never under 35 s, so a slow unicast link can still reach it.
- A drone already flying home on RTB no longer logs or latches a decline
  for orders it cannot take.
- Black-box samples logged without a GNSS fix carry a denied flag in the
  upload, and C2 does not paint their dead-reckoned positions RF-bad.
- A drone that runs out the ladder lands when its belief reaches its
  last-known home (in rtl as well as rtb); smart-RTH also watches rtl, and
  the crew swaps the battery only if the true base is there.
- The tether's slow band throttles speed so the drone eases onto the stop
  floor instead of lurching through it.
- Drones time telemetry, the link-loss failsafe and tether staleness from
  the cadence C2 last announced, not from C2's private plan.
- The commitment rule keeps the current order over a non-closing new one
  only while the current one closes; when neither closes, the drone takes
  the cheaper.

### RF and network

- A jammer's ERP is converted to EIRP and heard through the receive
  antenna, and noise and interference add in milliwatts (3.01 dB at the
  red-zone edge) instead of by a dB maximum.
- The required signal-to-interference ratio is per preset: LoRa uses the
  SX1276 SF10 figure (-15 dB), FSK-class radios +10 dB.
- Interference degrades only the link direction whose receiver hears it,
  and jammers on a field-calibrated channel cross the same measured 1 m
  loss as the signal.
- A mixed link's path loss is reciprocal, using the larger of the two
  radios' exponents in both directions, and radios link only when they
  share an air protocol (SiK and RFD900x do; SiK and LoRa do not).
- Line of sight needs 0.6 of the first Fresnel zone at the link frequency
  instead of a flat 5 m, and terrain is sampled finely enough not to miss
  crests on short missions.
- Each link's shadow fade starts with the full environment sigma instead of
  growing from 0 dB.
- Radio presets match their cited vendor pages: SiK V3 at -105 dBm,
  RFD900x at 224 kbps / -93 dBm with 3 dBi dipoles, Silvus -102 dBm,
  Rajant 29 dBm, ExpressLRS in its 250 Hz mode, XBee-PRO 900HP at 915 MHz;
  dead sources replaced and non-vendor figures marked as estimates.
- Every `hopGainDb` is labelled a modelling estimate; Silvus is described
  as interference cancellation/avoidance and Doodle as channel agility, not
  frequency hopping.
- Preset import rejects field combinations that imply a non-physical
  path-loss exponent.
- C2's transmit and duty clocks are kept per radio unit, so a LoRa unit's
  rest no longer silences C2's 2.4 GHz unit.
- Video admission budgets airtime on every hop of the route.
- Broadcast order reach is scored like unicast, and batch, compare and the
  after-action report's packet line count control-plane loss without video
  fragments.
- An interference source that names no `altM` sits at one 15 m default for
  the RF floor, the red-team direction finder, the TAK hazard mark and the
  3D mast, and an explicit `altM` of 0 stays at ground level.
- C2 unicast orders use the shared C2-rooted tree instead of a Dijkstra per
  drone, and a relay death or launch rebuilds that tree on the same tick.
- Sender deaths mid-air free the channel at the moment of death for
  broadcasts as for unicast.
- The packet capture agrees with the counters (dead-dst drops, frame ids on
  video fragments, the right hop blamed for a relay dying in
  store-and-forward); its version 3 header says whether the rolling window
  was truncated, and net.js documents all ten drop reasons.
- The red-team direction finder estimates range from received power with
  fading instead of reading the emitter's true range.

### Energy

- The micro preset is the DJI Mini 4 Pro (real disc, 18.96 Wh pack, fitted
  powertrain efficiency), so its full-pack hover matches the published
  30 min.
- The coaxial X8 counts one disc per stack with Leishman's coaxial loss
  (about 36 min hover instead of 46).
- Forward-flight power is level-flight momentum theory with a per-airframe
  drag area instead of a fitted cubic, and home-leg reserves are charged at
  the airframe's maximum-speed power.
- An RTB forced by wind above airspeed is logged and explained as an
  unflyable home leg instead of "battery low (100%)".
- In a mixed fleet the decline log reports battery against the drone's own
  airframe.

### Scenarios and tools

- Bundled scenarios fly what they describe: ddil-intermittent uses the
  suburban clutter factor its modelled city calls for, so its 12 drones can
  cover the span; ddil-full's tactical micros fly RFD900x and its jammer is
  retuned so it no longer covers base and objective; ddil-disrupted's two
  emitters deny the corridor's middle but leave base and objective clear;
  convoy escort drives open-road terrain, so the moving command vehicle no
  longer drops behind a ridge.
- Loading a scenario rejects unknown environment, airframe, terrain or
  radio ids before anything changes, and sets the fleet size before the
  relay wing so the wing is not clamped by a stale slider maximum.
- Packet-capture replay re-applies mid-run UI actions, runs in slices with
  progress on the button, and logs whether it reproduced the capture.
- Calibration refuses fits it cannot determine (span under half a decade,
  95% interval on n wider than ±0.5, device-scale RSSI), accepts
  unit-carrying headers and east/north positions, fits lost-packet rows as
  censored, and its verdict follows the re-derived range.
- The batch report prints mean with a Student-t 95% interval and n,
  min/max below 20 runs, C2 contact to one decimal, and the video bitrate
  actually flown; duplicate seeds are refused.
- Batch caps jammer and GPS-zone lists at 64 and weights its work budget by
  active jammers; the example study flies the suburban clutter factor
  over its modelled city.
- Batch CSV cells a spreadsheet would evaluate are prefixed with `'`.
- The compare tool runs a scenario file exactly or refuses it, fills
  missing fields with the page's defaults, caps the relay wing below the
  fleet, refuses repeated seeds, uses sample SD, and integrates energy
  across battery swaps.
- Compare reports objective uptime and fleet contact as separate columns,
  prints k/N arrived and a censored median arrival time (">duration" when
  half or fewer seeds arrive), and by default runs for twice the longest
  transit.
- The batch API server's time budget follows each request's own pace instead
  of a fixed 5 minutes: the worker reports progress every few sim-seconds
  and the server allows twice the batch's projected total at the pace it has
  shown, never under 5 minutes (a hang is caught no later than before) and
  never over twice the cost of the largest batch the limits admit (~36
  minutes at `tools/batch.js`'s documented rates). Those rates are stale, so
  they stand in only until the first progress report; a batch that needs
  more than the ceiling still gets a 504, which says whether it stalled or
  hit the ceiling and how to split the batch or run it with the CLI. The
  usage line names `--host`.
- The benchmark's `droppedPct` is the control-plane loss that batch, compare
  and the after-action report state, not the aggregate that counts video
  fragments.

### UI and accessibility

- Selects and the map canvas have accessible names, the status pill and
  event log are live regions, and dim text and the lost pill meet WCAG AA
  contrast.
- Keyboard control: fleet rows are focusable buttons, and the focused map
  pans, zooms, steps the selection and moves sources, zones, the objective
  and C2.
- A tap on the map selects; only a real drag moves the target, C2, a source
  or a zone.
- The 3D view draws GPS zones, lost-drone ghosts, TAK marks, packets and
  the coverage map, with haloed labels.
- Each frame steps a whole number of fixed steps, so 120x is no longer
  held to about 57x on a 60 Hz display, and the clock shows the achieved
  rate when it falls short.
- The calibration readout is visible, and status texts, the mixed-fleet
  band warning and the relay-wing slider (fleet size minus one, capped at
  15) follow scenario loads and fleet changes.
- The drone decision card shows ground speed, prices the home leg from the
  nav belief, quotes the real hold threshold, and explains a landed drone
  correctly.
- The chain-throughput KPI uses each hop's own radio rate and duty cycle
  and subtracts only C2's airtime, and the channel line splits busy air
  into C2 and video.
- The hop table reads 100% loss when a hop's instantaneous margin is at or
  below 0 dB, matching the delivery gate.
- The spectrum-agility label, its log line and the Disrupted pack say
  anti-jam spectrum agility instead of frequency hopping.
- The 2D hillshade is a cached layer rebuilt only on zoom, resize, terrain
  change or when the view leaves it, and the 3D camera basis is built once
  per frame.
- Smaller fixes: landscape-phone layout, map halo for the selected source
  or zone, lost-drone ghosts in red, legend colours, the 'Target distance'
  slider measured from C2, '&' in place names, the after-action EW line,
  and a dismissible first-run tip that clears the scale bar's label.
- The page loads no Google Fonts and carries a Content-Security-Policy.

### Maps and TAK

- The basemap uses the keyless OpenStreetMap standard tiles (CARTO tiles
  now need an API key), under a veil darkened for them.
- OSM import keeps multipolygon buildings and turned footprints (minimum-area
  boxes), parses feet-and-inches heights, and paces Nominatim and Overpass
  requests per their usage policies.
- OSM, the basemap and TAK share one WGS-84 local projection, and TAK
  export and import wrap longitude at the antimeridian.
- CoT export uses MITRE/atak-civ types (`a-f-A-M-H-Q`, `b-m-p-w`,
  `u-d-c-c`), marks every atom `how="m-s"`, sends hae 9999999.0 for an
  unknown datum, and uses a per-page uid prefix so two pages do not
  overwrite each other.
- CoT import takes the callsign from `<contact>`, parses crafted files in
  linear time, and imported marks survive a relaunch.
- `tak_bridge.py` forwards only well-formed CoT events, caps frames at
  256 KiB and defaults to multicast TTL 1.

### SITL bridge and security

- All three WebSocket servers refuse foreign web origins with HTTP 403
  (extendable with `--allow-origin`), can require a `--token` /
  `$BRIDGE_TOKEN` secret (HTTP 401 without it; a `+` in it matches as
  typed), and generate a token when bound beyond loopback; `tak_bridge.py`
  binds loopback by default.
- The servers clamp an init's vehicle count to 256, validate an init before
  it takes control, and answer a malformed message with a status line
  instead of closing the socket.
- The batch API binds loopback by default and refuses cross-origin browser
  POSTs; a `service_ack` for a foreign id can no longer pollute
  `Object.prototype` in the browser.
- The bridge flies ArduCopter only: a PX4 vehicle fails as
  `failed:unsupported-autopilot`.
- The bridge sends a 1 Hz GCS heartbeat, listens only to each vehicle's own
  autopilot, uses ArduPilot's position-only setpoint mask, and revokes
  READY when the vehicle leaves GUIDED or disarms.
- `run_ardupilot_sitl.sh` starts every instance with `FS_GCS_ENABLE=1`
  (RTL; override with the `FS_GCS_ENABLE` environment variable), so a dead
  bridge brings the vehicles home and lands them.
- An abort is confirmed only by a heartbeat newer than the request, abort
  hold no longer floods setpoints, and a resume during confirm-abort is
  refused until then.
- An init keeps every vehicle it still lists (flight and service state
  intact), lands a dropped armed vehicle, sends no takeoff to one already
  flying, and replies from its own task, so services and goals sent while
  vehicles boot are answered at once.
- Sim drones with no bridge vehicle are marked down and readiness reads
  against the count the sim asked for; the bridge reports a `--count`
  override.
- Landing is re-sent until acknowledged and can be retried; a failed
  relaunch parks as failed, and a vehicle can be relaunched from aborted
  or after a refused relaunch.
- In external mode a drone lands when its nav belief reaches the home it
  last learned, as an internal one does, and gets no battery swap where
  there is no ground crew.
- A vehicle that touches down after its landing timed out, or whose land
  retry was refused because it was already down, goes on to the swap
  handshake; a refused relaunch is retried after 3 s, up to 3 relaunches,
  then reported as failed with the vehicle on the pad.
- The mock behaves like ArduCopter on land, refused arm and refused
  GUIDED, and the conformance suite runs those cases against both servers.

### CI and developer experience

- CI whitespace check works on pull requests and fails on push, covering the
  whole push.
- CI tests Node 22.x and 24.x (Node 20 is end-of-life); actions moved to
  their node24 majors and Dependabot keeps them current.
- `package.json` adds a zero-dependency `npm test` (runs exactly
  `test/*.test.js`), `npm run bench` and the Node >= 22 floor.
- CI uploads the mock acceptance report and logs when the Python job fails
  (`run_acceptance.py --logs-dir`), and the workflow token is read-only.
- CI runs a TAK-bridge test suite; the Playwright browser-to-mock test is an
  opt-in manual workflow.
- A GitHub Pages deploy job runs only after every CI job passes on a main
  push; it stays inert until the repository's Pages source is switched to
  GitHub Actions.
- The GPS-denied tests and a new determinism guard (no `Math.random` in
  `js/`) assert what they claim.
- Added CONTRIBUTING pre-PR commands, `CITATION.cff`, this changelog and
  `SECURITY.md`; `out/` and local venvs are ignored.

### Docs

- MODEL.md states the models the code runs, with a doc test pinning its
  constants.
- README's radio, energy, failsafe, calibration, map, TAK and capture
  sections match the code, and stale measured figures (including
  `bench/BASELINE.md`) are marked as such.
- RADIOS.md covers all nine presets with sources, marks estimates and
  documents `jamSirDb`.
- docs/PROTOCOL.md matches both servers' wire messages, checked by the
  conformance suite.
- sitl/README.md and SECURITY.md describe the handshake gate, the GCS
  heartbeat and `FS_GCS_ENABLE`, and the ArduCopter-only bridge.
- VALUE.md states what the project is and is not worth today, and PITCH.md
  drops unsupported uniqueness claims.

### Hardening (issues #21 to #27)

- Render loop survives a failing frame; external mode treats bridge input as
  untrusted; terrain and broadcast reception reject NaN; scenario files are
  validated in full before anything changes; the batch API budgets relay
  planning and rejects malformed requests; soak-audit hygiene fixes.

### Real ArduPilot SITL acceptance and audits (2026-09-28)

- Acceptance runner for mock and real SITL, with the stability and soak
  audit fixes.

### External review fixes (2026-09-15 to 2026-09-19)

- The 32 findings of the first external review (issue #6), the follow-up
  review and the third review (W01 to W10), each with a regression test.
- Optimization pass O1 to O9.

### Baseline (2026-07-15)

- Browser drone-swarm relay simulator with real radio presets.

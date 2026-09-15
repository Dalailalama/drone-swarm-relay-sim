# Review-fix tracker — external review of `ffb35e6`

Working through the 32 findings of the 2026-09-15 external implementation
review (issue #6). Method: **failing regression first**, then the fix, then
green, one coherent commit per finding (or per tightly-coupled cluster).
A finding whose probe does not reproduce is investigated and marked
*disputed* with the evidence, never silently "fixed".

Corrected plan-item tally at review time: **19 present / 22 partial /
12 open** (of B1–B53). Optimizations O1–O9: mostly absent; handled as a
separate pass after correctness.

Bridge/SITL findings carry two verification states: *mock-verified*
(WebSocket mock, no autopilot) and *SITL-verified* (real ArduPilot flight).
A finding is not closed as SITL-verified until actually flown.

| # | Finding (short) | Review evidence | Regression test | Fix commit | Status |
|---|---|---|---|---|---|
| 1 | Building collision at dt=0.05 | **reproduced**: entry t=0.35 s, x=85.399 (reviewer: x=85.394) | test/collision.test.js (4: head-on, corner clip, expel, overfly) | swept segment/AABB clamp + 2.5 m clearance in stepDrone | **fixed** |
| 2 | Upwind feasibility uses scalar wind | **reproduced** both ways: impossible return accepted AND easy downwind rejected | test/windvector.test.js (4) | groundSpeedAlong (wind vector, matches movement envelope) in orderFeasible + onboard RTH; unflyable leg = explicit reject | **fixed** |
| 3 | Unicast outcome decided at schedule time | **reproduced**: dead sender + moved receiver both delivered | test/netsched.test.js (2) | commit-at-transmission: liveness/RF/retries evaluated when air leaves the antenna | **fixed** |
| 4 | Forwarded broadcasts bypass channel/duty | **reproduced**: two copies overlapped at [1.02, 2.02] | test/netsched.test.js (1) | all transmissions through one earliest-eligible commit phase (control wins ties) | **fixed** |
| 5 | Expired traffic keeps channel reserved | **reproduced**: fresh cmd starved behind ghost queue; t=0 packet never aged | test/netsched.test.js (2) | no advance reservations to leak; TTL `??` fix; broadcast supersession + backlog cap | **fixed** |
| 6 | Objective connectivity not wired to consumers | **reproduced**: connected=true at launch w/ objective 1000 km away; 5 km short counted on long-range radio | test/objective.test.js (4) | `connected` = live route to a drone on-station (orbit-ring radius, radio-independent); `fleetConnected` split out; pill shows "en route"; 4 tests re-scoped to their true subject | **fixed** |
| 7 | Imported radio presets inject HTML | **reproduced**: live `<img>` in specCard; built-in SiK rewritten to 59 dBm; garbage fields registered | test/presetinject.test.js (4) | whitelist+bounds sanitizer (reject lying numbers), built-in ids collide to `-imported`, all preset strings escaped at render | **fixed** |
| 8 | Stale OSM `.then` overwrites new scenario | **reproduced**: B's target reverted 888→111 on A's late fetch; button stuck | test/osmrace.test.js (4) | generation carried through completion (`applied` result + gen check), button ownership cleanup, geocode + relaunch + terrain-change all cancel | **fixed** |
| 9 | External telemetry never goes stale | **reproduced**: 30 s-old sample still "current" | test/external.test.js (1) | local receipt-age staleness (3 s) feeds the freeze→dead ladder; stale policy documented | **fixed (mock-verified)** |
| 10 | Old socket callbacks break reconnection | **reproduced**: ghost onclose un-readied live bridge | test/external.test.js (1) | every handler guarded by socket identity | **fixed (mock-verified)** |
| 11 | External avoidance/landing unconfirmed | **reproduced**: landed+swap at 50 m; raw goal shipped through a 300 m tower | test/extgoals.test.js (3) | goals clipped short of no-fly footprints before shipping; RTB-over-pad commands descent; landing requires telemetry-confirmed touchdown (≤2 m) | **fixed (mock-verified)** |
| 12 | Bridge readiness lacks ack/arm/takeoff check | **reproduced** in mock: success narrated after exception; ready listed all ids | sitl/test_bridge.py (3 of 6) | confirmed state machine: GUIDED via heartbeat, arm via ACK+armed flag, takeoff via ACK+climb; per-vehicle {ready, state} in the ready reply | **fixed (mock-verified — NOT flown; SITL open, VM offline)** |
| 13 | Late vehicle start / controller races | **reproduced** in mock: late heartbeat never initialized; second client stomped fleet | sitl/test_bridge.py (3 of 6) | one task per vehicle (sole socket reader) with resume-from-earliest-step recovery; telemetry never gated on the gather; controller ownership + init lock | **fixed (mock-verified — NOT flown; SITL open, VM offline)** |
| 14 | Batch workers unbounded/uncancellable | **reproduced**: 3 simultaneous requests → 3 workers, 200/200/200; no timeout | test/batchvalid.test.js (3) | bounded pool (2 workers, queue 8→429), per-run time budget (504+terminate), client-disconnect reaps the worker, exit-without-result handled | **fixed** |
| 15 | Video loss counts fragments as frames | **reproduced**: 4-frag chunk → 4 drops (+ expiry double) | test/vidframes.test.js (4) | one lifecycle per frame: tombstone on first loss, stragglers discarded, expiry merges | **fixed** |
| 16 | Utilization double-bills airtime | **reproduced**: 1 s of air read as 0.4 of a 5 s window | test/netsched.test.js (1) | billed once at actual transmission, per channel; busiest-channel share reported | **fixed** |
| 17 | ACK-replayed coverage samples double-count | **reproduced**: weight 3→6 on replay; 32 B bill for 3 riding samples | test/covdedup.test.js (4) | per-vehicle seq dedup at C2 (restart-aware), duplicates still ACKed, sample rows billed on air | **fixed** |
| 18 | Disconnected nav reads live truth | **reproduced**: denied black-box logged truth (97,98) w/ belief (1000,1000); rtb followed a silently-moved base | test/navbelief.test.js (3) | black box logs the BELIEF; base knowledge = launch briefing + C2 position riding every packet; rtb/rtl/relink/RTH plan on last-KNOWN base. Neighbor positions in the tether stay beacon-measurement-based (documented scope) | **fixed** |
| 19 | Failed A* still assigns blocked routes | **reproduced**: 12 slots through a solid wall, relays ordered onto them | test/planfail.test.js (3) | no-route → empty slot list + explicit C2 error, straight-line fallbacks guarded | **fixed** |
| 20 | Adversary band filtering wrong representation | **reproduced**: in-band hunter moved 0.0 m; silent target tracked live | test/advband.test.js (3) | jammerFreqMHz normalizer everywhere; DF fixes measured once at emission, kept as taken; txAt=actual emission via scheduler rework | **fixed** |
| 21 | Video grants lack expiry | **reproduced**: 13 chunks streamed past expiry on heartbeats alone | test/vidgrant.test.js (3) | orders carry absolute videoUntil + grant id; onboard check uses the deadline, never link freshness | **fixed** |
| 22 | OSM reload loses saved geometry/seed | **reproduced**: seed 7→45, drones spawned at origin | test/rebuild.test.js (1) | post-fetch rebuild carries the scenario's seed+base+target — built once, correctly | **fixed** |
| 23 | Calibrated presets not exported in scenario | **reproduced**: fresh page fell back to default radio | test/presetexport.test.js (2) | custom/calibrated definitions embedded in exports (built-ins stay id-only), validated on import | **fixed** |
| 24 | Count slider double-inits bridge | **reproduced**: 2 init messages per change | test/external.test.js (1) | handler's duplicate call removed; resetSwarm's central sync is the one path | **fixed (mock-verified)** |
| 25 | External altitude datum undefined | **reproduced**: 120 m origin-relative read as 120 m AGL over hills | test/external.test.js (1) | contract defined: bridge alt = origin-relative (-NED.z); converted to AGL at the vehicle via ground-height delta | **fixed (mock-verified)** |
| 26 | TAK export labels AGL as HAE | **reproduced**: hae=50.0 for 120 m AGL @ 500 m origin | test/takhae.test.js (3) | anchor carries a real vertical datum (origin HAE, UI field); exports = HAE + terrain + AGL; unknown origin omits hae | **fixed** |
| 27 | CoT regex truncates opposite quotes | **reproduced**: O'Brien → "O" | test/cotquotes.test.js (3) | backreference-matched quote delimiters in all attribute parsing; entity round-trips covered | **fixed** |
| 28 | Browser dt=0.05 vs batch dt=0.25 | **reproduced**: three step policies across browser/batch/bench | test/simdt.test.js (2) | SIM_DT_SEC defined once in swarm.js, consumed by browser+batch+bench; baseline regenerated at the true step (honest costs + fleet-uptime column) | **fixed** |
| 29 | Battery swaps counted twice | **reproduced**: full land→swap→relaunch cycle counted 2 | test/swapcount.test.js (1) | counted at the completed relaunch transition, log-text sniffing removed | **fixed** |
| 30 | Batch validation permissive on types | **reproduced**: count=1.5, seeds='bad', env='toString', null coords all accepted | test/batchvalid.test.js (2) | strict provided-field validation (wrong type ≠ omitted), integer counts, bounded nested cell fields & geometry, drone-second work budget | **fixed** |
| 31 | Failed tiles never retry | **reproduced**: hole persisted after network recovery | test/tileretry.test.js (2) | bounded exponential backoff (5 s→5 min), successes cached as before | **fixed** |
| 32 | City sliders bypass geometry/zero handling | **reproduced**: seed 0→42, city centred off the moved corridor | test/rebuild.test.js (1) | regeneration uses base→target geometry and null-safe seed | **fixed** |

Optimizations O1–O9: tracked after the 32 correctness findings; each will be
implemented against a measured benchmark, not marked done by adjacency.

## Optimization pass (O1-O9)

| Opt | Status | Notes |
|---|---|---|
| O1 drone id map | **done** | nodePos Map (self-healing) replaces per-hop linear find |
| O2 per-step RF/LOS caches | **substantially covered** | per-tick margin cache (pre-existing) + O9 ray-walk LOS; further caching deferred until a profile demands it |
| O3 browser sim worker | **deferred, deliberately** | swarm state is shared live with the renderer and mutated by UI drags; a worker port means snapshot serialization every frame — measured budget (sub-realtime only >=140 drones at 20 Hz) does not justify the redesign yet |
| O4 A* binary heap | **done** | open list linear-scan+splice -> min-heap, lazy stale-skip kept |
| O5 cached mission membership | **done** | one flock snapshot per tick (was per-drone O(N^2)) |
| O6 3D static-scene cache | **done** | ground+building projections reused while camera/terrain/canvas hold; textures stream by reference |
| O7 incremental DOM rows | **done** | hops/fleet/event panels assign innerHTML only on change |
| O8 city-slider debounce | **done** | 150 ms debounce; labels track live |
| O9 ring/pruning family | **done** | capture batch-trim, coverage-map bound (oldest-first), sep-grid history purge, LOS candidates by ray-walk (was full-list for long links) |

Interleaved A/B at n=100 under identical machine load: ~10.6->9.4 ms/tick median
(the wall-clock numbers in any single bench run vary +/-20% with background
load — BASELINE.md is only regenerated on an idle machine).

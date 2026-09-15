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
| 11 | External avoidance/landing unconfirmed | airborne drone marked landed at altM=50 | — | — | queued (external) |
| 12 | Bridge readiness lacks ack/arm/takeoff check | bridge.py logs success after exception | — | — | queued (bridge; mock vs SITL split) |
| 13 | Late vehicle start / controller races | no re-init on late heartbeat; shared state | — | — | queued (bridge; mock vs SITL split) |
| 14 | Batch workers unbounded/uncancellable | worker per request, no queue/timeout | — | — | queued (batch) |
| 15 | Video loss counts fragments as frames | **reproduced**: 4-frag chunk → 4 drops (+ expiry double) | test/vidframes.test.js (4) | one lifecycle per frame: tombstone on first loss, stragglers discarded, expiry merges | **fixed** |
| 16 | Utilization double-bills airtime | **reproduced**: 1 s of air read as 0.4 of a 5 s window | test/netsched.test.js (1) | billed once at actual transmission, per channel; busiest-channel share reported | **fixed** |
| 17 | ACK-replayed coverage samples double-count | **reproduced**: weight 3→6 on replay; 32 B bill for 3 riding samples | test/covdedup.test.js (4) | per-vehicle seq dedup at C2 (restart-aware), duplicates still ACKed, sample rows billed on air | **fixed** |
| 18 | Disconnected nav reads live truth | black-box logged ~truth in GPS-denied | — | — | queued |
| 19 | Failed A* still assigns blocked routes | **reproduced**: 12 slots through a solid wall, relays ordered onto them | test/planfail.test.js (3) | no-route → empty slot list + explicit C2 error, straight-line fallbacks guarded | **fixed** |
| 20 | Adversary band filtering wrong representation | **reproduced**: in-band hunter moved 0.0 m; silent target tracked live | test/advband.test.js (3) | jammerFreqMHz normalizer everywhere; DF fixes measured once at emission, kept as taken; txAt=actual emission via scheduler rework | **fixed** |
| 21 | Video grants lack expiry | **reproduced**: 13 chunks streamed past expiry on heartbeats alone | test/vidgrant.test.js (3) | orders carry absolute videoUntil + grant id; onboard check uses the deadline, never link freshness | **fixed** |
| 22 | OSM reload loses saved geometry/seed | seed 7→45, drone at default spawn | — | — | queued |
| 23 | Calibrated presets not exported in scenario | reload in fresh page silently falls back | — | — | queued |
| 24 | Count slider double-inits bridge | **reproduced**: 2 init messages per change | test/external.test.js (1) | handler's duplicate call removed; resetSwarm's central sync is the one path | **fixed (mock-verified)** |
| 25 | External altitude datum undefined | **reproduced**: 120 m origin-relative read as 120 m AGL over hills | test/external.test.js (1) | contract defined: bridge alt = origin-relative (-NED.z); converted to AGL at the vehicle via ground-height delta | **fixed (mock-verified)** |
| 26 | TAK export labels AGL as HAE | altM=120, anchor 500 → hae=50.0 | — | — | queued |
| 27 | CoT regex truncates opposite quotes | O'Brien → "O" | — | — | queued |
| 28 | Browser dt=0.05 vs batch dt=0.25 | equal seeds diverge | — | — | queued |
| 29 | Battery swaps counted twice | **reproduced**: full land→swap→relaunch cycle counted 2 | test/swapcount.test.js (1) | counted at the completed relaunch transition, log-text sniffing removed | **fixed** |
| 30 | Batch validation permissive on types | count=1.5, seeds='bad' accepted | — | — | queued (batch) |
| 31 | Failed tiles never retry | cached failure until eviction | — | — | queued |
| 32 | City sliders bypass geometry/zero handling | origin-distance, seed 0→42 | — | — | queued |

Optimizations O1–O9: tracked after the 32 correctness findings; each will be
implemented against a measured benchmark, not marked done by adjacency.

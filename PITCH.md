# The million-dollar pitch — feature brief

**One-line pitch:** *"The only simulator that proves a drone swarm stays connected when distance, terrain, and jamming try to break it — calibrated to real radios, flying real autopilots, over real cities."*

**What the money buys (pick the buyer, not the feature):**
a license from a defense prime, a $1M-scale government/grant award, a white-label
deal with a mesh-radio vendor, or an acquisition by a drone-autonomy company.
Every feature below exists to make one of those four signatures defensible.

---

## Already built — the 60-second demo that opens the door

- **Comms-first distributed simulation** — three separate worlds (truth / C2's
  beliefs / each drone's beliefs) exchanging *real packets* with per-hop airtime,
  fading, retries. Kill a relay mid-chain and watch C2 notice seconds later,
  strike it off the roster, re-plan, and heal. Nobody else demos this honestly.
- **Real hardware radio physics** — SiK, RFD900x, LoRa EU868, Silvus/Doodle/
  Rajant-class MANET profiles; datasheet TX power, calibrated path-loss exponent,
  log-normal shadowing, 4/3-Earth radio horizon, shared-channel contention,
  regulatory duty cycle.
- **Self-healing relay mesh** — ETX routing, the tether rule (no drone outruns
  its link), the commitment rule (never accept a tasking you can't safely come
  home from), rescue drones chaining toward last-heard positions.
- **Interference / RF denial** — drag a jammer onto the map; the swarm paints the
  dead zone onto a learned coverage map and physically bends the chain around it.
- **Real places** — type any place on Earth, fetch actual OSM buildings, fly over
  real geography in 2D map view or hand-rolled 3D.
- **Bridge to reality** — the same C2 logic commands ArduPilot/PX4 SITL (or a
  mock) over a WebSocket→MAVLink bridge. The sim is already half a ground station.
- **Evidence artifacts** — JSONL packet capture ("tcpdump for the mesh"),
  Markdown after-action reports, reproducible seeded scenarios.

---

## Tier 1 — Deal-closers (verbatim funded-RFP language)

> **STATUS: BUILT ✅ — all six shipped and tested (see README "Tier-1
> capabilities"); commits land feature-by-feature with headless integration
> tests under `test/`.**

These phrases appear in real RFPs and grant calls worldwide. Each maps to one
buyer's checklist.

- **DDIL / contested-comms scenario pack** — packaged scenarios for Denied,
  Disrupted, Intermittent, Limited-bandwidth (DDIL) operations: GPS-denied +
  jammed + terrain-shadowed at once. *Why it sells:* it's the exact acronym on
  defense and DHS funding calls; a ready-made pack turns the demo into a
  procurement artifact.
- **Heterogeneous swarms** — mixed airframes *and* mixed radios in one mission:
  long-endurance relays carrying big radios + small expendable mission drones;
  C2 assigns roles by capability and energy budget. *Why it sells:* "orchestrate
  a heterogeneous autonomous swarm" is the phrase attached to Replicator-class
  programs; most competitors simulate homogeneous fleets.
- **GPS-denied navigation model** — position-estimate drift inside denied zones;
  drones act on *believed* positions while truth diverges; planner hedges relay
  placement accordingly. *Why it sells:* appears in essentially every autonomy
  RFP; cheap to build (drift term on the belief state) and instantly quotable.
- **Anti-jam spectrum agility (LPI/LPD)** — frequency-hopping radio presets,
  low-probability-of-intercept toggle, and quantified recovery: "frequency
  agility restored X% of chain throughput under Y dBm jamming." *Why it sells:*
  converts the interference demo from "it suffers honestly" into "we have
  countermeasures and numbers."
- **Payload/video backhaul constraint** — bandwidth-aware video streaming over
  the relay chain: hops consume chain capacity, C2 schedules who gets to send
  video now. *Why it sells:* customers buy *video*, not telemetry — this is the
  feature that makes the comms problem visceral to a general, not just an engineer.
- **Sim-to-real calibration loop** — ingest real MAVLink flight logs (tlog/ULOG),
  auto-fit the path-loss exponent per radio, emit a validation report
  (predicted vs measured margin/range). *Why it sells:* this single feature
  converts the tool from "plausible" to "validated" — the difference between a
  toy and the reference model in a contract. It is also Plan B Week 2, pulled
  forward in software-only form using any community flight logs.

## Tier 2 — Moat-deepeners (why they can't just copy it)

- **Red-team adversary mode** — an adaptive jammer AI that learns the swarm's
  routes and moves to exploit them; wargame connectivity before deployment.
- **ATAK / TAK integration** — export the live common operating picture (tracks,
  coverage heatmap, chain health) to ATAK; import real TAK markers as objectives.
  *Every* public-safety and defense buyer lives in ATAK.
- **Scale run** — 100+ nodes with published performance benchmarks; larger swarms
  are a stated gap in competitor tooling.
- **Batch Monte Carlo engine + REST API** — "run 500 seeded missions overnight,
  wake up to a confidence report": uptime distributions vs altitude/radio/fleet
  mix. Turns a browser toy into an enterprise evaluation harness (metered cloud
  service = recurring revenue).
- **Vertical mission library** — one-click templates: SAR grid search, wildfire
  overwatch, powerline/pipeline linear inspection, convoy escort, perimeter.
  Each template is a sales conversation starter for a different vertical.

## Tier 3 — Platform plays (product → company)

- **White-label radio vendor edition** — a vendor's radio as a first-class,
  datasheet-exact profile inside a branded sandbox; their sales engineers demo
  through your simulator. Distribution without hiring sales.
- **Hardware-in-the-loop bench kit** — package the existing bridge as the
  "fly-the-plan-before-you-fly-the-plan" step of a real deployment workflow.
- **Multi-operator distributed C2** — two ground stations, handover of a swarm
  mid-mission; matches joint/coalition operating concepts.
- **Audit-grade model card** — publish `MODEL.md`: every constant, its source,
  and its error bars. Procurement officers need something to defend; give them
  the document that survives a technical evaluation.

---

## Honest framing (put this in the deck, it builds trust)

- The demo + Tier 1 wins the meeting; the validation loop + a paid pilot study
  win the signature. Plans A/B in this repo already chart that path — this list
  is the engineering spine of Quarter 1–3 of Plan A.
- Nothing here requires hardware spend; everything ships software-only first.
- The moat is *honesty*: datasheet-anchored physics, packet-level causality, and
  published error bars. Lead with that; competitors lead with animations.

## Suggested build order (cheapest → most deal-value)

1. Heterogeneous swarms (extends existing role assignment in `js/swarm.js`)
2. GPS-denied drift (belief-state change, small)
3. DDIL scenario pack (content, uses existing features)
4. Video backhaul (bandwidth accounting in `js/net.js`)
5. Anti-jam hopping profiles (`js/radios.js`)
6. Calibration loop from flight logs (new module, biggest credibility jump)

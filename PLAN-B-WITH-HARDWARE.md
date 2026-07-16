# Plan B — the hardware path (once there is money)

**What this plan is.** The continuation of [Plan A](PLAN-A-SIMULATION-ONLY.md)
for **after money arrives** — a grant, a paid pilot, a licence deal, or an
investment (all of which the simulation-only work is designed to unlock). It
adds the one thing simulation can't give you: **proof that it works on real
drones, in the real world.** The software track from Plan A keeps running in
parallel; this document is the *hardware overlay* on top of it.

**The trigger.** Do **not** start this plan until you have secured funding.
The whole point of Plan A is to reach a fundable position *without* spending on
hardware. Concretely, start Plan B when you have **≥ ~$5,000 in hand
earmarked for hardware** (a small grant, a pilot contract, or savings you've
decided to invest), and ideally a **named first customer or partner** who
wants the real-world result (a SAR team, a wildfire/forestry agency, an
inspection company, a research lab, or a defense-adjacent integrator).

**The goal (from funded start, ~18–24 months).** Go from "it works in
simulation" to **"it flew, connected a real relay chain across real terrain
and interference, and delivered a real mission for a real customer"** — with
the data to prove it. That result is what turns grants into bigger grants,
pilots into contracts, and a demo into a company.

**Global, civilian-first, dual-use — same as Plan A.** The first real flights
should serve a peaceful, universal use-case (search-and-rescue over terrain,
wildfire overwatch, powerline inspection, conservation). We validate a
connectivity capability, not a weapon. Defense/contested-comms is the hardest
variant of the same problem and follows the same hardware, if and when you
choose it.

**How to read the schedule.** Phased, with weekly detail at the start of the
funded period, then monthly. Every block has **Goal**, **Tasks**, **Kit/Cost**,
and **Done-when**. Costs are realistic 2026 estimates and *ranges* — buy the
cheapest thing that proves the point first.

---

## Budget tiers (buy up only when the last tier is proven)

| Tier | What it buys | Rough cost | Proves |
|---|---|---|---|
| **T0 — Bench** | 2–3 telemetry/mesh radios, 2 companion computers (Raspberry Pi class), cables, one drone or ground rover | **$400–$1,500** | The bridge + C2 logic run on real radios and real compute, not just SITL |
| **T1 — Starter fleet** | 3 small drones (450-class DIY or RTF dev quads) + autopilots, radios, companions, batteries, field kit | **$3,000–$8,000** | A real 3-drone relay chain forms and holds a link outdoors |
| **T2 — Field pilot** | 5–8 drones, better antennas, one professional mesh radio pair to benchmark against, ruggedized ground station | **$15,000–$40,000** | A real mission in a real environment for a real customer |
| **T3 — Scale** | 10–20 drones, professional MANET radios (Doodle Labs / Silvus class), spares, transport, insurance | **$100,000+** | Repeatable deployments; a productized offering |

Start at T0. **Do not** jump to T2/T3 without a customer paying for that step.

---

## Phase 0 — Pre-flight (the week funding lands)

- **Goal:** convert money into the right first purchases and a safe, legal plan.
- **Tasks:**
  - Confirm the **regulations** for where you'll fly: register as a drone
    operator, get the basic remote-pilot certificate for your country, and
    identify legal flight areas (this varies by nation — do it first, it's
    often free or cheap and gates everything).
  - Order **T0 bench kit**: an SiK/RFD900-class telemetry radio pair, an
    ExpressLRS or LoRa module set, 2 Raspberry Pi (or similar) companion
    computers, a Pixhawk-class autopilot (or one dev drone that includes one),
    cables, SD cards, antennas.
  - Line up a **flight-safe test site** and, if possible, a partner/mentor in a
    local drone club for airframe help.
- **Kit/Cost:** T0, **$400–$1,500**.
- **Done-when:** legal to fly, bench kit ordered, test site identified.

---

## Phase 1 — Bench to first flight (Weeks 1–13 of funded period)

Theme: prove the *exact software you already built* runs on real radios and
real drones, one honest step at a time.

### Week 1 — Bridge on real radios
- **Goal:** the SITL bridge talks to a real autopilot over a real radio link.
- **Tasks:** Flash ArduPilot/PX4 on the autopilot. Connect it to a companion
  computer. Run your existing MAVLink bridge over the *real* telemetry radio
  (not UDP loopback). Confirm telemetry flows and you can send a goal.
- **Kit/Cost:** T0.
- **Done-when:** your sim's C2 commands a real (grounded) autopilot via a real
  radio.

### Week 2 — Measure the real link
- **Goal:** calibrate the simulator against reality.
- **Tasks:** Walk two radios apart and log RSSI vs distance. Compare to the
  sim's path-loss model for that radio. Tune the model's exponent to match your
  actual hardware/antennas. **This is the single most valuable early result** —
  it turns your sim from "plausible" into "validated against measured data."
- **Deliverable:** a measured-vs-modeled RSSI chart (great for grants/papers).
- **Done-when:** the sim's predicted range matches your field measurement
  within a stated error.

### Weeks 3–4 — One drone, autonomous hop
- **Goal:** first real flight under your C2 logic.
- **Tasks:** Get one drone flying in GUIDED mode taking position goals from
  your bridge. Fly a simple out-and-back. Log the link margin along the path
  and compare to the sim's prediction for that terrain.
- **Kit/Cost:** T1 (buy the first drone if T0 didn't include one).
- **Done-when:** one drone flies your commanded mission and the link data
  matches the sim.

### Weeks 5–8 — Two drones, a real relay
- **Goal:** the core thesis, in the air: one drone relays for another.
- **Tasks:** Add a second drone. Fly the mission drone beyond direct radio
  range of the ground station, with the second drone positioned as a relay.
  Show telemetry from the far drone arriving *through* the relay. Kill the
  relay's link (power its radio down) and show the failsafe behave as the sim
  predicted.
- **Kit/Cost:** T1.
- **Done-when:** a **real two-hop relay link** carries a command to a drone
  that couldn't be reached directly. (This clip alone is worth a grant.)

### Weeks 9–12 — Three drones, self-forming chain
- **Goal:** an autonomous relay chain, outdoors, unscripted.
- **Tasks:** Three drones; the C2 logic elects relays and forms the chain on
  its own as the mission drone flies out. Add a real terrain obstacle (fly in a
  valley / behind a hill) and show the chain adapt. Record everything.
- **Kit/Cost:** T1.
- **Done-when:** a 3-drone chain **self-forms and self-heals in real flight**,
  matching the simulator's behaviour.

### Week 13 — Validation write-up
- **Goal:** turn flights into evidence.
- **Tasks:** Write a validation report: sim prediction vs field result for
  range, relay formation, and failsafe. Update the model card. Publish a
  flight-test video. Send it to your grant officer / first customer / the
  university partner.
- **Deliverable:** a sim-vs-real validation report + flight video.
- **Done-when:** you can prove, with data, that the simulation predicts reality.

**Phase 1 done-when:** a real, self-forming 3-drone relay chain, validated
against the simulator. **Cumulative hardware spend: ~$3k–$8k (T1).**

---

## Phase 2 — First real-world pilot (Months 4–9)

Theme: a real mission, in a real environment, for a real (civilian) customer.

- **Month 4 — Pick the pilot & scenario.** With your first customer/partner
  (SAR team, forestry/wildfire agency, inspection firm, or research group),
  define a concrete pilot: e.g. *"search a 2 km stretch of valley where
  handheld radio drops out, keeping live video/telemetry back to the command
  post via the relay chain."* Model it in the sim first (free), then plan the
  real flight.
- **Month 5 — Add interference & GPS-denied reality.** Introduce a real
  degraded-comms element safely and legally (fly in genuinely RF-difficult
  terrain, or use the customer's own environment). Show the swarm map the dead
  zone and route around it — the same behaviour as the sim's interference
  feature, now real.
- **Month 6 — Companion-onboard C2.** Move the C2 / relay logic onto the
  companion computers so the swarm coordinates with reduced dependence on the
  ground station — a resilience story customers care about.
- **Months 7–8 — Run the pilot.** Execute the real mission with the customer
  present. Capture the after-action data. Iterate. Get a **testimonial or
  letter of results** — this is worth more than any spec sheet.
- **Month 9 — Scale the fleet if justified.** If the pilot proved value, move
  to **T2**: 5–8 drones, better antennas, and *one* professional mesh-radio
  pair so you can benchmark hobby vs pro hardware in your own sim and in the
  air.
- **Kit/Cost:** T1 → **T2 ($15k–$40k)** only after a successful pilot.
- **Phase 2 done-when:** one **completed real-world pilot** with documented
  results and a reference customer.

---

## Phase 3 — Repeatable capability (Months 10–18)

- **Months 10–12 — Productize the deployment.** Turn the pilot into a
  repeatable package: a field kit, a setup checklist, the C2 software, and the
  after-action reporting (reuse the sim's report generator). Aim for a
  deployment a non-expert operator can run.
- **Months 13–15 — Second and third pilots.** Different customers, different
  verticals (e.g. add wildfire overwatch or powerline inspection to the SAR
  reference). Each pilot is priced (T2-funded by the customer, not you). Publish
  a second validation paper with multi-environment data.
- **Months 16–18 — Bigger funding on proof.** With real deployments in hand,
  go for the large awards / contracts / round that were out of reach at the
  demo stage: a major grant (single awards at this tier reach **$1M+**), a
  multi-unit licence, or a seed/Series-A raise. The flight-validated data is
  what unlocks the tier of money that pays for **T3 scale**.
- **Phase 3 done-when:** ≥ 2–3 paid pilots, a repeatable product, a validation
  paper, and a large funding event or contract in progress.

---

## Year 2 (Months 19–24) — Scale or specialize

Re-plan quarterly from real results. The realistic seven-figure outcomes:

- **Deployed-capability business** — sell the field kit + software + support to
  public-safety, forestry, inspection, and infrastructure operators worldwide.
  Recurring service + licence revenue.
- **Government / defense variant** — if you choose it, the same validated
  hardware and software address contested-comms programs; a single Phase-II-
  scale award or contract reaches $1M+.
- **Acquisition / partnership** — a drone-autonomy company, mesh-radio vendor,
  or systems integrator acquires or licenses the validated capability rather
  than build it.
- **T3 scale** — with big funding, 10–20+ drones and professional MANET radios
  for large, repeatable, multi-drone deployments.

**Year-2 done-when:** a flight-validated product with paying deployments and a
seven-figure funding or acquisition path — built on the proof that the
simulation was right all along.

---

## Full hardware bill of materials (reference)

**T0 — Bench (~$400–$1,500)**
- SiK/RFD900-class telemetry radio pair — ~$40–$200
- ExpressLRS + LoRa module set — ~$60
- 2× companion computer (Raspberry Pi 5 class) — ~$160
- Pixhawk-class autopilot — ~$150–$300 (or bundled in a dev drone)
- Cables, antennas, SD cards, bench PSU — ~$100
- (Optional) 1 dev drone or ground rover to carry a radio — ~$300–$700

**T1 — Starter fleet (~$3,000–$8,000)**
- 3× 450-class drones (DIY kit: frame, motors, ESC, props, autopilot) or RTF
  dev quads — ~$400–$1,200 each
- 3× companion computers + radios (from T0 line, ×3) — ~$500
- Batteries (×2–3 per drone) + chargers — ~$600
- Field kit: cases, spares, tools, first-aid, hi-vis, tablet ground station —
  ~$500
- Insurance (liability) — varies by country, budget ~$300+/yr

**T2 — Field pilot (~$15,000–$40,000)**
- 5–8 drones (better airframes, longer endurance) — the bulk
- High-gain / directional antennas — ~$500–$2,000
- 1× professional mesh-radio pair (Doodle Labs class) to benchmark — ~$2,000–$5,000
- Ruggedized ground station + telemetry mast — ~$1,500

**T3 — Scale ($100,000+)**
- 10–20+ production-grade drones
- Professional MANET radios (Silvus/Doodle Labs class) per node — ~$1,500–$8,000 each
- Spares, transport, insurance, and (if productizing) light manufacturing/assembly

---

## Safety, legal, and ethics (non-negotiable)

- **Fly legal.** Register, certify, and respect airspace rules in every
  jurisdiction. This is the fastest way to lose everything if ignored.
- **Fly safe.** Ranges, checklists, geofences, observers, insurance. Real
  drones can hurt people and property.
- **Stay civilian-first.** Lead with disaster-response, safety, and
  infrastructure use-cases. If you ever engage defense customers, keep it to
  the same *connectivity/resilience* capability, follow export-control law, and
  make deliberate, documented choices about what you will and won't build.

## KPIs (hardware track)

- Sim-vs-real error (range, margin) — the validation metric.
- Successful autonomous relay flights; max hops flown.
- Pilots completed; reference customers; testimonials.
- Hardware spend vs milestones (never buy a tier you haven't earned).
- Post-pilot funding events / contracts.

## Honest risks

- **Hardware eats time and money** — everything takes longer and costs more
  than the sim suggests; keep the software track (Plan A) as your cheap,
  fast-moving core.
- **Weather, crashes, and regulations** will delay flights — build slack in.
- **Don't over-buy** — the discipline of "prove the tier before funding the
  next" is what keeps this from becoming an expensive hobby instead of a
  business.
- **The sim is your unfair advantage** — every hardware decision should be
  modeled first (free) and only then flown (expensive). That loop is the whole
  reason Plan A comes first.

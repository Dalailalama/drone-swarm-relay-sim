# Plan A — the simulation-only path (no money, just a laptop)

**What this plan is.** A week-by-week, two-year roadmap to grow this project
from an open-source demo into a fundable, revenue-earning simulation product
— using **only a computer**. No drones, no radios, no hardware spend. Every
task here can be done with CPU (and optionally GPU) simulation, writing,
research, and outreach. This is the plan you can start **today, for free**,
and the one you pitch as *"the capability already exists in simulation — we
just need resources to take it to hardware"* (that hardware step is
[Plan B](PLAN-B-WITH-HARDWARE.md)).

**The goal (24 months).** Reach a position where the project has: a real user
base, at least one peer-reviewed or published validation study, a hosted
paid tier and/or paid simulation studies, **one or more non-dilutive grants
awarded**, and a credible case to either raise money or land a first pilot —
i.e. the door to Plan B is open and funded.

**The problem we solve (say this the same way every time).** *Keeping a team
of drones connected to their operator when there is no communications
infrastructure and the environment — distance, terrain, interference — keeps
breaking the link, by turning the drones themselves into a self-healing relay
mesh.* This is a **global, civilian-first, dual-use** problem: disaster
response and search-and-rescue, wildfire and infrastructure monitoring, long
linear inspection (power lines, pipelines, rail, coast), conservation, mining
and ports, and — the hardest version — degraded/contested comms. We are not
building a weapon; we are solving connectivity where connectivity is hardest.

**How to read the schedule.** Weekly detail for the first quarter (where
precision matters most), then monthly through the first year, then quarterly
in year two (you cannot honestly plan week 87 today — you plan the direction
and re-plan each quarter). Every block has a **Goal**, **Tasks**,
**Deliverable**, and **Done-when** metric. Assume ~10–20 focused hours/week;
compress if you have more.

**Total cash cost of this entire plan: ~$0–$300** (an optional domain name and
a few dollars of cloud hosting later). Everything else is time.

---

## Quarter 1 — Make it undeniable (Weeks 1–13)

Theme: turn a good demo into a *credible, cited, discoverable* tool, and start
the (free) funding machine.

### Week 1 — The money-shot demo
- **Goal:** one 30–60s video that makes the value obvious in 10 seconds.
- **Tasks:** Build a "contested/denied-comms" scenario in the sim (drop an
  interference source between base and target; watch the coverage map bloom
  red and the swarm route around / hold its frontier). Record it. Also record
  a "search-and-rescue over mountains" scenario (terrain blocks radio, relays
  bridge the valley). Save both as shareable scenario `.json` files (Scenario
  → Save).
- **Deliverable:** 2 short screen-recordings + 2 scenario files committed to
  the repo under `scenarios/`.
- **Done-when:** a stranger watching the video understands the problem and the
  solution without narration.

### Week 2 — Landing page & positioning
- **Goal:** a one-line identity and a page that isn't just a GitHub readme.
- **Tasks:** Register a domain (~$10/yr, optional). Put up a one-page site
  (GitHub Pages, free) with the tagline *"Design and stress-test how a drone
  swarm stays connected — before you buy a single drone,"* the money-shot
  video, the live demo link, and the 6 civilian use-cases from the README.
  Write the project's one-paragraph "elevator" and pin it everywhere.
- **Deliverable:** live landing page; a crisp elevator paragraph.
- **Done-when:** you can send one URL to anyone and they "get it."

### Week 3 — Documentation & credibility
- **Goal:** make the model trustworthy to an engineer who's skeptical.
- **Tasks:** Write a `MODEL.md` that states plainly what each number means,
  what is calibrated vs derived (the path-loss exponent fit, the fade margin,
  the ETX cost, the interference floor model), and the known limitations.
  Add the datasheet source links for every radio (already partly done). This
  honesty is what makes defense/academic users trust the rest.
- **Deliverable:** `MODEL.md` (model card).
- **Done-when:** a comms engineer could audit your assumptions from one file.

### Week 4 — First public launch
- **Goal:** first wave of real users and feedback.
- **Tasks:** Write a launch post (blog + Hacker News "Show HN" + relevant
  subreddits: r/diydrones, r/UAVmapping, r/amateurradio, r/robotics). Post the
  video to LinkedIn and X. Submit to the ArduPilot / PX4 community forums as
  *"a comms-first swarm simulator that bridges to SITL."* Ask explicitly for
  feedback and use-cases.
- **Deliverable:** launch posts live; a feedback issue open on GitHub.
- **Done-when:** ≥ 200 unique visitors and ≥ 5 substantive pieces of feedback.

### Week 5 — Heterogeneous swarms (feature)
- **Goal:** support mixed drone/radio types — the thing Replicator failed on.
- **Tasks:** Let a mission mix airframes and radios (e.g. long-endurance relay
  drones carrying a big radio + small mission drones). Add a second radio
  class per swarm. This is the single most defensible technical feature for
  the "orchestrate a heterogeneous swarm" narrative.
- **Deliverable:** heterogeneous swarm support + a demo scenario.
- **Done-when:** a scenario with 2 drone types and 2 radios forms a chain.

### Week 6 — GPS-denied navigation (feature)
- **Goal:** cover a verbatim funded-requirement phrase.
- **Tasks:** Model position drift when GPS is denied in an area (tie it to the
  interference source, or a separate "GPS-denied zone"). Drones' *believed*
  position diverges from truth; show how that degrades relay placement and how
  the swarm copes. This directly maps to grant/RFP language worldwide.
- **Deliverable:** GPS-denied zone feature + scenario.
- **Done-when:** a drone in the denied zone shows position uncertainty and the
  planner accounts for it.

### Week 7 — First research scan & grant longlist
- **Goal:** know exactly which free money exists, globally.
- **Tasks:** Build a spreadsheet of **non-dilutive** funding you're eligible
  for. Cast wide and global, not US-military-only: national research councils
  and innovation agencies (e.g. Horizon Europe / EIC in the EU, national SBIR
  equivalents, disaster-management and public-safety grants, wildfire/forestry
  agencies, conservation tech funds, university research partnerships, cloud
  credits for startups, and — where applicable — defense innovation open
  topics as *one* of many). Note each program's deadline, amount, eligibility,
  and fit.
- **Deliverable:** a funding pipeline spreadsheet with ≥ 15 targets.
- **Done-when:** at least 3 have deadlines in the next 6 months and clear fit.

### Week 8 — Academic outreach
- **Goal:** find a university lab collaborator (credibility + co-authorship +
  grant eligibility).
- **Tasks:** Identify 10 labs worldwide working on UAV networks / FANET /
  disaster robotics / mesh comms. Email each a tight note: *"I built an
  open-source, browser-based comms-first swarm simulator that bridges to real
  PX4/ArduPilot firmware — would your group find it useful for teaching or
  research? Happy to add features you need."* Offer the tool free.
- **Deliverable:** 10 personalized emails sent.
- **Done-when:** ≥ 1 lab replies with interest.

### Week 9 — Reproducible study #1
- **Goal:** produce a *result*, not just a tool — the seed of a paper.
- **Tasks:** Run a systematic simulation study you can write up: e.g. *"How
  many relay drones does it take to hold a link across N km of mountainous
  terrain, as a function of radio class and interference?"* Sweep parameters,
  collect the after-action reports, make charts. This is pure CPU work.
- **Deliverable:** a data set + charts + a short writeup (`studies/relay-scaling.md`).
- **Done-when:** you have a defensible, quotable finding with a graph.

### Week 10 — Hosted demo hardening + analytics
- **Goal:** understand and serve your users.
- **Tasks:** Add lightweight privacy-respecting analytics to the live demo
  (page views, which scenarios get loaded). Fix the top 3 usability issues
  from launch feedback. Make scenario sharing via URL work (encode scenario in
  the link) so users can send each other setups.
- **Deliverable:** shareable-scenario URLs + basic analytics.
- **Done-when:** you can see which use-cases resonate.

### Week 11 — Content engine #1
- **Goal:** become the reference for "swarm comms" so people find you.
- **Tasks:** Write the first deep technical blog post from your study
  (Week 9). Title for search: *"How drone swarms stay connected when the radio
  link keeps breaking."* Explain the tether rule, ETX routing, coverage
  learning. Link the live demo throughout. Cross-post to dev.to / Medium.
- **Deliverable:** one substantial, SEO-aware technical article.
- **Done-when:** it's live and shared; aim for steady organic traffic.

### Week 12 — First grant application
- **Goal:** submit, don't just plan.
- **Tasks:** Pick the best-fit near-deadline grant from Week 7. Write it. Lean
  on the civilian/dual-use framing (disaster response / public-safety
  connectivity), the open-source credibility, the live demo as your
  feasibility proof, and your Week 9 study as evidence. Get the university
  contact (Week 8) to co-sign or letter-of-support if possible.
- **Deliverable:** one complete grant submission.
- **Done-when:** submitted with confirmation.

### Week 13 — Quarter review & consolidate
- **Goal:** measure, tidy, decide Q2 priorities.
- **Tasks:** Tally: GitHub stars, demo visitors, feedback, lab contacts, grant
  submitted. Tag a `v1.0` release. Clean the issue tracker. Write a short
  "state of the project" post. Decide Q2 feature focus based on what users and
  grant reviewers actually asked for.
- **Deliverable:** `v1.0` tagged release + quarter recap.
- **Done-when:** you have honest numbers and a Q2 plan.

**Quarter 1 done-when:** live landing page + model card; heterogeneous swarms
and GPS-denied features shipped; ≥ 1 university contact; 1 study; 1 grant
submitted; a growing user base. **Cost so far: ~$10 (domain).**

---

## Quarter 2 — Depth, proof, and the first dollar (Months 4–6)

Weekly cadence relaxes to ~2-week sprints. Theme: turn credibility into a
publishable result and the first revenue, still all in software.

### Month 4 — Spectrum-agility + LPI features; study #2
- Add frequency-hopping / spectrum-agile link modelling and a
  low-probability-of-intercept toggle (these phrases appear in funded RFPs
  worldwide). Run study #2: *"How much does frequency-agility recover a swarm's
  connectivity under interference?"* Chart it.
- **Deliverable:** spectrum-agility feature + study #2 writeup.
- **Done-when:** a quantified before/after result you can publish.

### Month 5 — Write the paper / whitepaper
- Combine studies #1–#2 into a workshop-paper or a serious whitepaper:
  *"A communications-first simulation framework for resilient drone-swarm
  command-and-control."* Submit to an open-access venue or arXiv, and/or a
  relevant workshop (UAV networks, disaster robotics, comms). Co-author with
  the university contact if you have one.
- **Deliverable:** a paper/whitepaper submitted or on arXiv.
- **Done-when:** it has a citable URL.

### Month 6 — Hosted "Pro" MVP (first revenue path)
- Stand up a hosted tier on free/cheap cloud (a static host + a small server
  for the SITL bridge is enough). Gate paid features behind a simple license:
  saving unlimited scenarios, batch parameter sweeps in the cloud, PDF
  after-action reports, priority support. Price it low to start
  (e.g. $19–$49/mo individual, custom for teams). Add a "Sponsor / support"
  button and a GitHub Sponsors page.
- **Deliverable:** a hosted Pro tier + a way to pay you.
- **Done-when:** the checkout works end-to-end (even before the first sale).

**Quarter 2 done-when:** a published paper/whitepaper; spectrum-agility + LPI
features; a working paid tier; grant #1 decision pending or in; ≥ 2 studies.
**Cost so far: ~$10–$60** (domain + minimal hosting).

---

## Quarter 3 — First revenue & partnerships (Months 7–9)

- **Month 7 — Simulation-study-as-a-service.** Offer paid, bespoke simulation
  studies: an org tells you their scenario (region, terrain, radios, mission),
  you run it and deliver an after-action report + recommendations. First
  targets: SAR teams, wildfire agencies, drone-service companies, university
  labs, and mesh-radio vendors who want a sandbox for their hardware. Price
  $2k–$10k per study. **This is your fastest real revenue** and needs only
  your laptop.
- **Month 8 — Vendor partnership.** Approach mesh-radio makers (Doodle Labs,
  Rajant, etc.) and drone-autonomy companies: offer to add their radio's exact
  link-budget as a first-class profile so their customers can prototype
  against it. This is credibility + a distribution channel + a potential
  sponsor/licensee.
- **Month 9 — Grant #2 + community.** Submit a second grant using your now-real
  traction (paper, users, first revenue). Grow the open-source community: label
  "good first issues," recruit contributors, publish a public roadmap.
- **Quarter 3 done-when:** first paid study or Pro subscriptions; ≥ 1 vendor or
  lab partnership; grant #2 submitted; ≥ 1 external contributor.

---

## Quarter 4 — Consolidate to a fundable position (Months 10–12)

- **Month 10 — Category authorship.** Publish a definitive piece: *"The comms-
  first approach to drone-swarm resilience"* — establish the vocabulary
  (tether rule, learned RF coverage, relay-mesh C2) as *yours*. Talk at a
  meetup or virtual conference.
- **Month 11 — Decision & data room.** Assemble a one-page pitch + a data room
  (metrics, users, paper, revenue, grants, letters of support). Decide the
  Year-2 path: **(a)** stay bootstrapped on grants + Pro + studies; **(b)**
  pursue a bigger grant / accelerator that funds hardware (→ Plan B); or **(c)**
  raise a small pre-seed on the strength of the demo + traction.
- **Month 12 — First-year close.** Ship a `v2.0`. Publish an annual recap with
  real numbers. Bank at least one grant award or a few thousand dollars of
  study/subscription revenue.
- **Year-1 done-when:** the project has users, a paper, revenue, and at least
  one funding decision in hand — a credible base to either keep bootstrapping
  or open Plan B. **Cumulative cash cost: still only ~$100–$300.**

---

## Year 2 — Scale the software business (Quarters 5–8)

Plan quarter-by-quarter; re-plan each quarter from real data. Direction:

- **Q5 (Months 13–15) — Deepen the moat.** Ship the features that only you
  have: a scenario library for each vertical (SAR, wildfire, inspection,
  contested), multi-operator views, larger swarms (100+), and a proper
  cloud batch-simulation service (usage-metered — SITL-hours / node-count).
  Target: recurring revenue crosses a few thousand $/month.
- **Q6 (Months 16–18) — Land anchor customers.** Convert study clients and
  partners into ongoing licenses. Aim for 2–3 organizations paying annually
  (public-safety agency, drone-services firm, or a defense-adjacent integrator
  using it as an eval harness). Apply for the largest grant you're eligible
  for globally.
- **Q7 (Months 19–21) — Team or partner.** Bring on a co-founder or first hire
  (fundable from grant/revenue), or formalize a partnership with a vendor/lab.
  Publish paper #2 with real study depth. Establish the tool as teaching
  material in ≥ 1 university course.
- **Q8 (Months 22–24) — The million-dollar decision.** By now the realistic
  paths to seven figures are visible and you pick one: a **major grant /
  Phase-II-scale award** (single awards at this tier reach $1M+), a **seed
  round** on the traction, an **enterprise/government license deal**, or an
  **acqui-hire / asset sale** to a prime or integrator who needs exactly this
  capability. All of them are opened by the software-only work in this plan.

**Year-2 done-when:** recurring revenue + at least one large funding event or
serious acquisition/partnership conversation — i.e. a genuine seven-figure
trajectory, reached without ever buying a drone.

---

## The funding ladder (all achievable software-only)

1. **Cloud/startup credits** — free compute (weeks).
2. **GitHub Sponsors / donations** — small, immediate (Q1+).
3. **Paid simulation studies** — $2k–$10k each, fastest real cash (Q3+).
4. **Hosted Pro subscriptions** — recurring (Q2+).
5. **Non-dilutive grants** — national research/innovation agencies, disaster
   & public-safety funds, EU/Horizon-type programs, conservation-tech funds,
   and defense innovation *open topics* as one option among many. Ranges from
   a few thousand to $1M+ at the top tiers (Q1 submit → awards land months
   later).
6. **Enterprise/government license or pilot** — the bridge to Plan B (Year 2).
7. **Seed round or acquisition** — the exit ramp (Year 2).

## KPIs to track from day one

- GitHub stars & forks; live-demo unique visitors; scenarios shared.
- University/lab contacts; external contributors.
- Studies published; papers/citations.
- Grants submitted → awarded; $ non-dilutive raised.
- Pro subscribers; paid studies; MRR.

## Honest risks

- **Grants are slow and competitive** — submit many, expect a low hit rate,
  don't stake everything on one.
- **Open-source ≠ automatic revenue** — you must actively build the paid tier
  and sell studies; the free tool is the funnel, not the business.
- **Simulation credibility has limits** — buyers will eventually ask for
  hardware validation; that's the honest boundary where Plan B begins, and why
  the model-card honesty (Week 3) matters so much.
- **Solo-founder bandwidth** — this plan assumes steady weekly hours; protect
  the schedule or it slips a quarter.

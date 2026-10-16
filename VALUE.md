# What this project is worth, and what would change that

Facts only. This replaces the aspirational "million-dollar pitch" framing
with what the October 2026 research actually supports. Every figure comes
from the raw notes in
[docs/research/market-and-funding-2026-10.md](docs/research/market-and-funding-2026-10.md),
each with its source URL. Re-check a source before quoting it.

## Bottom line

**No fact supports a USD 1M valuation today.** The software is substantial:
a packet-level relay-mesh sim, datasheet-anchored radios, terrain and OSM
cities, a MAVLink SITL bridge, CoT export, a Monte Carlo API, and hundreds
of regression tests. But valuations and $1M-scale awards in this space go to
teams with validation evidence, users and contract vehicles. As of 9 Oct
2026 the repo had 3 GitHub stars, 0 forks and 1 contributor. It has no
legal entity, no field-measured dataset, no publication and no named users.
Each of those is fixable.

## The defensible claim (and the ones to drop)

- **Defensible:** one zero-install, MIT-licensed tool that combines four
  things: closed-loop swarm C2 that places, tethers and heals relays;
  packet-level mesh simulation (airtime, contention, ETX); RF calibrated to
  datasheet ranges; and a MAVLink bridge to ArduPilot SITL. No single public
  tool found does all four.
- **Not defensible:** "the only simulator…" and "nobody else demos this".
  Each layer has a higher-fidelity incumbent:
  - **Protocol fidelity:** ns-3, EMANE/CORE, Keysight EXata/JNE.
  - **Propagation fidelity:** Remcom Wireless InSite, MATLAB siteviewer,
    NVIDIA Sionna RT (free, Apache-2.0).
  - **MANET/ATAK planning:** CloudRF SOOTHSAYER (from £40/month, with a
    TAK-signed ATAK plugin), ATDI HTZ Warfare.
  - **Same RF model family, free:** Gazebo's RFComms plugin uses the same
    log-distance + log-normal family.

## Value anchors (what money in this space has looked like)

| Event | Figure | What it was paying for |
|---|---|---|
| Motorola Solutions acquires Silvus (2025) | $4.4B up-front | MANET radio revenue, military customers |
| Ansys acquires AGI/STK (2020) | $700M | Mission-engineering software with a large installed base |
| Auterion Series B | $130M | Commercial PX4 with fleet customers |
| Foxglove Series B (Nov 2025) | $40M | Robotics tooling with named enterprise users |

All of these had revenue or paying users first. None was a pre-user repo.

## Realistic $1M-scale routes, and their gates

| Route | Amount | Hard gate |
|---|---|---|
| US NSF SBIR (NSF 26-510) | Phase I ≤ $305k, Phase II ≤ $1.25M | US small business, ≥51% owned by US citizens or permanent residents |
| EU EIC Accelerator | grant ≤ €2.5M | EU/associated-country entity; TRL 5+ already shown |
| NATO DIANA | €100k (+ ≤ €300k Mission Track) | Incorporated and majority-owned in a NATO nation |
| India iDEX SPARK → procurement | ≤ Rs 1.5 crore | DPIIT-recognized startup or MSME; challenge problem-statement fit |
| India iDEX ADITI | ≤ Rs 25 crore | Applicant co-funds ≥ 50% |
| Paid pilot studies / open-core SaaS | market-set | Users who trust the model, which needs validation data |

## The evidence that moves the number (in order)

1. **Field validation.** One real RSSI-vs-distance dataset per radio, run
   through the built-in calibration loop (`js/calibrate.js`), with the
   residuals report committed. This is the single biggest credibility jump.
   EIC, DIANA and UK calls score TRL 5-7, and SITL is not "relevant
   environment".
2. **Recorded multi-vehicle SITL flight.** Commit the acceptance report and
   a capture from a real ArduPilot `--count N` run, not only the mock.
3. **Source every anti-jam number.** The hopping gains and the LPI 3 dB / 6 dB
   trade need datasheet or test citations, as the radio presets already have.
4. **A tagged v1.0 release, CITATION.cff and an arXiv preprint.** Funded
   simulators of this kind carry 180-2,000+ citations. A reproducible batch
   study is the paper.
5. **Users.** A Show HN / ArduPilot-forum launch, university-lab outreach,
   and 2-3 letters of intent or pilot users.
6. **An entity.** Every program above $100k requires one, in a jurisdiction
   that matches the program.

Until items 1, 2 and 5 exist, describe this as a strong open-source
prototype. That is accurate, and accuracy is what gets it trusted.

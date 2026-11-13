# Contributing

Thanks for the interest! This project deliberately has **zero dependencies
and no build step** — plain JavaScript, plain canvas, servable from any
static file server. Please keep it that way in PRs.

## The easiest and most valuable PR: add a radio

Radio presets live in [js/radios.js](js/radios.js) as plain data:

```js
{
  id: 'my-radio',
  name: 'Vendor Model (band)',
  freqMHz: 915,
  txDbm: 20,          // transmit power
  sensDbm: -110,      // receiver sensitivity at the air rate below
  antGainDbi: 2,      // stock antenna, per end
  airRateKbps: 64,
  rangeLosM: 1000,    // vendor-rated or reproducibly field-tested LOS range
  dutyCycle: 0.1,     // optional: legal duty limit, omit if none
  hopGainDb: 12,      // optional: FHSS / anti-jam rejection, omit for fixed-channel radios
  note: 'One sentence of practical character.',
  source: 'https://link-to-datasheet',
}
```

Rules:

- **`source` is mandatory** — a datasheet or a reproducible field test.
  `rangeLosM` is the calibration anchor for the whole path-loss model, so
  it has to be defensible. Add a row to [RADIOS.md](RADIOS.md) with any
  judgment calls you made.
- Sensitivity must correspond to the quoted air rate (they trade off).

## Everything else

- **Physics changes** need a unit test in `test/` pinning the new behavior.
  Run the suite with `npm test` (Node 22+).
- **Simulation logic** (planner, failsafes, network): keep the separation of
  knowledge honest. C2 code may only read `s.c2.*` (its beliefs); drone code
  may only read its own fields; only physics reads truth. If your feature
  needs a node to know something, send it a packet.
- **Determinism**: never call `Math.random()` in simulation code — use the
  seeded RNG (`s.net.rng` / `gaussian(s.net.rng)`). Same seed must produce a
  bit-identical run; `test/hygiene.test.js` fails on any `Math.random` call
  in `js/`, and reviewers will check.
- UI copy: sentence case, terse, no exclamation marks.

## Running locally

```
python -m http.server 8000   # or any static server
npm test                     # JS suite: node --test "test/*.test.js"
```

## Before you open a PR

These are the commands CI runs (`.github/workflows/ci.yml`); run the ones
your change touches.

```
npm test                                         # JS suite (Node 22+)
git diff --check main...HEAD                     # no trailing whitespace

pip install -r sitl/requirements.txt             # websockets, pymavlink
python -B sitl/test_bridge.py                    # bridge scenarios
python -B sitl/test_mock_vehicles.py             # executable mock (needs websockets)
python -B sitl/test_protocol_conformance.py      # wire protocol
python -B sitl/test_failure_scenarios.py         # failure scenarios
python -B sitl/test_tak_bridge.py                # TAK bridge (needs websockets)
python -B sitl/run_acceptance.py --mode mock --logs-dir out/acc --report out/acc/report.json
```

Changes under `sitl/` need the Python suites green (Python 3.11 or 3.12);
`test_bridge.py`, the conformance suite and the failure scenarios run with
nothing installed, the mock and TAK bridge suites and the acceptance run need
`websockets`.

One optional check is not in the default suites: `test/test_integration_mock.py`
drives the real page in headless Chromium against the mock (connect, land,
battery swap, relaunch). It needs Playwright and a browser download, so it
runs on demand only, locally or in CI (Actions, "Browser E2E (opt-in)", Run
workflow; see `.github/workflows/e2e.yml`, which uploads the trace and
screenshots from `test-results/`):

```
pip install -r test/requirements-e2e.txt         # playwright, websockets
python -m playwright install chromium
python -B test/test_integration_mock.py
```

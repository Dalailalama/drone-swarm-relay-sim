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
  Run the suite with `node --test` (Node 20+).
- **Simulation logic** (planner, failsafes, network): keep the separation of
  knowledge honest. C2 code may only read `s.c2.*` (its beliefs); drone code
  may only read its own fields; only physics reads truth. If your feature
  needs a node to know something, send it a packet.
- **Determinism**: never call `Math.random()` in simulation code — use the
  seeded RNG (`s.net.rng` / `gaussian(s.net.rng)`). Same seed must produce a
  bit-identical run; there's a test for this in spirit and reviewers will
  check.
- UI copy: sentence case, terse, no exclamation marks.

## Running locally

```
python -m http.server 8000   # or any static server
node --test                  # physics tests
```

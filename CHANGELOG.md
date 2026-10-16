# Changelog

Notable changes, newest first. The project has no tagged release yet; when
one is cut, its version and date go in a heading here and in
`CITATION.cff`. Per-finding detail (evidence, regression test, commit) for
the review and audit work lives in [REVIEW-FIXES.md](REVIEW-FIXES.md).

## Unreleased

### Developer experience and CI

- CI whitespace check works on pull requests and fails on push, covering the
  whole push.
- CI tests Node 22.x and 24.x (Node 20 is end-of-life); actions moved to
  their node24 majors and Dependabot keeps them current.
- `package.json` adds a zero-dependency `npm test` (runs exactly
  `test/*.test.js`), `npm run bench` and the Node >= 22 floor.
- CI uploads the mock acceptance report and logs when the Python job fails
  (`run_acceptance.py --logs-dir`), and the workflow token is read-only.
- The GPS-denied tests and a new determinism guard (no `Math.random` in
  `js/`) assert what they claim.
- Added CONTRIBUTING pre-PR commands, `CITATION.cff`, this changelog and
  `SECURITY.md`; `out/` and local venvs are ignored.

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

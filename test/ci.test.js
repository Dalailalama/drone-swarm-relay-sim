// CI / repo-hygiene audit findings (devex-tests-ci). The workflow is plain
// YAML, so these are static checks on its text: they pin what CI actually
// runs, so a regression shows up locally instead of as a silently green job.
//  ci-whitespace-pr-path-broken: on pull_request the job diffed against
//      origin/<base>, which actions/checkout never fetches (exit 128); on push
//      it diffed only the last commit and swallowed the result with `|| true`.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CI = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');

// The YAML block of one job (from its key to the next top-level job key).
function job(name) {
  const m = CI.match(new RegExp('\\n  ' + name + ':\\n([\\s\\S]*?)(?=\\n  [\\w-]+:\\n|$)'));
  assert.ok(m, 'ci.yml has no job ' + name);
  return m[1];
}

test('whitespace job: PRs diff against the merge commit’s base parent, pushes can fail', () => {
  const ws = job('whitespace-and-lint');
  assert.ok(!/origin\/\$\{\{\s*github\.base_ref/.test(ws),
    'origin/<base_ref> is never fetched by actions/checkout on a PR: git exits 128');
  assert.match(ws, /git diff --check HEAD\^1 HEAD/, 'PR path should diff the merge commit against its first parent');
  assert.ok(!/\|\|\s*true/.test(ws), 'the push path must be allowed to fail');
  assert.match(ws, /github\.event\.before/, 'the push path should cover the whole push, not just HEAD~1');
});

// node-matrix-eol: Node 20 went end-of-life 2026-04-30 and the project is
// developed and benchmarked on Node 24, which the matrix never ran; the
// pinned action majors declared the retired node20 runtime.
test('Node matrix covers the supported LTS lines and actions are on node24 majors', () => {
  const m = job('test-javascript').match(/node-version:\s*\[([^\]]*)\]/);
  assert.ok(m, 'test-javascript has a node-version matrix');
  const versions = m[1].split(',').map(v => v.trim());
  assert.ok(!versions.includes('20.x'), 'Node 20 is end-of-life');
  for (const v of ['22.x', '24.x']) assert.ok(versions.includes(v), 'matrix should test ' + v);
  assert.ok(!/actions\/checkout@v[1-4]\b/.test(CI), 'checkout@v4 and older declare node20');
  assert.ok(!/actions\/setup-node@v[1-4]\b/.test(CI), 'setup-node@v4 and older declare node20');
  assert.ok(!/actions\/setup-python@v[1-5]\b/.test(CI), 'setup-python@v5 and older declare node20');
  assert.ok(fs.existsSync(path.join(ROOT, '.github/dependabot.yml')), 'dependabot keeps action majors current');
});

// test-count-and-entrypoint: bare `node --test` matches **/test/**/*.js, so
// test/helpers/*.js ran as test files and inflated the count by two; there
// was no `npm test` and no declared Node floor.
test('npm test runs exactly the *.test.js files, and CI uses it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.private, true);
  assert.ok(!pkg.dependencies && !pkg.devDependencies, 'zero dependencies');
  assert.match(pkg.scripts.test, /node --test "test\/\*\.test\.js"/);
  assert.match(pkg.engines.node, />=\s*22/);
  assert.match(job('test-javascript'), /run: npm test/);
});

// ci-no-failure-artifacts: a CI-only acceptance failure left nothing to
// inspect (its logs stayed on the runner), and the token had repo defaults.
test('CI keeps acceptance diagnostics on failure and runs with a read-only token', () => {
  assert.match(CI, /\npermissions:\n  contents: read\n/, 'top-level least-privilege permissions');
  const py = job('test-python');
  assert.match(py, /run_acceptance\.py[^\n]*--logs-dir/, 'acceptance logs go to a known directory');
  const up = py.match(/- name: Upload acceptance diagnostics\n([\s\S]*?)(?=\n      - name:|$)/);
  assert.ok(up, 'an upload step for the acceptance diagnostics');
  assert.match(up[1], /if: failure\(\)/);
  assert.match(up[1], /uses: actions\/upload-artifact@v\d+/);
  assert.match(up[1], /acceptance-logs/);
});

// missing-citation-changelog: no CITATION.cff ("Cite this repository"),
// changelog or security policy.
test('CITATION.cff, CHANGELOG.md and SECURITY.md exist and agree', () => {
  const cff = fs.readFileSync(path.join(ROOT, 'CITATION.cff'), 'utf8');
  for (const key of ['cff-version', 'message', 'title', 'authors', 'license', 'repository-code']) {
    assert.match(cff, new RegExp('^' + key + ':', 'm'), 'CITATION.cff needs ' + key);
  }
  assert.match(cff, /^license: MIT$/m);
  assert.match(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'), /^MIT License/);
  const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const latest = (log.match(/^## \[?([^\]\s]+)/m) || [])[1];
  assert.ok(latest, 'CHANGELOG.md has a release heading');
  const ver = (cff.match(/^version:\s*"?([^"\s]+)/m) || [])[1];
  if (ver) assert.strictEqual(ver, latest.replace(/^v/, ''), 'CITATION.cff version matches the latest CHANGELOG heading');
  else assert.strictEqual(latest, 'Unreleased', 'an untagged CITATION.cff goes with an Unreleased changelog head');
  assert.ok(fs.existsSync(path.join(ROOT, 'SECURITY.md')));
});

// gitignore-out-dir: tools/batch.js writes its reports to ./out by default
// (repo root, per the README's command); local venvs for the sitl/ Python
// dependencies were not ignored either.
test('.gitignore covers batch reports and local Python venvs', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map(l => l.trim());
  for (const p of ['out/', '.venv/', 'venv/']) assert.ok(lines.includes(p), '.gitignore should list ' + p);
});

// playwright-e2e-unrun-and-weak: the only browser <-> mock test imported an
// undeclared dependency, ran nowhere, printed success from `finally`, and its
// last wait also passed when the relaunch FAILED ('retries exhausted').
test('the Playwright e2e is opt-in, declared, and ends on positive evidence', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
  const wf = read('.github/workflows/e2e.yml');
  assert.match(wf, /^on:\n  workflow_dispatch:\n\n/m, 'the e2e workflow must run on demand only');
  assert.match(wf, /pip install -r test\/requirements-e2e\.txt/);
  assert.match(wf, /playwright install --with-deps chromium/);
  assert.match(wf, /run: python -B test\/test_integration_mock\.py/);
  assert.ok(!/test_integration_mock|playwright/.test(CI), 'the default CI must not need Playwright');
  assert.match(read('test/requirements-e2e.txt'), /^playwright==\d+\.\d+\.\d+$/m, 'pin playwright');
  const e2e = read('test/test_integration_mock.py');
  assert.match(e2e, /msg\.action === 'relaunch' && msg\.id === 'DR-1'/, 'require that a relaunch was sent');
  assert.match(e2e, /d\.servicePhase === 'none' && d\.state === 'ready'/, 'require DR-1 back READY with no service');
  assert.match(e2e, /!d\.failureReason/);
  const fin = e2e.slice(e2e.indexOf('        finally:'));
  assert.ok(!/completed successfully/.test(fin.slice(0, fin.indexOf('\n    print('))),
    'success must not be printed from finally (it showed on failures too)');
  assert.match(read('CONTRIBUTING.md'), /test\/requirements-e2e\.txt/);
});

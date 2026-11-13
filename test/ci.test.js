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

// pages-ungated: the live demo was branch-served by the built-in Pages
// builder, which ran in parallel with CI, so a commit that failed tests went
// live anyway — and ran Jekyll over the whole tree for nothing.
test('the Pages deploy runs only for a main push after every CI job passed, with write scopes on that job alone', () => {
  const dep = job('deploy-pages');
  const needs = (dep.match(/\n    needs:\s*\[([^\]]*)\]/) || [])[1];
  assert.ok(needs, 'deploy-pages must declare needs');
  for (const j of ['whitespace-and-lint', 'test-javascript', 'test-python']) {
    assert.ok(needs.split(',').map(s => s.trim()).includes(j), 'deploy-pages must wait for ' + j);
  }
  const cond = (dep.match(/\n    if:\s*([^\n]+)/) || [])[1] || '';
  assert.match(cond, /github\.event_name == 'push'/, 'never deploy a pull request');
  assert.match(cond, /github\.ref == 'refs\/heads\/main'/, 'deploy main only');
  assert.match(dep, /\n    permissions:\n(      [\w-]+: \w+\n)*      pages: write\n/, 'pages: write on the deploy job');
  assert.match(dep, /\n      id-token: write\n/, 'id-token: write on the deploy job');
  assert.match(dep, /uses: actions\/upload-pages-artifact@v\d+/);
  assert.match(dep, /uses: actions\/deploy-pages@v\d+/);
  assert.match(CI, /\npermissions:\n  contents: read\n/, 'the top-level token stays read-only');
  for (const j of ['whitespace-and-lint', 'test-javascript', 'test-python']) {
    assert.ok(!/pages: write|id-token: write/.test(job(j)), j + ' must not get Pages write scopes');
  }
  assert.ok(fs.existsSync(path.join(ROOT, '.nojekyll')), '.nojekyll: the site is plain static files, no Jekyll pass');
});

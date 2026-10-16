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

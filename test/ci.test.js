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

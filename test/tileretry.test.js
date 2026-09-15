// Finding #31 (review of ffb35e6, B44): a failed tile fetch was cached as
// failed until eviction — one transient network blip left a permanent hole
// in the basemap after the network recovered. Failures must retry with
// bounded exponential backoff.
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { loadUI } = require('./helpers/dom.js');

test('regression #31: a failed tile retries after backoff instead of caching forever', () => {
  const ui = loadUI();
  const tileGet = vm.runInContext('tileGet', ui.ctx);

  const e1 = tileGet(16, 100, 200);
  assert.ok(e1 && e1.img, 'first request creates a fetch');
  e1.img.onerror(); // the network hiccups
  assert.strictEqual(e1.failed, true);

  // Immediately after: still cooling down — no hammering the CDN.
  assert.strictEqual(tileGet(16, 100, 200), e1, 'no instant re-fetch');

  // Past the first backoff window: a FRESH attempt.
  ui.ctx.__clock.ms += 6000;
  const e2 = tileGet(16, 100, 200);
  assert.notStrictEqual(e2, e1, 'failed tile never retried after the network recovered');
  assert.strictEqual(e2.failed, false, 'fresh attempt starts clean');

  // Second failure backs off longer (exponential).
  e2.img.onerror();
  ui.ctx.__clock.ms += 6000; // 6 s < the ~10 s second-stage delay
  assert.strictEqual(tileGet(16, 100, 200), e2, 'second backoff must be longer than the first');
  ui.ctx.__clock.ms += 6000; // now past it
  const e3 = tileGet(16, 100, 200);
  assert.notStrictEqual(e3, e2, 'retry resumes after the longer window');
});

test('a loaded tile is never re-fetched (guard)', () => {
  const ui = loadUI();
  const tileGet = vm.runInContext('tileGet', ui.ctx);
  const e1 = tileGet(15, 10, 20);
  e1.img.onload();
  assert.strictEqual(e1.ok, true);
  ui.ctx.__clock.ms += 1e7;
  assert.strictEqual(tileGet(15, 10, 20), e1, 'good tiles stay cached');
});

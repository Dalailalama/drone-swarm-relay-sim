// Terrain unit tests — run with:  node --test test/terrain.test.js
// Pin down the dome-height math and the LOS ray-vs-terrain check so a PR
// can't silently break line-of-sight blocking or preset generation.

const { test } = require('node:test');
const assert = require('node:assert');

const T = require('../js/terrain.js');

test('terrainHeightAt: center, edge, beyond radius, empty', () => {
  const hills = [{ x: 0, y: 0, radiusM: 100, heightM: 50 }];
  assert.strictEqual(T.terrainHeightAt(hills, 0, 0), 50);
  assert.strictEqual(T.terrainHeightAt(hills, 100, 0), 0);
  assert.strictEqual(T.terrainHeightAt(hills, 150, 0), 0);
  assert.strictEqual(T.terrainHeightAt([], 0, 0), 0);
  assert.strictEqual(T.terrainHeightAt([], 500, 500), 0);
});

test('terrainHeightAt: two overlapping hills take the max, not the sum', () => {
  const hills = [
    { x: 0, y: 0, radiusM: 100, heightM: 50 },
    { x: 50, y: 0, radiusM: 100, heightM: 80 },
  ];
  const h = T.terrainHeightAt(hills, 25, 0);
  assert.ok(h < 130, 'must not sum the two hills');
  assert.ok(h <= 80 + 1e-9, 'must not exceed the taller hill\'s peak');
});

test('losBlocked: a tall hill between two low endpoints blocks the link', () => {
  const hills = [{ x: 1000, y: 0, radiusM: 300, heightM: 200 }];
  const blocked = T.losBlocked(hills, 0, 0, 50, 2000, 0, 50);
  assert.strictEqual(blocked, true);
});

test('losBlocked: same geometry but both endpoints high clears the peak + margin', () => {
  const hills = [{ x: 1000, y: 0, radiusM: 300, heightM: 200 }];
  const blocked = T.losBlocked(hills, 0, 0, 260, 2000, 0, 260);
  assert.strictEqual(blocked, false);
});

test('losBlocked: no hills never blocks', () => {
  assert.strictEqual(T.losBlocked([], 0, 0, 1, 2000, 0, 1), false);
});

test('losBlocked: ray passing beside the hill (offset > radius) is not blocked', () => {
  const hills = [{ x: 1000, y: 0, radiusM: 100, heightM: 500 }];
  // straight line at y=500, well outside the 100 m radius footprint
  const blocked = T.losBlocked(hills, 0, 500, 50, 2000, 500, 50);
  assert.strictEqual(blocked, false);
});

test('terrainPreset "ridge": exactly one hill, centered on the segment midpoint', () => {
  const opts = { distM: 1000, altM: 100, targetX: 1000, targetY: 0, seed: 1 };
  const hills = T.terrainPreset('ridge', opts);
  assert.strictEqual(hills.length, 1);
  const dist = Math.hypot(hills[0].x - 500, hills[0].y - 0);
  assert.ok(dist < 1, 'ridge hill must sit within 1 m of the spine midpoint');
});

test('terrainPreset "twin": two hills flank opposite sides of the spine', () => {
  const opts = { distM: 1000, altM: 100, targetX: 1000, targetY: 0, seed: 1 };
  const hills = T.terrainPreset('twin', opts);
  assert.strictEqual(hills.length, 2);
  // spine runs along y=0 here, so perpendicular offset is just y
  assert.ok(hills[0].y * hills[1].y < 0, 'perpendicular offsets must have opposite signs');
});

test('terrainPreset "random": same seed produces identical hills', () => {
  const opts = { distM: 1500, altM: 80, targetX: 1200, targetY: 900, seed: 7 };
  const a = T.terrainPreset('random', opts);
  const b = T.terrainPreset('random', opts);
  assert.strictEqual(a.length, 4);
  assert.deepStrictEqual(a, b);
});

test('terrainPreset: "none" and unknown names return an empty array', () => {
  const opts = { distM: 1000, altM: 100, targetX: 1000, targetY: 0, seed: 1 };
  assert.deepStrictEqual(T.terrainPreset('none', opts), []);
  assert.deepStrictEqual(T.terrainPreset('garbage', opts), []);
});

// Terrain v2 tests — fractal ground + buildings. Run with: node --test test/
const { test } = require('node:test');
const assert = require('node:assert');

const T = require('../js/terrain.js');

const OPTS = { distM: 1000, altM: 50, targetX: 1000, targetY: 0, seed: 7 };

test('flat terrain is flat and buildingless', () => {
  const t = T.makeTerrain('flat', OPTS);
  assert.strictEqual(T.terrainGroundAt(t, 123, -456), 0);
  assert.strictEqual(t.buildings.length, 0);
});

test('fractal ground is deterministic, non-negative, and bounded by its amplitude', () => {
  const a = T.makeTerrain('rolling', OPTS);
  const b = T.makeTerrain('rolling', OPTS);
  let maxH = 0;
  for (let i = 0; i < 500; i++) {
    const x = (i * 137) % 2000 - 500, y = (i * 89) % 1600 - 300;
    const ha = T.terrainGroundAt(a, x, y);
    assert.strictEqual(ha, T.terrainGroundAt(b, x, y), 'same seed, same ground');
    assert.ok(ha >= 0 && ha <= a.groundAmpM);
    maxH = Math.max(maxH, ha);
  }
  assert.ok(maxH > a.groundAmpM * 0.3, 'terrain should actually have ridges, got max ' + maxH);
});

test('different seeds give different ground', () => {
  const a = T.makeTerrain('rolling', OPTS);
  const b = T.makeTerrain('rolling', { ...OPTS, seed: 8 });
  let diff = 0;
  for (let i = 0; i < 50; i++) {
    if (T.terrainGroundAt(a, i * 97, i * 61) !== T.terrainGroundAt(b, i * 97, i * 61)) diff++;
  }
  assert.ok(diff > 40);
});

test('buildings add height inside their footprint only', () => {
  const t = { seed: 1, groundAmpM: 0, groundScaleM: 1, buildings: [{ x: 100, y: 100, w: 40, d: 40, heightM: 60 }] };
  assert.strictEqual(T.terrainHeightAt(t, 100, 100), 60);
  assert.strictEqual(T.terrainHeightAt(t, 119, 119), 60);
  assert.strictEqual(T.terrainHeightAt(t, 121, 100), 0);
});

test('LOS: a 100 m tower between two 50 m drones blocks; flying over it at 120 m clears', () => {
  const t = { seed: 1, groundAmpM: 0, groundScaleM: 1, buildings: [{ x: 500, y: 0, w: 60, d: 60, heightM: 100 }] };
  assert.ok(T.losBlocked(t, 0, 0, 50, 1000, 0, 50));
  assert.ok(!T.losBlocked(t, 0, 0, 120, 1000, 0, 120));
});

test('LOS: ray passing beside the tower is clear', () => {
  const t = { seed: 1, groundAmpM: 0, groundScaleM: 1, buildings: [{ x: 500, y: 200, w: 60, d: 60, heightM: 100 }] };
  assert.ok(!T.losBlocked(t, 0, 0, 50, 1000, 0, 50));
});

test('LOS: a ridge between two valleys blocks at low altitude, clear from high above', () => {
  const t = T.makeTerrain('rolling', OPTS);
  let peakX = 0, peakH = -1;
  for (let x = 100; x <= 900; x += 10) {
    const h = T.terrainGroundAt(t, x, 0);
    if (h > peakH) { peakH = h; peakX = x; }
  }
  const aAlt = T.terrainGroundAt(t, peakX - 400, 0) + 30;
  const bAlt = T.terrainGroundAt(t, peakX + 400, 0) + 30;
  if (peakH > Math.max(aAlt, bAlt) + 20) {
    assert.ok(T.losBlocked(t, peakX - 400, 0, aAlt, peakX + 400, 0, bAlt));
  }
  assert.ok(!T.losBlocked(t, peakX - 400, 0, t.groundAmpM + 60, peakX + 400, 0, t.groundAmpM + 60));
});

test('urban preset: deterministic district with some swarm-blocking towers', () => {
  const a = T.makeTerrain('urban', OPTS);
  const b = T.makeTerrain('urban', OPTS);
  assert.deepStrictEqual(a.buildings, b.buildings);
  assert.ok(a.buildings.length > 20, 'expected a real district, got ' + a.buildings.length);
  const tall = a.buildings.filter(x => x.heightM > OPTS.altM);
  assert.ok(tall.length >= 2, 'expected towers above flight altitude');
  assert.ok(tall.length < a.buildings.length / 2, 'most buildings should be low-rise');
});

test('mixed preset has both ground relief and buildings', () => {
  const t = T.makeTerrain('mixed', OPTS);
  assert.ok(t.groundAmpM > 0);
  assert.ok(t.buildings.length > 5);
});

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

test('urban preset: deterministic city with a downtown of swarm-blocking towers', () => {
  const a = T.makeTerrain('urban', OPTS);
  const b = T.makeTerrain('urban', OPTS);
  assert.deepStrictEqual(a.buildings, b.buildings);
  assert.ok(a.buildings.length > 80, 'expected a real city, got ' + a.buildings.length);
  const tall = a.buildings.filter(x => x.heightM > OPTS.altM);
  assert.ok(tall.length >= 5, 'expected downtown towers above flight altitude');
  assert.ok(tall.length < a.buildings.length / 2, 'most buildings should be low-rise');
});

test('building spatial index agrees with linear scan', () => {
  const t = T.makeTerrain('urban', OPTS);
  const linear = { ...t, bGrid: null };
  for (let i = 0; i < 300; i++) {
    const x = (i * 37) % 1400 - 200, y = ((i * 53) % 1000) - 500;
    const viaGrid = T.buildingAt(t, x, y);
    const viaScan = T.buildingAt(linear, x, y);
    assert.strictEqual(viaGrid, viaScan, 'index mismatch at ' + x + ',' + y);
  }
});

test('mixed preset has both ground relief and buildings', () => {
  const t = T.makeTerrain('mixed', OPTS);
  assert.ok(t.groundAmpM > 0);
  assert.ok(t.buildings.length > 5);
});

test('LOS sampling scales with ray length — a narrow tower mid-link blocks (regression M4)', () => {
  // 24 m tower centered on a 1000 m link. A fixed 28-sample scheme spaces
  // samples ~34.5 m apart and would step right over it; length-scaled
  // sampling must catch it.
  const t = { seed: 1, groundAmpM: 0, groundScaleM: 1, buildings: [{ x: 500, y: 0, w: 24, d: 24, heightM: 100 }] };
  assert.ok(T.losBlocked(t, 0, 0, 50, 1000, 0, 50), 'narrow mid-link tower must block LOS');
  // and clearing it overhead is still clear
  assert.ok(!T.losBlocked(t, 0, 0, 130, 1000, 0, 130), 'flying over the tower stays clear');
});

test('city keep-out honors footprint + jitter, not just grid center (regression m2)', () => {
  const t = T.makeTerrain('urban', OPTS);
  const keepOut = [{ x: 0, y: 0, rM: 130 }, { x: OPTS.targetX, y: OPTS.targetY, rM: 110 }];
  for (const b of t.buildings) {
    const hw = b.w / 2, hd = b.d / 2;
    // nearest point of the footprint rectangle to each clearing center
    for (const z of keepOut) {
      const nx = Math.max(b.x - hw, Math.min(z.x, b.x + hw));
      const ny = Math.max(b.y - hd, Math.min(z.y, b.y + hd));
      assert.ok(Math.hypot(nx - z.x, ny - z.y) >= z.rM,
        'building footprint intrudes into clearing at ' + b.x.toFixed(0) + ',' + b.y.toFixed(0));
    }
  }
});

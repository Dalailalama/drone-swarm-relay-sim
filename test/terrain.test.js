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

// Audit rf-physics/los-terrain-undersampled-short-missions: the 40 m terrain
// step is coarser than the finest FBM octave on short missions (lattice
// groundScaleM / 8 = 8.8 m at distM 200), so rays passed up to 23 m under a
// ridge between two samples and were judged clear.
test('LOS terrain sampling follows the map\'s finest relief on short missions', () => {
  const t = T.makeTerrain('rolling', { distM: 200, altM: 50, seed: 7, targetX: 200, targetY: 0 });
  assert.strictEqual(T.losBlocked(t, 18.6, 59.4, 68.7, -433.3, 105.3, 47.7), true,
    'the pinned ray passes ~23 m under a crest between two 40 m samples');
  // Seeded sweep: 60-460 m links, 30 m AGL ends; a 1 m walk is ground truth.
  let a = 12345;
  const rnd = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; };
  let under = 0;
  for (let k = 0; k < 300; k++) {
    const ax = (rnd() - 0.5) * 900, ay = (rnd() - 0.5) * 900;
    const L = 60 + rnd() * 400, th = rnd() * 2 * Math.PI;
    const bx = ax + L * Math.cos(th), by = ay + L * Math.sin(th);
    const aAlt = T.terrainGroundAt(t, ax, ay) + 30, bAlt = T.terrainGroundAt(t, bx, by) + 30;
    let walkBlocked = false;
    const steps = Math.ceil(L);
    for (let i = 1; i < steps && !walkBlocked; i++) {
      const f = i / steps;
      if (T.terrainGroundAt(t, ax + (bx - ax) * f, ay + (by - ay) * f) > aAlt + (bAlt - aAlt) * f) walkBlocked = true;
    }
    if (!walkBlocked) continue;
    under++;
    assert.ok(T.losBlocked(t, ax, ay, aAlt, bx, by, bAlt),
      'ray (' + ax.toFixed(1) + ',' + ay.toFixed(1) + ')-(' + bx.toFixed(1) + ',' + by.toFixed(1) + ') goes under the ground but reads clear');
  }
  assert.ok(under > 20, 'the sweep must include rays that hit the ground, got ' + under);
});

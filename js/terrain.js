// Terrain model v2 — continuous fractal ground plus buildings.
//
// The ground is a value-noise heightfield (4-octave FBM): endless rolling
// hills and valleys, deterministic from a seed, sampled analytically at any
// (x, y) — no stored grid. Buildings are axis-aligned boxes planted on the
// ground in seeded city blocks. Radio links need line of sight over BOTH.
//
// Flight model: drones terrain-follow (their absolute altitude is the
// ground under them + their AGL setting), the way real autopilots fly
// terrain-following missions. They can't follow a building — anything
// built taller than their AGL is a no-fly box they steer around.

const LOS_CLEARANCE_M = 5;   // Fresnel-ish breathing room over obstructions
const LOS_SAMPLES = 28;

// --- Seeded value noise -------------------------------------------------------
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed | 0, 1013904223);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t) { return t * t * (3 - 2 * t); }

function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smoothstep(x - ix), fy = smoothstep(y - iy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// Fractal Brownian motion: stacked octaves, each half the amplitude and
// twice the frequency of the last — the standard recipe for natural ground.
function fbm(x, y, seed) {
  let v = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < 4; o++) {
    v += amp * valueNoise(x * freq, y * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return v / norm; // 0..1
}

// --- Terrain object -------------------------------------------------------------
// { seed, groundAmpM, groundScaleM, buildings: [{x, y, w, d, heightM}] }

function terrainGroundAt(t, x, y) {
  if (!t || !t.groundAmpM) return 0;
  const n = fbm(x / t.groundScaleM, y / t.groundScaleM, t.seed);
  // push the low end down to flat valley floors, keep ridges pronounced
  return Math.pow(Math.max(0, n - 0.30) / 0.70, 1.4) * t.groundAmpM;
}

function buildingAt(t, x, y) {
  if (!t || !t.buildings || !t.buildings.length) return null;
  const list = t.bGrid
    ? t.bGrid.get(Math.floor(x / BGRID_CELL_M) + ',' + Math.floor(y / BGRID_CELL_M))
    : t.buildings;
  if (!list) return null;
  for (const b of list) {
    if (Math.abs(x - b.x) <= b.w / 2 && Math.abs(y - b.y) <= b.d / 2) return b;
  }
  return null;
}

// Surface height including structures: ground, plus the roof if (x,y) is
// inside a building footprint.
function terrainHeightAt(t, x, y) {
  const g = terrainGroundAt(t, x, y);
  const b = buildingAt(t, x, y);
  return b ? terrainGroundAt(t, b.x, b.y) + b.heightM : g;
}

// True if the ray from A (absolute altitude aAltM) to B clips ground or a
// building anywhere along the way. The Fresnel clearance requirement tapers
// to zero at the endpoints — a ray naturally grazes the ground right at its
// own antenna, and demanding full clearance there would deafen any
// ground-level station.
function losBlocked(t, ax, ay, aAltM, bx, by, bAltM) {
  if (!t || (!t.groundAmpM && (!t.buildings || !t.buildings.length))) return false;
  for (let i = 1; i <= LOS_SAMPLES; i++) {
    const f = i / (LOS_SAMPLES + 1);
    const x = ax + (bx - ax) * f;
    const y = ay + (by - ay) * f;
    const rayAlt = aAltM + (bAltM - aAltM) * f;
    const clearance = LOS_CLEARANCE_M * Math.min(1, 6 * f, 6 * (1 - f));
    if (terrainHeightAt(t, x, y) + clearance >= rayAlt) return true;
  }
  return false;
}

// --- Presets ---------------------------------------------------------------------
// opts = { distM, altM, targetX, targetY, seed }
// Base is (0,0); the spine runs to (targetX, targetY).

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A city: seeded street grid with a downtown core. Towers cluster downtown
// (60-150 m, real city heights), low-rise sprawl thins out toward the
// edges, with parks and lots left empty. Reads like an actual city from
// the 3D view, not a single block.
function makeCity(cx, cy, spanM, rng) {
  const buildings = [];
  const pitch = Math.max(40, spanM / 22);        // block spacing incl. street
  const n = Math.max(5, Math.round(spanM / pitch));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const gx = cx + (i - (n - 1) / 2) * pitch;
      const gy = cy + (j - (n - 1) / 2) * pitch;
      const rCore = Math.hypot(gx - cx, gy - cy) / (spanM / 2); // 0 downtown → 1 edge
      if (rng() < 0.12 + rCore * 0.5) continue;  // density falls off from the core
      const bx = gx + (rng() - 0.5) * pitch * 0.2;
      const by = gy + (rng() - 0.5) * pitch * 0.2;
      const w = pitch * (0.42 + rng() * 0.26);
      const d = pitch * (0.42 + rng() * 0.26);
      const towerP = 0.30 * Math.max(0, 1 - rCore * 1.3); // towers live downtown
      const heightM = rng() < towerP
        ? 60 + rng() * 90
        : 8 + rng() * 26;
      buildings.push({ x: bx, y: by, w, d, heightM });
    }
  }
  return buildings;
}

// Spatial hash so 150+ buildings stay cheap to query: buildingAt only looks
// at the handful of buildings whose footprints overlap one grid cell.
const BGRID_CELL_M = 120;

function indexBuildings(t) {
  t.bGrid = new Map();
  for (const b of t.buildings) {
    const x0 = Math.floor((b.x - b.w / 2) / BGRID_CELL_M), x1 = Math.floor((b.x + b.w / 2) / BGRID_CELL_M);
    const y0 = Math.floor((b.y - b.d / 2) / BGRID_CELL_M), y1 = Math.floor((b.y + b.d / 2) / BGRID_CELL_M);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const key = ix + ',' + iy;
        let arr = t.bGrid.get(key);
        if (!arr) { arr = []; t.bGrid.set(key, arr); }
        arr.push(b);
      }
    }
  }
  return t;
}

function makeTerrain(name, opts) {
  opts = opts || {};
  const distM = opts.distM || 1000;
  const altM = opts.altM || 50;
  const seed = (opts.seed || 1) | 0;
  const tX = opts.targetX || distM, tY = opts.targetY || 0;
  const rng = mulberry32(seed ^ 0x5eed);
  const along = f => ({ x: tX * f, y: tY * f });

  if (name === 'rolling') {
    return {
      seed, buildings: [],
      groundAmpM: 2.6 * altM + 40,     // ridge tops well above flight level
      groundScaleM: distM * 0.35,      // feature wavelength ~ a few hops
    };
  }
  if (name === 'urban') {
    const c = along(0.5);
    return indexBuildings({
      seed, groundAmpM: 0, groundScaleM: 1,
      buildings: makeCity(c.x, c.y, distM * 1.15, rng),
    });
  }
  if (name === 'mixed') {
    const c = along(0.55);
    return indexBuildings({
      seed, groundAmpM: 2.0 * altM + 30, groundScaleM: distM * 0.45,
      buildings: makeCity(c.x, c.y, distM * 0.55, rng),
    });
  }
  // 'flat' and anything unknown
  return { seed, buildings: [], groundAmpM: 0, groundScaleM: 1 };
}

// UMD-lite export so terrain is unit-testable under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    terrainGroundAt, terrainHeightAt, buildingAt, losBlocked, makeTerrain,
    fbm, valueNoise, LOS_CLEARANCE_M,
  };
}

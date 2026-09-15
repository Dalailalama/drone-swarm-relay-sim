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

const LOS_CLEARANCE_M = 5;      // Fresnel-ish breathing room over obstructions
// LOS is sampled by distance, not a fixed count: spacing must stay below the
// smallest obstacle or a ray can punch clean through a building that sits
// between two samples. Buildings (~20 m footprints) need a fine step; open
// terrain hills are hundreds of metres wide and tolerate a coarse one. A cap
// bounds cost on very long links (which only occur in building-free terrain).
const LOS_STEP_BUILDING_M = 8;
const LOS_STEP_TERRAIN_M = 40;
const LOS_SAMPLES_MIN = 12;
const LOS_SAMPLES_MAX = 160;

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
  let best = null;
  for (const b of list) {
    if (Math.abs(x - b.x) <= b.w / 2 && Math.abs(y - b.y) <= b.d / 2) {
      if (!best || b.heightM > best.heightM) best = b;
    }
  }
  return best;
}

// Buildings whose grid cells fall within radiusM of (x, y) — for obstacle
// queries at scale. Uses the spatial hash so a query stays cheap even with
// thousands of buildings. Deduplicates buildings spanning multiple cells (B24).
function buildingsNear(t, x, y, radiusM) {
  if (!t || !t.buildings || !t.buildings.length) return [];
  if (!t.bGrid) return t.buildings;
  const c = BGRID_CELL_M;
  const x0 = Math.floor((x - radiusM) / c), x1 = Math.floor((x + radiusM) / c);
  const y0 = Math.floor((y - radiusM) / c), y1 = Math.floor((y + radiusM) / c);
  const seen = new Set();
  const out = [];
  for (let ix = x0; ix <= x1; ix++) {
    for (let iy = y0; iy <= y1; iy++) {
      const arr = t.bGrid.get(ix + ',' + iy);
      if (arr) {
        for (const b of arr) {
          if (!seen.has(b)) {
            seen.add(b);
            out.push(b);
          }
        }
      }
    }
  }
  return out;
}

// Surface height including structures: ground, plus the roof if (x,y) is
// inside a building footprint.
function terrainHeightAt(t, x, y) {
  const g = terrainGroundAt(t, x, y);
  const b = buildingAt(t, x, y);
  return b ? terrainGroundAt(t, b.x, b.y) + b.heightM : g;
}

function rayIntersectsAABB(ax, ay, bx, by, minX, maxX, minY, maxY) {
  const dx = bx - ax, dy = by - ay;
  let tmin = 0, tmax = 1;
  if (Math.abs(dx) < 1e-9) {
    if (ax < minX || ax > maxX) return null;
  } else {
    let t1 = (minX - ax) / dx, t2 = (maxX - ax) / dx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (Math.abs(dy) < 1e-9) {
    if (ay < minY || ay > maxY) return null;
  } else {
    let t1 = (minY - ay) / dy, t2 = (maxY - ay) / dy;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return { tmin, tmax };
}

// True if the ray from A (absolute altitude aAltM) to B clips ground or a
// building anywhere along the way. The Fresnel clearance requirement tapers
// to zero at the endpoints — a ray naturally grazes the ground right at its
// own antenna, and demanding full clearance there would deafen any
// ground-level station.
function losBlocked(t, ax, ay, aAltM, bx, by, bAltM) {
  if (!t || (!t.groundAmpM && (!t.buildings || !t.buildings.length))) return false;

  const minRayAlt = Math.min(aAltM, bAltM);
  // O5: If ray altitude at both endpoints is strictly above highest roof and highest ground, it cannot clip
  if (t._maxRoofAlt != null && minRayAlt > t._maxRoofAlt + LOS_CLEARANCE_M && minRayAlt > (t.groundAmpM || 0) + LOS_CLEARANCE_M) {
    return false;
  }

  // Exact 2D segment-AABB check against buildings (B23)
  if (t.buildings && t.buildings.length) {
    const minRayX = Math.min(ax, bx), maxRayX = Math.max(ax, bx);
    const minRayY = Math.min(ay, by), maxRayY = Math.max(ay, by);
    let bCandidates = t.buildings;
    if (t.bGrid) {
      // O9: gather candidates by WALKING THE RAY through the spatial hash
      // (with a one-cell margin) instead of boxing the whole span — the old
      // 5-cell fallback made every long link (a 40 km RFD hop) scan the
      // entire building list. Cells are ~120 m; half-cell steps can't skip
      // one, and the walk is clipped to the ray's own extent.
      const set = new Set();
      const c = BGRID_CELL_M;
      const rayLen2 = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(rayLen2 / (c / 2)));
      let px = null, py = null;
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const gx = Math.floor((ax + (bx - ax) * f) / c);
        const gy = Math.floor((ay + (by - ay) * f) / c);
        if (gx === px && gy === py) continue;
        px = gx; py = gy;
        for (let ix = gx - 1; ix <= gx + 1; ix++) {
          for (let iy = gy - 1; iy <= gy + 1; iy++) {
            const arr = t.bGrid.get(ix + ',' + iy);
            if (arr) for (let k = 0; k < arr.length; k++) set.add(arr[k]);
          }
        }
      }
      bCandidates = set;
    }
    for (const b of bCandidates) {
      const minBx = b.x - b.w / 2, maxBx = b.x + b.w / 2;
      const minBy = b.y - b.d / 2, maxBy = b.y + b.d / 2;
      if (maxRayX < minBx || minRayX > maxBx || maxRayY < minBy || minRayY > maxBy) continue;
      const isect = rayIntersectsAABB(ax, ay, bx, by, minBx, maxBx, minBy, maxBy);
      if (isect) {
        const fPoints = [isect.tmin, isect.tmax, (isect.tmin + isect.tmax) / 2];
        const bAlt = terrainGroundAt(t, b.x, b.y) + b.heightM;
        for (const f of fPoints) {
          const rayAlt = aAltM + (bAltM - aAltM) * f;
          const clearance = LOS_CLEARANCE_M * Math.min(1, 6 * f, 6 * (1 - f));
          if (bAlt + clearance >= rayAlt) return true;
        }
      }
    }
  }

  // Terrain heightfield sampling
  if (t.groundAmpM > 0) {
    const rayLen = Math.hypot(bx - ax, by - ay);
    const stepM = LOS_STEP_TERRAIN_M;
    const n = Math.max(LOS_SAMPLES_MIN, Math.min(LOS_SAMPLES_MAX, Math.ceil(rayLen / stepM)));
    for (let i = 1; i <= n; i++) {
      const f = i / (n + 1);
      const x = ax + (bx - ax) * f;
      const y = ay + (by - ay) * f;
      const rayAlt = aAltM + (bAltM - aAltM) * f;
      const clearance = LOS_CLEARANCE_M * Math.min(1, 6 * f, 6 * (1 - f));
      if (terrainGroundAt(t, x, y) + clearance >= rayAlt) return true;
    }
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
// keepOut: [{x, y, rM}] — clearings where no block may be planted. The
// ground station's staging area and the objective are always clearings;
// nobody sites a GCS mast inside a random building cluster.
// opts.density (0..1): from a bare handful of buildings up to a dense grid of
// thousands filling the footprint. opts.heightScale (0..1): from a low-rise
// town to a skyscraper metropolis (raises both how many towers and how tall).
function makeCity(cx, cy, spanM, rng, keepOut, opts) {
  opts = opts || {};
  const density = Math.max(0, Math.min(1, opts.density != null ? opts.density : 0.4));
  const hscale = Math.max(0, Math.min(1, opts.heightScale != null ? opts.heightScale : 0.4));
  const buildings = [];
  // Denser slider -> smaller blocks -> a finer grid of them. Grid is capped so
  // "max density" tops out at a few thousand, not an unbounded number.
  const pitch = Math.max(22, 150 - density * 128);
  const n = Math.min(64, Math.max(1, Math.round(spanM / pitch)));
  const clearMargin = 0.62 * pitch;
  const baseFill = 0.02 + density * 0.96;        // ~2% of cells built -> ~98%
  const towerFrac = 0.04 + hscale * 0.50;        // fraction that are tall towers
  const towerMin = 18 + hscale * 40;
  const towerMax = 35 + hscale * 265;            // tallest towers ~35 m -> ~300 m
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const gx = cx + (i - (n - 1) / 2) * pitch;
      const gy = cy + (j - (n - 1) / 2) * pitch;
      if (keepOut && keepOut.some(z => Math.hypot(gx - z.x, gy - z.y) < z.rM + clearMargin)) { rng(); continue; }
      const rCore = Math.hypot(gx - cx, gy - cy) / (spanM / 2); // 0 downtown -> 1 edge
      // Edges thin out more at low density (a small town); a dense city fills
      // uniformly out to its footprint.
      const fill = baseFill * (1 - rCore * 0.45 * (1 - density));
      if (rng() >= fill) continue;
      const bx = gx + (rng() - 0.5) * pitch * 0.2;
      const by = gy + (rng() - 0.5) * pitch * 0.2;
      const w = pitch * (0.42 + rng() * 0.26);
      const d = pitch * (0.42 + rng() * 0.26);
      const towerP = towerFrac * Math.max(0.25, 1 - rCore); // towers cluster downtown but appear throughout
      const heightM = rng() < towerP
        ? towerMin + rng() * (towerMax - towerMin)
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
  let maxH = 0;
  for (const b of t.buildings) {
    if (b.heightM > maxH) maxH = b.heightM;
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
  t._maxRoofAlt = (t.groundAmpM || 0) + maxH;
  return t;
}

function makeTerrain(name, opts) {
  opts = opts || {};
  const distM = opts.distM != null ? opts.distM : 1000;
  const altM = opts.altM != null ? opts.altM : 50;
  const seed = (opts.seed != null ? opts.seed : 1) | 0;
  const baseX = (opts.base && opts.base.x != null) ? opts.base.x : (opts.baseX != null ? opts.baseX : 0);
  const baseY = (opts.base && opts.base.y != null) ? opts.base.y : (opts.baseY != null ? opts.baseY : 0);
  const tX = (opts.target && opts.target.x != null) ? opts.target.x : (opts.targetX != null ? opts.targetX : distM);
  const tY = (opts.target && opts.target.y != null) ? opts.target.y : (opts.targetY != null ? opts.targetY : 0);
  const rng = mulberry32(seed ^ 0x5eed);
  const along = f => ({ x: baseX + (tX - baseX) * f, y: baseY + (tY - baseY) * f });

  if (name === 'rolling') {
    const groundAmpM = 2.6 * 50 + 40;     // fixed reference baseline so altitude sweeps do not alter topography (B26)
    return {
      seed, buildings: [],
      groundAmpM,
      _maxRoofAlt: groundAmpM,
      groundScaleM: distM * 0.35,      // feature wavelength ~ a few hops
    };
  }
  const keepOut = [
    { x: baseX, y: baseY, rM: 130 },      // GCS staging clearing
    { x: tX, y: tY, rM: 110 },    // objective clearing (at generation time)
  ];
  const cityOpts = { density: opts.density, heightScale: opts.heightScale };
  if (name === 'urban') {
    const c = along(0.5);
    return indexBuildings({
      seed, groundAmpM: 0, groundScaleM: 1,
      buildings: makeCity(c.x, c.y, distM * 3.5, rng, keepOut, cityOpts),
    });
  }
  if (name === 'mixed') {
    const c = along(0.55);
    return indexBuildings({
      seed, groundAmpM: 2.0 * 50 + 30, groundScaleM: distM * 0.45,
      buildings: makeCity(c.x, c.y, distM * 2.2, rng, keepOut, cityOpts),
    });
  }
  // 'flat' and anything unknown
  return { seed, buildings: [], groundAmpM: 0, groundScaleM: 1 };
}

// UMD-lite export so terrain is unit-testable under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    terrainGroundAt, terrainHeightAt, buildingAt, buildingsNear, losBlocked, makeTerrain,
    indexBuildings, fbm, valueNoise, LOS_CLEARANCE_M,
  };
}

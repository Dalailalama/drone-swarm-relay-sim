// Terrain model — dome-shaped hills scattered between base and target.
// Radio links need line of sight (LOS): a link between two antennas is
// blocked when the straight ray connecting them clips a hill instead of
// passing clean over it. Drones fly AGL (above ground level), so a drone's
// absolute altitude is terrainHeightAt(underneath it) + its AGL setting —
// it rides the terrain profile rather than holding a fixed sea-level height.

// Extra clearance (metres) required above the highest terrain sample along a
// ray before a link counts as line-of-sight — real antennas need a bit of
// Fresnel-zone breathing room, not just a mathematically-grazing ray.
const LOS_CLEARANCE_M = 5;

// Height of the terrain surface at (x, y): the tallest hill covering that
// point. Each hill is a paraboloid dome — heightM at the center, tapering
// to 0 at radiusM, and 0 (no contribution) beyond that.
//   h = heightM * max(0, 1 - (d/radiusM)^2),  d = horizontal dist to center
function terrainHeightAt(hills, x, y) {
  let maxH = 0;
  for (const hill of hills) {
    const dx = x - hill.x, dy = y - hill.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const h = hill.heightM * Math.max(0, 1 - (d / hill.radiusM) * (d / hill.radiusM));
    if (h > maxH) maxH = h;
  }
  return maxH;
}

// True if the straight ray from A (ax, ay, aAltAbsM) to B (bx, by, bAltAbsM)
// — both altitudes absolute, not AGL — dips into the terrain plus clearance
// anywhere along the way. Sampled at 24 evenly-spaced interior points; good
// enough for a sim, and cheap since hills are smooth domes with no cliffs.
function losBlocked(hills, ax, ay, aAltAbsM, bx, by, bAltAbsM) {
  if (!hills || hills.length === 0) return false;

  // Bounding-box pre-check: a hill can only matter if its footprint (center
  // +/- radius) overlaps the segment's bounding box. Cheap way to skip
  // sampling entirely when nothing is anywhere near the ray.
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by), maxY = Math.max(ay, by);
  const relevant = hills.filter(hill =>
    hill.x + hill.radiusM >= minX && hill.x - hill.radiusM <= maxX &&
    hill.y + hill.radiusM >= minY && hill.y - hill.radiusM <= maxY
  );
  if (relevant.length === 0) return false;

  for (let i = 1; i <= 24; i++) {
    const t = i / 25;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const rayAltM = aAltAbsM + (bAltAbsM - aAltAbsM) * t;
    const groundM = terrainHeightAt(relevant, x, y);
    if (groundM + LOS_CLEARANCE_M >= rayAltM) return true;
  }
  return false;
}

// Deterministic seeded RNG (mulberry32) — same as js/net.js. Kept as a local
// helper so this module stays dependency-free.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Named terrain layouts for scenario setup. Base is always (0, 0); the
// "spine" is the straight line from base to (targetX, targetY). Hills are
// returned as absolute {x, y, radiusM, heightM} points.
function terrainPreset(name, opts) {
  const { distM, altM, targetX, targetY, seed } = opts;
  const spineLen = Math.hypot(targetX, targetY) || 1; // avoid div by zero
  const ux = targetX / spineLen, uy = targetY / spineLen; // unit along spine
  const px = -uy, py = ux;                              // unit perpendicular

  const along = (frac) => ({ x: targetX * frac, y: targetY * frac });
  const withPerp = (pt, offsetM) => ({ x: pt.x + px * offsetM, y: pt.y + py * offsetM });

  if (name === 'none') return [];

  if (name === 'ridge') {
    // Narrow and tall: steep enough that the swarm can't treat it as a
    // radio tower, small enough that relay slots straddle it — the shape
    // that actually casts a radio shadow across the spine.
    const center = along(0.5);
    return [{
      x: center.x, y: center.y,
      radiusM: 0.14 * distM,
      heightM: 2.2 * altM + 30,
    }];
  }

  if (name === 'twin') {
    const c1 = withPerp(along(1 / 3), 0.18 * distM);
    const c2 = withPerp(along(2 / 3), -0.18 * distM);
    const radiusM = 0.22 * distM;
    const heightM = 2.0 * altM + 20;
    return [
      { x: c1.x, y: c1.y, radiusM, heightM },
      { x: c2.x, y: c2.y, radiusM, heightM },
    ];
  }

  if (name === 'random') {
    const rng = mulberry32(seed);
    const hills = [];
    for (let i = 0; i < 4; i++) {
      const alongFrac = 0.15 + rng() * (0.95 - 0.15);
      const perpFrac = -0.35 + rng() * (0.35 - -0.35);
      const radiusM = (0.15 + rng() * (0.30 - 0.15)) * distM;
      const heightM = (1.5 + rng() * (3.0 - 1.5)) * altM + 20;
      const base = withPerp(along(alongFrac), perpFrac * distM);
      hills.push({ x: base.x, y: base.y, radiusM, heightM });
    }
    return hills;
  }

  return [];
}

// UMD-lite export so terrain is unit-testable under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { terrainHeightAt, losBlocked, terrainPreset, LOS_CLEARANCE_M };
}

// Map-first basemap — real OpenStreetMap cartography rendered under the sim.
//
// When the mission is georeferenced (a real area is loaded), the 2D canvas
// stops being an abstract dark plane and becomes the map: genuine OSM tiles
// (CARTO's dark style) draw as the ground, and the swarm, links, coverage
// and interference draw on top. The map is the picture; the fetched
// buildings remain the physics — a park or river on the tile does not
// affect radio, and we don't pretend otherwise.
//
// Zero dependencies on purpose: a slippy map is Web-Mercator arithmetic
// plus an image cache, and the app already owns pan/zoom/pinch. Tiles
// © OpenStreetMap contributors, style © CARTO (credited in the corner).

const TILE_SIZE = 256;
const TILE_MIN_Z = 3, TILE_MAX_Z = 19;
const TILE_CACHE_MAX = 400;          // ~25 MB worst case; evicted oldest-first
const TILE_GRID_CAP = 18;            // sanity cap on tiles per axis per frame
const TILE_EQUATOR_M = 156543.03392; // metres per tile pixel at z0 on the equator
// Local sim frame is x=East, y=South in metres — must match js/osm.js.
const TILE_M_PER_DEG_LAT = 110540;
const TILE_M_PER_DEG_LON = 111320;   // × cos(lat)

// anchor = { lat, lon, x, y }: the geographic point pinned to local (x, y).
function tileLocalToLatLon(anchor, x, y) {
  return {
    lat: anchor.lat - (y - anchor.y) / TILE_M_PER_DEG_LAT,
    lon: anchor.lon + (x - anchor.x) / (TILE_M_PER_DEG_LON * Math.cos(anchor.lat * Math.PI / 180)),
  };
}

function tileLatLonToLocal(anchor, lat, lon) {
  return {
    x: anchor.x + (lon - anchor.lon) * TILE_M_PER_DEG_LON * Math.cos(anchor.lat * Math.PI / 180),
    y: anchor.y + (anchor.lat - lat) * TILE_M_PER_DEG_LAT,
  };
}

// Web-Mercator: lat/lon → fractional tile coordinates at zoom z, and back.
function tileFromLatLon(lat, lon, z) {
  const n = Math.pow(2, z);
  const rad = lat * Math.PI / 180;
  return {
    x: (lon + 180) / 360 * n,
    y: (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n,
  };
}

function tileToLatLon(tx, ty, z) {
  const n = Math.pow(2, z);
  return {
    lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI,
    lon: tx / n * 360 - 180,
  };
}

// Zoom where one tile pixel ≈ one canvas pixel. pxPerM is canvas px per
// metre, so a DPR-scaled canvas naturally pulls sharper (higher-z) tiles.
function tileZoomFor(lat, pxPerM) {
  const z = Math.round(Math.log2(TILE_EQUATOR_M * Math.cos(lat * Math.PI / 180) * pxPerM));
  return Math.max(TILE_MIN_Z, Math.min(TILE_MAX_Z, z));
}

// --- Fetch cache (browser only) ----------------------------------------------
const tileCache = new Map(); // 'z/x/y' -> { img, ok, failed }

function tileGet(z, x, y) {
  const n = Math.pow(2, z);
  if (y < 0 || y >= n) return null;               // off the projection
  const wx = ((x % n) + n) % n;                    // wrap around the antimeridian
  const key = z + '/' + wx + '/' + y;
  let e = tileCache.get(key);
  if (e) return e;
  if (tileCache.size >= TILE_CACHE_MAX) {
    for (const k of tileCache.keys()) {           // evict oldest inserted
      tileCache.delete(k);
      if (tileCache.size < TILE_CACHE_MAX * 0.9) break;
    }
  }
  e = { img: new Image(), ok: false, failed: false };
  e.img.crossOrigin = 'anonymous';
  e.img.onload = () => { e.ok = true; };
  e.img.onerror = () => { e.failed = true; };
  e.img.src = 'https://' + 'abcd'[(wx + y) % 4] + '.basemaps.cartocdn.com/dark_all/' + key + '.png';
  tileCache.set(key, e);
  return e;
}

// Draw the basemap for the current view. Returns true when the frame is
// georeferenced (caller then skips the abstract grid), false otherwise.
function drawTiles(ctx, cv, view, anchor) {
  if (!anchor) return false;
  const z = tileZoomFor(anchor.lat, view.pxPerM);
  // Screen corners → lat/lon → fractional tile range at z.
  const tl = screenToWorld(view, cv, 0, 0);
  const br = screenToWorld(view, cv, cv.width, cv.height);
  const llTL = tileLocalToLatLon(anchor, tl.x, tl.y);
  const llBR = tileLocalToLatLon(anchor, br.x, br.y);
  const tTL = tileFromLatLon(llTL.lat, llTL.lon, z);
  const tBR = tileFromLatLon(llBR.lat, llBR.lon, z);
  const x0 = Math.floor(tTL.x), x1 = Math.floor(tBR.x);
  const y0 = Math.floor(tTL.y), y1 = Math.floor(tBR.y);
  if (x1 - x0 > TILE_GRID_CAP || y1 - y0 > TILE_GRID_CAP) return true; // absurd zoom-out: keep bg
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const e = tileGet(z, tx, ty);
      if (!e || !e.ok) continue;                  // still loading / failed: bg shows
      // Tile corners → local metres → screen. Adjacent tiles share exact
      // corner math, so edges meet without seams.
      const nw = tileToLatLon(tx, ty, z);
      const se = tileToLatLon(tx + 1, ty + 1, z);
      const lNW = tileLatLonToLocal(anchor, nw.lat, nw.lon);
      const lSE = tileLatLonToLocal(anchor, se.lat, se.lon);
      const pNW = worldToScreen(view, cv, lNW.x, lNW.y);
      const pSE = worldToScreen(view, cv, lSE.x, lSE.y);
      ctx.drawImage(e.img, pNW.x, pNW.y, pSE.x - pNW.x, pSE.y - pNW.y);
    }
  }
  // A light theme veil so the sim overlay keeps its contrast on the imagery.
  ctx.fillStyle = 'rgba(19,20,16,0.30)';
  ctx.fillRect(0, 0, cv.width, cv.height);
  return true;
}

// UMD-lite export so the projection math is unit-testable under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    tileLocalToLatLon, tileLatLonToLocal, tileFromLatLon, tileToLatLon, tileZoomFor,
    TILE_MIN_Z, TILE_MAX_Z, TILE_EQUATOR_M,
  };
}

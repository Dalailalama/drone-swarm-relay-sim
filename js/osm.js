// Real-world areas from OpenStreetMap — buildings for any place on Earth.
//
// Turns a lat/lon + radius into the same axis-aligned building boxes the
// procedural city uses ({x, y, w, d, heightM}), so LOS, routing, rendering
// and the spatial index all work unchanged over real geography. Data comes
// from the public Overpass API at runtime (no code dependencies); heights
// use the building's own `height` tag when mapped, else floor count, else a
// low-rise default — and each building remembers whether its height was
// measured or estimated, because our radio physics depends on it.
//
// OpenStreetMap data is © OpenStreetMap contributors, ODbL — the UI credits
// this whenever an imported area is active.

const OSM_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OSM_NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// The ONE local projection shared by OSM import, the tile basemap and TAK
// (they all load after this file): equirectangular about the anchor, scaled
// by the WGS-84 meridian (M) and prime-vertical (N) radii at the anchor's
// latitude. Under 1 m of error within ~3 km of the anchor.
const GEO_WGS84_A = 6378137, GEO_WGS84_E2 = 6.69437999014e-3;
function geoMetresPerDeg(latDeg) {
  const phi = latDeg * Math.PI / 180, s = Math.sin(phi);
  const w = 1 - GEO_WGS84_E2 * s * s;
  return {
    lat: GEO_WGS84_A * (1 - GEO_WGS84_E2) / Math.pow(w, 1.5) * Math.PI / 180,
    lon: GEO_WGS84_A / Math.sqrt(w) * Math.cos(phi) * Math.PI / 180,
  };
}
const OSM_LEVEL_HEIGHT_M = 3.2;   // storey height when only a floor count is mapped
const OSM_DEFAULT_HEIGHT_M = 9;   // untagged building: low-rise guess (~3 floors)
const OSM_MAX_BUILDINGS = 6000;   // keep the biggest N; renderer & physics stay smooth

// "18.5", "18.5 m", "60 ft" → metres; null if unparseable.
function osmParseHeight(v) {
  if (v == null) return null;
  const m = String(v).match(/^\s*(-?[\d.]+)\s*(m|ft|feet|')?\s*$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  return (m[2] && m[2].toLowerCase() !== 'm') ? n * 0.3048 : n;
}

// One Overpass `way` element (out geom) → AABB building box in local metres,
// or null if degenerate. Frame matches the sim: x=East, y=South, origin at
// (lat0, lon0) — north is up on screen like a real map.
function osmWayToBuilding(el, lat0, lon0) {
  if (!el || el.type !== 'way' || !el.geometry || el.geometry.length < 3) return null;
  const k = geoMetresPerDeg(lat0);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const g of el.geometry) {
    const x = (g.lon - lon0) * k.lon;
    const y = (lat0 - g.lat) * k.lat;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const w = maxX - minX, d = maxY - minY;
  if (!(w > 2 && d > 2)) return null; // slivers and bad geometry
  const tags = el.tags || {};
  let heightM = osmParseHeight(tags.height) ?? osmParseHeight(tags['building:height']);
  let estimated = false;
  if (heightM == null) {
    const levels = parseFloat(tags['building:levels']);
    if (isFinite(levels) && levels > 0) { heightM = levels * OSM_LEVEL_HEIGHT_M + 2; }
    else heightM = OSM_DEFAULT_HEIGHT_M;
    estimated = true;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w, d, heightM, estimated };
}

// Multipolygon relation (out geom) → its outer rings as point lists. Mappers
// split one outer ring across several untagged ways, in either direction, so
// stitch them end to end. Inner rings (courtyards) are ignored: a box per
// outer ring is the same approximation every building gets.
function osmOuterRings(rel) {
  const same = (p, q) => p.lat === q.lat && p.lon === q.lon;
  const segs = (rel.members || [])
    .filter(m => m.type === 'way' && m.role === 'outer' && m.geometry && m.geometry.length >= 2)
    .map(m => m.geometry);
  const rings = [];
  while (segs.length) {
    let ring = segs.shift().slice();
    for (let grew = true; grew && !same(ring[0], ring[ring.length - 1]);) {
      grew = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (same(s[0], end)) ring = ring.concat(s.slice(1));
        else if (same(s[s.length - 1], end)) ring = ring.concat(s.slice(0, -1).reverse());
        else continue;
        segs.splice(i, 1); grew = true; break;
      }
    }
    rings.push(ring);
  }
  return rings;
}

// Full Overpass JSON → building list, biggest-footprint first, capped.
// Ways are buildings directly; multipolygon relations carry the tags on the
// relation and give one box per outer ring. Pure and unit-testable.
function osmParseBuildings(json, lat0, lon0) {
  const out = [];
  for (const el of (json && json.elements) || []) {
    if (el && el.tags && el.tags.building === 'no') continue;
    if (el && el.type === 'relation') {
      for (const ring of osmOuterRings(el)) {
        const b = osmWayToBuilding({ type: 'way', tags: el.tags, geometry: ring }, lat0, lon0);
        if (b) out.push(b);
      }
      continue;
    }
    const b = osmWayToBuilding(el, lat0, lon0);
    if (b) out.push(b);
  }
  out.sort((a, b) => (b.w * b.d) - (a.w * a.d));
  const dropped = Math.max(0, out.length - OSM_MAX_BUILDINGS);
  return { buildings: out.slice(0, OSM_MAX_BUILDINGS), dropped };
}

// Real places have no polite clearing for a ground station: carve a small
// staging area at the GCS and the objective so the mast isn't spawned inside
// somebody's roof. Returns how many buildings were cleared, honestly.
function osmClearZones(buildings, zones) {
  let cleared = 0;
  for (let i = buildings.length - 1; i >= 0; i--) {
    const b = buildings[i];
    if (zones.some(z => Math.hypot(b.x - z.x, b.y - z.y) < z.rM)) { buildings.splice(i, 1); cleared++; }
  }
  return cleared;
}

// "19.07, 72.87" → {lat, lon}; anything else → null (treat as a place name).
function osmParseLatLon(text) {
  const m = String(text).match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// --- Network (browser only) --------------------------------------------------

async function osmGeocode(query) {
  const url = OSM_NOMINATIM + '?format=json&limit=1&q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Place search failed (' + res.status + ')');
  const hits = await res.json();
  if (!hits.length) throw new Error('No place found for "' + query + '"');
  return { lat: parseFloat(hits[0].lat), lon: parseFloat(hits[0].lon), name: hits[0].display_name };
}

// Building ways AND multipolygon building relations (whose outer ways are
// untagged, so a way-only query never sees them); building=no is not one.
function osmBuildingQuery(lat, lon, radiusM) {
  const around = '(around:' + Math.round(radiusM) + ',' + lat.toFixed(6) + ',' + lon.toFixed(6) + ')';
  return '[out:json][timeout:25];(way["building"]["building"!="no"]' + around +
    ';relation["building"]["type"="multipolygon"]' + around + ';);out geom;';
}

async function osmFetchArea(lat, lon, radiusM) {
  const q = osmBuildingQuery(lat, lon, radiusM);
  let lastErr = null;
  for (const ep of OSM_ENDPOINTS) {
    try {
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) { lastErr = new Error('Overpass ' + res.status + ' (busy — try again in a minute)'); continue; }
      const json = await res.json();
      const { buildings, dropped } = osmParseBuildings(json, lat, lon);
      return { lat, lon, radiusM, buildings, dropped };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Overpass unreachable');
}

// UMD-lite export so parsing is unit-testable under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    geoMetresPerDeg, osmParseHeight, osmWayToBuilding, osmParseBuildings, osmBuildingQuery, osmClearZones, osmParseLatLon,
    OSM_LEVEL_HEIGHT_M, OSM_DEFAULT_HEIGHT_M, OSM_MAX_BUILDINGS,
  };
}

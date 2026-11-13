// ATAK / TAK integration — speak the actual format public-safety and defense
// teams already run: Cursor-on-Target (CoT) XML atoms.
//
// Two directions, both zero-dependency:
//   EXPORT — the whole common operating picture (every drone, the command
//   post, the objective, denial zones, GNSS dead zones) serialized as CoT
//   atoms. Download as a snapshot file, or stream continuously over
//   WebSocket to sitl/tak_bridge.py, which pushes them onto TAK's standard
//   UDP multicast so a real ATAK client sees the swarm live.
//   IMPORT — drop a CoT file (marks from another ATAK user) and its points
//   land on the map; one click turns any imported marker into the mission
//   objective.
//
// Georeferencing is honest about being approximate: the sim world is metres
// in a local tangent plane. With a real OSM area loaded we reuse its exact
// geographic anchor; otherwise an operator-entered origin converts local
// metres to lat/lon equirectangularly with the WGS-84 scale at the anchor —
// the same projection OSM import and the basemap use (js/osm.js
// geoMetresPerDeg) — under 1 m of error within ~3 km of the anchor.

const takGeoScale = typeof geoMetresPerDeg === 'function'
  ? geoMetresPerDeg : require('./osm.js').geoMetresPerDeg;
const takWrapLon = typeof geoWrapLon === 'function'
  ? geoWrapLon : require('./osm.js').geoWrapLon;

// haeM: height above ellipsoid of the LOCAL FRAME's zero-ground reference —
// the vertical datum for every exported altitude (finding #26). null means
// the operator hasn't supplied one, and exports then send TAK's UNKNOWN
// value (hae/le 9999999) rather than stamping a number in the wrong datum.
// hae is a required <point> attribute (atak-civ takcot point.xsd), so it
// cannot simply be left out.
function makeTakAnchor(latDeg, lonDeg, xLocal, yLocal, haeM) {
  return { lat: latDeg, lon: lonDeg, x: xLocal || 0, y: yLocal || 0, haeM: haeM != null ? haeM : null };
}

// Sim frame: x east-positive, y SOUTH-positive (screen style). South is
// negative latitude, hence the minus sign on y. Longitude wraps at the
// antimeridian both ways: exports stay inside point.xsd's -180..180, and a
// mark just across the line imports metres away, not around the planet.
function localToLatLon(anchor, x, y) {
  const k = takGeoScale(anchor.lat);
  return {
    lat: anchor.lat - (y - anchor.y) / k.lat,
    lon: takWrapLon(anchor.lon + (x - anchor.x) / k.lon),
  };
}

function latLonToLocal(anchor, lat, lon) {
  const k = takGeoScale(anchor.lat);
  return {
    x: anchor.x + takWrapLon(lon - anchor.lon) * k.lon,
    y: anchor.y - (lat - anchor.lat) * k.lat,
  };
}

// CoT types per the MITRE CoTtypes.xml (a-.-A-M-H-Q = Air/Mil/Rotor/
// Drone,RPV,UAV; b-m-p-w = waypoint) and ATAK's drawn circle (u-d-c-c).
const TAK_TYPES = {
  drone: 'a-f-A-M-H-Q',     // friendly rotary-wing UAV
  gcs: 'a-f-G-U-C',         // friendly ground unit (the C2 ground station)
  objective: 'b-m-p-w',     // mission objective: a waypoint, not a unit
  hazard: 'u-d-c-c',        // drawn circle (denial / GNSS-dead zone)
};
const TAK_UNKNOWN = '9999999.0'; // CotConstants.UNKNOWN_VALUE (hae/ce/le)

function cotTimestamp(secSinceEpoch) {
  // CoT wants ISO 8601 UTC (Z).
  return new Date(secSinceEpoch * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

// One CoT atom. haeM = height above ellipsoid (metres).
function cotEvent(o) {
  const t = cotTimestamp(o.nowSec || Date.now() / 1000);
  const stale = cotTimestamp((o.nowSec || Date.now() / 1000) + (o.staleSec || 30));
  const ce = o.ceM != null ? o.ceM : 15;
  // No vertical datum: hae AND its vertical error are unknown.
  const hae = o.haeM != null ? o.haeM.toFixed(1) : TAK_UNKNOWN;
  const le = o.haeM == null ? TAK_UNKNOWN : (o.leM != null ? o.leM : 15);
  // how="m-s": machine-generated, simulated (MITRE CoT how codes) — never
  // m-g (GPS fix), since the bridge can put these on a real TAK net.
  let xml = '<event version="2.0" uid="' + esc(o.uid) + '" type="' + o.cotType +
    '" time="' + t + '" start="' + t + '" stale="' + stale + '" how="m-s">' +
    '<point lat="' + o.lat.toFixed(7) + '" lon="' + o.lon.toFixed(7) + '"' +
    ' hae="' + hae + '" ce="' + ce + '" le="' + le + '"/>' +
    '<detail><contact callsign="' + esc(o.callsign || o.uid) + '"/>';
  if (o.radiusM != null) {
    // atak-civ shape.xsd ellipse: major/minor/angle only.
    xml += '<shape><ellipse major="' + o.radiusM.toFixed(0) + '" minor="' + o.radiusM.toFixed(0) +
      '" angle="0"/></shape>';
  }
  if (o.remarks) xml += '<remarks>' + esc(o.remarks) + '</remarks>';
  xml += '</detail></event>';
  return xml;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unesc(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// CoT uid is "a globally unique name" and the newest event for a uid
// overwrites every earlier one (MITRE base schema), so fixed SIM-* uids made
// two simulator tabs or operators on one TAK net overwrite each other's
// tracks. Each page draws a prefix from browser randomness once at load
// (UI only; the sim stays seeded): bytes → "SIM-12ab00".
function makeTakUidPrefix(bytes) {
  return 'SIM-' + Array.from(bytes, v => (v & 255).toString(16).padStart(2, '0')).join('');
}

// The full picture, straight off a live swarm object. Returns an array of
// atom strings (callers join with \n for file or wire). uidPrefix names this
// instance on the TAK net (default 'SIM').
function buildCotFromSwarm(s, anchor, nowSec, uidPrefix) {
  const pre = (uidPrefix || 'SIM') + '-';
  const out = [];
  const put = (uid, cotType, x, y, hae, callsign, extra) => {
    const ll = localToLatLon(anchor, x, y);
    out.push(cotEvent(Object.assign({
      uid, cotType, lat: ll.lat, lon: ll.lon, haeM: hae,
      callsign, nowSec: nowSec != null ? nowSec : (Date.now() / 1000),
    }, extra || {})));
  };
  const roleOf = d => d.order && d.order.role ? d.order.role : 'mission';
  // Vertical datum (finding #26): every exported altitude is the anchor's
  // HAE plus the local ABSOLUTE altitude (terrain under the object + its
  // height above ground). With no anchor HAE, hae is TAK's unknown value
  // 9999999, which is the truth.
  const groundAt = (x, y) => (typeof terrainGroundAt === 'function' && s.terrain)
    ? terrainGroundAt(s.terrain, x, y) : 0;
  const haeOf = absAltM => (anchor.haeM != null ? anchor.haeM + absAltM : null);
  put(pre + 'GCS', TAK_TYPES.gcs, s.base.x, s.base.y,
    haeOf(groundAt(s.base.x, s.base.y) + 2), 'C2 GROUND STATION',
    { remarks: 'relay chain hops=' + (s.c2 && s.c2.relays ? s.c2.relays.length : 0) });
  for (const d of s.drones) {
    if (!alive(d)) continue;
    const aglM = d.altM != null ? d.altM : s.altitudeM; // external telemetry AGL wins
    put(pre + d.id, TAK_TYPES.drone, d.x, d.y,
      haeOf(groundAt(d.x, d.y) + aglM),
      d.id + ' ' + roleOf(d),
      { remarks: 'bat ' + d.batteryPct.toFixed(0) + '% mode ' + d.mode, staleSec: 20, ceM: 10 });
  }
  put(pre + 'TGT', TAK_TYPES.objective, s.target.x, s.target.y,
    haeOf(groundAt(s.target.x, s.target.y)), 'OBJECTIVE',
    { remarks: 'mission objective' });
  for (const j of (s.jammers || [])) {
    const r = jammerDenialRadiusM(s, j);
    if (!(r > 0)) continue;
    put(pre + j.id, TAK_TYPES.hazard, j.x, j.y,
      haeOf(groundAt(j.x, j.y) + (j.altM ?? JAMMER_DEFAULT_ALT_M)), 'RF DENIAL ' + j.id.replace('JX-', ''),
      { radiusM: r, remarks: 'denial ~' + Math.round(r) + ' m @ ' + j.erpDbm + ' dBm', staleSec: 60 });
  }
  for (const z of (s.gpsZones || [])) {
    if (z.on === false) continue;
    put(pre + z.id, TAK_TYPES.hazard, z.x, z.y,
      haeOf(groundAt(z.x, z.y)), 'GPS DENIED ' + z.id.replace('GZ-', ''),
      { radiusM: z.rM, remarks: 'GNSS denied zone r=' + Math.round(z.rM) + ' m', staleSec: 60 });
  }
  return out;
}

// --- Import ------------------------------------------------------------------
// Regex parsing on purpose: CoT files are flat lists of <event> documents,
// and the sim must parse them identically in browser and Node (no DOMParser
// under Node, no dependencies allowed).
function parseCoTFile(text) {
  const marks = [];
  // Every scan stays inside ONE atom: import runs on the UI thread, and a
  // search that ran to the end of the file per atom made a crafted file of
  // unclosed atoms O(n²) (seconds at 16k atoms). `<` can't appear raw in an
  // XML attribute, so a tag that never closes stops at the next `<`.
  const evRe = /<event\b[^<>]*>/g;
  // Quotes match their OPENING delimiter via backreference (finding #27):
  // the old ["']...["'] class let either quote end either style, truncating
  // callsign="O'Brien" to "O". The opposite quote inside is data. The name
  // must start after whitespace, or parent_callsign= would match callsign=.
  const attrRaw = (str, name) => {
    const m = str.match(new RegExp('(?:^|\\s)' + name + '=(["\'])([\\s\\S]*?)\\1'));
    return m ? m[2] : null;
  };
  const attr = (tag, name) => {
    const v = attrRaw(tag, name);
    return v == null ? null : unesc(v);
  };
  const starts = [];
  let m;
  while ((m = evRe.exec(text)) !== null) starts.push(m);
  for (let i = 0; i < starts.length; i++) {
    const tag = starts[i][0];
    const uid = attr(tag, 'uid');
    const type = attr(tag, 'type') || 'a-u-?';
    // An atom runs to its </event>, or to the next <event> if it never closes.
    let scope = text.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : text.length);
    const close = scope.indexOf('</event>');
    if (close !== -1) scope = scope.slice(0, close);
    const pm = scope.match(/<point\b[^<>]*\/?>/);
    if (!pm) continue;
    const lat = parseFloat(attrRaw(pm[0], 'lat'));
    const lon = parseFloat(attrRaw(pm[0], 'lon'));
    const hae = parseFloat(attrRaw(pm[0], 'hae'));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    // The mark's own name is on <contact>, not <link parent_callsign=...>.
    const cm = scope.match(/<contact\b[^<>]*>/);
    const cs = cm ? attrRaw(cm[0], 'callsign') : null;
    marks.push({
      uid: uid || 'cot-' + marks.length,
      cotType: type,
      lat, lon,
      hae: isFinite(hae) && hae < 9999999 ? hae : null, // 9999999: TAK unknown
      callsign: cs != null ? unesc(cs) : uid || 'marker'
    });
  }
  return marks;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    makeTakAnchor, localToLatLon, latLonToLocal,
    TAK_TYPES, cotEvent, makeTakUidPrefix, buildCotFromSwarm, parseCoTFile,
  };
}

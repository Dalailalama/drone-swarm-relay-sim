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
// metres to lat/lon equirectangularly — sub-metre accuracy at the few-km
// scales this simulator flies, which is far inside CoT's own precision.

const M_PER_DEG_LAT = 111320;

function makeTakAnchor(latDeg, lonDeg, xLocal, yLocal) {
  return { lat: latDeg, lon: lonDeg, x: xLocal || 0, y: yLocal || 0 };
}

// Sim frame: x east-positive, y SOUTH-positive (screen style). South is
// negative latitude, hence the minus sign on y.
function localToLatLon(anchor, x, y) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(anchor.lat * Math.PI / 180);
  return {
    lat: anchor.lat - (y - anchor.y) / M_PER_DEG_LAT,
    lon: anchor.lon + (x - anchor.x) / mPerDegLon,
  };
}

function latLonToLocal(anchor, lat, lon) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(anchor.lat * Math.PI / 180);
  return {
    x: anchor.x + (lon - anchor.lon) * mPerDegLon,
    y: anchor.y - (lat - anchor.lat) * M_PER_DEG_LAT,
  };
}

// Conventional CoT types (ATAK renders any well-formed atom; these are the
// usual choices for small UAS work).
const TAK_TYPES = {
  drone: 'a-f-A-M-H-U',     // airborne rotary-wing UAS
  gcs: 'a-f-G-U-C',         // friendly ground unit, command post
  hazard: 'a-n-G-A-c',      // area hazard (denial / GNSS-dead circle)
};

function cotTimestamp(secSinceEpoch) {
  // CoT wants ISO 8601 UTC (Z).
  return new Date(secSinceEpoch * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
}

// One CoT atom. haeM = height above ellipsoid (metres).
function cotEvent(o) {
  const t = cotTimestamp(o.nowSec || Date.now() / 1000);
  const stale = cotTimestamp((o.nowSec || Date.now() / 1000) + (o.staleSec || 30));
  const ce = o.ceM != null ? o.ceM : 15;
  const le = o.leM != null ? o.leM : 15;
  let xml = '<event version="2.0" uid="' + esc(o.uid) + '" type="' + o.cotType +
    '" time="' + t + '" start="' + t + '" stale="' + stale + '" how="m-g">' +
    '<point lat="' + o.lat.toFixed(7) + '" lon="' + o.lon.toFixed(7) +
    '" hae="' + (o.haeM || 0).toFixed(1) + '" ce="' + ce + '" le="' + le + '"/>' +
    '<detail><contact callsign="' + esc(o.callsign || o.uid) + '"/>';
  if (o.radiusM != null) {
    xml += '<shape><ellipse cx="' + o.radiusM.toFixed(0) + '" cy="' + o.radiusM.toFixed(0) +
      '" major="' + o.radiusM.toFixed(0) + '" minor="' + o.radiusM.toFixed(0) + '" angle="0"/></shape>';
  }
  if (o.remarks) xml += '<remarks>' + esc(o.remarks) + '</remarks>';
  xml += '</detail></event>';
  return xml;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The full picture, straight off a live swarm object. Returns an array of
// atom strings (callers join with \n for file or wire).
function buildCotFromSwarm(s, anchor, nowSec) {
  const out = [];
  const put = (uid, cotType, x, y, hae, callsign, extra) => {
    const ll = localToLatLon(anchor, x, y);
    out.push(cotEvent(Object.assign({
      uid, cotType, lat: ll.lat, lon: ll.lon, haeM: hae,
      callsign, nowSec: nowSec != null ? nowSec : (s ? s.time : 0),
    }, extra || {})));
  };
  const roleOf = d => d.order && d.order.role ? d.order.role : 'mission';
  put('SIM-GCS', TAK_TYPES.gcs, s.base.x, s.base.y, 2, 'C2 GROUND STATION',
    { remarks: 'relay chain hops=' + (s.c2 && s.c2.relays ? s.c2.relays.length : 0) });
  for (const d of s.drones) {
    if (!alive(d)) continue;
    put('SIM-' + d.id, TAK_TYPES.drone, d.x, d.y, s.altitudeM,
      d.id + ' ' + roleOf(d),
      { remarks: 'bat ' + d.batteryPct.toFixed(0) + '% mode ' + d.mode, staleSec: 20, ceM: 10 });
  }
  put('SIM-TGT', TAK_TYPES.gcs, s.target.x, s.target.y, 0, 'OBJECTIVE',
    { remarks: 'mission objective' });
  for (const j of (s.jammers || [])) {
    const r = jammerDenialRadiusM(s, j);
    if (!(r > 0)) continue;
    put('SIM-' + j.id, TAK_TYPES.hazard, j.x, j.y, 0, 'RF DENIAL ' + j.id.replace('JX-', ''),
      { radiusM: r, remarks: 'denial ~' + Math.round(r) + ' m @ ' + j.erpDbm + ' dBm', staleSec: 60 });
  }
  for (const z of (s.gpsZones || [])) {
    if (z.on === false) continue;
    put('SIM-' + z.id, TAK_TYPES.hazard, z.x, z.y, 0, 'GPS DENIED ' + z.id.replace('GZ-', ''),
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
  const evRe = /<event\b[^>]*>/g;
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(name + '="([^"]*)"'));
    return m ? m[1] : null;
  };
  let m;
  while ((m = evRe.exec(text)) !== null) {
    const tag = m[0];
    const uid = attr(tag, 'uid');
    const type = attr(tag, 'type') || 'a-u-?';
    // point may follow anywhere after <event> up to </event> or next event
    const end = text.indexOf('</event>', m.index);
    const scope = text.slice(m.index, end === -1 ? m.index + 2000 : end);
    const pm = scope.match(/<point\b[^>]*\/?>/);
    if (!pm) continue;
    const lat = parseFloat((pm[0].match(/lat="([^"]*)"/) || [])[1]);
    const lon = parseFloat((pm[0].match(/lon="([^"]*)"/) || [])[1]);
    const hae = parseFloat((pm[0].match(/hae="([^"]*)"/) || [])[1]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const cm = scope.match(/callsign="([^"]*)"/);
    marks.push({ uid: uid || 'cot-' + marks.length, cotType: type, lat, lon, hae: isFinite(hae) ? hae : 0, callsign: cm ? cm[1] : uid || 'marker' });
  }
  return marks;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    M_PER_DEG_LAT, makeTakAnchor, localToLatLon, latLonToLocal,
    TAK_TYPES, cotEvent, buildCotFromSwarm, parseCoTFile,
  };
}

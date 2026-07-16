// Swarm simulation with distributed knowledge.
//
// Three separate worlds, on purpose:
//   TRUTH   — actual positions, batteries, radio physics (this file's state)
//   C2      — what the ground station believes, built only from telemetry
//             packets that physically arrived (s.c2.known)
//   DRONE   — what each drone believes: the last order packet it received
//             (d.order) and how long since it heard from C2 (d.lastC2)
//
// C2 plans relays from its beliefs and sends orders as packets. Drones obey
// the orders that arrive, and run onboard failsafes when the link goes quiet:
// hold position first, then fly home until contact returns (regain-link RTL —
// the behavior that lets a broken chain heal itself).

const DRONE = {
  accelMs2: 4,
  separationM: 25,
  orbitRadiusM: 60,
  landThresholdM: 25,
};

const RELAY = {
  deployFrac: 0.80,     // default hop spacing as a fraction of usable range
  recallHysteresis: 1.19, // recall span = deploy span × this (prevents flapping)
  minBatteryPct: 30,
};

const FAILSAFE = {
  holdSec: 8,          // silence before a drone freezes in place
  rtlMissionSec: 30,   // silence before a mission drone retreats to regain link
  rtlRelaySec: 90,     // relays hold much longer — they ARE the link
  relinkWaitSec: 35,   // listen time at each relink attempt point
  relinkArriveM: 40,   // "close enough" to an attempt point
  relinkAttempts: 3,   // tries before giving up and flying home to C2
  relinkStepFrac: 0.7, // each failed attempt falls back this fraction of usable range toward base
};

const RESCUE = {
  delaySec: 12,        // give the drones' own failsafes a moment first
  memorySec: 180,      // how long C2 hunts for a silent drone before giving up
  maxChain: 3,         // rescuers may chain off each other this many deep
};

const C2 = {
  cmdIntervalSec: 1.0,   // order broadcast rate
  tlmIntervalSec: 2.0,   // drone telemetry rate
  staleSec: 6,           // missed ~3 telemetry → C2 treats drone as out of contact
  forgetSec: 25,         // C2 drops it from planning entirely
};

const BATTERY = {
  homeMargin: 1.3,      // plan the flight home with 30% pessimism
  reserveFrac: 0.07,    // plus a fixed floor of usable energy
  swapSec: 90,          // ground-crew battery swap time before relaunch
};

const GPS_SIGMA_M = 1.5; // typical GNSS horizontal error — C2 sees noisy positions

// Tether rule: never outrun your link. Each drone tracks the beacon RSSI of
// its upstream chain neighbor; as that margin thins it stops extending, and
// when it nearly dies it closes back in. Thresholds sit just under the
// planned per-hop margin, so tighter hop-spacing settings still work — the
// tether is a floor, not a leash of fixed length.
const TETHER = {
  emaAlpha: 0.15,       // beacon RSSI smoothing per tick
  slowBelowPlanDb: 1.5, // start pausing extension this far under planned margin
  stopBelowPlanDb: 6,   // close back in this far under planned margin
  minSlowDb: 1.5,
  minStopDb: 0.5,
};

function plannedHopMarginDb(s) {
  return linkMarginDb(s.radio, s.envFactor, usableRangeM(s.radio, s.envFactor) * s.deployFrac);
}

const COVERAGE = {
  deadLogIntervalSec: 5,  // while disconnected, log a dead-zone sample this often
  deadLogMax: 20,         // onboard black-box capacity
  searchRadiusCells: 5,   // how far C2 will shift a relay slot out of a bad cell
};

// Regulatory duty cycle stretches how often a node may transmit at all.
function tlmIntervalSec(s) {
  const tx = (NET.tlmBytes * 8) / (s.radio.airRateKbps * 1000);
  return Math.max(C2.tlmIntervalSec, s.radio.dutyCycle ? tx / s.radio.dutyCycle : 0);
}

function cmdIntervalSec(s, nDrones) {
  // Broadcast mode: ONE packet per round regardless of fleet size — the
  // whole reason low-bandwidth C2 links broadcast instead of unicasting.
  const bytes = s.broadcastC2
    ? NET.bcastHeaderBytes + NET.bcastRowBytes * nDrones
    : NET.cmdBytes * nDrones;
  const tx = (bytes * 8) / (s.radio.airRateKbps * 1000);
  return Math.max(C2.cmdIntervalSec, s.radio.dutyCycle ? tx / s.radio.dutyCycle : 0);
}

let droneSeq = 0;

function makeDrone(x, y, target, rng, airframe) {
  droneSeq += 1;
  return {
    id: 'DR-' + droneSeq,
    x, y, vx: 0, vy: 0,
    energyWh: usableWh(airframe),
    batteryPct: 100,
    // Onboard state — the drone's own little world
    order: { role: 'mission', slot: -1, k: 0, upstream: 'C2', target: { x: target.x, y: target.y } }, // preflight upload
    upMarginEma: 30, // smoothed RSSI margin to the upstream neighbor, dB
    mode: 'ok',            // ok | hold | relink | rtl | rtb | landed | dead
    lastC2: 0,
    holdX: 0, holdY: 0,
    lastLinkX: x, lastLinkY: y, // where the link last provably worked
    relinkUntil: null,
    relinkAttempt: 0,
    relinkGoalX: 0, relinkGoalY: 0,
    rejectedRole: null, rejectedSig: null,
    deadLog: [],          // onboard black box: positions where the link was dead
    nextDeadLog: 0,
    bcastSeen: 0,         // highest broadcast sequence heard (flood dedup)
    inbox: [],
    nextTlm: rng() * C2.tlmIntervalSec,
    orbitPhase: rng() * Math.PI * 2,
  };
}

function makeSwarm(opts) {
  droneSeq = 0;
  const s = {
    base: { x: 0, y: 0 },
    target: { x: opts.targetX, y: opts.targetY },  // C2 operator intent
    drones: [],
    time: 0,
    airframe: opts.airframe,
    altitudeM: opts.altitudeM || 50,
    deployFrac: opts.deployFrac || RELAY.deployFrac,
    corridorRouting: opts.corridorRouting !== false,
    wind: { x: opts.windX || 0, y: opts.windY || 0 },
    events: [],
    radio: opts.radio,
    envFactor: opts.envFactor,
    shadowSigmaDb: opts.shadowSigmaDb || 0,
    terrain: opts.terrain || makeTerrain('flat'),
    jammers: opts.jammers ? opts.jammers.map(j => ({ ...j })) : [],
    covCellM: Math.max(20, usableRangeM(opts.radio, opts.envFactor) * 0.15),
    showCoverage: true,
    broadcastC2: opts.broadcastC2 !== false,
    captureOn: !!opts.captureOn,
    net: makeNet(opts.seed || 42),
    c2: { known: {}, relays: [], inbox: [], nextCmd: 0, wasFresh: {}, lost: {}, rescuers: [], unfit: {}, cov: new Map(), slotCache: {}, bcastSeq: 0 },
  };
  for (let i = 0; i < opts.count; i++) {
    const a = (i / opts.count) * Math.PI * 2;
    s.drones.push(makeDrone(s.base.x + 60 * Math.cos(a), s.base.y + 60 * Math.sin(a), s.target, s.net.rng, opts.airframe));
  }
  return s;
}

function logEvent(s, msg, kind) {
  s.events.push({ t: s.time, msg, kind: kind || 'info' });
  if (s.events.length > 80) s.events.shift();
}

function dist2d(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function alive(d) { return d.mode !== 'dead' && d.mode !== 'landed'; }
function effRole(d) { return d.mode === 'ok' ? d.order.role : d.mode; }

// --- Learned RF coverage map --------------------------------------------------
// FASTER's three kinds of space, in radio form: measured-good (a packet
// provably arrived from here), measured-bad (a drone sat here in silence),
// and unknown (the model has an opinion but nobody has checked).
function covKey(s, x, y) {
  return Math.floor(x / s.covCellM) + ',' + Math.floor(y / s.covCellM);
}

function covMark(s, x, y, kind, weight) {
  const key = covKey(s, x, y);
  let e = s.c2.cov.get(key);
  if (!e) { e = { good: 0, bad: 0 }; s.c2.cov.set(key, e); }
  e[kind] += weight || 1;
}

function covState(s, x, y) {
  const e = s.c2.cov.get(covKey(s, x, y));
  if (!e) return 'unknown';
  return e.bad > e.good ? 'bad' : 'good';
}

// C2 carries the same terrain database the drones use for avoidance — a
// planned position inside an unfliable building's footprint is a bad plan
// without needing to be flown first. Measured-bad cells cover what the
// terrain map can't predict: the RF shadows.
function insideObstacle(s, pos) {
  return s.terrain.buildings.some(b => {
    const r = buildingObstacleRadiusM(s, b);
    // Overflyable buildings (r === 0) are not obstacles — the flight-time
    // avoidance skips them too, so the planner must not route around a phantom
    // skirt the drones fly straight through.
    return r > 0 && dist2d(pos, b) < r + 10;
  });
}

function badPlan(s, pos) {
  return covState(s, pos.x, pos.y) === 'bad' || insideObstacle(s, pos) || inDenialZone(s, pos);
}

// If a planned position is a bad plan (measured-bad cell or known terrain),
// spiral outward to the nearest position that isn't (perpendicular shifts
// explored first, so chains sidestep shadows rather than shorten).
function covAdjust(s, pos) {
  if (!badPlan(s, pos)) return pos;
  const cell = s.covCellM;
  const B = s.base, T = s.target;
  const L = Math.max(1, dist2d(B, T));
  const px = -(T.y - B.y) / L, py = (T.x - B.x) / L; // perpendicular to spine
  for (let r = 1; r <= COVERAGE.searchRadiusCells; r++) {
    const candidates = [
      { x: pos.x + px * r * cell, y: pos.y + py * r * cell },
      { x: pos.x - px * r * cell, y: pos.y - py * r * cell },
      { x: pos.x + (T.x - B.x) / L * r * cell, y: pos.y + (T.y - B.y) / L * r * cell },
      { x: pos.x - (T.x - B.x) / L * r * cell, y: pos.y - (T.y - B.y) / L * r * cell },
    ];
    for (const c of candidates) {
      if (!badPlan(s, c)) return c;
    }
  }
  return pos; // everything nearby is known-bad — no better idea than the plan
}

const C2_ANTENNA_M = 6; // ground station telemetry mast — BVLOS ops raise these

// --- Chain path planning ------------------------------------------------------
// C2 plans the relay chain along a PATH, not a straight line: A* over its
// legitimate knowledge (terrain database + measured-bad coverage cells),
// slots spaced along the path, then every adjacent hop LOS-validated against
// the terrain model — a ridge between two slots gets an extra relay ON it
// rather than a dead hop across it.
const PLAN = { replanSec: 5, maxSlots: 12 };

function planChain(s) {
  const tKey = Math.round(s.target.x / 40) + ',' + Math.round(s.target.y / 40);
  const cached = s.c2.chainPlan;
  if (cached && cached.tKey === tKey && s.time - cached.at < PLAN.replanSec) return cached;

  const usable = Math.min(usableRangeM(s.radio, s.envFactor), radioHorizonM(C2_ANTENNA_M, s.altitudeM));
  const span = usable * s.deployFrac;
  const cell = Math.max(40, usable * 0.25);
  // The search box must be wide enough to route AROUND the widest denial zone,
  // otherwise A* can't find a detour and the chain fails through it.
  const pad = Math.max(span * 1.5, maxDenialRadiusM(s) * 1.35 + span);
  const minX = Math.min(s.base.x, s.target.x) - pad, maxX = Math.max(s.base.x, s.target.x) + pad;
  const minY = Math.min(s.base.y, s.target.y) - pad, maxY = Math.max(s.base.y, s.target.y) + pad;
  const nx = Math.max(2, Math.ceil((maxX - minX) / cell)), ny = Math.max(2, Math.ceil((maxY - minY) / cell));
  const pos = (ix, iy) => ({ x: minX + (ix + 0.5) * cell, y: minY + (iy + 0.5) * cell });
  const blocked = p => insideObstacle(s, p) || covState(s, p.x, p.y) === 'bad' || inDenialZone(s, p);
  const idx = (ix, iy) => iy * nx + ix;

  const sIx = Math.min(nx - 1, Math.max(0, Math.floor((s.base.x - minX) / cell)));
  const sIy = Math.min(ny - 1, Math.max(0, Math.floor((s.base.y - minY) / cell)));
  const gIx = Math.min(nx - 1, Math.max(0, Math.floor((s.target.x - minX) / cell)));
  const gIy = Math.min(ny - 1, Math.max(0, Math.floor((s.target.y - minY) / cell)));

  // A* (8-connected); measured-good cells slightly cheaper so proven space wins ties
  const gCost = new Map(), from = new Map();
  const open = [{ ix: sIx, iy: sIy, g: 0, f: 0 }];
  gCost.set(idx(sIx, sIy), 0);
  let found = false;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.ix === gIx && cur.iy === gIy) { found = true; break; }
    if (gCost.get(idx(cur.ix, cur.iy)) < cur.g) continue;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const ix = cur.ix + dx, iy = cur.iy + dy;
        if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue;
        const p = pos(ix, iy);
        if ((ix !== gIx || iy !== gIy) && blocked(p)) continue;
        const stepCost = (dx && dy ? 1.4142 : 1) * (covState(s, p.x, p.y) === 'good' ? 0.9 : 1);
        const g = cur.g + stepCost;
        const key = idx(ix, iy);
        if (gCost.has(key) && gCost.get(key) <= g) continue;
        gCost.set(key, g);
        from.set(key, idx(cur.ix, cur.iy));
        const h = Math.hypot(ix - gIx, iy - gIy) * 0.9;
        open.push({ ix, iy, g, f: g + h });
      }
    }
  }

  // Reconstruct → world points → greedy simplify (skip while straight
  // segments stay clear of blocked cells)
  let path = [{ x: s.base.x, y: s.base.y }, { x: s.target.x, y: s.target.y }];
  if (found) {
    const cellsRev = [];
    let k = idx(gIx, gIy);
    while (k !== undefined && k !== idx(sIx, sIy)) { cellsRev.push(k); k = from.get(k); }
    const pts = cellsRev.reverse().map(kk => pos(kk % nx, Math.floor(kk / nx)));
    pts.unshift({ x: s.base.x, y: s.base.y });
    pts[pts.length - 1] = { x: s.target.x, y: s.target.y };
    const clearRun = (a, b) => {
      const n = Math.ceil(dist2d(a, b) / (cell / 2));
      for (let i = 1; i < n; i++) {
        const p = { x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n };
        if (blocked(p)) return false;
      }
      return true;
    };
    path = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !clearRun(pts[i], pts[j])) j--;
      path.push(pts[j]);
      i = j;
    }
  }

  // Slots at even arc-length along the path
  const segs = [];
  let pathLen = 0;
  for (let i = 0; i < path.length - 1; i++) { const L = dist2d(path[i], path[i + 1]); segs.push(L); pathLen += L; }
  const kSlots = Math.min(PLAN.maxSlots, Math.max(0, Math.ceil(pathLen / span) - 1));
  const at = arc => {
    let rem = arc;
    for (let i = 0; i < segs.length; i++) {
      if (rem <= segs[i] || i === segs.length - 1) {
        const f = segs[i] ? rem / segs[i] : 0;
        return { x: path[i].x + (path[i + 1].x - path[i].x) * f, y: path[i].y + (path[i + 1].y - path[i].y) * f };
      }
      rem -= segs[i];
    }
    return path[path.length - 1];
  };
  let slots = [];
  for (let i = 0; i < kSlots; i++) slots.push(at(pathLen * (i + 1) / (kSlots + 1)));

  // LOS-densify with the terrain model: a ridge between adjacent nodes gets
  // a relay on it instead of a dead hop over it (two passes max)
  const altOf = (p, isC2) => terrainGroundAt(s.terrain, p.x, p.y) + (isC2 ? C2_ANTENNA_M : s.altitudeM);
  for (let pass = 0; pass < 2 && slots.length < PLAN.maxSlots; pass++) {
    const nodesL = [s.base, ...slots, s.target];
    let inserted = false;
    for (let i = 0; i < nodesL.length - 1 && slots.length < PLAN.maxSlots; i++) {
      const a = nodesL[i], b = nodesL[i + 1];
      if (losBlocked(s.terrain, a.x, a.y, altOf(a, i === 0), b.x, b.y, altOf(b, false))) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        slots.splice(i === 0 ? 0 : i, 0, mid); // insert between a and b
        inserted = true;
        break; // re-walk with fresh node list
      }
    }
    if (inserted) pass--; // keep passing until clean or capped
    else break;
  }

  const plan = { slots, pathLen, tKey, at: s.time };
  s.c2.chainPlan = plan;
  return plan;
}

// Absolute antenna altitude. Drones terrain-follow: AGL above the ground
// beneath them, like a real terrain-following mission. Ridges between two
// valleys still cut line of sight; buildings are handled as obstacles.
function nodeAltAbsM(s, id, pos) {
  const agl = id === 'C2' ? C2_ANTENNA_M : s.altitudeM;
  return terrainGroundAt(s.terrain, pos.x, pos.y) + agl;
}

// Buildings taller than the swarm's AGL can't be overflown — each one is a
// no-fly cylinder (radius = half footprint diagonal plus a safety skirt).
function buildingObstacleRadiusM(s, b) {
  if (b.heightM <= s.altitudeM) return 0;
  return Math.hypot(b.w, b.d) / 2 + 18;
}

// Live link margin between two nodes: 3D slant-range path loss plus the
// link's current shadowing offset, hard-blocked beyond the radio horizon
// and hard-blocked when terrain cuts the line of sight. This is what
// routing, packet delivery, and the hop display all consume — one
// consistent radio truth.
// --- Interference / denied-RF sources ----------------------------------------
// A generic RF interference source: raises the effective noise floor around it,
// in a matching band, propagating with the same path loss and terrain shadowing
// as any signal. This models congested urban spectrum, a broadcast tower, a
// downed/rogue emitter, or deliberate jamming — one entity for every use case.
// Because it feeds straight into liveMarginDb, the coverage map LEARNS the
// denied zone, the tether keeps drones from flying into it, and ETX routing
// bends the chain around it — no special-case logic anywhere else.
const JAM_SNR_OFFSET_DB = 10; // gap between raw interference power and the usable-floor scale

// Elevated noise floor (dBm, in sensitivity-equivalent terms) that all active
// interference sources impose on a receiver at rxPos/rxAlt. -Infinity if none.
function interferenceFloorDbm(s, rxPos, rxAlt) {
  const jams = s.jammers;
  if (!jams || !jams.length) return -Infinity;
  const n = pathLossExponent(s.radio);
  const pl1 = pl1m(s.radio.freqMHz);
  let lin = 0;
  for (const j of jams) {
    if (j.on === false) continue;
    if (j.band !== 'all' && Math.abs(j.band - s.radio.freqMHz) > 150) continue; // out of band
    const ground = Math.hypot(rxPos.x - j.x, rxPos.y - j.y);
    const jAlt = terrainGroundAt(s.terrain, j.x, j.y) + (j.altM || 15);
    if (losBlocked(s.terrain, j.x, j.y, jAlt, rxPos.x, rxPos.y, rxAlt)) continue; // terrain shadows it
    const slant = Math.hypot(ground, jAlt - rxAlt);
    const pl = pl1 + 10 * n * Math.log10(Math.max(1, slant / s.envFactor));
    lin += Math.pow(10, (j.erpDbm - pl) / 10);
  }
  return lin > 0 ? 10 * Math.log10(lin) + JAM_SNR_OFFSET_DB : -Infinity;
}

// How much interference degrades this link, in dB (>=0). The effective floor is
// the worse of the receiver-end interference at either node vs the radio's own
// sensitivity; the penalty is how far that floor rises above sensitivity.
function interferencePenaltyDb(s, aPos, aAlt, bPos, bAlt) {
  if (!s.jammers || !s.jammers.length) return 0;
  const fa = interferenceFloorDbm(s, aPos, aAlt);
  const fb = interferenceFloorDbm(s, bPos, bAlt);
  const floor = Math.max(fa, fb);
  return floor > s.radio.sensDbm ? floor - s.radio.sensDbm : 0;
}

// Is a position inside a denial zone — i.e. would a relay's receiver there be
// jammed below usable? C2 uses this in path planning to route the chain AROUND
// interference (a relay placed inside the red zone has a jammed receiver and
// breaks the chain, so the swarm gets stuck). Framed as C2's spectrum survey:
// a ground station can sense where strong emitters deny its band, the same way
// it already uses its terrain database. Terrain shadowing is respected, so a
// hill that blocks the emitter also shrinks the avoided area.
function inDenialZone(s, pos) {
  if (!s.jammers || !s.jammers.length) return false;
  const alt = terrainGroundAt(s.terrain, pos.x, pos.y) + s.altitudeM;
  return interferenceFloorDbm(s, pos, alt) > s.radio.sensDbm;
}

// Widest active denial radius — used to give the path planner room to detour.
function maxDenialRadiusM(s) {
  let r = 0;
  for (const j of (s.jammers || [])) r = Math.max(r, jammerDenialRadiusM(s, j));
  return r;
}

// Radius at which a single source raises the floor to the radio's sensitivity
// (flat-ground estimate) — the visible "denied zone" for the current radio.
function jammerDenialRadiusM(s, j) {
  if (j.on === false) return 0;
  if (j.band !== 'all' && Math.abs(j.band - s.radio.freqMHz) > 150) return 0;
  const n = pathLossExponent(s.radio);
  const exp = (j.erpDbm - pl1m(s.radio.freqMHz) + JAM_SNR_OFFSET_DB - s.radio.sensDbm) / (10 * n);
  return s.envFactor * Math.pow(10, exp);
}

let jammerSeq = 0;
function makeJammer(x, y, erpDbm) {
  jammerSeq += 1;
  return { id: 'JX-' + jammerSeq, x, y, erpDbm: erpDbm != null ? erpDbm : 10, band: 'all', altM: 15, on: true };
}

function liveMarginDb(s, aId, bId) {
  const a = nodePos(s, aId), b = nodePos(s, bId);
  if (!a || !b) return -Infinity;
  const altA = nodeAltAbsM(s, aId, a), altB = nodeAltAbsM(s, bId, b);
  const ground = dist2d(a, b);
  if (ground > radioHorizonM(altA, altB)) return -Infinity;
  if (losBlocked(s.terrain, a.x, a.y, altA, b.x, b.y, altB)) return -Infinity;
  const slant = Math.hypot(ground, altA - altB);
  return linkMarginDb(s.radio, s.envFactor, slant) + fadeDb(s, aId, bId)
    - interferencePenaltyDb(s, a, altA, b, altB);
}

// Comms-corridor transit (methodology from FASTER's safe corridors: keep the
// path inside space you can trust). The trusted space here is the coverage
// tube along the base→target spine where the relay chain lives. For any
// far-away goal, converge onto the spine and travel along it, peeling off
// only for the final hop — so a transiting drone stays commandable instead
// of cutting a dark corner. Built purely from the drone's own order: no
// god-view needed.
function corridorGoal(s, d, g) {
  if (!s.corridorRouting) return g;
  const hop = usableRangeM(s.radio, s.envFactor) * 0.8;
  if (dist2d(d, g) <= hop) return g;                    // final hop: go direct
  const B = s.base, T = d.order.target;
  const L = dist2d(B, T);
  if (L < 1) return g;
  const ux = (T.x - B.x) / L, uy = (T.y - B.y) / L;
  const tMe = Math.max(0, Math.min(L, (d.x - B.x) * ux + (d.y - B.y) * uy));
  const tGoal = Math.max(0, Math.min(L, (g.x - B.x) * ux + (g.y - B.y) * uy));
  if (Math.abs(tGoal - tMe) < hop * 0.5) return g;      // same stretch: direct
  const step = Math.sign(tGoal - tMe) * Math.min(hop * 0.75, Math.abs(tGoal - tMe));
  const t = tMe + step;
  return { x: B.x + ux * t, y: B.y + uy * t };
}

// Where would this order send the drone?
function orderGoal(s, order) {
  if (order.role === 'relay') return slotFromOrder(s, order);
  if (order.role === 'rescue' && order.goto) return order.goto;
  return order.target;
}

// FASTER-style commitment rule (methodology from MIT ACL's FASTER planner:
// never commit to a plan unless a backup plan provably closes). Here the
// backup plan is energetic: fly to the goal, then still make it home against
// the wind with the pessimism margin and reserve intact.
function orderFeasible(s, d, order) {
  const af = s.airframe;
  const goal = orderGoal(s, order);
  const windMs = Math.hypot(s.wind.x, s.wind.y);
  const speed = Math.max(1, af.maxSpeedMs - windMs);
  const pw = flightPowerW(af, af.maxSpeedMs);
  const whToGoal = pw * (dist2d(d, goal) / speed) / 3600;
  const whGoalHome = pw * (dist2d(goal, s.base) / speed) / 3600 * BATTERY.homeMargin;
  return d.energyWh > whToGoal + whGoalHome + usableWh(af) * BATTERY.reserveFrac;
}

// Slot i of k relays: fraction (i+1)/(k+1) along base → ordered target.
// If C2 supplied an explicit (coverage-adjusted) position, that wins.
function slotFromOrder(s, order) {
  if (order.slotPos) return order.slotPos;
  const f = (order.slot + 1) / (order.k + 1);
  return {
    x: s.base.x + (order.target.x - s.base.x) * f,
    y: s.base.y + (order.target.y - s.base.y) * f,
  };
}

function relaysRequired(D, span) {
  return Math.max(0, Math.ceil(D / span) - 1);
}

// --- C2 ground station -------------------------------------------------------
function c2Step(s) {
  // Ingest telemetry that physically arrived. Every received report is also
  // a coverage measurement: the link provably worked at that position.
  for (const p of s.c2.inbox) {
    s.c2.known[p.src] = { ...p.payload, at: s.time };
    covMark(s, p.payload.x, p.payload.y, 'good');
    if (p.payload.deadLog) {
      // Sitting somewhere in silence is much stronger evidence than one
      // lucky packet — weight dead samples accordingly.
      for (const pt of p.payload.deadLog) covMark(s, pt.x, pt.y, 'bad', 3);
      logEvent(s, 'C2: ' + p.src + ' uploaded ' + p.payload.deadLog.length + ' dead-zone samples — coverage map updated', 'info');
    }
  }
  s.c2.inbox = [];

  if (s.time < s.c2.nextCmd) return;
  s.c2.nextCmd = s.time + cmdIntervalSec(s, Object.keys(s.c2.known).length || 1);

  const known = s.c2.known;
  const fresh = id => known[id] && (s.time - known[id].at) <= C2.staleSec;

  // Operator display: log contact changes, and REMEMBER where the lost were
  // last heard — that memory is what rescue dispatch works from.
  for (const id of Object.keys(known)) {
    const f = fresh(id);
    if (s.c2.wasFresh[id] && !f) {
      logEvent(s, 'C2 lost telemetry from ' + id, 'warn');
      s.c2.lost[id] = { x: known[id].x, y: known[id].y, at: s.time };
      covMark(s, known[id].x, known[id].y, 'bad', 2); // weaker than a dead log, but evidence
    }
    if (!s.c2.wasFresh[id] && f) {
      logEvent(s, 'C2 regained telemetry from ' + id, 'info');
      delete s.c2.lost[id];
    }
    s.c2.wasFresh[id] = f;
    if (s.time - known[id].at > C2.forgetSec) { delete known[id]; delete s.c2.wasFresh[id]; }
  }
  for (const id of Object.keys(s.c2.lost)) {
    if (s.time - s.c2.lost[id].at > RESCUE.memorySec) {
      delete s.c2.lost[id]; // written off — dead, or long gone
      logEvent(s, 'C2 gives up the search for ' + id, 'error');
    }
  }

  // A drone that declined its tasking gets struck off and benched for a
  // while, so C2 immediately elects someone with the reserves for the job.
  for (const id of [...s.c2.relays]) {
    if (fresh(id) && known[id].reject === 'relay') {
      s.c2.relays = s.c2.relays.filter(r => r !== id);
      s.c2.unfit[id] = s.time + 60;
      logEvent(s, 'C2: ' + id + ' declined relay duty (low reserves) — benched, reassigning', 'warn');
    }
  }
  for (const rid of [...s.c2.rescuers]) {
    if (fresh(rid) && known[rid].reject === 'rescue') {
      s.c2.unfit[rid] = s.time + 60;
      logEvent(s, 'C2: ' + rid + ' declined rescue tasking — benched', 'warn');
      s.c2.rescuers = s.c2.rescuers.filter(x => x !== rid);
    }
  }

  // Roster hygiene: relays C2 can no longer account for are struck off
  const before = s.c2.relays.length;
  s.c2.relays = s.c2.relays.filter(id =>
    fresh(id) && !['rtb', 'rtl', 'landed', 'dead'].includes(known[id].role));
  if (s.c2.relays.length < before) {
    logEvent(s, 'C2: relay roster degraded (' + s.c2.relays.length + '/' + before + ') — re-planning', 'error');
  }

  // Chain length comes from the PLANNED PATH (A* around known terrain and
  // measured dead zones, LOS-densified over ridges) — not from straight-line
  // distance. Hop span stays capped by the radio horizon at altitude.
  const usable = Math.min(
    usableRangeM(s.radio, s.envFactor),
    radioHorizonM(C2_ANTENNA_M, s.altitudeM));
  const plan = planChain(s);
  const k = s.c2.relays.length;
  const kNeeded = plan.slots.length;

  // Operator warning: mission demands more relays than the fleet can supply.
  // Drones will still try (and their failsafes will bring them back) — but
  // the operator should know the plan doesn't close.
  const assets = Object.keys(known).filter(id => fresh(id)).length;
  const infeasible = kNeeded >= assets && assets > 0;
  if (infeasible && !s.c2.infeasibleWarned) {
    logEvent(s, 'C2 warning: target needs ' + kNeeded + ' relays but only ' + assets + ' drones in contact — link cannot close', 'error');
    s.c2.infeasibleWarned = true;
  } else if (!infeasible) {
    s.c2.infeasibleWarned = false;
  }

  if (kNeeded > k) {
    // Elect from fresh mission drones with battery to spare
    const candidates = Object.keys(known).filter(id =>
      fresh(id) && known[id].role === 'mission' &&
      known[id].battery >= RELAY.minBatteryPct && !s.c2.relays.includes(id) &&
      !s.c2.rescuers.includes(id) && !(s.c2.unfit[id] > s.time));
    if (candidates.length) {
      const slot = plan.slots[k] || s.target;
      let best = null, bestScore = -Infinity;
      for (const id of candidates) {
        const score = 0.6 * (known[id].battery / 100)
                    + 0.4 * (1 - Math.min(1, dist2d(known[id], slot) / (usable * 2)));
        if (score > bestScore) { bestScore = score; best = id; }
      }
      s.c2.relays.push(best);
      logEvent(s, 'C2 orders ' + best + ' to relay slot ' + s.c2.relays.length, 'relay');
    }
  } else if (kNeeded < k - 1 && k > 0) {
    // Plan wants a visibly shorter chain (>1 spare, so replan jitter can't flap)
    const freed = s.c2.relays.pop();
    logEvent(s, 'C2 releases ' + freed + ' from relay duty', 'relay');
  }

  // --- Rescue dispatch (fallback engine, C2 side) ------------------------
  // Multi-hop tentacle: rescuers chain off each other — the first anchors on
  // the nearest fresh node, each next one on the rescuer before it — and the
  // chain crawls toward the lost group's last-known centroid one
  // link-length at a time, every member tethered and connected as it goes.
  const lostIds = Object.keys(s.c2.lost);
  if (s.c2.rescuers.length && !lostIds.length) {
    logEvent(s, 'C2: contact restored — rescue chain of ' + s.c2.rescuers.length + ' released', 'relay');
    s.c2.rescuers = [];
  } else {
    const before = s.c2.rescuers.length;
    s.c2.rescuers = s.c2.rescuers.filter(rid => {
      const kR = known[rid];
      return fresh(rid) && kR && !['rtb', 'landed', 'dead'].includes(kR.role);
    });
    if (s.c2.rescuers.length < before) {
      logEvent(s, 'C2: rescue chain degraded (' + s.c2.rescuers.length + '/' + before + ') — reassigning', 'warn');
    }
  }

  const reach = usable * s.deployFrac;
  const wantMoreRescuers = (() => {
    if (!lostIds.length || s.c2.rescuers.length >= RESCUE.maxChain) return false;
    if (!lostIds.some(id => s.time - s.c2.lost[id].at > RESCUE.delaySec)) return false;
    if (!s.c2.rescuers.length) return true;
    // extend only when the current tip is on station and still short
    const tip = known[s.c2.rescuers[s.c2.rescuers.length - 1]];
    return tip && dist2d(tip, lostCentroid(s)) > reach * 1.05;
  })();
  if (wantMoreRescuers) {
    const candidates = Object.keys(known).filter(id =>
      fresh(id) && known[id].role === 'mission' &&
      known[id].battery >= RELAY.minBatteryPct && !s.c2.relays.includes(id) &&
      !s.c2.rescuers.includes(id) && !(s.c2.unfit[id] > s.time));
    if (candidates.length) {
      const c = lostCentroid(s);
      let best = null, bestD = Infinity;
      for (const id of candidates) {
        const dd = dist2d(known[id], c);
        if (dd < bestD) { bestD = dd; best = id; }
      }
      s.c2.rescuers.push(best);
      logEvent(s, 'C2 extends rescue chain (' + s.c2.rescuers.length + '): ' + best + ' toward last-known contact', 'relay');
    }
  }

  // Per-rescuer goto: link i anchors on link i-1 (first on the nearest
  // fresh non-rescuer node), each stepping one reach toward the centroid.
  // Slots are assigned base-side-first by each rescuer's projection onto the
  // base->centroid axis, so the drone nearest the lost group fills the
  // DEEPEST slot and the base-side drone fills the shallow one — otherwise
  // the best-placed asset gets pinned to slot 0 and driven backward.
  const rescueOrders = {};
  if (s.c2.rescuers.length) {
    const c = lostCentroid(s);
    const cvx = c.x - s.base.x, cvy = c.y - s.base.y;
    const axisDenom = Math.max(1, cvx * cvx + cvy * cvy);
    const projT = id => {
      const p = known[id];
      return p ? ((p.x - s.base.x) * cvx + (p.y - s.base.y) * cvy) / axisDenom : 0;
    };
    const ordered = [...s.c2.rescuers].sort((a, b) => projT(a) - projT(b));
    let anchor = s.base, anchorId = 'C2', aD = dist2d(s.base, c);
    for (const id of Object.keys(known)) {
      if (!fresh(id) || s.c2.rescuers.includes(id)) continue;
      const dd = dist2d(known[id], c);
      if (dd < aD) { aD = dd; anchor = known[id]; anchorId = id; }
    }
    for (const rid of ordered) {
      const dHop = dist2d(anchor, c);
      const step = Math.min(reach, dHop);
      const goto = dHop < 1 ? { x: c.x, y: c.y } : {
        x: anchor.x + (c.x - anchor.x) / dHop * step,
        y: anchor.y + (c.y - anchor.y) / dHop * step,
      };
      rescueOrders[rid] = { goto, upstream: anchorId };
      // the next link anchors on this one: its live position if fresh,
      // otherwise where it was told to go
      anchor = fresh(rid) && known[rid] ? known[rid] : goto;
      anchorId = rid;
    }
  }

  // Build every drone's order. Every order names the drone's UPSTREAM chain
  // neighbor, so it can tether to it: relays hang off the previous slot
  // (slot 0 off C2), the flock hangs off the last relay, the rescuer off
  // its anchor.
  const lastRelay = s.c2.relays.length ? s.c2.relays[s.c2.relays.length - 1] : 'C2';
  const orderFor = id => {
    if (rescueOrders[id]) {
      return {
        role: 'rescue', slot: -1, goto: rescueOrders[id].goto,
        upstream: rescueOrders[id].upstream,
        k: s.c2.relays.length,
        target: { x: s.target.x, y: s.target.y },
      };
    }
    const slot = s.c2.relays.indexOf(id);
    return {
      role: slot >= 0 ? 'relay' : 'mission',
      slot,
      upstream: slot > 0 ? s.c2.relays[slot - 1] : (slot === 0 ? 'C2' : lastRelay),
      k: s.c2.relays.length,
      slotPos: slot >= 0 ? adjustedSlotPos(s, slot, s.c2.relays.length) : null,
      target: { x: s.target.x, y: s.target.y },
    };
  };

  const ids = Object.keys(known);
  if (s.broadcastC2) {
    // One flooded packet carries the whole table — see stepBcasts
    const orders = {};
    for (const id of ids) orders[id] = orderFor(id);
    s.c2.bcastSeq += 1;
    sendBroadcast(s, 'C2', { seq: s.c2.bcastSeq, orders },
      NET.bcastHeaderBytes + NET.bcastRowBytes * ids.length);
  } else {
    // Unicast: one routed packet per drone — best effort, dies without a route
    for (const id of ids) sendPacket(s, 'cmd', 'C2', id, orderFor(id));
  }
}

// Slot positions come from the planned path; covAdjust still guards against
// cells that turned measured-bad since the last replan.
function adjustedSlotPos(s, slot, k) {
  const plan = s.c2.chainPlan;
  const nominal = (plan && plan.slots[slot])
    || slotFromOrder(s, { slot, k, target: s.target, role: 'relay' });
  return covAdjust(s, nominal);
}

function lostCentroid(s) {
  const ids = Object.keys(s.c2.lost);
  let cx = 0, cy = 0;
  for (const id of ids) { cx += s.c2.lost[id].x; cy += s.c2.lost[id].y; }
  return { x: cx / ids.length, y: cy / ids.length };
}

// --- Drone onboard logic -------------------------------------------------------
function droneComms(s, d) {
  for (const p of d.inbox) {
    if (p.kind !== 'cmd' && p.kind !== 'bcast') continue;
    // Any heard C2 transmission proves the link works here — even a
    // broadcast without a row for us (C2 hasn't met us yet)
    d.lastC2 = s.time;
    d.lastLinkX = d.x; d.lastLinkY = d.y;
    d.relinkUntil = null;
    d.relinkAttempt = 0;
    if (d.mode === 'hold' || d.mode === 'relink' || d.mode === 'rtl') {
      d.mode = 'ok';
      logEvent(s, d.id + ' link restored — resuming orders', 'info');
    }

    // Commitment rule: refuse a NEW tasking whose recovery plan doesn't
    // close; keep flying the current (previously vetted) order instead.
    // The signature keys on the RESOLVED goal (relay slotPos / rescue goto /
    // mission target), not just the role/slot label — otherwise a slot that
    // migrates after a replan, or a rescue goto that steps deeper, keeps the
    // same label and slips past the feasibility gate unvetted.
    const o = p.kind === 'bcast' ? p.payload.orders[d.id] : p.payload;
    if (!o) continue;
    const og = orderGoal(s, o), cg = orderGoal(s, d.order);
    const sig = o.role + '/' + Math.round(og.x) + ',' + Math.round(og.y);
    const changed = sig !== (d.order.role + '/' + Math.round(cg.x) + ',' + Math.round(cg.y));
    if (changed && !orderFeasible(s, d, o)) {
      d.rejectedRole = o.role;
      if (d.rejectedSig !== sig) {
        d.rejectedSig = sig;
        const pct = (d.energyWh / usableWh(s.airframe) * 100).toFixed(0);
        logEvent(s, d.id + ' declines ' + o.role + ' tasking — recovery plan does not close (' + pct + '% battery)', 'warn');
      }
      continue;
    }
    const prevRole = d.order.role;
    d.order = o;
    d.rejectedRole = null; d.rejectedSig = null;
    if (d.mode === 'ok' && prevRole !== d.order.role) {
      logEvent(s, d.id + ' now ' + d.order.role + (d.order.role === 'relay' ? ' (slot ' + (d.order.slot + 1) + ')' : ''), 'relay');
    }
  }
  d.inbox = [];

  if (!alive(d) || d.mode === 'rtb') return;

  // Telemetry beacon — position as the GPS sees it, not as God sees it.
  // Any dead-zone samples collected while disconnected ride along (black box
  // upload) and are cleared once handed to the radio.
  if (s.time >= d.nextTlm) {
    d.nextTlm = s.time + tlmIntervalSec(s);
    sendPacket(s, 'tlm', d.id, 'C2', {
      x: d.x + GPS_SIGMA_M * gaussian(s.net.rng),
      y: d.y + GPS_SIGMA_M * gaussian(s.net.rng),
      battery: d.batteryPct, role: effRole(d),
      reject: d.rejectedRole || null,
      deadLog: d.deadLog.length ? d.deadLog.splice(0) : null,
    });
  }

  // Black box: while the link is silent, remember where it was silent.
  const silent = d.mode === 'hold' || d.mode === 'relink' || d.mode === 'rtl';
  if (silent && s.time >= d.nextDeadLog) {
    d.nextDeadLog = s.time + COVERAGE.deadLogIntervalSec;
    if (d.deadLog.length < COVERAGE.deadLogMax) {
      d.deadLog.push({
        x: d.x + GPS_SIGMA_M * gaussian(s.net.rng),
        y: d.y + GPS_SIGMA_M * gaussian(s.net.rng),
      });
    }
  }

  // Link-loss failsafe ladder. Timeouts scale with the expected command rate
  // (like PX4's COM_DL_LOSS_T) so a slow duty-limited link isn't mistaken for
  // a dead one.
  const holdAfter = Math.max(FAILSAFE.holdSec, 3 * cmdIntervalSec(s, s.drones.length));
  const rtlAfter = d.order.role === 'relay'
    ? Math.max(FAILSAFE.rtlRelaySec, 3 * holdAfter)
    : Math.max(FAILSAFE.rtlMissionSec, 2 * holdAfter);
  const age = s.time - d.lastC2;
  if (d.mode === 'ok' && age > holdAfter) {
    d.mode = 'hold'; d.holdX = d.x; d.holdY = d.y;
    logEvent(s, d.id + ' lost C2 link — holding position', 'warn');
  }
  if (d.mode === 'hold' && age > rtlAfter) {
    // Fallback engine, stage 1: don't abandon the mission for base yet —
    // retreat to the last position where the link provably worked.
    d.mode = 'relink';
    d.relinkAttempt = 1;
    d.relinkGoalX = d.lastLinkX; d.relinkGoalY = d.lastLinkY;
    d.relinkUntil = null;
    logEvent(s, d.id + ' link timeout — retreating to last-link point (attempt 1/' + FAILSAFE.relinkAttempts + ')', 'warn');
  }
  if (d.mode === 'relink') {
    if (dist2d(d, { x: d.relinkGoalX, y: d.relinkGoalY }) < FAILSAFE.relinkArriveM) {
      if (d.relinkUntil === null) d.relinkUntil = s.time + FAILSAFE.relinkWaitSec;
      else if (s.time > d.relinkUntil) {
        // Attempt failed. Fall back one radio-range step toward base and
        // listen again; after the last attempt, go home for real.
        const dHome = dist2d(d, s.base);
        const step = usableRangeM(s.radio, s.envFactor) * FAILSAFE.relinkStepFrac;
        if (d.relinkAttempt >= FAILSAFE.relinkAttempts || dHome <= step) {
          d.mode = 'rtl';
          logEvent(s, d.id + ' no contact after ' + d.relinkAttempt + ' attempts — returning to C2', 'warn');
        } else {
          d.relinkAttempt += 1;
          const f = step / dHome;
          d.relinkGoalX = d.x + (s.base.x - d.x) * f;
          d.relinkGoalY = d.y + (s.base.y - d.y) * f;
          d.relinkUntil = null;
          logEvent(s, d.id + ' still silent — falling back toward C2 (attempt ' + d.relinkAttempt + '/' + FAILSAFE.relinkAttempts + ')', 'warn');
        }
      }
    }
  }
}

function updateBattery(s, d, dt, vAirMs) {
  const af = s.airframe;
  d.energyWh = Math.max(0, d.energyWh - flightPowerW(af, vAirMs) * dt / 3600);
  d.batteryPct = d.energyWh / usableWh(af) * 100;

  if (d.mode === 'ok' || d.mode === 'hold' || d.mode === 'relink') {
    // Onboard smart-RTH: energy to fly home at cruise, with pessimism + reserve.
    // Assumes the whole trip could be upwind — conservative, like real firmware.
    const windMs = Math.hypot(s.wind.x, s.wind.y);
    const homeSpeed = Math.max(1, af.maxSpeedMs - windMs);
    const secsHome = dist2d(d, s.base) / homeSpeed;
    const whHome = flightPowerW(af, af.maxSpeedMs) * secsHome / 3600 * BATTERY.homeMargin;
    if (d.energyWh <= whHome + usableWh(af) * BATTERY.reserveFrac) {
      d.mode = 'rtb';
      logEvent(s, d.id + ' battery low — RTB (' + d.batteryPct.toFixed(0) + '%)', 'warn');
      sendPacket(s, 'tlm', d.id, 'C2', { x: d.x, y: d.y, battery: d.batteryPct, role: 'rtb' });
    }
  }

  if (d.energyWh <= 0 && alive(d)) {
    d.mode = 'dead';
    d.vx = d.vy = 0;
    logEvent(s, d.id + ' battery exhausted — down', 'error');
  }
}

function killDrone(s, d) {
  if (!alive(d)) return;
  d.mode = 'dead';
  d.vx = d.vy = 0;
  logEvent(s, d.id + ' lost', 'error'); // note: C2 only finds out via telemetry silence
}

// --- Motion --------------------------------------------------------------------
function goalFor(s, d) {
  if (d.mode === 'rtb' || d.mode === 'rtl') return { x: s.base.x, y: s.base.y };
  if (d.mode === 'hold') return { x: d.holdX, y: d.holdY };
  if (d.mode === 'relink') return { x: d.relinkGoalX, y: d.relinkGoalY };
  if (d.order.role === 'rescue' && d.order.goto) return d.order.goto;
  if (d.order.role === 'relay') return slotFromOrder(s, d.order);
  // Mission: loiter ring around the ORDERED target (which may be stale — that's the point)
  d.orbitPhase += 0.0004 * s.airframe.maxSpeedMs;
  const flock = s.drones.filter(x => alive(x) && x.mode === 'ok' && x.order.role === 'mission');
  const idx = Math.max(0, flock.indexOf(d));
  const a = d.orbitPhase + (idx / Math.max(1, flock.length)) * Math.PI * 2;
  return {
    x: d.order.target.x + DRONE.orbitRadiusM * Math.cos(a),
    y: d.order.target.y + DRONE.orbitRadiusM * Math.sin(a),
  };
}

// The tether applied to a goal: while the upstream link is healthy the goal
// passes through; as the measured margin sinks toward the floor, outbound
// progress (anything that increases distance from the upstream node) is
// throttled to zero; below the floor the drone closes back in. Retreats and
// homeward flights are never blocked — the tether only stops you from
// flying AWAY from your link.
function tetherGoal(s, d, goal) {
  if (d.mode !== 'ok' || !d.order.upstream) return goal;
  const upPos = d.order.upstream === 'C2' ? s.base : nodePos(s, d.order.upstream);
  if (!upPos || (upPos !== s.base && !alive(upPos))) return goal;

  const plan = plannedHopMarginDb(s);
  const slowDb = Math.max(TETHER.minSlowDb, plan - TETHER.slowBelowPlanDb);
  const stopDb = Math.max(TETHER.minStopDb, plan - TETHER.stopBelowPlanDb);
  const m = d.upMarginEma;

  if (m >= slowDb) return goal;
  // only throttle motion that takes us FARTHER from the upstream node
  if (dist2d(goal, upPos) <= dist2d(d, upPos)) return goal;

  if (m <= stopDb) {
    // link nearly gone: step back toward the upstream neighbor
    if (!d.tethered) { d.tethered = true; logEvent(s, d.id + ' tether: link to ' + d.order.upstream + ' thin — closing up', 'warn'); }
    return { x: d.x + (upPos.x - d.x) * 0.4, y: d.y + (upPos.y - d.y) * 0.4 };
  }
  // in the slow band: freeze outbound progress proportionally
  const f = (m - stopDb) / (slowDb - stopDb);
  return { x: d.x + (goal.x - d.x) * f, y: d.y + (goal.y - d.y) * f };
}

function stepDrone(s, d, dt) {
  if (!alive(d)) return;

  droneComms(s, d);

  // Track the upstream beacon (radios hear their neighbors constantly)
  if (d.order.upstream) {
    const raw = liveMarginDb(s, d.id, d.order.upstream);
    const capped = Math.max(-20, Math.min(40, raw));
    d.upMarginEma += (capped - d.upMarginEma) * TETHER.emaAlpha;
    if (d.tethered && d.upMarginEma > plannedHopMarginDb(s) - TETHER.slowBelowPlanDb + 1) d.tethered = false;
  }

  const goal = tetherGoal(s, d, corridorGoal(s, d, goalFor(s, d)));
  // Cache the vetted goal so external mode ships exactly this one instead of
  // recomputing goalFor (which advances orbitPhase as a side effect — a
  // second call would double-step the loiter and diverge from what we vet).
  d.goalX = goal.x; d.goalY = goal.y;
  const maxV = s.airframe.maxSpeedMs;

  // External-vehicle mode: real autopilot firmware (or the mock) flies the
  // drone. Position and velocity were pulled from telemetry at the top of the
  // tick; the goal we just computed is shipped to the vehicle by
  // externalPushGoals. We skip our own physics integration entirely, but
  // still bill battery — against AIRSPEED (ground velocity minus wind), the
  // same quantity the internal model bills, so a relay holding station in
  // wind is charged for fighting it instead of reading as free hover.
  const external = typeof externalActive === 'function' && externalActive();
  if (external) {
    const eva = Math.hypot(d.vx - s.wind.x, d.vy - s.wind.y);
    updateBattery(s, d, dt, Math.min(eva, maxV));
  } else {
    const dx = goal.x - d.x, dy = goal.y - d.y;
    const dGoal = Math.hypot(dx, dy);

    const brake = (maxV * maxV) / (2 * DRONE.accelMs2);
    const desiredSpeed = dGoal > brake ? maxV : maxV * (dGoal / brake);
    let ax = 0, ay = 0;
    if (dGoal > 0.5) {
      ax = (dx / dGoal) * desiredSpeed - d.vx;
      ay = (dy / dGoal) * desiredSpeed - d.vy;
    } else {
      ax = -d.vx; ay = -d.vy;
    }

    for (const o of s.drones) {
      if (o === d || !alive(o)) continue;
      const sd = dist2d(d, o);
      if (sd < DRONE.separationM && sd > 0.01) {
        const push = (DRONE.separationM - sd) / DRONE.separationM * DRONE.accelMs2 * 2;
        ax += ((d.x - o.x) / sd) * push;
        ay += ((d.y - o.y) / sd) * push;
      }
    }

    // Obstacle avoidance: onboard map, buildings above flight level are
    // no-fly cylinders. Radial push plus a tangential bias so a head-on
    // approach slides around the rim instead of stalling against it.
    for (const b of s.terrain.buildings) {
      const rObst = buildingObstacleRadiusM(s, b);
      if (!rObst) continue;
      const dxh = d.x - b.x, dyh = d.y - b.y;
      const dh = Math.hypot(dxh, dyh);
      if (dh < rObst && dh > 0.01) {
        const push = ((rObst - dh) / rObst) * DRONE.accelMs2 * 3;
        ax += (dxh / dh) * push - (dyh / dh) * push * 0.4;
        ay += (dyh / dh) * push + (dxh / dh) * push * 0.4;
      }
    }

    const aMag = Math.hypot(ax, ay);
    if (aMag > DRONE.accelMs2) { ax = ax / aMag * DRONE.accelMs2; ay = ay / aMag * DRONE.accelMs2; }
    d.vx += ax * dt; d.vy += ay * dt;

    // The speed limit and the power bill are paid in AIRSPEED. Wind shifts the
    // ground-frame envelope: full tailwind adds, headwind subtracts, and a
    // strong enough wind blows the drone backwards at full throttle.
    let vax = d.vx - s.wind.x, vay = d.vy - s.wind.y;
    const va = Math.hypot(vax, vay);
    if (va > maxV) {
      vax *= maxV / va; vay *= maxV / va;
      d.vx = vax + s.wind.x; d.vy = vay + s.wind.y;
    }
    d.x += d.vx * dt; d.y += d.vy * dt;

    updateBattery(s, d, dt, Math.min(va, maxV));
  }

  if ((d.mode === 'rtb' || d.mode === 'rtl') && dist2d(d, s.base) < DRONE.landThresholdM) {
    if (d.mode === 'rtb') {
      d.mode = 'landed'; d.vx = d.vy = 0;
      d.swapAt = s.time + BATTERY.swapSec;
      logEvent(s, d.id + ' landed at base — battery swap in progress', 'info');
    }
    // rtl drones hovering at base will regain link and be re-tasked
  }
}

// --- Status for display ----------------------------------------------------------
// Built from TRUTH (what the map shows) plus C2's belief (what the operator sees).
function chainStatus(s) {
  const onChain = d => alive(d) && (d.mode === 'ok' || d.mode === 'hold');
  const relays = s.drones.filter(d => onChain(d) && d.order.role === 'relay')
    .sort((a, b) => a.order.slot - b.order.slot);
  const flock = s.drones.filter(d => onChain(d) && d.order.role === 'mission');

  const nodes = [{ kind: 'base', x: s.base.x, y: s.base.y, label: 'C2', id: 'C2' }];
  for (const r of relays) nodes.push({ kind: 'relay', x: r.x, y: r.y, label: r.id, id: r.id, drone: r });
  if (flock.length) {
    let cx = 0, cy = 0;
    for (const d of flock) { cx += d.x; cy += d.y; }
    nodes.push({ kind: 'mission', x: cx / flock.length, y: cy / flock.length, label: 'flock', id: flock[0].id });
  }

  // The hops shown to the operator are the ACTUAL route packets take (BFS
  // over live links to the flock) whenever one exists — a planned-adjacency
  // line through a tower shadow is misleading if traffic is flowing around
  // it. Only when nothing routes do we draw the planned chain, so a truly
  // broken chain still shows its red hops.
  let chainPts = nodes;
  if (flock.length) {
    let cx2 = 0, cy2 = 0;
    for (const d of flock) { cx2 += d.x; cy2 += d.y; }
    cx2 /= flock.length; cy2 /= flock.length;
    let rep = flock[0], repD = Infinity;
    for (const d of flock) {
      const dd = Math.hypot(d.x - cx2, d.y - cy2);
      if (dd < repD) { repD = dd; rep = d; }
    }
    const route = routePath(s, 'C2', rep.id);
    if (route && route.length > 1) {
      chainPts = route.map(id => {
        if (id === 'C2') return { kind: 'base', x: s.base.x, y: s.base.y, label: 'C2', id: 'C2' };
        const d = nodePos(s, id);
        return { kind: effRole(d) === 'relay' ? 'relay' : 'mesh', x: d.x, y: d.y, label: d.id, id: d.id, drone: d };
      });
    }
  }

  const hops = [];
  for (let i = 0; i < chainPts.length - 1; i++) {
    const dM = dist2d(chainPts[i], chainPts[i + 1]);
    const margin = Math.max(-99, liveMarginDb(s, chainPts[i].id, chainPts[i + 1].id));
    const state = margin >= FADE_MARGIN_DB ? 'ok' : margin >= 0 ? 'degraded' : 'lost';
    hops.push({
      a: chainPts[i], b: chainPts[i + 1], distM: dM, marginDb: margin,
      rssiDbm: margin + s.radio.sensDbm,
      lossPct: (1 - pktSuccessProb(margin)) * 100,
      state,
    });
  }

  // Ground truth connectivity: can a packet route from C2 to any mission drone?
  const connected = flock.some(d => routePath(s, 'C2', d.id) !== null);

  // Operator's view: how many drones does C2 have fresh contact with?
  const freshCount = Object.keys(s.c2.known)
    .filter(id => (s.time - s.c2.known[id].at) <= C2.staleSec).length;
  const aliveCount = s.drones.filter(alive).length;

  return { nodes, hops, connected, missionCount: flock.length, relayCount: relays.length, freshCount, aliveCount };
}

// --- Tick -------------------------------------------------------------------------
function stepSwarm(s, dt) {
  s.time += dt;

  // External-vehicle mode: adopt the vehicles' real positions BEFORE any
  // logic runs, so C2 planning, routing, and the tether all reason about
  // ground truth from the autopilots.
  const external = typeof externalActive === 'function' && externalActive();
  if (external) externalPullPositions(s);

  c2Step(s);

  // Ground crew: landed drones get a fresh pack and go back to work
  for (const d of s.drones) {
    if (d.mode === 'landed' && d.swapAt && s.time >= d.swapAt) {
      d.mode = 'ok';
      d.energyWh = usableWh(s.airframe);
      d.batteryPct = 100;
      d.swapAt = null;
      d.lastC2 = s.time;
      d.order = { role: 'mission', slot: -1, k: 0, upstream: 'C2', target: { x: s.target.x, y: s.target.y } };
      logEvent(s, d.id + ' battery swapped — relaunching', 'info');
    }
  }

  for (const d of s.drones) stepDrone(s, d, dt);
  stepNet(s, dt);

  // Ship the goals our logic just decided out to the vehicles.
  if (external) externalPushGoals(s);

  return chainStatus(s);
}

// --- After-action report -----------------------------------------------------
// A human-readable mission summary (Markdown) — the artifact a planner or
// customer actually wants out of a simulation run: did the swarm hold the
// link, how hard did it work, and what did it learn about the RF environment.
function afterActionReport(s) {
  const st = chainStatus(s);
  const mins = (s.time / 60).toFixed(1);
  const cov = [...s.c2.cov.values()];
  const badCells = cov.filter(e => e.bad > e.good).length;
  const goodCells = cov.filter(e => e.good >= e.bad && (e.good + e.bad) > 0).length;
  const deliv = s.net.delivered, drop = s.net.dropped;
  const dropPct = (deliv + drop) ? (100 * drop / (deliv + drop)).toFixed(1) : '0';
  const activeJam = (s.jammers || []).filter(j => j.on !== false).length;
  const D = dist2d(s.base, s.target);
  const relayEvents = s.events.filter(e => e.kind === 'relay').length;
  const failsafes = s.events.filter(e => /lost C2 link|link timeout|retreating/.test(e.msg)).length;
  const swaps = s.events.filter(e => e.msg.includes('swapped')).length;
  const L = [];
  L.push('# Mission after-action report');
  L.push('');
  L.push('_Generated by the drone swarm relay simulator at T+' + mins + ' min._');
  L.push('');
  L.push('## Setup');
  L.push('- **Radio:** ' + s.radio.name + ' (' + s.radio.freqMHz + ' MHz, usable ~' + fmtDist(usableRangeM(s.radio, s.envFactor)) + ')');
  L.push('- **Airframe:** ' + s.airframe.name + ' — ' + s.drones.length + ' drones');
  L.push('- **Objective distance:** ' + fmtDist(D) + ' from the ground station');
  L.push('- **Altitude:** ' + s.altitudeM + ' m AGL' + (Math.hypot(s.wind.x, s.wind.y) > 0.5 ? ' · wind ' + Math.hypot(s.wind.x, s.wind.y).toFixed(0) + ' m/s' : ''));
  L.push('- **Interference sources:** ' + activeJam + (activeJam ? ' active (RF denial in play)' : ' (clean spectrum)'));
  L.push('');
  L.push('## Outcome');
  L.push('- **Link to objective:** ' + (st.connected ? '**CONNECTED** end-to-end' : '**not connected** at report time'));
  L.push('- **Chain:** ' + st.relayCount + ' relay drones bridging ' + st.missionCount + ' mission drones');
  L.push('- **C2 contact:** ' + st.freshCount + ' of ' + st.aliveCount + ' airborne drones in fresh telemetry contact');
  L.push('- **Relay re-plans:** ' + relayEvents + ' · **Failsafe events:** ' + failsafes + ' · **Battery swaps:** ' + swaps);
  L.push('');
  L.push('## RF environment learned');
  L.push('- **Coverage cells mapped:** ' + cov.length + ' (' + goodCells + ' measured-good, ' + badCells + ' measured dead zones)');
  L.push('- **Packets delivered:** ' + deliv.toLocaleString() + ' · **dropped:** ' + drop.toLocaleString() + ' (' + dropPct + '% loss)');
  L.push('- **Channel utilization:** ' + (s.net.utilization * 100).toFixed(1) + '%' + (s.radio.dutyCycle ? ' (legal duty-cycle cap ' + (s.radio.dutyCycle * 100) + '%)' : ''));
  L.push('');
  L.push('## Timeline (last events)');
  for (const e of s.events.slice(-14)) {
    L.push('- `T+' + Math.floor(e.t / 60) + ':' + String(Math.floor(e.t % 60)).padStart(2, '0') + '` ' + e.msg);
  }
  L.push('');
  L.push('_This is a simulation result, not a flight-tested outcome. Model calibration and assumptions are documented in the project README._');
  return L.join('\n');
}

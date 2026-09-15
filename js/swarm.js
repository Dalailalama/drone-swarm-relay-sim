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

// The canonical simulation timestep — ONE step policy for the browser loop,
// the batch engine and the benchmark (review finding #28): equal seeds and
// settings must produce identical trajectories in every runtime, and a
// benchmark number is only comparable to the product it claims to measure
// if both step the same dt. 20 Hz keeps the collision sweep and tether
// margins honest at full flight speed.
const SIM_DT_SEC = 0.05;

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

function plannedHopMarginDb(s, d) {
  // Per-drone: a heterogeneous fleet plans each unit's hop against the radio
  // THAT UNIT flies — the tactical edge is shorter-legged than the wing.
  const r = (d && droneRadio(d)) || s.radio;
  return linkMarginDb(r, s.envFactor, usableRangeM(r, s.envFactor) * s.deployFrac);
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

// Per-node hardware. Heterogeneous missions give each drone its own airframe
// and radio (js/fleet.js); homogeneous missions leave both null and everything
// falls back to the swarm-wide preset — identical behaviour to before.
function afOf(s, d) { return d.af || s.airframe; }
function droneRadio(d) { return d.radio || null; }

// The radio a node transmits on. C2 is assumed to carry a matched companion
// unit for every radio type in the field (two dongles on the mast is exactly
// what real mixed-fleet ground stations do), so C2 pairs with whatever the
// far end flies.
function nodeRadioOf(s, id) {
  if (id === 'C2') return null;
  const d = nodePos(s, id);
  return d ? droneRadio(d) : null;
}

function makeDrone(x, y, target, rng, airframe, radio, cls) {
  droneSeq += 1;
  return {
    id: 'DR-' + droneSeq,
    x, y, vx: 0, vy: 0,
    energyWh: usableWh(airframe),
    batteryPct: 100,
    af: airframe || null,
    radio: radio || null,
    cls: cls || 'mission',   // 'relay' = relay-wing unit, 'mission' = tactical
    // Navigation belief: where the drone THINKS it is (GPS-denied drift, js/gpsnav.js)
    belX: x, belY: y, dvx: 0, dvy: 0,
    gpsDenied: false,
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
    base: {
      x: (opts.base && opts.base.x != null) ? opts.base.x : (opts.baseX != null ? opts.baseX : 0),
      y: (opts.base && opts.base.y != null) ? opts.base.y : (opts.baseY != null ? opts.baseY : 0),
    },
    target: {
      x: (opts.target && opts.target.x != null) ? opts.target.x : opts.targetX,
      y: (opts.target && opts.target.y != null) ? opts.target.y : opts.targetY,
    },
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
    // Heterogeneous fleet (js/fleet.js): relayWing drones carry the heavy
    // radio + endurance airframe and hold the chain; the rest fly tactical.
    relayAirframe: opts.relayAirframe || null,
    relayRadio: opts.relayRadio || null,
    relayIdx: (opts.relayWing > 0 && opts.relayAirframe && opts.relayRadio)
      ? relayClassIndices(opts.count, opts.relayWing) : [],
    terrain: opts.terrain || makeTerrain('flat'),
    jammers: opts.jammers ? opts.jammers.map(j => ({ ...j })) : [],
    gpsZones: opts.gpsZones ? opts.gpsZones.map(z => ({ ...z })) : [],
    covCellM: Math.max(20, usableRangeM(opts.radio, opts.envFactor) * 0.15),
    showCoverage: true,
    broadcastC2: opts.broadcastC2 !== false,
    captureOn: !!opts.captureOn,
    // Payload/video backhaul (Feature: Tier-1 #4)
    videoOn: !!opts.videoOn,
    videoKbps: opts.videoKbps || 500,
    // Moving-mission dynamics (Tier-2 mission library): the ground station
    // itself can drive (convoy escort) and the objective can drift (wildfire
    // front, flood edge). m/s in world frame; zero for static missions.
    baseVel: opts.baseVel || { x: 0, y: 0 },
    targetVel: opts.targetVel || { x: 0, y: 0 },
    // Red-team mode: interference sources direction-find the swarm's own
    // transmissions and crawl toward the traffic (js/adversary.js).
    adversaryMode: !!opts.adversaryMode,
    advStats: { movedM: 0 },
    // Imported ATAK CoT marks (Tier-2): [{id, callsign, lat, lon, x, y}] —
    // ephemeral intel, not saved with scenarios.
    takMarks: [],
    // Anti-jam spectrum agility + LPI/LPD waveform (Feature: Tier-1 #5)
    spectrumAgility: !!opts.spectrumAgility,
    lpiMode: !!opts.lpiMode,
    stats: { tSec: 0, connSec: 0 },
    net: makeNet(opts.seed != null ? opts.seed : 42),
    c2: { known: {}, relays: [], inbox: [], nextCmd: 0, wasFresh: {}, lost: {}, rescuers: [], unfit: {}, cov: new Map(), slotCache: {}, bcastSeq: 0, everHeard: new Set(), vidGrantee: null, vidIdx: 0 },
  };
  for (let i = 0; i < opts.count; i++) {
    const a = (i / opts.count) * Math.PI * 2;
    const isWing = s.relayIdx.includes(i);
    const dr = makeDrone(
      s.base.x + 60 * Math.cos(a), s.base.y + 60 * Math.sin(a), s.target, s.net.rng,
      isWing && opts.relayAirframe ? opts.relayAirframe : opts.airframe,
      isWing && opts.relayRadio ? opts.relayRadio : opts.radio,
      isWing ? 'relay' : 'mission');
    // Launch briefing: every drone knows where the base is at takeoff;
    // later updates arrive only by received C2 packets (finding #18).
    dr.baseKnown = { x: s.base.x, y: s.base.y, at: 0 };
    s.drones.push(dr);
  }
  return s;
}

function logEvent(s, msg, kind) {
  s.events.push({ t: s.time, msg, kind: kind || 'info' });
  if (s.events.length > 80) s.events.shift();
  if (s.stats) {
    s.stats.totalEvents = (s.stats.totalEvents || 0) + 1;
    if (kind === 'relay') s.stats.relayEvents = (s.stats.relayEvents || 0) + 1;
    if (/lost C2 link|link timeout|retreating/.test(msg)) s.stats.failsafes = (s.stats.failsafes || 0) + 1;
    // Swaps are counted at the COMPLETED state transition (relaunch site),
    // not by sniffing log text — matching both the landing and the relaunch
    // message made one physical swap count twice (review finding #29).
  }
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
  // Only buildings near the point can matter — query the spatial index so this
  // stays cheap even in a city of thousands. 220 m covers the largest tower
  // footprint's obstacle radius.
  const near = buildingsNear(s.terrain, pos.x, pos.y, 220);
  for (const b of near) {
    const r = buildingObstacleRadiusM(s, b);
    // Overflyable buildings (r === 0) are not obstacles — the flight-time
    // avoidance skips them too, so the planner must not route around a phantom
    // skirt the drones fly straight through.
    if (r > 0 && dist2d(pos, b) < r + 10) return true;
  }
  return false;
}

function badPlan(s, pos) {
  // GPS-denied areas count as bad PLANS even though the RF there is fine:
  // relay geometry is built from telemetry positions, and a drone deep in
  // denial reports garbage positions — so C2 places slots outside active
  // zones unless nowhere better exists (covAdjust handles the "unless").
  return covState(s, pos.x, pos.y) === 'bad' || insideObstacle(s, pos)
    || inDenialZone(s, pos) || gpsDeniedAt(s.gpsZones, pos.x, pos.y);
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

// The relay chain lives on whatever radio the relay wing flies (heterogeneous)
// or on the swarm-wide radio (homogeneous). Planning numbers for slot spacing
// come from THAT radio, because those are the radios holding the slots.
function chainRadio(s) { return (s.relayIdx && s.relayIdx.length && s.relayRadio) || s.radio; }

function planChain(s) {
  const tKey = Math.round(s.target.x / 40) + ',' + Math.round(s.target.y / 40);
  const cached = s.c2.chainPlan;
  if (cached && cached.tKey === tKey && s.time - cached.at < PLAN.replanSec) return cached;

  const usable = Math.min(usableRangeM(chainRadio(s), s.envFactor), radioHorizonM(C2_ANTENNA_M, s.altitudeM));
  const span = usable * s.deployFrac;
  const cell = Math.max(40, usable * 0.25);
  // The search box must be wide enough to route AROUND the widest denial zone,
  // otherwise A* can't find a detour and the chain fails through it.
  const pad = Math.max(span * 1.5, maxDenialRadiusM(s) * 1.35 + span);
  const minX = Math.min(s.base.x, s.target.x) - pad, maxX = Math.max(s.base.x, s.target.x) + pad;
  const minY = Math.min(s.base.y, s.target.y) - pad, maxY = Math.max(s.base.y, s.target.y) + pad;
  const nx = Math.max(2, Math.ceil((maxX - minX) / cell)), ny = Math.max(2, Math.ceil((maxY - minY) / cell));
  const pos = (ix, iy) => ({ x: minX + (ix + 0.5) * cell, y: minY + (iy + 0.5) * cell });
  const blocked = p => insideObstacle(s, p) || covState(s, p.x, p.y) === 'bad'
    || inDenialZone(s, p) || gpsDeniedAt(s.gpsZones, p.x, p.y);
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

  // No route means NO plan — placing slots along the straight-line fallback
  // put relays inside the very denial zone the search failed to cross
  // (review finding #19). C2 gets an empty slot list and says so; drones'
  // own protections (tether, coverage) handle whatever was already airborne.
  if (!found) {
    const failedPlan = { slots: [], pathLen: dist2d(s.base, s.target), tKey, at: s.time, feasible: false };
    s.c2.chainPlan = failedPlan;
    return failedPlan;
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

  // Heterogeneous fleets: the wing's long hops span the backhaul, but the
  // FLOCK hangs off the last relay on the tactical radio's short legs — so
  // the plan always ends with a slot inside tactical reach of the objective.
  // Without this the chain "closes" on paper over wing-radio hops and then
  // can't hand off to short-range mission drones at all.
  if (s.relayIdx && s.relayIdx.length) {
    const tactReach = usableRangeM(s.radio, s.envFactor) * s.deployFrac * 0.9;
    if (pathLen > tactReach) {
      const arcs = [];
      const nEven = kSlots + 1;
      for (let i = 0; i < kSlots; i++) arcs.push(pathLen * (i + 1) / nEven);
      arcs.push(pathLen - Math.min(tactReach, pathLen * 0.45));
      arcs.sort((a, b) => a - b);
      const minGap = span * 0.25;
      slots = [];
      let prev = -Infinity;
      for (const arc of arcs) {
        if (arc - prev < minGap) continue;
        slots.push(at(arc));
        prev = arc;
      }
    }
  }

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

  const plan = { slots, pathLen, tKey, at: s.time, feasible: found };
  s.c2.chainPlan = plan;
  return plan;
}

// Absolute antenna altitude. Drones terrain-follow: AGL above the ground
// beneath them, like a real terrain-following mission. Ridges between two
// valleys still cut line of sight; buildings are handled as obstacles.
function nodeAltAbsM(s, id, pos) {
  const d = id !== 'C2' ? nodePos(s, id) : null;
  const agl = id === 'C2' ? C2_ANTENNA_M : ((d && d.altM != null) ? d.altM : s.altitudeM);
  return terrainGroundAt(s.terrain, pos.x, pos.y) + agl;
}

// Buildings taller than the swarm's AGL can't be overflown — each one is a
// no-fly cylinder (radius = half footprint diagonal plus a safety skirt).
function buildingObstacleRadiusM(s, b) {
  if (b.heightM <= s.altitudeM) return 0;
  return Math.hypot(b.w, b.d) / 2 + 18;
}

// External vehicles fly straight at whatever goal they're given — the
// autopilot doesn't carry our obstacle map, so OUR knowledge must not
// command it through a tower (review finding #11). Pull a goal back to just
// short of the first no-fly footprint on its straight line. Vetting re-runs
// on every goal push (~2 Hz), so capping the scan radius keeps it cheap
// while the vehicle still never receives a leg that crosses a known building.
function clipGoalToNoFly(s, from, goal) {
  if (!s.terrain || !s.terrain.buildings || !s.terrain.buildings.length) return goal;
  const legM = dist2d(from, goal);
  if (legM < 1e-6) return goal;
  const scanM = Math.min(legM + OBSTACLE_CLEAR_M + 40, 600);
  let firstHit = null;
  for (const b of buildingsNear(s.terrain, from.x, from.y, scanM)) {
    if (b.heightM <= s.altitudeM) continue;
    const minX = b.x - b.w / 2 - OBSTACLE_CLEAR_M, maxX = b.x + b.w / 2 + OBSTACLE_CLEAR_M;
    const minY = b.y - b.d / 2 - OBSTACLE_CLEAR_M, maxY = b.y + b.d / 2 + OBSTACLE_CLEAR_M;
    if (from.x > minX && from.x < maxX && from.y > minY && from.y < maxY) continue; // expel logic owns this case
    const hit = rayIntersectsAABB(from.x, from.y, goal.x, goal.y, minX, maxX, minY, maxY);
    if (hit && hit.tmin > 0 && hit.tmin <= 1 && (firstHit == null || hit.tmin < firstHit)) firstHit = hit.tmin;
  }
  if (firstHit == null) return goal;
  const f = Math.max(0, firstHit - 0.02);
  return { x: from.x + (goal.x - from.x) * f, y: from.y + (goal.y - from.y) * f };
}

// Hard flight envelope (review finding #1 / B6): the avoidance push in
// stepDrone is a soft force capped by the accel limit — inertia can beat it,
// and at dt=0.05 a full-speed drone punched ~0.4 m into a footprint. This is
// the guarantee the push can't make: sweep each step's motion segment against
// every no-fly building nearby (same exact segment/AABB math LOS uses); a
// step that would cross into a footprint — inflated by a clearance band —
// stops at the wall instead, keeping only the velocity that slides along it.
const OBSTACLE_CLEAR_M = 2.5;

function clampStepToBuildings(s, d, dt) {
  const sx = d.x, sy = d.y;
  const ex = sx + d.vx * dt, ey = sy + d.vy * dt;
  const reach = Math.abs(ex - sx) + Math.abs(ey - sy) + OBSTACLE_CLEAR_M + 40;
  let best = null; // earliest wall crossing this step: { t, nx, ny }
  for (const b of buildingsNear(s.terrain, sx, sy, reach)) {
    if (b.heightM <= s.altitudeM) continue; // scenery below flight level
    const minX = b.x - b.w / 2 - OBSTACLE_CLEAR_M, maxX = b.x + b.w / 2 + OBSTACLE_CLEAR_M;
    const minY = b.y - b.d / 2 - OBSTACLE_CLEAR_M, maxY = b.y + b.d / 2 + OBSTACLE_CLEAR_M;
    if (sx > minX && sx < maxX && sy > minY && sy < maxY) {
      // Already inside the clearance band (spawn, drift, loaded state):
      // exit through the nearest face and shed the inward velocity —
      // never trap, never teleport across the building.
      const exits = [
        { pen: sx - minX, nx: -1, ny: 0 }, { pen: maxX - sx, nx: 1, ny: 0 },
        { pen: sy - minY, nx: 0, ny: -1 }, { pen: maxY - sy, nx: 0, ny: 1 },
      ];
      let e = exits[0];
      for (const c of exits) if (c.pen < e.pen) e = c;
      d.x = sx + e.nx * (e.pen + 0.05); d.y = sy + e.ny * (e.pen + 0.05);
      const vn = d.vx * e.nx + d.vy * e.ny;
      if (vn < 0) { d.vx -= e.nx * vn; d.vy -= e.ny * vn; }
      return; // this tick's motion is spent resolving the incursion
    }
    const hit = rayIntersectsAABB(sx, sy, ex, ey, minX, maxX, minY, maxY);
    if (hit && hit.tmin > 0 && hit.tmin <= 1 && (!best || hit.tmin < best.t)) {
      // Wall normal = the face the entry point lies on.
      const px = sx + (ex - sx) * hit.tmin, py = sy + (ey - sy) * hit.tmin;
      const faces = [
        { m: Math.abs(px - minX), nx: -1, ny: 0 }, { m: Math.abs(px - maxX), nx: 1, ny: 0 },
        { m: Math.abs(py - minY), nx: 0, ny: -1 }, { m: Math.abs(py - maxY), nx: 0, ny: 1 },
      ];
      let f = faces[0];
      for (const c of faces) if (c.m < f.m) f = c;
      best = { t: hit.tmin, nx: f.nx, ny: f.ny };
    }
  }
  if (!best) { d.x = ex; d.y = ey; return; }
  const f = Math.max(0, best.t - 1e-3);
  d.x = sx + (ex - sx) * f;
  d.y = sy + (ey - sy) * f;
  const vn = d.vx * best.nx + d.vy * best.ny;
  if (vn < 0) { d.vx -= best.nx * vn; d.vy -= best.ny * vn; } // slide, don't stall
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

// One band representation everywhere (review finding #20): a jammer's band
// may arrive as a number (MHz), a numeric string, 'all', or a legacy name.
// Returns the center frequency in MHz, or null for wideband/'all'. The DF
// branch used to recognize only '2.4g'/'5g' and mapped numeric 2400 to
// 915 — a 2.4 GHz hunter was deaf to a 2.4 GHz emitter beside it.
function jammerFreqMHz(j) {
  if (j.freqMHz != null) return j.freqMHz;
  const b = j.band;
  if (b == null || b === 'all') return null;
  if (typeof b === 'number') return b;
  const n = parseFloat(b);
  if (isFinite(n)) return n;
  if (b === '2.4g') return 2400;
  if (b === '5g') return 5800;
  if (b === 'sub1g') return 915;
  return null;
}

// Spectrum agility (anti-jam) and LPI/LPD waveform modelling.
// - Frequency agility: a hopping radio only ever sits in the jammer's band a
//   small fraction of the time — modelled as processing/escape gain that
//   subtracts from the interference the RECEIVER experiences. Per-radio
//   `hopGainDb` (datasheet-class MANET/FHSS radios carry 12–16 dB).
// - LPI/LPD mode: low-probability-of-intercept waveforms trade link budget
//   for survivability — a fixed margin cost, but a jammer that can barely
//   see you can't aim at you either, so the denial floor drops further.
const AGILITY = {
  lpiCostDb: 3,          // link budget paid for the spread waveform
  lpiDenyReductionDb: 6, // extra interference rejection (harder to follow)
};

// Total interference rejection this receiver enjoys right now, dB.
function agilityGainDb(s, radio) {
  if (!radio) return 0;
  let g = 0;
  if (s.spectrumAgility && radio.hopGainDb) g += radio.hopGainDb;
  if (s.lpiMode) g += AGILITY.lpiDenyReductionDb;
  return g;
}

// Elevated noise floor (dBm, in sensitivity-equivalent terms) that all active
// interference sources impose on a receiver at rxPos/rxAlt. -Infinity if none.
// rxRadio carries the receiver's anti-jam capability (spectrum agility).
function interferenceFloorDbm(s, rxPos, rxAlt, rxRadio) {
  const jams = s.jammers;
  if (!jams || !jams.length) return -Infinity;
  const rad = rxRadio || s.radio;
  const n = pathLossExponent(rad);
  const pl1 = pl1m(rad.freqMHz);
  const gainDb = agilityGainDb(s, rad);
  let lin = 0;
  for (const j of jams) {
    if (j.on === false) continue;
    const jf = jammerFreqMHz(j);
    if (jf != null && Math.abs(jf - rad.freqMHz) > 150) continue; // out of band
    const ground = Math.hypot(rxPos.x - j.x, rxPos.y - j.y);
    const jAlt = terrainGroundAt(s.terrain, j.x, j.y) + (j.altM || 15);
    if (losBlocked(s.terrain, j.x, j.y, jAlt, rxPos.x, rxPos.y, rxAlt)) continue; // terrain shadows it
    const slant = Math.hypot(ground, jAlt - rxAlt);
    const pl = pl1 + 10 * n * Math.log10(Math.max(1, slant / s.envFactor));
    lin += Math.pow(10, (j.erpDbm - gainDb - pl) / 10);
  }
  return lin > 0 ? 10 * Math.log10(lin) + JAM_SNR_OFFSET_DB : -Infinity;
}

// How much interference degrades this link, in dB (>=0). Each end's floor is
// compared against THAT end's own sensitivity; the worst end wins. Radios ra
// and rb are the transmit-side radios of each node (their receivers share the
// hardware), or null for swarm-wide defaults.
function interferencePenaltyDb(s, aPos, aAlt, bPos, bAlt, ra, rb) {
  if (!s.jammers || !s.jammers.length) return 0;
  const rA = ra || s.radio, rB = rb || s.radio;
  const fa = interferenceFloorDbm(s, aPos, aAlt, rA);
  const fb = interferenceFloorDbm(s, bPos, bAlt, rB);
  return Math.max(0,
    isNaN(fa) ? -Infinity : fa - rA.sensDbm,
    isNaN(fb) ? -Infinity : fb - rB.sensDbm);
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
  // Spectrum survey uses the radio that would actually HOLD a relay there.
  return interferenceFloorDbm(s, pos, alt, chainRadio(s)) > chainRadio(s).sensDbm;
}

// Widest active denial radius — used to give the path planner room to detour.
function maxDenialRadiusM(s) {
  let r = 0;
  for (const j of (s.jammers || [])) r = Math.max(r, jammerDenialRadiusM(s, j));
  return r;
}

// Radius at which a single source raises the floor to the radio's sensitivity
// (flat-ground estimate) — the visible "denied zone" for the current radio,
// shrunk by whatever anti-jam rejection that radio enjoys right now.
function jammerDenialRadiusM(s, j) {
  if (j.on === false) return 0;
  if (j.band !== 'all' && Math.abs(j.band - s.radio.freqMHz) > 150) return 0;
  const r = chainRadio(s);
  const n = pathLossExponent(r);
  const eff = j.erpDbm - agilityGainDb(s, r);
  const exp = (eff - pl1m(r.freqMHz) + JAM_SNR_OFFSET_DB - r.sensDbm) / (10 * n);
  return s.envFactor * Math.pow(10, exp);
}

let jammerSeq = 0;
function makeJammer(x, y, erpDbm) {
  jammerSeq += 1;
  return { id: 'JX-' + jammerSeq, x, y, erpDbm: erpDbm != null ? erpDbm : 10, band: 'all', altM: 15, on: true };
}

function liveMarginDb(s, aId, bId) {
  if (aId === bId) return Infinity;
  const cacheKey = aId < bId ? aId + ':' + bId : bId + ':' + aId;
  if (s && s._marginCache) {
    const cached = s._marginCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  const a = nodePos(s, aId), b = nodePos(s, bId);
  if (!a || !b) return -Infinity;

  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  const maxSpan = 60000;
  if (dx > maxSpan || dy > maxSpan) {
    if (s && s._marginCache) s._marginCache.set(cacheKey, -Infinity);
    return -Infinity;
  }

  const altA = nodeAltAbsM(s, aId, a), altB = nodeAltAbsM(s, bId, b);
  const ground = Math.hypot(dx, dy);
  if (ground > radioHorizonM(altA, altB)) {
    if (s && s._marginCache) s._marginCache.set(cacheKey, -Infinity);
    return -Infinity;
  }
  if (losBlocked(s.terrain, a.x, a.y, altA, b.x, b.y, altB)) {
    if (s && s._marginCache) s._marginCache.set(cacheKey, -Infinity);
    return -Infinity;
  }
  // Mixed fleets: each end transmits with its own radio's power, antenna and
  // calibrated path-loss curve; the link carries the worse direction (js/fleet.js).
  // C2 pairs with the far end's radio (the ground station flies a matched
  // companion unit for every type in the field).
  const ra = (aId === 'C2' ? droneRadio(b) : droneRadio(a)) || s.radio;
  const rb = (bId === 'C2' ? droneRadio(a) : droneRadio(b)) || s.radio;
  const slant = Math.hypot(ground, altA - altB);
  // LPI/LPD waveform: pay a fixed link-budget cost for the spread spectrum.
  const lpiCost = s.lpiMode ? AGILITY.lpiCostDb : 0;
  const res = mixedLinkMarginDb(ra, rb, s.envFactor, slant) + fadeDb(s, aId, bId)
    - lpiCost
    - interferencePenaltyDb(s, a, altA, b, altB, ra, rb);
  if (s && s._marginCache) s._marginCache.set(cacheKey, res);
  return res;
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
  const hop = usableRangeM(droneRadio(d) || s.radio, s.envFactor) * 0.8;
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

// Ground speed achievable along the track from -> to against the wind
// VECTOR (review finding #2 / B21). The crosswind component must be crabbed
// out of the airspeed budget; what's left projects onto the track:
//   g = wind·û + sqrt(maxV² − wind⊥²)
// Same envelope math the movement integrator flies, so the planner promises
// only what the physics can deliver. Returns 0 when the leg cannot be flown
// at all (crosswind exceeds airspeed, or the wind blows the drone backward
// at full throttle) — infeasible is an answer, not a slow speed.
function groundSpeedAlong(af, wind, fromP, toP) {
  const dx = toP.x - fromP.x, dy = toP.y - fromP.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-6) return af.maxSpeedMs;
  const ux = dx / L, uy = dy / L;
  const wPar = wind.x * ux + wind.y * uy;
  const wPerp = wind.x * uy - wind.y * ux;
  const rem = af.maxSpeedMs * af.maxSpeedMs - wPerp * wPerp;
  if (rem <= 0) return 0;
  return Math.max(0, wPar + Math.sqrt(rem));
}

// FASTER-style commitment rule (methodology from MIT ACL's FASTER planner:
// never commit to a plan unless a backup plan provably closes). Here the
// backup plan is energetic: fly to the goal, then still make it home against
// the wind with the pessimism margin and reserve intact. Each leg is solved
// against the wind vector; an unflyable leg rejects the order outright — a
// scalar "max(1, maxV − |wind|)" floor used to accept short impossible
// returns on battery cost and reject easy downwind runs at stall speed.
function orderFeasible(s, d, order) {
  const af = afOf(s, d);
  const goal = orderGoal(s, order);
  const gOut = groundSpeedAlong(af, s.wind, d, goal);
  const gHome = groundSpeedAlong(af, s.wind, goal, s.base);
  if (gOut < 0.5 || gHome < 0.5) return false; // a leg that can't be flown fails every backup plan
  const pw = flightPowerW(af, af.maxSpeedMs);
  const whToGoal = pw * (dist2d(d, goal) / gOut) / 3600;
  const whGoalHome = pw * (dist2d(goal, s.base) / gHome) / 3600 * BATTERY.homeMargin;
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
    s.c2.everHeard.add(p.src);
    covMark(s, p.payload.x, p.payload.y, 'good');
    if (p.payload.deadLog && p.payload.deadLog.length) {
      // Sitting somewhere in silence is much stronger evidence than one
      // lucky packet — weight dead samples accordingly. But apply each
      // sample ONCE, deduped by the vehicle's own sequence: a lost ACK makes
      // the sender replay, and replays used to stack weight 3→6→9 of
      // phantom certainty into the coverage map (finding #17). A sequence
      // moving BACKWARD means the vehicle reinitialized — accept the new
      // session's numbering rather than silencing it.
      s.c2.covSeqApplied = s.c2.covSeqApplied || {};
      const maxSeq = p.payload.deadLogMaxSeq || 0;
      let appliedUpTo = s.c2.covSeqApplied[p.src] || 0;
      if (maxSeq && maxSeq < appliedUpTo) appliedUpTo = 0; // restarted vehicle
      let freshSamples = 0;
      for (const pt of p.payload.deadLog) {
        if (pt.seq != null && pt.seq <= appliedUpTo) continue; // replayed evidence
        covMark(s, pt.x, pt.y, 'bad', 3);
        freshSamples++;
      }
      s.c2.covSeqApplied[p.src] = Math.max(appliedUpTo, maxSeq);
      if (freshSamples) logEvent(s, 'C2: ' + p.src + ' uploaded ' + freshSamples + ' dead-zone samples — coverage map updated', 'info');
      // ACK duplicates too — a replay means the sender never heard us.
      sendPacket(s, 'ack', 'C2', p.src, { ackDeadLogSeq: maxSeq || p.payload.deadLog.length });
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
  // distance. Hop span stays capped by the radio horizon at altitude, and is
  // sized to whatever radio holds the slots (relay wing in a mixed fleet).
  const usable = Math.min(
    usableRangeM(chainRadio(s), s.envFactor),
    radioHorizonM(C2_ANTENNA_M, s.altitudeM));
  const plan = planChain(s);
  const k = s.c2.relays.length;
  const kNeeded = plan.slots.length;

  // Operator warning: the route search failed outright — no chain can be
  // planned at all. Louder and earlier than the not-enough-relays case,
  // and announced exactly once per blockage (finding #19).
  if (!plan.feasible && !s.c2.noRouteWarned) {
    logEvent(s, 'C2: no feasible route to the objective — corridor blocked, relay plan withheld', 'error');
    s.c2.noRouteWarned = true;
  } else if (plan.feasible) {
    s.c2.noRouteWarned = false;
  }

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
    // Elect from fresh mission drones with battery to spare. Heterogeneous
    // fleets: relay-wing units are preferred for relay duty (they carry the
    // long-range radio + endurance pack); tactical units are only pulled
    // onto the chain when no wing unit is available — C2 says so out loud.
    const base = Object.keys(known).filter(id =>
      fresh(id) && known[id].role === 'mission' &&
      known[id].battery >= RELAY.minBatteryPct && !s.c2.relays.includes(id) &&
      !s.c2.rescuers.includes(id) && !(s.c2.unfit[id] > s.time));
    const wing = base.filter(id => known[id].cls === 'relay');
    const candidates = wing.length ? wing : base;
    // Mixed fleet, launch phase: if wing units exist but haven't checked in
    // yet, hold the election a few command rounds instead of pinning a
    // tactical drone onto the chain it can barely hold. "Checked in ever"
    // (not currently-fresh) is the right bar — contact drops are normal.
    const rosterKnown = s.c2.everHeard.size >= s.drones.length;
    const waitingForRoster = !wing.length && !!s.relayIdx.length && !rosterKnown && s.time < 30;
    if (candidates.length && !waitingForRoster) {
      const slot = plan.slots[k] || s.target;
      let best = null, bestScore = -Infinity;
      for (const id of candidates) {
        const score = 0.6 * (known[id].battery / 100)
                    + 0.4 * (1 - Math.min(1, dist2d(known[id], slot) / (usable * 2)));
        if (score > bestScore) { bestScore = score; best = id; }
      }
      if (!wing.length && !s.c2.wingFallbackWarned) {
        logEvent(s, 'C2: no relay-wing units available — electing tactical drones for the chain', 'warn');
        s.c2.wingFallbackWarned = true;
      }
      if (wing.length) s.c2.wingFallbackWarned = false;
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
    // Rescue prefers TACTICAL units: pulling a relay-wing drone off the chain
    // costs the whole swarm its backhaul, so the wing is the last resort.
    const base = Object.keys(known).filter(id =>
      fresh(id) && known[id].role === 'mission' &&
      known[id].battery >= RELAY.minBatteryPct && !s.c2.relays.includes(id) &&
      !s.c2.rescuers.includes(id) && !(s.c2.unfit[id] > s.time));
    const tac = base.filter(id => known[id].cls !== 'relay');
    const candidates = tac.length ? tac : base.filter(id => {
      const d = nodePos(s, id);
      const r = (d && droneRadio(d)) || s.radio;
      return bandCompatible(r, s.radio);
    });
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
        videoOn: false,
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
      // The grant rides in the order with an ABSOLUTE expiry and an id —
      // the drone stops at the deadline no matter how chatty the link
      // stays (finding #21). Renewal requires a fresh order, on purpose.
      videoOn: id === s.c2.vidGrantee,
      videoUntil: id === s.c2.vidGrantee && s.c2.vidGrantAt != null ? s.c2.vidGrantAt + VID_GRANT_SEC : null,
      videoGrant: id === s.c2.vidGrantee ? (s.c2.vidGrantSeq || 0) : null,
      c2: { x: s.base.x, y: s.base.y }, // the GCS streams its own position (finding #18)
      target: { x: s.target.x, y: s.target.y },
    };
  };

  const ids = Object.keys(known);

  // --- Payload scheduling (video backhaul) --------------------------------
  // One streamer at a time: a store-and-forward relay chain divides its
  // airrate across hops AND users, so C2 hands out the channel in round-robin
  // turns. The grant rides to the drone inside its order packet — no magic.
  const VID_GRANT_SEC = 20;
  if (s.videoOn && s.videoKbps > 0) {
    const wanters = ids.filter(id => fresh(id) && known[id].role === 'mission').sort();
    if (!wanters.length) {
      s.c2.vidGrantee = null;
      s.c2.vidGrantAt = null;
    } else {
      let expired = false;
      if (s.c2.vidGrantee && s.c2.vidGrantAt != null && (s.time - s.c2.vidGrantAt >= VID_GRANT_SEC)) {
        expired = true;
      }
      let idx = wanters.indexOf(s.c2.vidGrantee);
      if (idx < 0 || expired) {
        // previous grantee gone from contact or grant expired — hand the mic to the next in line
        if (expired && idx >= 0) {
          idx = (idx + 1) % wanters.length;
          s.c2.vidIdx = idx;
        } else {
          idx = s.c2.vidIdx % wanters.length;
          s.c2.vidIdx = (s.c2.vidIdx + 1) % wanters.length;
        }
        s.c2.vidGrantee = wanters[idx];
        s.c2.vidGrantAt = s.time;
        s.c2.vidGrantSeq = (s.c2.vidGrantSeq || 0) + 1; // fresh grant, fresh identity
      }
    }
  } else {
    s.c2.vidGrantee = null;
    s.c2.vidGrantAt = null;
  }

  if (s.broadcastC2) {
    // One flooded packet carries the whole table — see stepBcasts
    const orders = {};
    for (const id of ids) orders[id] = orderFor(id);
    s.c2.bcastSeq += 1;
    const bcastBytes = NET.bcastHeaderBytes + NET.bcastRowBytes * ids.length;
    sendBroadcast(s, 'C2', { seq: s.c2.bcastSeq, orders, c2: { x: s.base.x, y: s.base.y } }, bcastBytes);
    if (s.relayRadio && !bandCompatible(s.radio, s.relayRadio)) {
      sendBroadcast(s, 'C2', { seq: s.c2.bcastSeq, orders, c2: { x: s.base.x, y: s.base.y } }, bcastBytes, s.relayRadio);
    }
  } else {
    // Unicast: one routed packet per drone — best effort, dies without a route
    for (const id of ids) sendPacket(s, 'cmd', 'C2', id, orderFor(id));
  }
}

// Slot positions come from the planned path; covAdjust still guards against
// cells that turned measured-bad since the last replan.
function adjustedSlotPos(s, slot, k) {
  const plan = s.c2.chainPlan;
  if (plan && plan.feasible === false) return null; // no route — never mint straight-line slots (finding #19)
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
    if (p.kind === 'ack' && p.payload && p.payload.ackDeadLogSeq != null) {
      d.deadLogAckedSeq = Math.max(d.deadLogAckedSeq || 0, p.payload.ackDeadLogSeq);
      d.deadLog = d.deadLog.filter(sample => sample.seq && sample.seq > d.deadLogAckedSeq);
      continue;
    }
    if (p.kind !== 'cmd' && p.kind !== 'bcast') continue;
    // Any heard C2 transmission proves the link works here — even a
    // broadcast without a row for us (C2 hasn't met us yet)
    d.lastC2 = s.time;
    d.lastLinkX = d.x; d.lastLinkY = d.y;
    d.relinkUntil = null;
    d.relinkAttempt = 0;
    // C2's own position rides in every packet it sends (a real GCS streams
    // its location). This is the ONLY way a drone learns the base moved
    // (finding #18) — knowledge arrives by radio, never by telepathy.
    const c2pos = p.payload && p.payload.c2;
    if (c2pos && isFinite(c2pos.x) && isFinite(c2pos.y)) {
      d.baseKnown = { x: c2pos.x, y: c2pos.y, at: s.time };
    }
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
  // upload) and are retained until network delivery is confirmed by ACK.
  if (s.time >= d.nextTlm) {
    d.nextTlm = s.time + tlmIntervalSec(s);
    // Report what the drone's navigation believes — GNSS denial poisons the
    // position C2 sees, which is exactly how a real jammed airframe lies.
    const repX = d.gpsDenied ? d.belX : d.x + GPS_SIGMA_M * gaussian(s.net.rng);
    const repY = d.gpsDenied ? d.belY : d.y + GPS_SIGMA_M * gaussian(s.net.rng);
    let unacked = null;
    let deadLogMaxSeq = 0;
    if (d.deadLog && d.deadLog.length > 0) {
      if (!d.deadLogSeq) d.deadLogSeq = 0;
      for (let i = 0; i < d.deadLog.length; i++) {
        const sample = d.deadLog[i];
        if (sample.seq == null) sample.seq = ++d.deadLogSeq;
      }
      const acked = d.deadLogAckedSeq || 0;
      const list = [];
      let maxSeq = 0;
      for (let i = 0; i < d.deadLog.length; i++) {
        const sample = d.deadLog[i];
        if (!sample.seq || sample.seq > acked) {
          list.push({ x: sample.x, y: sample.y, seq: sample.seq });
          if (sample.seq > maxSeq) maxSeq = sample.seq;
        }
      }
      if (list.length > 0) {
        unacked = list;
        deadLogMaxSeq = maxSeq;
      }
    }
    sendPacket(s, 'tlm', d.id, 'C2', {
      x: repX,
      y: repY,
      gps: d.gpsDenied ? 'denied' : 'ok',   // drones DO know when they've lost the fix
      battery: d.batteryPct, role: effRole(d),
      cls: d.cls,   // fleet class rides along so C2 assigns roles by capability
      reject: d.rejectedRole || null,
      deadLog: unacked,
      deadLogMaxSeq: deadLogMaxSeq,
      // Riding samples aren't free: each packed {x, y, seq} row costs real
      // bytes on the air on top of the base telemetry frame (finding #17).
    }, NET.tlmBytes + (unacked ? unacked.length * 10 : 0));
  }

  // Payload stream: emit real video chunks only while C2's grant says so.
  // Each chunk pays its full airtime on the shared channel — video visibly
  // competes with C2 traffic, and both starve when the chain thins.
  if (!d.nextVid) d.nextVid = 0;
  // Grant validity is the grant's OWN absolute deadline — never general
  // link freshness, which any broadcast refreshes without carrying a new
  // grant (finding #21). Orders without a deadline (legacy) get a hard cap.
  const vidGrantValid = d.order.videoOn &&
    s.time <= (d.order.videoUntil != null ? d.order.videoUntil : (d.lastC2 || 0) + 25);
  if (s.videoOn && vidGrantValid && d.mode === 'ok' && s.time >= d.nextVid) {
    d.nextVid = Math.max(d.nextVid + VID.chunkSec, s.time);
    sendPacket(s, 'vid', d.id, 'C2', null,
      Math.round(s.videoKbps * 1000 / 8 * VID.chunkSec));
  }

  // Black box: while the link is silent, remember where it was silent.
  const silent = d.mode === 'hold' || d.mode === 'relink' || d.mode === 'rtl';
  if (silent && s.time >= d.nextDeadLog) {
    d.nextDeadLog = s.time + COVERAGE.deadLogIntervalSec;
    if (d.deadLog.length < COVERAGE.deadLogMax) {
      d.deadLogSeq = (d.deadLogSeq || 0) + 1;
      d.deadLog.push({
        seq: d.deadLogSeq,
        // The black box records where the drone THINKS it is (finding #18):
        // GPS-denied, that's the drifted dead-reckoning belief — writing the
        // truth would be data the vehicle doesn't possess.
        x: d.gpsDenied ? d.belX : d.x + GPS_SIGMA_M * gaussian(s.net.rng),
        y: d.gpsDenied ? d.belY : d.y + GPS_SIGMA_M * gaussian(s.net.rng),
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
        const homeK = d.baseKnown || s.base; // last KNOWN base — never live truth (finding #18)
        const dHome = dist2d(d, homeK);
        const step = usableRangeM(droneRadio(d) || s.radio, s.envFactor) * FAILSAFE.relinkStepFrac;
        if (d.relinkAttempt >= FAILSAFE.relinkAttempts || dHome <= step) {
          d.mode = 'rtl';
          logEvent(s, d.id + ' no contact after ' + d.relinkAttempt + ' attempts — returning to C2', 'warn');
        } else {
          d.relinkAttempt += 1;
          const f = step / dHome;
          d.relinkGoalX = d.x + (homeK.x - d.x) * f;
          d.relinkGoalY = d.y + (homeK.y - d.y) * f;
          d.relinkUntil = null;
          logEvent(s, d.id + ' still silent — falling back toward C2 (attempt ' + d.relinkAttempt + '/' + FAILSAFE.relinkAttempts + ')', 'warn');
        }
      }
    }
  }
}

function updateBattery(s, d, dt, vAirMs) {
  const af = afOf(s, d);
  d.energyWh = Math.max(0, d.energyWh - flightPowerW(af, vAirMs) * dt / 3600);
  d.batteryPct = d.energyWh / usableWh(af) * 100;

  if (d.mode === 'ok' || d.mode === 'hold' || d.mode === 'relink') {
    // Onboard smart-RTH: energy to fly home at cruise, with pessimism +
    // reserve, along the ACTUAL home track against the wind vector (review
    // finding #2). A home leg that can't be flown at all reads as infinite
    // cost — alarm and turn back NOW rather than burn battery pretending a
    // floored "1 m/s" return exists.
    const homeK = d.baseKnown || s.base; // the drone plans against what it KNOWS (finding #18)
    const gHome = groundSpeedAlong(af, s.wind, d, homeK);
    const secsHome = gHome > 0.05 ? dist2d(d, homeK) / gHome : Infinity;
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
function goalFor(s, d, dt) {
  if (d.mode === 'rtb' || d.mode === 'rtl') {
    // Home is where the drone last LEARNED the base to be (finding #18) —
    // an operator who moves in radio silence is honestly not followed.
    const homeK = d.baseKnown || s.base;
    return { x: homeK.x, y: homeK.y };
  }
  if (d.mode === 'hold') return { x: d.holdX, y: d.holdY };
  if (d.mode === 'relink') return { x: d.relinkGoalX, y: d.relinkGoalY };
  if (d.order.role === 'rescue' && d.order.goto) return d.order.goto;
  if (d.order.role === 'relay') return slotFromOrder(s, d.order);
  // Mission: loiter ring around the ORDERED target (which may be stale — that's the point)
  const stepTime = dt != null ? dt : 0.25;
  d.orbitPhase += (stepTime / 0.25) * 0.0004 * afOf(s, d).maxSpeedMs;
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

  const plan = plannedHopMarginDb(s, d);
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

// --- Separation spatial grid ---------------------------------------------------
// Naive flocking separation is O(n²); at 100+ nodes every substep pays it
// four times over. A uniform grid at exactly the separation radius turns
// each drone's neighbor query into ~9 cells of a few members each — same
// physics, linear-ish cost.
function buildSepGrid(s) {
  const cell = DRONE.separationM;
  let grid = s._sepGrid;
  if (!grid) {
    grid = new Map();
    s._sepGrid = grid;
  } else {
    for (const arr of grid.values()) arr.length = 0;
  }
  for (let i = 0; i < s.drones.length; i++) {
    const d = s.drones[i];
    if (!alive(d)) continue;
    const key = Math.floor(d.x / cell) + ',' + Math.floor(d.y / cell);
    let arr = grid.get(key);
    if (!arr) { arr = []; grid.set(key, arr); }
    arr.push(d);
  }
  return grid;
}

function sepNeighbors(s, x, y) {
  const cell = DRONE.separationM;
  const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
  const out = [];
  if (!s._sepGrid) return out;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const arr = s._sepGrid.get((gx + dx) + ',' + (gy + dy));
      if (arr) {
        for (let i = 0; i < arr.length; i++) out.push(arr[i]);
      }
    }
  }
  return out;
}

function stepDrone(s, d, dt) {
  if (!alive(d)) return;

  droneComms(s, d);

  // Track the upstream beacon (radios hear their neighbors constantly)
  if (d.order.upstream) {
    const raw = liveMarginDb(s, d.id, d.order.upstream);
    const capped = Math.max(-20, Math.min(40, raw));
    const alpha = 1 - Math.exp(-dt / 1.54);
    d.upMarginEma += (capped - d.upMarginEma) * alpha;
    if (d.tethered && d.upMarginEma > plannedHopMarginDb(s, d) - TETHER.slowBelowPlanDb + 1) d.tethered = false;
  }

  // GNSS: is the truth position inside a denial zone? Healthy → belief snaps
  // to truth. Denied → dead reckoning (js/gpsnav.js): belief integrates
  // airspeed + drift, so the drone steers by where it THINKS it is.
  const wasDenied = d.gpsDenied;
  d.gpsDenied = gpsDeniedAt(s.gpsZones, d.x, d.y);
  if (!wasDenied && d.gpsDenied) logEvent(s, d.id + ' GNSS degraded — dead reckoning', 'warn');
  if (wasDenied && !d.gpsDenied) {
    const err = Math.hypot(d.belX - d.x, d.belY - d.y);
    if (err > 25) {
      logEvent(s, d.id + ' GNSS reacquired — nav error had grown to ' + err.toFixed(0) + ' m', 'warn');
      s.maxNavErrM = Math.max(s.maxNavErrM || 0, err);
    }
  }
  const bel = stepBelief(d, dt, s.net.rng, d.gpsDenied);
  d.belX = bel.belX; d.belY = bel.belY; d.dvx = bel.dvx; d.dvy = bel.dvy;
  // Instrumentation (sim-side observables, like batteryPct): whether this
  // drone ever lost GNSS, and the worst truth-vs-belief error seen.
  if (d.gpsDenied) {
    d.hadDenied = true;
    const err = Math.hypot(d.belX - d.x, d.belY - d.y);
    if (err > (d.peakNavErr || 0)) d.peakNavErr = err;
    s.maxNavErrM = Math.max(s.maxNavErrM || 0, err);
  }

  const goal = tetherGoal(s, d, corridorGoal(s, d, goalFor(s, d, dt)));
  // Cache the vetted goal so external mode ships exactly this one instead of
  // recomputing goalFor (which advances orbitPhase as a side effect — a
  // second call would double-step the loiter and diverge from what we vet).
  d.goalX = goal.x; d.goalY = goal.y;
  const maxV = afOf(s, d).maxSpeedMs;

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
    // Steer by the navigation BELIEF, not truth: without GNSS the drone aims
    // at where it thinks the goal is and misses by exactly its nav error.
    // The proximity/obstacle pushes below stay on truth — those are onboard
    // sensors, not satellite receivers.
    const dx = goal.x - d.belX, dy = goal.y - d.belY;
    const dGoal = Math.hypot(dx, dy);

    let maxVg = maxV;
    if (dGoal > 0.01 && s.wind && (s.wind.x || s.wind.y)) {
      const ux = dx / dGoal, uy = dy / dGoal;
      const wPar = s.wind.x * ux + s.wind.y * uy;
      const wPerp = s.wind.x * uy - s.wind.y * ux;
      const vaRemSq = maxV * maxV - wPerp * wPerp;
      maxVg = vaRemSq > 0 ? Math.max(0, wPar + Math.sqrt(vaRemSq)) : 0;
    }
    const brake = (maxVg * maxVg) / (2 * DRONE.accelMs2);
    const desiredSpeed = dGoal > brake ? maxVg : maxVg * (dGoal / Math.max(0.1, brake));
    let ax = 0, ay = 0;
    if (dGoal > 0.5) {
      ax = (dx / dGoal) * desiredSpeed - d.vx;
      ay = (dy / dGoal) * desiredSpeed - d.vy;
    } else {
      ax = -d.vx; ay = -d.vy;
    }

    // Separation: only nearby flockmates matter — 3×3 grid cells around the
    // drone (cell = separation radius), not the whole fleet.
    const sepM = DRONE.separationM;
    const sepSq = sepM * sepM;
    const gx = Math.floor(d.x / sepM), gy = Math.floor(d.y / sepM);
    if (s._sepGrid) {
      for (let cdx = -1; cdx <= 1; cdx++) {
        for (let cdy = -1; cdy <= 1; cdy++) {
          const arr = s._sepGrid.get((gx + cdx) + ',' + (gy + cdy));
          if (!arr) continue;
          for (let oi = 0; oi < arr.length; oi++) {
            const o = arr[oi];
            if (o === d || !alive(o)) continue;
            const diffX = d.x - o.x, diffY = d.y - o.y;
            const sdSq = diffX * diffX + diffY * diffY;
            if (sdSq < sepSq && sdSq > 0.0001) {
              const sd = Math.sqrt(sdSq);
              const push = (sepM - sd) / sepM * DRONE.accelMs2 * 2;
              ax += (diffX / sd) * push;
              ay += (diffY / sd) * push;
            }
          }
        }
      }
    }

    // Obstacle avoidance: onboard map, buildings above flight level are
    // no-fly cylinders. Radial push plus a tangential bias so a head-on
    // approach slides around the rim instead of stalling against it.
    // Only buildings near the drone can push it — spatial-index query keeps
    // this cheap in a dense city. The push is radial (away) PLUS a tangential
    // slide chosen toward the goal, so the drone slides around a building
    // instead of stalling head-on against it (which wedged it in dense cities).
    for (const b of buildingsNear(s.terrain, d.x, d.y, 200)) {
      const rObst = buildingObstacleRadiusM(s, b);
      if (!rObst) continue;
      const dxh = d.x - b.x, dyh = d.y - b.y;
      const dh = Math.hypot(dxh, dyh);
      if (dh < rObst && dh > 0.01) {
        const strength = ((rObst - dh) / rObst) * DRONE.accelMs2 * 3;
        const nx = dxh / dh, ny = dyh / dh;      // radial, away from the building
        let tx = -ny, ty = nx;                    // tangent; flip to point toward the goal
        if ((goal.x - d.x) * tx + (goal.y - d.y) * ty < 0) { tx = -tx; ty = -ty; }
        ax += nx * strength * 0.7 + tx * strength * 1.0;
        ay += ny * strength * 0.7 + ty * strength * 1.0;
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
    clampStepToBuildings(s, d, dt); // hard no-fly guarantee — soft push above is advisory

    updateBattery(s, d, dt, Math.min(va, maxV));
  }

  if ((d.mode === 'rtb' || d.mode === 'rtl') && dist2d(d, s.base) < DRONE.landThresholdM) {
    // Internal physics is a 2D abstraction — touchdown is instantaneous.
    // A REAL vehicle must CONFIRM it: reported altitude near the ground, or
    // no swap crew starts work under a hovering aircraft (finding #11).
    const grounded = !external || (d.altM != null && d.altM <= 2);
    if (d.mode === 'rtb' && grounded) {
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
    const route = (() => {
      const up = pathToC2(s, rep.id);       // shared C2 tree — no fresh search
      return up ? up.slice().reverse() : null;
    })();
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

  // Ground-truth connectivity, two grades (review finding #6):
  //   fleetConnected — C2 can reach at least one mission drone SOMEWHERE;
  //   connected      — the metric every consumer reads (status pill, uptime,
  //                    batch reports): C2 has a live route to a mission drone
  //                    ON STATION at the objective. On-station is an explicit
  //                    mission radius — the orbit ring plus slack — never a
  //                    function of radio range, which used to make a drone
  //                    45 km short of the target count as "at the objective"
  //                    on a long-range radio.
  const tree = c2Tree(s);
  const fleetConnected = flock.some(d => (tree.dist.get(d.id) || Infinity) < Infinity);
  const onStationM = DRONE.orbitRadiusM * 2.5;
  const connected = flock.some(d =>
    (tree.dist.get(d.id) || Infinity) < Infinity && dist2d(d, s.target) <= onStationM);
  const objectiveConnected = connected;

  // Operator's view: how many drones does C2 have fresh contact with?
  const freshCount = Object.keys(s.c2.known)
    .filter(id => (s.time - s.c2.known[id].at) <= C2.staleSec).length;
  const aliveCount = s.drones.filter(alive).length;

  return { nodes, hops, connected, fleetConnected, objectiveConnected, missionCount: flock.length, relayCount: relays.length, freshCount, aliveCount };
}

// --- Red-team adversaries -----------------------------------------------------
// Each active source DFs recent transmissions (net.txAt) and crawls toward
// their recency-weighted centroid at its own ground speed. Sensor-honest:
// models reception range, frequency band, terrain LOS, and sensor angular noise (B20).
function stepAdversaries(s, dt) {
  if (!s.adversaryMode || !s.jammers || !s.jammers.length) return;
  const now = s.time;
  for (const j of s.jammers) {
    if (j.on === false) continue;
    const contacts = [];
    const jAlt = terrainGroundAt(s.terrain, j.x, j.y) + (j.altM != null ? j.altM : 2);
    // A DF fix is a MEASUREMENT: taken once, at the emission, and kept as
    // taken (finding #20). Re-deriving bearings from the emitter's live
    // position every tick let a hunter track targets that had gone silent.
    j._obs = j._obs || {};
    for (const [id, t] of Object.entries(s.net.txAt)) {
      if (typeof ADVERSARY !== 'undefined' && (now - t > ADVERSARY.senseWindowSec)) {
        delete j._obs[id]; // emission aged out of the receiver's memory
        continue;
      }
      const prev = j._obs[id];
      if (!prev || prev.t !== t) {
        // New emission — attempt one measurement now (the emission tick).
        let fix = null;
        const p = nodePos(s, id);
        if (p && (p === s.base || alive(p))) {
          const rad = id === 'C2' ? s.radio : (droneRadio(p) || s.radio);
          const jf = jammerFreqMHz(j);
          const bandOk = jf == null || Math.abs(rad.freqMHz - jf) <= BAND_COMPAT_MHZ;
          const dist = dist2d(j, p);
          const maxDetectRange = j.detectRangeM || Math.max(4000, usableRangeM(rad, s.envFactor) * 2.5);
          if (bandOk && dist <= maxDetectRange &&
              !losBlocked(s.terrain, j.x, j.y, jAlt, p.x, p.y, nodeAltAbsM(s, id, p))) {
            const bearing = Math.atan2(p.y - j.y, p.x - j.x) + gaussian(s.net.rng) * 0.03; // ~1.7° error
            fix = { x: j.x + dist * Math.cos(bearing), y: j.y + dist * Math.sin(bearing), age: t };
          }
        }
        j._obs[id] = { t, fix }; // a failed measurement is recorded too — no retry until the next emission
      }
      const ob = j._obs[id];
      if (ob.fix) contacts.push(ob.fix);
    }
    const target = trafficCentroid(contacts, now);
    const speed = j.moveSpeedMs || 9;
    const before = { x: j.x, y: j.y };
    const np = adversaryStep(j, target, speed, dt);
    if (np !== j) {
      j.x = np.x; j.y = np.y;
      s.advStats.movedM += dist2d(before, j);
      if (!j._huntLogged) {
        logEvent(s, 'RED TEAM: ' + j.id + ' is direction-finding traffic — hunting at ' + speed + ' m/s', 'error');
        j._huntLogged = true;
      }
    }
  }
}

// --- Tick -------------------------------------------------------------------------
function stepSwarm(s, dt) {
  s.time += dt;
  if (!s._marginCache) s._marginCache = new Map();
  else s._marginCache.clear();

  // Moving-mission dynamics: the convoy drives, the fire front creeps. The
  // chain re-plans live behind them — exactly the behaviour a dragged
  // operator already exercises, now on a clock.
  s.base.x += (s.baseVel ? s.baseVel.x : 0) * dt;
  s.base.y += (s.baseVel ? s.baseVel.y : 0) * dt;
  s.target.x += (s.targetVel ? s.targetVel.x : 0) * dt;
  s.target.y += (s.targetVel ? s.targetVel.y : 0) * dt;

  // Red team moves first: it repositions before the swarm's planning round.
  stepAdversaries(s, dt);

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
      d.energyWh = usableWh(afOf(s, d));
      d.batteryPct = 100;
      d.swapAt = null;
      d.lastC2 = s.time;
      d.order = { role: 'mission', slot: -1, k: 0, upstream: 'C2', target: { x: s.target.x, y: s.target.y } };
      if (s.stats) s.stats.swaps = (s.stats.swaps || 0) + 1; // one completed swap, counted once
      logEvent(s, d.id + ' battery swapped — relaunching', 'info');
    }
  }

  // Neighbor grid rebuilt once per tick — the flock moves between ticks.
  s._sepGrid = buildSepGrid(s);
  for (const d of s.drones) stepDrone(s, d, dt);
  if (s._marginCache) s._marginCache.clear();
  stepNet(s, dt);

  // Link-uptime accounting — the denominator of the anti-jam story.
  s.stats.tSec += dt;

  // Ship the goals our logic just decided out to the vehicles.
  if (external) externalPushGoals(s);

  const st = chainStatus(s);
  if (st.connected) s.stats.connSec += dt;
  if (st.fleetConnected) s.stats.fleetConnSec = (s.stats.fleetConnSec || 0) + dt;
  return st;
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
  const relayEvents = (s.stats && s.stats.relayEvents) || s.events.filter(e => e.kind === 'relay').length;
  const failsafes = (s.stats && s.stats.failsafes) || s.events.filter(e => /lost C2 link|link timeout|retreating/.test(e.msg)).length;
  const swaps = (s.stats && s.stats.swaps) || s.events.filter(e => e.msg.includes('swapped')).length;
  const L = [];
  L.push('# Mission after-action report');
  L.push('');
  L.push('_Generated by the drone swarm relay simulator at T+' + mins + ' min._');
  L.push('');
  L.push('## Setup');
  L.push('- **Radio:** ' + s.radio.name + ' (' + s.radio.freqMHz + ' MHz, usable ~' + fmtDist(usableRangeM(s.radio, s.envFactor)) + ')');
  // Fleet composition: heterogeneous missions list each class separately.
  const wingN = (s.relayIdx && s.relayIdx.length) || 0;
  let fleetLine = '- **Airframe:** ' + afOf(s, s.drones[0] || {}).name + ' × ' + (s.drones.length - wingN);
  if (wingN) {
    fleetLine += ' · relay wing: ' + s.relayAirframe.name + ' × ' + wingN +
      ' on ' + s.relayRadio.name;
  }
  L.push(fleetLine + ' — ' + s.drones.length + ' drones');
  L.push('- **Objective distance:** ' + fmtDist(D) + ' from the ground station');
  L.push('- **Altitude:** ' + s.altitudeM + ' m AGL' + (Math.hypot(s.wind.x, s.wind.y) > 0.5 ? ' · wind ' + Math.hypot(s.wind.x, s.wind.y).toFixed(0) + ' m/s' : ''));
  L.push('- **Interference sources:** ' + activeJam + (activeJam ? ' active (RF denial in play)' : ' (clean spectrum)'));
  if (s.spectrumAgility || s.lpiMode) {
    const r = chainRadio(s);
    L.push('- **EW waveforms:** ' +
      (s.spectrumAgility && r.hopGainDb ? 'spectrum agility ON (+' + r.hopGainDb + ' dB anti-jam)' : '') +
      (s.spectrumAgility && s.lpiMode ? ' · ' : '') +
      (s.lpiMode ? 'LPI/LPD ON (\u2212' + AGILITY.lpiCostDb + ' dB budget, +' + AGILITY.lpiDenyReductionDb + ' dB denial rejection)' : ''));
  }
  const gpsZ = (s.gpsZones || []).filter(z => z.on !== false).length;
  if (gpsZ) {
    L.push('- **GPS denial:** ' + gpsZ + ' zone' + (gpsZ === 1 ? '' : 's') +
      (s.maxNavErrM ? ' · worst observed nav error ' + s.maxNavErrM.toFixed(0) + ' m' : ''));
  }
  if (s.adversaryMode && activeJam) {
    L.push('- **Red-team adversary:** sources hunted traffic, repositioning ' +
      s.advStats.movedM.toFixed(0) + ' m in total — uptime below includes the chase.');
  }
  L.push('');
  L.push('## Outcome');
  L.push('- **Link to objective:** ' + (st.connected ? '**CONNECTED** end-to-end' : '**not connected** at report time'));
  L.push('- **Chain:** ' + st.relayCount + ' relay drones bridging ' + st.missionCount + ' mission drones');
  L.push('- **C2 contact:** ' + st.freshCount + ' of ' + st.aliveCount + ' airborne drones in fresh telemetry contact');
  if (s.stats.tSec > 0) {
    L.push('- **Link uptime:** ' + (100 * s.stats.connSec / s.stats.tSec).toFixed(1) + '% of the mission connected end-to-end');
  }
  L.push('- **Relay re-plans:** ' + relayEvents + ' · **Failsafe events:** ' + failsafes + ' · **Battery swaps:** ' + swaps);
  L.push('');
  if (s.videoOn) {
    const v = s.net.vid;
    const total = v.framesDelivered + v.droppedFrames;
    L.push('## Payload link');
    L.push('- **Video backhaul:** ' + s.videoKbps + ' kbps demand — ' +
      v.framesDelivered.toLocaleString() + ' chunks delivered' +
      (total ? ' (' + (100 * v.droppedFrames / total).toFixed(1) + '% chunk loss)' : '') +
      (s.c2.vidGrantee ? ' · streaming now: ' + s.c2.vidGrantee : ''));
    L.push('');
  }
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

// UMD-lite: only the cross-runtime policy constant — the sim itself runs as
// browser globals / inside the vm harness.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SIM_DT_SEC };
}

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
    covCellM: Math.max(20, usableRangeM(opts.radio, opts.envFactor) * 0.15),
    showCoverage: true,
    broadcastC2: opts.broadcastC2 !== false,
    net: makeNet(opts.seed || 42),
    c2: { known: {}, relays: [], inbox: [], nextCmd: 0, wasFresh: {}, lost: {}, rescuer: null, unfit: {}, cov: new Map(), slotCache: {}, bcastSeq: 0 },
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
  return s.terrain.buildings.some(b => dist2d(pos, b) < buildingObstacleRadiusM(s, b) + 10);
}

function badPlan(s, pos) {
  return covState(s, pos.x, pos.y) === 'bad' || insideObstacle(s, pos);
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
function liveMarginDb(s, aId, bId) {
  const a = nodePos(s, aId), b = nodePos(s, bId);
  if (!a || !b) return -Infinity;
  const altA = nodeAltAbsM(s, aId, a), altB = nodeAltAbsM(s, bId, b);
  const ground = dist2d(a, b);
  if (ground > radioHorizonM(altA, altB)) return -Infinity;
  if (losBlocked(s.terrain, a.x, a.y, altA, b.x, b.y, altB)) return -Infinity;
  const slant = Math.hypot(ground, altA - altB);
  return linkMarginDb(s.radio, s.envFactor, slant) + fadeDb(s, aId, bId);
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
  if (s.c2.rescuer && fresh(s.c2.rescuer) && known[s.c2.rescuer].reject === 'rescue') {
    s.c2.unfit[s.c2.rescuer] = s.time + 60;
    logEvent(s, 'C2: ' + s.c2.rescuer + ' declined rescue tasking — benched', 'warn');
    s.c2.rescuer = null;
  }

  // Roster hygiene: relays C2 can no longer account for are struck off
  const before = s.c2.relays.length;
  s.c2.relays = s.c2.relays.filter(id =>
    fresh(id) && !['rtb', 'rtl', 'landed', 'dead'].includes(known[id].role));
  if (s.c2.relays.length < before) {
    logEvent(s, 'C2: relay roster degraded (' + s.c2.relays.length + '/' + before + ') — re-planning', 'error');
  }

  // Hysteresis on chain length, planned against operator intent.
  // Hop span is capped by the radio horizon at operating altitude — a 40 km
  // radio is still a ~30 km radio when the Earth gets in the way.
  const usable = Math.min(
    usableRangeM(s.radio, s.envFactor),
    radioHorizonM(C2_ANTENNA_M, s.altitudeM));
  const D = dist2d(s.base, s.target);
  const k = s.c2.relays.length;
  const kNeeded = relaysRequired(D, usable * s.deployFrac);

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
      !(s.c2.unfit[id] > s.time));
    if (candidates.length) {
      const slotF = (k + 1) / (k + 2);
      const slot = { x: s.base.x + (s.target.x - s.base.x) * slotF, y: s.base.y + (s.target.y - s.base.y) * slotF };
      let best = null, bestScore = -Infinity;
      for (const id of candidates) {
        const score = 0.6 * (known[id].battery / 100)
                    + 0.4 * (1 - Math.min(1, dist2d(known[id], slot) / (usable * 2)));
        if (score > bestScore) { bestScore = score; best = id; }
      }
      s.c2.relays.push(best);
      logEvent(s, 'C2 orders ' + best + ' to relay slot ' + s.c2.relays.length, 'relay');
    }
  } else if (kNeeded < k && relaysRequired(D, usable * Math.min(1.2, s.deployFrac * RELAY.recallHysteresis)) < k && k > 0) {
    // Release only when the deploy criterion won't immediately re-demand it
    const freed = s.c2.relays.pop();
    logEvent(s, 'C2 releases ' + freed + ' from relay duty', 'relay');
  }

  // --- Rescue dispatch (fallback engine, C2 side) ------------------------
  const lostIds = Object.keys(s.c2.lost);
  if (s.c2.rescuer) {
    const kR = known[s.c2.rescuer];
    const still = fresh(s.c2.rescuer) && kR && !['rtb', 'landed', 'dead'].includes(kR.role);
    if (!still) {
      logEvent(s, 'C2: rescue drone ' + s.c2.rescuer + ' unavailable — reassigning', 'warn');
      s.c2.rescuer = null;
    } else if (!lostIds.length) {
      logEvent(s, 'C2: contact restored — ' + s.c2.rescuer + ' released from rescue', 'relay');
      s.c2.rescuer = null;
    }
  }
  if (!s.c2.rescuer && lostIds.length &&
      lostIds.some(id => s.time - s.c2.lost[id].at > RESCUE.delaySec)) {
    const candidates = Object.keys(known).filter(id =>
      fresh(id) && known[id].role === 'mission' &&
      known[id].battery >= RELAY.minBatteryPct && !s.c2.relays.includes(id) &&
      !(s.c2.unfit[id] > s.time));
    if (candidates.length) {
      const c = lostCentroid(s);
      let best = null, bestD = Infinity;
      for (const id of candidates) {
        const dd = dist2d(known[id], c);
        if (dd < bestD) { bestD = dd; best = id; }
      }
      s.c2.rescuer = best;
      logEvent(s, 'C2 dispatches ' + best + ' toward last-known contact point', 'relay');
    }
  }
  let rescueGoto = null;
  if (s.c2.rescuer) {
    // Tentacle rule: extend from the nearest fresh node toward the lost
    // group's last-known centroid, one link-length at a time, so the rescuer
    // stays connected while it hunts. As its own telemetry comes back from
    // farther out, the reach point advances.
    const c = lostCentroid(s);
    let anchor = s.base, anchorId = 'C2', aD = dist2d(s.base, c);
    for (const id of Object.keys(known)) {
      if (!fresh(id) || id === s.c2.rescuer) continue; // can't anchor on itself
      const dd = dist2d(known[id], c);
      if (dd < aD) { aD = dd; anchor = known[id]; anchorId = id; }
    }
    const reach = Math.min(usable * s.deployFrac, aD);
    rescueGoto = aD < 1 ? { x: c.x, y: c.y } : {
      x: anchor.x + (c.x - anchor.x) / aD * reach,
      y: anchor.y + (c.y - anchor.y) / aD * reach,
    };
    rescueGoto.anchorId = anchorId;
  }

  // Build every drone's order. Every order names the drone's UPSTREAM chain
  // neighbor, so it can tether to it: relays hang off the previous slot
  // (slot 0 off C2), the flock hangs off the last relay, the rescuer off
  // its anchor.
  const lastRelay = s.c2.relays.length ? s.c2.relays[s.c2.relays.length - 1] : 'C2';
  const orderFor = id => {
    if (id === s.c2.rescuer && rescueGoto) {
      return {
        role: 'rescue', slot: -1, goto: rescueGoto,
        upstream: rescueGoto.anchorId,
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

// Nominal slot on the spine, shifted out of measured-bad coverage cells.
// Cached per (slot, k, target) so the assignment doesn't wander every cycle
// as measurement counts tick up — it only re-adjusts when its cell turns bad.
function adjustedSlotPos(s, slot, k) {
  const nominal = slotFromOrder(s, { slot, k, target: s.target, role: 'relay' });
  const key = slot + '/' + k + '/' + Math.round(s.target.x / 50) + ',' + Math.round(s.target.y / 50);
  const cached = s.c2.slotCache[key];
  if (cached && !badPlan(s, cached)) return cached;
  const adj = covAdjust(s, nominal);
  s.c2.slotCache[key] = adj;
  if (dist2d(adj, nominal) > s.covCellM * 0.9) {
    logEvent(s, 'C2: relay slot ' + (slot + 1) + ' moved off measured dead zone (' + Math.round(dist2d(adj, nominal)) + ' m sidestep)', 'relay');
  }
  return adj;
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
    const o = p.kind === 'bcast' ? p.payload.orders[d.id] : p.payload;
    if (!o) continue;
    const sig = o.role + '/' + o.slot + '/' + Math.round(o.target.x) + ',' + Math.round(o.target.y);
    const changed = sig !== (d.order.role + '/' + d.order.slot + '/' + Math.round(d.order.target.x) + ',' + Math.round(d.order.target.y));
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
  const maxV = s.airframe.maxSpeedMs;
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

  const hops = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const dM = dist2d(nodes[i], nodes[i + 1]);
    const margin = Math.max(-99, liveMarginDb(s, nodes[i].id, nodes[i + 1].id));
    const state = margin >= FADE_MARGIN_DB ? 'ok' : margin >= 0 ? 'degraded' : 'lost';
    hops.push({
      a: nodes[i], b: nodes[i + 1], distM: dM, marginDb: margin,
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
  return chainStatus(s);
}

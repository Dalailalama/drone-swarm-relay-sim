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
};

const GPS_SIGMA_M = 1.5; // typical GNSS horizontal error — C2 sees noisy positions

// Regulatory duty cycle stretches how often a node may transmit at all.
function tlmIntervalSec(s) {
  const tx = (NET.tlmBytes * 8) / (s.radio.airRateKbps * 1000);
  return Math.max(C2.tlmIntervalSec, s.radio.dutyCycle ? tx / s.radio.dutyCycle : 0);
}

function cmdIntervalSec(s, nDrones) {
  const tx = (NET.cmdBytes * 8) / (s.radio.airRateKbps * 1000);
  return Math.max(C2.cmdIntervalSec, s.radio.dutyCycle ? tx * nDrones / s.radio.dutyCycle : 0);
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
    order: { role: 'mission', slot: -1, k: 0, target: { x: target.x, y: target.y } }, // preflight upload
    mode: 'ok',            // ok | hold | relink | rtl | rtb | landed | dead
    lastC2: 0,
    holdX: 0, holdY: 0,
    lastLinkX: x, lastLinkY: y, // where the link last provably worked
    relinkUntil: null,
    relinkAttempt: 0,
    relinkGoalX: 0, relinkGoalY: 0,
    rejectedRole: null, rejectedSig: null,
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
    wind: { x: opts.windX || 0, y: opts.windY || 0 },
    events: [],
    radio: opts.radio,
    envFactor: opts.envFactor,
    shadowSigmaDb: opts.shadowSigmaDb || 0,
    net: makeNet(opts.seed || 42),
    c2: { known: {}, relays: [], inbox: [], nextCmd: 0, wasFresh: {}, lost: {}, rescuer: null, unfit: {} },
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

const C2_ANTENNA_M = 2; // ground station mast height

function nodeAltM(s, id) {
  return id === 'C2' ? C2_ANTENNA_M : s.altitudeM;
}

// Live link margin between two nodes: 3D slant-range path loss plus the
// link's current shadowing offset, hard-blocked beyond the radio horizon.
// This is what routing, packet delivery, and the hop display all consume —
// one consistent radio truth.
function liveMarginDb(s, aId, bId) {
  const a = nodePos(s, aId), b = nodePos(s, bId);
  if (!a || !b) return -Infinity;
  const ground = dist2d(a, b);
  if (ground > radioHorizonM(nodeAltM(s, aId), nodeAltM(s, bId))) return -Infinity;
  const slant = Math.hypot(ground, nodeAltM(s, aId) - nodeAltM(s, bId));
  return linkMarginDb(s.radio, s.envFactor, slant) + fadeDb(s, aId, bId);
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
function slotFromOrder(s, order) {
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
  // Ingest telemetry that physically arrived
  for (const p of s.c2.inbox) {
    s.c2.known[p.src] = { ...p.payload, at: s.time };
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
    let anchor = s.base, aD = dist2d(s.base, c);
    for (const id of Object.keys(known)) {
      if (!fresh(id) || id === s.c2.rescuer) continue; // can't anchor on itself
      const dd = dist2d(known[id], c);
      if (dd < aD) { aD = dd; anchor = known[id]; }
    }
    const reach = Math.min(usable * s.deployFrac, aD);
    rescueGoto = aD < 1 ? { x: c.x, y: c.y } : {
      x: anchor.x + (c.x - anchor.x) / aD * reach,
      y: anchor.y + (c.y - anchor.y) / aD * reach,
    };
  }

  // Dispatch orders — best effort; packets die if no route exists
  for (const id of Object.keys(known)) {
    if (id === s.c2.rescuer && rescueGoto) {
      sendPacket(s, 'cmd', 'C2', id, {
        role: 'rescue', slot: -1, goto: rescueGoto,
        k: s.c2.relays.length,
        target: { x: s.target.x, y: s.target.y },
      });
      continue;
    }
    const slot = s.c2.relays.indexOf(id);
    sendPacket(s, 'cmd', 'C2', id, {
      role: slot >= 0 ? 'relay' : 'mission',
      slot,
      k: s.c2.relays.length,
      target: { x: s.target.x, y: s.target.y },
    });
  }
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
    if (p.kind !== 'cmd') continue;
    // Any received command proves the link works here, order accepted or not
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
    const o = p.payload;
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

  // Telemetry beacon — position as the GPS sees it, not as God sees it
  if (s.time >= d.nextTlm) {
    d.nextTlm = s.time + tlmIntervalSec(s);
    sendPacket(s, 'tlm', d.id, 'C2', {
      x: d.x + GPS_SIGMA_M * gaussian(s.net.rng),
      y: d.y + GPS_SIGMA_M * gaussian(s.net.rng),
      battery: d.batteryPct, role: effRole(d),
      reject: d.rejectedRole || null,
    });
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

function stepDrone(s, d, dt) {
  if (!alive(d)) return;

  droneComms(s, d);

  const goal = goalFor(s, d);
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
      logEvent(s, d.id + ' landed at base', 'info');
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
  for (const d of s.drones) stepDrone(s, d, dt);
  stepNet(s, dt);
  return chainStatus(s);
}

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
  maxSpeedMs: 14,
  accelMs2: 4,
  separationM: 25,
  orbitRadiusM: 60,
  landThresholdM: 25,
};

const RELAY = {
  deployFrac: 0.80,
  recallFrac: 0.95,
  minBatteryPct: 30,
};

const FAILSAFE = {
  holdSec: 8,          // silence before a drone freezes in place
  rtlMissionSec: 30,   // silence before a mission drone flies home to regain link
  rtlRelaySec: 90,     // relays hold much longer — they ARE the link
};

const C2 = {
  cmdIntervalSec: 1.0,   // order broadcast rate
  tlmIntervalSec: 2.0,   // drone telemetry rate
  staleSec: 6,           // missed ~3 telemetry → C2 treats drone as out of contact
  forgetSec: 25,         // C2 drops it from planning entirely
};

const BATTERY = {
  rtbReservePct: 12,
  movingDrainMult: 1.15,
};

let droneSeq = 0;

function makeDrone(x, y, target) {
  droneSeq += 1;
  return {
    id: 'DR-' + droneSeq,
    x, y, vx: 0, vy: 0,
    batteryPct: 100,
    // Onboard state — the drone's own little world
    order: { role: 'mission', slot: -1, k: 0, target: { x: target.x, y: target.y } }, // preflight upload
    mode: 'ok',            // ok | hold | rtl | rtb | landed | dead
    lastC2: 0,
    holdX: 0, holdY: 0,
    inbox: [],
    nextTlm: Math.random() * C2.tlmIntervalSec,
    orbitPhase: Math.random() * Math.PI * 2,
  };
}

function makeSwarm(opts) {
  droneSeq = 0;
  const s = {
    base: { x: 0, y: 0 },
    target: { x: opts.targetX, y: opts.targetY },  // C2 operator intent
    drones: [],
    time: 0,
    enduranceMin: opts.enduranceMin,
    events: [],
    radio: opts.radio,
    envFactor: opts.envFactor,
    net: makeNet(opts.seed || 42),
    c2: { known: {}, relays: [], inbox: [], nextCmd: 0, wasFresh: {} },
  };
  for (let i = 0; i < opts.count; i++) {
    const a = (i / opts.count) * Math.PI * 2;
    s.drones.push(makeDrone(s.base.x + 60 * Math.cos(a), s.base.y + 60 * Math.sin(a), s.target));
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

// Live link margin between two nodes — pure physics for now; the stochastic
// layer (shadowing/fading) hooks in here.
function liveMarginDb(s, aId, bId) {
  const a = nodePos(s, aId), b = nodePos(s, bId);
  if (!a || !b) return -Infinity;
  return linkMarginDb(s.radio, s.envFactor, dist2d(a, b));
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
  s.c2.nextCmd = s.time + C2.cmdIntervalSec;

  const known = s.c2.known;
  const fresh = id => known[id] && (s.time - known[id].at) <= C2.staleSec;

  // Operator display: log contact changes
  for (const id of Object.keys(known)) {
    const f = fresh(id);
    if (s.c2.wasFresh[id] && !f) logEvent(s, 'C2 lost telemetry from ' + id, 'warn');
    if (!s.c2.wasFresh[id] && f) logEvent(s, 'C2 regained telemetry from ' + id, 'info');
    s.c2.wasFresh[id] = f;
    if (s.time - known[id].at > C2.forgetSec) { delete known[id]; delete s.c2.wasFresh[id]; }
  }

  // Roster hygiene: relays C2 can no longer account for are struck off
  const before = s.c2.relays.length;
  s.c2.relays = s.c2.relays.filter(id =>
    fresh(id) && !['rtb', 'rtl', 'landed', 'dead'].includes(known[id].role));
  if (s.c2.relays.length < before) {
    logEvent(s, 'C2: relay roster degraded (' + s.c2.relays.length + '/' + before + ') — re-planning', 'error');
  }

  // Hysteresis on chain length, planned against operator intent
  const usable = usableRangeM(s.radio, s.envFactor);
  const D = dist2d(s.base, s.target);
  const k = s.c2.relays.length;
  const kNeeded = relaysRequired(D, usable * RELAY.deployFrac);
  if (kNeeded > k) {
    // Elect from fresh mission drones with battery to spare
    const candidates = Object.keys(known).filter(id =>
      fresh(id) && known[id].role === 'mission' &&
      known[id].battery >= RELAY.minBatteryPct && !s.c2.relays.includes(id));
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
  } else if (kNeeded < k && relaysRequired(D, usable * RELAY.recallFrac) < k && k > 0) {
    // Release only when the deploy criterion won't immediately re-demand it
    const freed = s.c2.relays.pop();
    logEvent(s, 'C2 releases ' + freed + ' from relay duty', 'relay');
  }

  // Dispatch orders — best effort; packets die if no route exists
  for (const id of Object.keys(known)) {
    const slot = s.c2.relays.indexOf(id);
    sendPacket(s, 'cmd', 'C2', id, {
      role: slot >= 0 ? 'relay' : 'mission',
      slot,
      k: s.c2.relays.length,
      target: { x: s.target.x, y: s.target.y },
    });
  }
}

// --- Drone onboard logic -------------------------------------------------------
function droneComms(s, d) {
  for (const p of d.inbox) {
    if (p.kind !== 'cmd') continue;
    const prevRole = d.order.role;
    d.order = p.payload;
    d.lastC2 = s.time;
    if (d.mode === 'hold' || d.mode === 'rtl') {
      d.mode = 'ok';
      logEvent(s, d.id + ' link restored — resuming orders', 'info');
    }
    if (d.mode === 'ok' && prevRole !== d.order.role) {
      logEvent(s, d.id + ' now ' + d.order.role + (d.order.role === 'relay' ? ' (slot ' + (d.order.slot + 1) + ')' : ''), 'relay');
    }
  }
  d.inbox = [];

  if (!alive(d) || d.mode === 'rtb') return;

  // Telemetry beacon
  if (s.time >= d.nextTlm) {
    d.nextTlm = s.time + C2.tlmIntervalSec;
    sendPacket(s, 'tlm', d.id, 'C2', { x: d.x, y: d.y, battery: d.batteryPct, role: effRole(d) });
  }

  // Link-loss failsafe ladder
  const age = s.time - d.lastC2;
  if (d.mode === 'ok' && age > FAILSAFE.holdSec) {
    d.mode = 'hold'; d.holdX = d.x; d.holdY = d.y;
    logEvent(s, d.id + ' lost C2 link — holding position', 'warn');
  }
  const rtlAfter = d.order.role === 'relay' ? FAILSAFE.rtlRelaySec : FAILSAFE.rtlMissionSec;
  if (d.mode === 'hold' && age > rtlAfter) {
    d.mode = 'rtl';
    logEvent(s, d.id + ' link timeout — flying home to regain contact', 'warn');
  }
}

function updateBattery(s, d, dt, moving) {
  const drainPerSec = 100 / (s.enduranceMin * 60) * (moving ? BATTERY.movingDrainMult : 1);
  d.batteryPct = Math.max(0, d.batteryPct - drainPerSec * dt);

  if (d.mode === 'ok' || d.mode === 'hold') {
    const secsHome = dist2d(d, s.base) / DRONE.maxSpeedMs;
    const pctHome = (secsHome / (s.enduranceMin * 60)) * 100 * BATTERY.movingDrainMult;
    if (d.batteryPct <= pctHome + BATTERY.rtbReservePct) {
      d.mode = 'rtb';
      logEvent(s, d.id + ' battery low — RTB', 'warn');
      sendPacket(s, 'tlm', d.id, 'C2', { x: d.x, y: d.y, battery: d.batteryPct, role: 'rtb' });
    }
  }

  if (d.batteryPct <= 0 && alive(d)) {
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
  if (d.order.role === 'relay') return slotFromOrder(s, d.order);
  // Mission: loiter ring around the ORDERED target (which may be stale — that's the point)
  d.orbitPhase += 0.0004 * DRONE.maxSpeedMs;
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
  const dx = goal.x - d.x, dy = goal.y - d.y;
  const dGoal = Math.hypot(dx, dy);

  const brake = (DRONE.maxSpeedMs * DRONE.maxSpeedMs) / (2 * DRONE.accelMs2);
  const desiredSpeed = dGoal > brake ? DRONE.maxSpeedMs : DRONE.maxSpeedMs * (dGoal / brake);
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
  const v = Math.hypot(d.vx, d.vy);
  if (v > DRONE.maxSpeedMs) { d.vx = d.vx / v * DRONE.maxSpeedMs; d.vy = d.vy / v * DRONE.maxSpeedMs; }
  d.x += d.vx * dt; d.y += d.vy * dt;

  updateBattery(s, d, dt, v > 2);

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
    const margin = liveMarginDb(s, nodes[i].id, nodes[i + 1].id);
    const state = margin >= FADE_MARGIN_DB ? 'ok' : margin >= 0 ? 'degraded' : 'lost';
    hops.push({ a: nodes[i], b: nodes[i + 1], distM: dM, marginDb: margin, rssiDbm: rssiAt(s.radio, s.envFactor, dM), state });
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
  stepNet(s);
  return chainStatus(s);
}

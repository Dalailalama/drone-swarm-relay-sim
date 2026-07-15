// Swarm logic: drone motion, battery, relay-chain planning with hysteresis,
// relay election, failure healing, and return-to-base.
// All positions are metres in world space; time is sim-seconds.

const DRONE = {
  maxSpeedMs: 14,        // typical quadcopter cruise
  accelMs2: 4,
  separationM: 25,       // min comfortable spacing
  orbitRadiusM: 60,      // mission loiter ring around target
  landThresholdM: 25,
};

const RELAY = {
  deployFrac: 0.80,      // plan hops at 80% of usable range
  recallFrac: 0.95,      // only recall a relay when 95%-spaced hops still fit
  minBatteryPct: 30,     // don't elect a relay below this battery
};

const BATTERY = {
  rtbReservePct: 12,     // land with this much left, beyond the flight home
  movingDrainMult: 1.15, // forward flight costs a bit more than hover
};

let droneSeq = 0;

function makeDrone(x, y) {
  droneSeq += 1;
  return {
    id: 'DR-' + droneSeq,
    x, y, vx: 0, vy: 0,
    role: 'mission',      // mission | relay | rtb | landed | dead
    batteryPct: 100,
    slotIndex: -1,        // relay slot along the chain, -1 if not a relay
    orbitPhase: Math.random() * Math.PI * 2,
  };
}

function makeSwarm(opts) {
  const s = {
    base: { x: 0, y: 0 },
    target: { x: opts.targetX, y: opts.targetY },
    drones: [],
    relays: [],           // drones in chain order, base-side first
    time: 0,
    enduranceMin: opts.enduranceMin,
    events: [],
    radio: opts.radio,
    envFactor: opts.envFactor,
  };
  for (let i = 0; i < opts.count; i++) {
    const a = (i / opts.count) * Math.PI * 2;
    s.drones.push(makeDrone(s.base.x + 60 * Math.cos(a), s.base.y + 60 * Math.sin(a)));
  }
  return s;
}

function logEvent(s, msg, kind) {
  s.events.push({ t: s.time, msg, kind: kind || 'info' });
  if (s.events.length > 60) s.events.shift();
}

function dist2d(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function alive(d) { return d.role !== 'dead' && d.role !== 'landed'; }
function onDuty(d) { return d.role === 'mission' || d.role === 'relay'; }

// Slot i (0-based) of k relays sits at fraction (i+1)/(k+1) along base→target.
function slotPos(s, i, k) {
  const f = (i + 1) / (k + 1);
  return { x: s.base.x + (s.target.x - s.base.x) * f, y: s.base.y + (s.target.y - s.base.y) * f };
}

function relaysRequired(D, span) {
  return Math.max(0, Math.ceil(D / span) - 1);
}

// --- Relay planning with hysteresis ----------------------------------------
function planRelays(s) {
  const usable = usableRangeM(s.radio, s.envFactor);
  const D = dist2d(s.base, s.target);
  const k = s.relays.length;
  const missionPool = s.drones.filter(d => d.role === 'mission' && d.batteryPct >= RELAY.minBatteryPct);

  const kNeeded = relaysRequired(D, usable * RELAY.deployFrac);
  const kRelaxed = relaysRequired(D, usable * RELAY.recallFrac);

  if (kNeeded > k && missionPool.length > 1) {
    // Grow: elect the mission drone best placed for the new outermost slot.
    const slot = slotPos(s, k, k + 1);
    let best = null, bestScore = -Infinity;
    for (const d of missionPool) {
      const score = 0.6 * (d.batteryPct / 100) + 0.4 * (1 - Math.min(1, dist2d(d, slot) / (usable * 2)));
      if (score > bestScore) { bestScore = score; best = d; }
    }
    if (best) {
      best.role = 'relay';
      s.relays.push(best);
      logEvent(s, best.id + ' promoted to relay (hop ' + s.relays.length + ')', 'relay');
    }
  } else if (kRelaxed < k && k > 0) {
    // Shrink: even with generous 95% spacing we have a spare — release the
    // mission-side relay back to the flock.
    const freed = s.relays.pop();
    freed.role = 'mission';
    freed.slotIndex = -1;
    logEvent(s, freed.id + ' released from relay duty', 'relay');
  }

  s.relays.forEach((d, i) => { d.slotIndex = i; });
}

// --- Battery & RTB ----------------------------------------------------------
function updateBattery(s, d, dt, moving) {
  const drainPerSec = 100 / (s.enduranceMin * 60) * (moving ? BATTERY.movingDrainMult : 1);
  d.batteryPct = Math.max(0, d.batteryPct - drainPerSec * dt);

  if (onDuty(d)) {
    const secsHome = dist2d(d, s.base) / DRONE.maxSpeedMs;
    const pctHome = (secsHome / (s.enduranceMin * 60)) * 100 * BATTERY.movingDrainMult;
    if (d.batteryPct <= pctHome + BATTERY.rtbReservePct) {
      if (d.role === 'relay') {
        const idx = s.relays.indexOf(d);
        if (idx >= 0) s.relays.splice(idx, 1);
        logEvent(s, d.id + ' battery low — leaving relay chain, RTB', 'warn');
      } else {
        logEvent(s, d.id + ' battery low — RTB', 'warn');
      }
      d.role = 'rtb';
      d.slotIndex = -1;
    }
  }

  if (d.batteryPct <= 0 && alive(d)) {
    if (d.role === 'relay') {
      const idx = s.relays.indexOf(d);
      if (idx >= 0) s.relays.splice(idx, 1);
    }
    d.role = 'dead';
    d.vx = d.vy = 0;
    logEvent(s, d.id + ' battery exhausted — down', 'error');
  }
}

function killDrone(s, d) {
  if (!alive(d)) return;
  if (d.role === 'relay') {
    const idx = s.relays.indexOf(d);
    if (idx >= 0) s.relays.splice(idx, 1);
    logEvent(s, d.id + ' lost — relay chain broken, healing', 'error');
  } else {
    logEvent(s, d.id + ' lost', 'error');
  }
  d.role = 'dead';
  d.vx = d.vy = 0;
}

// --- Motion ------------------------------------------------------------------
function goalFor(s, d) {
  if (d.role === 'relay') {
    return slotPos(s, d.slotIndex, s.relays.length);
  }
  if (d.role === 'rtb') {
    return { x: s.base.x, y: s.base.y };
  }
  // Mission: loiter ring around target, spread by phase, slow rotation.
  d.orbitPhase += 0.0004 * DRONE.maxSpeedMs;
  const mission = s.drones.filter(x => x.role === 'mission');
  const idx = Math.max(0, mission.indexOf(d));
  const a = d.orbitPhase + (idx / Math.max(1, mission.length)) * Math.PI * 2;
  return { x: s.target.x + DRONE.orbitRadiusM * Math.cos(a), y: s.target.y + DRONE.orbitRadiusM * Math.sin(a) };
}

function stepDrone(s, d, dt) {
  if (!alive(d)) return;

  const goal = goalFor(s, d);
  const dx = goal.x - d.x, dy = goal.y - d.y;
  const dGoal = Math.hypot(dx, dy);

  // Arrival: slow down inside the braking radius.
  const brake = (DRONE.maxSpeedMs * DRONE.maxSpeedMs) / (2 * DRONE.accelMs2);
  const desiredSpeed = dGoal > brake ? DRONE.maxSpeedMs : DRONE.maxSpeedMs * (dGoal / brake);
  let ax = 0, ay = 0;
  if (dGoal > 0.5) {
    ax = (dx / dGoal) * desiredSpeed - d.vx;
    ay = (dy / dGoal) * desiredSpeed - d.vy;
  } else {
    ax = -d.vx; ay = -d.vy;
  }

  // Separation from neighbours.
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

  if (d.role === 'rtb' && dist2d(d, s.base) < DRONE.landThresholdM) {
    d.role = 'landed';
    d.vx = d.vy = 0;
    logEvent(s, d.id + ' landed at base', 'info');
  }
}

// --- Connectivity ------------------------------------------------------------
// Chain nodes: base → relays in order → mission centroid. Each hop gets a
// live link margin from the actual drone positions, not the planned slots.
function chainStatus(s) {
  const missionDrones = s.drones.filter(d => d.role === 'mission');
  const nodes = [{ kind: 'base', x: s.base.x, y: s.base.y, label: 'C2' }];
  for (const r of s.relays) nodes.push({ kind: 'relay', x: r.x, y: r.y, label: r.id, drone: r });

  let endpoint = null;
  if (missionDrones.length) {
    let cx = 0, cy = 0;
    for (const d of missionDrones) { cx += d.x; cy += d.y; }
    endpoint = { kind: 'mission', x: cx / missionDrones.length, y: cy / missionDrones.length, label: 'flock' };
    nodes.push(endpoint);
  }

  const hops = [];
  let connected = missionDrones.length > 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    const dM = dist2d(nodes[i], nodes[i + 1]);
    const margin = linkMarginDb(s.radio, s.envFactor, dM);
    const state = margin >= FADE_MARGIN_DB ? 'ok' : margin >= 0 ? 'degraded' : 'lost';
    if (state === 'lost') connected = false;
    hops.push({ a: nodes[i], b: nodes[i + 1], distM: dM, marginDb: margin, rssiDbm: rssiAt(s.radio, s.envFactor, dM), state });
  }

  return { nodes, hops, connected, missionCount: missionDrones.length };
}

// --- Tick --------------------------------------------------------------------
function stepSwarm(s, dt) {
  s.time += dt;
  planRelays(s);
  for (const d of s.drones) stepDrone(s, d, dt);
  return chainStatus(s);
}

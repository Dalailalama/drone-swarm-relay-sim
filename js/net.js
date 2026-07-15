// Packet-level network simulation. No node in the swarm ever acts on
// information that didn't physically arrive as a packet over a live link.
// Packets travel hop-by-hop: each hop costs real airtime (bytes / air rate)
// plus a forwarding delay, and is only possible while that link has margin.

const NET = {
  procDelaySec: 0.02,   // per-hop forward/processing delay (store-and-forward)
  cmdBytes: 48,         // unicast role order: target, role, slot, chain length
  tlmBytes: 32,         // position, battery, status
  bcastHeaderBytes: 16, // broadcast order table: header...
  bcastRowBytes: 12,    // ...plus one packed row per drone
};

// Deterministic seeded RNG (mulberry32) — same seed, same mission playback.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  let u = 0, v = 0;
  while (!u) u = rng();
  while (!v) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makeNet(seed) {
  return {
    packets: [], bcasts: [], fades: new Map(), rng: mulberry32(seed),
    dropped: 0, delivered: 0,
    // shared-channel accounting: every transmission (and retry) occupies air
    airtimeAccum: 0, utilSince: 0, utilization: 0,
  };
}

// --- Broadcast flooding -------------------------------------------------------
// One packet carries the whole swarm's order table. Every node that hears a
// broadcast with a new sequence number takes its own row and re-transmits
// the packet ONCE — classic mesh flooding. No routes, no ACKs, no retries:
// each receiver rolls the packet-error dice exactly once per transmission it
// can hear, which is honestly how broadcast works.
function sendBroadcast(s, srcId, payload, bytes) {
  s.net.bcasts.push({ srcId, payload, bytes, tFire: s.time + hopTimeSec(s.radio, bytes) });
}

function stepBcasts(s) {
  const list = s.net.bcasts;
  if (!list.length) return;
  const next = [];
  // index loop on purpose: firing a broadcast appends rebroadcasts to `list`,
  // and those must be visited (they're future-scheduled, so they land in
  // `next` and fire on a later tick)
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (s.time < b.tFire) { next.push(b); continue; }
    s.net.airtimeAccum += (b.bytes * 8) / (s.radio.airRateKbps * 1000);
    for (const id of nodeIds(s)) {
      if (id === b.srcId || id === 'C2') continue;
      const d = nodePos(s, id);
      if (!d || !alive(d)) continue;
      if (d.bcastSeen >= b.payload.seq) continue;
      const m = liveMarginDb(s, b.srcId, id);
      if (m <= 0) continue;
      if (s.net.rng() >= pktSuccessProb(m)) continue; // one roll, no retry
      d.bcastSeen = b.payload.seq;
      d.inbox.push({ kind: 'bcast', src: 'C2', payload: b.payload });
      s.net.delivered++;
      // this node re-transmits the table once, after its own airtime
      list.push({ srcId: id, payload: b.payload, bytes: b.bytes, tFire: s.time + hopTimeSec(s.radio, b.bytes) });
    }
  }
  s.net.bcasts = next;
}

// --- Shadowing --------------------------------------------------------------
// Each link carries a slowly-wandering dB offset (Ornstein-Uhlenbeck process):
// terrain and obstruction effects that persist for seconds as drones move,
// on top of deterministic path loss. Stationary std dev = environment sigma.
const FADE = { tauSec: 10, pruneSec: 30 };

function fadeDb(s, aId, bId) {
  const key = aId < bId ? aId + '|' + bId : bId + '|' + aId;
  let f = s.net.fades.get(key);
  if (!f) { f = { db: 0, lastUsed: s.time }; s.net.fades.set(key, f); }
  f.lastUsed = s.time;
  return f.db;
}

function stepFades(s, dt) {
  const sigma = s.shadowSigmaDb || 0;
  for (const [key, f] of s.net.fades) {
    if (s.time - f.lastUsed > FADE.pruneSec) { s.net.fades.delete(key); continue; }
    f.db += (-f.db * dt / FADE.tauSec) + sigma * Math.sqrt(2 * dt / FADE.tauSec) * gaussian(s.net.rng);
  }
}

function hopTimeSec(radio, bytes) {
  return (bytes * 8) / (radio.airRateKbps * 1000) + NET.procDelaySec;
}

// --- Topology ---------------------------------------------------------------
// Node ids: 'C2' plus drone ids. Positions come from the swarm's ground truth
// (radio waves don't care what anyone believes).

function nodeIds(s) {
  const ids = ['C2'];
  for (const d of s.drones) if (alive(d)) ids.push(d.id);
  return ids;
}

function nodePos(s, id) {
  if (id === 'C2') return s.base;
  return s.drones.find(d => d.id === id) || null;
}

const LINK_MIN_MARGIN_DB = 0; // an in-flight packet uses whatever exists

function linkUsable(s, aId, bId, minMarginDb) {
  const a = nodePos(s, aId), b = nodePos(s, bId);
  if (!a || !b) return false;
  if (a !== s.base && !alive(a)) return false;
  if (b !== s.base && !alive(b)) return false;
  return liveMarginDb(s, aId, bId) > (minMarginDb ?? LINK_MIN_MARGIN_DB);
}

// ETX-style link cost: expected transmissions, evaluated PESSIMISTICALLY
// (margin minus the fade reserve). Min-hop routing famously prefers one long
// barely-alive link over two solid short ones — the mesh-networking "gray
// link" problem that pushed real protocols (OLSR, Babel, 802.11s) to
// link-quality metrics. Costing at margin-minus-reserve means an engineered
// relay hop with headroom beats a marginal shortcut, while desperate links
// stay usable when nothing better exists.
function linkCost(s, aId, bId) {
  if (!linkUsable(s, aId, bId)) return Infinity;
  const m = liveMarginDb(s, aId, bId);
  return 1 / Math.max(0.05, pktSuccessProb(m - FADE_MARGIN_DB));
}

// Total ETX cost of a path; Infinity if any link along it is unusable.
function pathCost(s, path) {
  if (!path || path.length < 2) return Infinity;
  let sum = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const c = linkCost(s, path[i], path[i + 1]);
    if (c === Infinity) return Infinity;
    sum += c;
  }
  return sum;
}

// Dijkstra over ETX costs (the node count is tiny — a dozen drones).
function routePath(s, from, to) {
  if (from === to) return [from];
  const ids = nodeIds(s);
  if (!ids.includes(from) || !ids.includes(to)) return null;
  const dist = new Map(ids.map(id => [id, Infinity]));
  const prev = new Map();
  const done = new Set();
  dist.set(from, 0);
  for (;;) {
    let cur = null, best = Infinity;
    for (const id of ids) {
      if (!done.has(id) && dist.get(id) < best) { best = dist.get(id); cur = id; }
    }
    if (cur === null) return null;   // target unreachable
    if (cur === to) break;
    done.add(cur);
    for (const nxt of ids) {
      if (done.has(nxt)) continue;
      const c = linkCost(s, cur, nxt);
      if (c === Infinity) continue;
      if (best + c < dist.get(nxt)) { dist.set(nxt, best + c); prev.set(nxt, cur); }
    }
  }
  const path = [to];
  let p = to;
  while (p !== from) { p = prev.get(p); if (p === undefined) return null; path.unshift(p); }
  return path;
}

// --- Packets ------------------------------------------------------------------
function sendPacket(s, kind, src, dst, payload) {
  const path = routePath(s, src, dst);
  if (!path || path.length < 2) { s.net.dropped++; return false; } // no route — radio silence
  const bytes = kind === 'cmd' ? NET.cmdBytes : NET.tlmBytes;
  const dt = hopTimeSec(s.radio, bytes);
  s.net.packets.push({
    kind, src, dst, payload, path,
    hop: 0,
    tHopStart: s.time,
    tArrive: s.time + dt,
  });
  return true;
}

function deliverPacket(s, p) {
  s.net.delivered++;
  if (p.dst === 'C2') s.c2.inbox.push(p);
  else {
    const d = nodePos(s, p.dst);
    if (d && alive(d)) d.inbox.push(p);
    else s.net.delivered--, s.net.dropped++;
  }
}

function stepNet(s, dt) {
  stepFades(s, dt);
  stepBcasts(s);
  const bytesOf = p => (p.kind === 'cmd' ? NET.cmdBytes : NET.tlmBytes);
  const keep = [];
  for (const p of s.net.packets) {
    let dead = false;
    while (s.time >= p.tArrive && !dead) {
      const from = p.path[p.hop], to = p.path[p.hop + 1];
      const retries = hopDelivered(s, from, to);
      const txSec = (bytesOf(p) * 8) / (s.radio.airRateKbps * 1000);
      s.net.airtimeAccum += txSec * (1 + (retries < 0 ? HOP_RETRIES : retries));
      if (retries < 0) { s.net.dropped++; dead = true; break; }
      p.hop++;
      if (p.hop >= p.path.length - 1) { deliverPacket(s, p); dead = true; break; }
      p.tHopStart = p.tArrive;
      // retransmissions cost extra airtime before the next hop can start
      p.tArrive += hopTimeSec(s.radio, bytesOf(p)) * (1 + retries);
    }
    if (!dead) keep.push(p);
  }
  s.net.packets = keep;

  // Sliding channel-utilization estimate: what fraction of the last window
  // was the single shared frequency actually busy?
  if (s.time - s.net.utilSince >= 5) {
    s.net.utilization = Math.min(1, s.net.airtimeAccum / (s.time - s.net.utilSince));
    s.net.airtimeAccum = 0;
    s.net.utilSince = s.time;
  }
}

// Hop attempt: the link must still exist when the packet actually crosses it,
// then each transmission rolls against the packet-error curve. Returns number
// of retries used (0 = first try), or -1 if all attempts failed.
const HOP_RETRIES = 2; // SiK, DigiMesh etc. do link-layer retransmits like this

function hopDelivered(s, fromId, toId) {
  if (!linkUsable(s, fromId, toId)) return -1;
  const p = pktSuccessProb(liveMarginDb(s, fromId, toId));
  for (let t = 0; t <= HOP_RETRIES; t++) {
    if (s.net.rng() < p) return t;
  }
  return -1;
}

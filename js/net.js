// Packet-level network simulation. No node in the swarm ever acts on
// information that didn't physically arrive as a packet over a live link.
// Packets travel hop-by-hop: each hop costs real airtime (bytes / air rate)
// plus a forwarding delay, and is only possible while that link has margin.

const NET = {
  procDelaySec: 0.02,   // per-hop forward/processing delay (store-and-forward)
  cmdBytes: 48,         // role order: target, role, slot, chain length
  tlmBytes: 32,         // position, battery, status
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
  return { packets: [], rng: mulberry32(seed), dropped: 0, delivered: 0 };
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

function linkUsable(s, aId, bId) {
  const a = nodePos(s, aId), b = nodePos(s, bId);
  if (!a || !b) return false;
  if (a !== s.base && !alive(a)) return false;
  if (b !== s.base && !alive(b)) return false;
  return liveMarginDb(s, aId, bId) > 0;
}

// BFS shortest-hop route. Real mesh firmwares (DigiMesh, 802.11s) do roughly
// this with routing tables; hop count is the standard metric.
function routePath(s, from, to) {
  if (from === to) return [from];
  const ids = nodeIds(s);
  if (!ids.includes(from) || !ids.includes(to)) return null;
  const prev = { [from]: from };
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const nxt of ids) {
      if (nxt in prev) continue;
      if (!linkUsable(s, cur, nxt)) continue;
      prev[nxt] = cur;
      if (nxt === to) {
        const path = [to];
        let p = to;
        while (p !== from) { p = prev[p]; path.unshift(p); }
        return path;
      }
      queue.push(nxt);
    }
  }
  return null;
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

function stepNet(s) {
  const bytesOf = p => (p.kind === 'cmd' ? NET.cmdBytes : NET.tlmBytes);
  const keep = [];
  for (const p of s.net.packets) {
    let dead = false;
    while (s.time >= p.tArrive && !dead) {
      const from = p.path[p.hop], to = p.path[p.hop + 1];
      if (!hopDelivered(s, from, to, bytesOf(p))) { s.net.dropped++; dead = true; break; }
      p.hop++;
      if (p.hop >= p.path.length - 1) { deliverPacket(s, p); dead = true; break; }
      p.tHopStart = p.tArrive;
      p.tArrive += hopTimeSec(s.radio, bytesOf(p));
    }
    if (!dead) keep.push(p);
  }
  s.net.packets = keep;
}

// Hop attempt: link must still exist when the packet actually crosses it.
// (Stochastic loss and retries are layered on in liveMarginDb / hopDelivered.)
function hopDelivered(s, fromId, toId, bytes) {
  return linkUsable(s, fromId, toId);
}

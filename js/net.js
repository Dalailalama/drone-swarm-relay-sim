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

// Payload/video backhaul: streamed chunks are REAL packets — they pay real
// airtime on the one shared channel, queue behind retries, and starve C2
// traffic exactly as hard as they starve behind it. One streamer at a time
// is C2's policy (see swarm.js), because a store-and-forward relay chain's
// capacity divides across hops and users — physics, not preference.
const VID = {
  chunkSec: 0.5,        // one aggregated frame bundle per chunk interval
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
    // rolling capture log (like a Wireshark trace): last CAP_MAX events
    cap: [], capSeq: 0,
    // packet id counter — always advances, independent of capture being on,
    // so pids are unique in a trace even for packets that predate capture
    pktSeq: 0,
    // payload/video accounting (Feature: Tier-1 #4)
    vid: { framesDelivered: 0, droppedFrames: 0 },
    // last-transmission clock per node id — the RF signature a direction-
    // finding adversary can legally sense (js/adversary.js)
    txAt: {},
    chanBusyUntil: {},
    nodeTxUntil: {},
    nodeDutyUntil: {},
    vidFrameSeq: 0,
  };
}

// Packet capture: append one event to the rolling trace. Kept lightweight so
// it can run every tick; export writes JSONL (one event per line).
const CAP_MAX = 4000;
function capLog(s, ev) {
  if (!s.captureOn) return;
  ev.seq = s.net.capSeq++;
  ev.t = +s.time.toFixed(3);
  s.net.cap.push(ev);
  if (s.net.cap.length > CAP_MAX) s.net.cap.shift();
}

// --- Hardware matching & Channel ID ------------------------------------------
function txRadioOf(s, from, to) {
  if (from === 'C2') {
    const toNode = to ? nodePos(s, to) : null;
    return (toNode && toNode.radio) ? toNode.radio : s.radio;
  }
  const fromNode = from ? nodePos(s, from) : null;
  return (fromNode && fromNode.radio) ? fromNode.radio : s.radio;
}

function channelKeyOf(radio) {
  if (!radio) return 'default';
  if (radio.band) return String(radio.band);
  if (radio.freqMHz < 1500) return 'sub1g';
  if (radio.freqMHz < 3000) return '2.4g';
  return '5g';
}

// --- Broadcast flooding -------------------------------------------------------
// One packet carries the whole swarm's order table. Every node that hears a
// broadcast with a new sequence number takes its own row and re-transmits
// the packet ONCE — classic mesh flooding. No routes, no ACKs, no retries:
// each receiver rolls the packet-error dice exactly once per transmission it
// can hear, which is honestly how broadcast works.
function sendBroadcast(s, srcId, payload, bytes, radioOverride) {
  if (srcId !== 'C2') {
    const d = nodePos(s, srcId);
    if (!d || !alive(d)) return;
  }
  const rad = radioOverride || (srcId === 'C2' ? s.radio : txRadioOf(s, srcId, null));
  const chan = channelKeyOf(rad);
  const airRate = (rad && rad.airRateKbps) || 64;
  const airtime = (bytes * 8) / (airRate * 1000);
  const tStart = Math.max(
    s.time,
    s.net.chanBusyUntil[chan] || 0,
    s.net.nodeTxUntil[srcId] || 0,
    s.net.nodeDutyUntil[srcId] || 0
  );
  s.net.chanBusyUntil[chan] = tStart + airtime;
  s.net.nodeTxUntil[srcId] = tStart + airtime;
  s.net.txAt[srcId] = tStart;
  s.net.airtimeAccum += airtime;
  if (rad.dutyCycle && rad.dutyCycle < 1) {
    const rest = airtime * (1 - rad.dutyCycle) / rad.dutyCycle;
    s.net.nodeDutyUntil[srcId] = Math.max(tStart + airtime, s.net.nodeDutyUntil[srcId] || 0) + rest;
  }
  s.net.bcasts.push({ srcId, payload, bytes, radio: rad, tFire: tStart + airtime });
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
    if (b.srcId !== 'C2') {
      const d = nodePos(s, b.srcId);
      if (!d || !alive(d)) continue; // dead transmitter (B17)
    }
    const rad = b.radio || (b.srcId === 'C2' ? s.radio : txRadioOf(s, b.srcId, null));
    const airRate = (rad && rad.airRateKbps) || 64;
    s.net.airtimeAccum += (b.bytes * 8) / (airRate * 1000);
    s.net.txAt[b.srcId] = s.time;
    for (const id of nodeIds(s)) {
      if (id === b.srcId || id === 'C2') continue;
      const d = nodePos(s, id);
      if (!d || !alive(d)) continue;
      if (d.bcastSeen >= b.payload.seq) continue;
      const rxRad = (d && d.radio) || s.radio;
      if (typeof bandCompatible === 'function' && !bandCompatible(rad, rxRad)) continue;
      const m = liveMarginDb(s, b.srcId, id);
      if (m <= 0) continue;
      if (s.net.rng() >= pktSuccessProb(m)) continue; // one roll, no retry
      d.bcastSeen = b.payload.seq;
      d.inbox.push({ kind: 'bcast', src: 'C2', payload: b.payload });
      s.net.delivered++;
      capLog(s, { ev: 'bcast', seqNo: b.payload.seq, from: b.srcId, to: id, marginDb: +m.toFixed(1) });
      // this node re-transmits the table once, after its own airtime
      const nodeRad = txRadioOf(s, id, null);
      list.push({ srcId: id, payload: b.payload, bytes: b.bytes, radio: nodeRad, tFire: s.time + hopTimeSec(nodeRad, b.bytes) });
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

// --- Shortest-path tree toward C2 ---------------------------------------------
// At scale, running a fresh Dijkstra PER TELEMETRY PACKET was the dominant
// cost (N drones → N full searches per round). Since nearly everything
// flows TOWARD the ground station and ETX link costs are symmetric, ONE
// tree rooted at C2 serves every upstream packet — rebuilt on a short
// cadence so routes still track the moving swarm.
const C2_TREE_TTL_SEC = 0.5;

function c2Tree(s) {
  if (s._c2Tree && s.time - s._c2Tree.at < C2_TREE_TTL_SEC) return s._c2Tree;
  const ids = nodeIds(s);
  const dist = new Map();
  for (let i = 0; i < ids.length; i++) dist.set(ids[i], Infinity);
  const prev = new Map();
  const done = new Set();
  dist.set('C2', 0);
  const maxRadio = (s.relayRadio && s.relayRadio.rangeLosM > s.radio.rangeLosM) ? s.relayRadio : s.radio;
  const maxSpan = usableRangeM(maxRadio, s.envFactor) * 2.5;
  for (;;) {
    let cur = null, best = Infinity;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!done.has(id)) {
        const d = dist.get(id);
        if (d < best) { best = d; cur = id; }
      }
    }
    if (cur === null || best === Infinity) break; // nothing reachable remains
    done.add(cur);
    const curPos = nodePos(s, cur);
    for (let i = 0; i < ids.length; i++) {
      const nxt = ids[i];
      if (done.has(nxt)) continue;
      if (curPos) {
        const nxtPos = nodePos(s, nxt);
        if (nxtPos && (Math.abs(curPos.x - nxtPos.x) > maxSpan || Math.abs(curPos.y - nxtPos.y) > maxSpan)) continue;
      }
      const c = linkCost(s, cur, nxt);
      if (c === Infinity) continue;
      if (best + c < dist.get(nxt)) { dist.set(nxt, best + c); prev.set(nxt, cur); }
    }
  }
  s._c2Tree = { at: s.time, prev, dist };
  return s._c2Tree;
}

function pathToC2(s, src) {
  const t = c2Tree(s);
  if (!t.dist.has(src) || t.dist.get(src) === Infinity) return null;
  const path = [src];
  let p = src;
  while (p !== 'C2') { p = t.prev.get(p); if (p === undefined) return null; path.push(p); }
  return path;
}

// --- Packets ------------------------------------------------------------------
// bytesOverride lets payload kinds (video chunks) carry their real size.
function preparePacketHop(s, p) {
  const from = p.path[p.hop], to = p.path[p.hop + 1];
  if (!from || !to) return false;

  if (from !== 'C2') {
    const dFrom = nodePos(s, from);
    if (!dFrom || !alive(dFrom)) {
      s.net.dropped++;
      if (p.kind === 'vid' && !p.frameDropped) {
        p.frameDropped = true;
        s.net.vid.droppedFrames++;
      }
      capLog(s, { ev: 'drop', reason: 'dead-src', pid: p.pid, kind: p.kind, from, to });
      return false;
    }
  }
  if (to !== 'C2') {
    const dTo = nodePos(s, to);
    if (!dTo || !alive(dTo)) {
      s.net.dropped++;
      if (p.kind === 'vid' && !p.frameDropped) {
        p.frameDropped = true;
        s.net.vid.droppedFrames++;
      }
      capLog(s, { ev: 'drop', reason: 'dead-dst', pid: p.pid, kind: p.kind, from, to });
      return false;
    }
  }

  const rad = txRadioOf(s, from, to);
  const chan = channelKeyOf(rad);
  const airRate = (rad && rad.airRateKbps) || 64;
  const singleTxSec = (p.bytes * 8) / (airRate * 1000);

  const tStart = Math.max(
    s.time,
    p.tReady || s.time,
    s.net.chanBusyUntil[chan] || 0,
    s.net.nodeTxUntil[from] || 0,
    s.net.nodeDutyUntil[from] || 0
  );

  const retries = hopDelivered(s, from, to);
  const attempts = retries < 0 ? (HOP_RETRIES + 1) : (retries + 1);
  const totalAirtime = singleTxSec * attempts;
  const retryGap = 0.02;
  const hopDuration = totalAirtime + (attempts - 1) * retryGap;

  s.net.chanBusyUntil[chan] = tStart + totalAirtime;
  s.net.nodeTxUntil[from] = tStart + totalAirtime;
  s.net.txAt[from] = tStart;
  s.net.airtimeAccum += totalAirtime;

  if (rad.dutyCycle && rad.dutyCycle < 1) {
    const dutyRest = totalAirtime * (1 - rad.dutyCycle) / rad.dutyCycle;
    s.net.nodeDutyUntil[from] = Math.max(tStart + totalAirtime, s.net.nodeDutyUntil[from] || 0) + dutyRest;
  }

  p.tStart = tStart;
  p.tArrive = tStart + hopDuration + NET.procDelaySec;
  p.retries = retries;
  p.dead = (retries < 0);
  return true;
}

function sendPacket(s, kind, src, dst, payload, bytesOverride) {
  let path = null;
  if (src !== 'C2' && dst !== 'C2' && linkUsable(s, src, dst, 0)) {
    path = [src, dst];
  } else {
    path = dst === 'C2' ? pathToC2(s, src) : routePath(s, src, dst);
  }
  if (!path || path.length < 2) {
    s.net.dropped++;
    if (kind === 'vid') s.net.vid.droppedFrames++;
    capLog(s, { ev: 'drop', reason: 'no-route', kind, src, dst });
    return false; // no route — radio silence
  }
  const bytes = bytesOverride != null ? bytesOverride
    : kind === 'cmd' ? NET.cmdBytes : (kind === 'ack' ? 24 : NET.tlmBytes);

  const rad = txRadioOf(s, path[0], path[1]);
  const chan = channelKeyOf(rad);
  const airRate = (rad && rad.airRateKbps) || 64;
  const queueDelay = Math.max(0, (s.net.chanBusyUntil[chan] || 0) - s.time);
  const frameAirtime = (bytes * 8) / (airRate * 1000);

  // Video latency bound: drop video frame if channel backlog exceeds 1.0s or frame won't fit
  if (kind === 'vid' && (queueDelay > 1.0 || queueDelay + frameAirtime > 2.0)) {
    s.net.dropped++;
    s.net.vid.droppedFrames++;
    capLog(s, { ev: 'drop', reason: 'queue-latency', kind, src, dst });
    return false;
  }

  const MTU = 256;
  if (kind === 'vid' && bytes > MTU) {
    const numFrags = Math.ceil(bytes / MTU);
    const frameId = 'vf' + (++s.net.vidFrameSeq);
    for (let i = 0; i < numFrags; i++) {
      const fragBytes = Math.min(MTU, bytes - i * MTU);
      const p = {
        kind, src, dst, payload, path,
        pid: 'p' + s.net.pktSeq++,
        hop: 0,
        bytes: fragBytes,
        frameId,
        fragIdx: i,
        fragCount: numFrags,
        chunkSec: VID.chunkSec,
        tSent: s.time,
        tReady: s.time,
      };
      if (preparePacketHop(s, p)) {
        s.net.packets.push(p);
      }
    }
    capLog(s, { ev: 'send', pid: frameId, kind, src, dst, frags: numFrags, bytes });
    return true;
  }

  const pid = 'p' + s.net.pktSeq++;
  const p = {
    kind, src, dst, payload, path,
    pid, hop: 0,
    bytes,
    chunkSec: kind === 'vid' ? VID.chunkSec : null,
    tSent: s.time,
    tReady: s.time,
  };
  if (preparePacketHop(s, p)) {
    s.net.packets.push(p);
  }
  capLog(s, { ev: 'send', pid, kind, src, dst, hops: path.length - 1, path: path.join('>') });
  return true;
}

function deliverPacket(s, p) {
  s.net.delivered++;
  if (p.kind === 'vid') {
    if (p.frameId) {
      if (s.c2) {
        s.c2.vidReassembly = s.c2.vidReassembly || new Map();
        let entry = s.c2.vidReassembly.get(p.frameId);
        if (!entry) {
          entry = { received: new Set(), total: p.fragCount, at: s.time };
          s.c2.vidReassembly.set(p.frameId, entry);
        }
        entry.received.add(p.fragIdx);
        if (entry.received.size === entry.total) {
          s.net.vid.framesDelivered++;
          s.c2.vidReassembly.delete(p.frameId);
        }
      } else {
        s.net.vid.framesDelivered++;
      }
    } else {
      s.net.vid.framesDelivered++;
    }
  }
  if (p.dst === 'C2') {
    // Payload chunks are consumed by the application layer, not the
    // telemetry ingest — C2's belief state only updates from real reports.
    if (p.kind !== 'vid' && s.c2 && s.c2.inbox) s.c2.inbox.push(p);
  }
  else {
    const d = nodePos(s, p.dst);
    if (d && alive(d)) d.inbox.push(p);
    else s.net.delivered--, s.net.dropped++;
  }
}

function stepNet(s, dt) {
  stepFades(s, dt);
  stepBcasts(s);

  // Prune expired video reassembly
  if (s.c2 && s.c2.vidReassembly) {
    for (const [fid, ent] of s.c2.vidReassembly) {
      if (s.time - ent.at > 3.0) {
        s.c2.vidReassembly.delete(fid);
        s.net.vid.droppedFrames++;
      }
    }
  }

  let writeIdx = 0;
  const packets = s.net.packets;
  const len = packets.length;
  for (let i = 0; i < len; i++) {
    const p = packets[i];
    // Check packet expiration (TTL: 3.0s for video, 6.0s for telemetry, 10.0s for commands)
    const ttl = p.kind === 'vid' ? 3.0 : (p.kind === 'tlm' ? 6.0 : 10.0);
    if (s.time - (p.tSent || s.time) > ttl) {
      s.net.dropped++;
      if (p.kind === 'vid' && !p.frameDropped) {
        p.frameDropped = true;
        s.net.vid.droppedFrames++;
        if (p.frameId && s.c2 && s.c2.vidReassembly) s.c2.vidReassembly.delete(p.frameId);
      }
      capLog(s, { ev: 'drop', reason: 'ttl-expired', pid: p.pid, kind: p.kind });
      continue;
    }

    if (s.time < p.tArrive) {
      packets[writeIdx++] = p;
      continue;
    }

    const from = p.path[p.hop], to = p.path[p.hop + 1];
    if (p.dead) {
      s.net.dropped++;
      if (p.kind === 'vid' && !p.frameDropped) {
        p.frameDropped = true;
        s.net.vid.droppedFrames++;
        if (p.frameId && s.c2 && s.c2.vidReassembly) s.c2.vidReassembly.delete(p.frameId);
      }
      capLog(s, { ev: 'drop', reason: 'link-fail', pid: p.pid, kind: p.kind, from, to, marginDb: +liveMarginDb(s, from, to).toFixed(1) });
      continue;
    }

    capLog(s, { ev: 'hop', pid: p.pid, kind: p.kind, from, to, retries: p.retries, marginDb: +liveMarginDb(s, from, to).toFixed(1) });
    p.hop++;
    if (p.hop >= p.path.length - 1) {
      capLog(s, { ev: 'deliver', pid: p.pid, kind: p.kind, src: p.src, dst: p.dst });
      deliverPacket(s, p);
      continue;
    }

    p.tReady = p.tArrive;
    if (preparePacketHop(s, p)) {
      packets[writeIdx++] = p;
    }
  }
  packets.length = writeIdx;

  // Sliding channel-utilization estimate: what fraction of the last window
  // was the single shared frequency actually busy?
  if (s.time - s.net.utilSince >= 5) {
    s.net.utilization = Math.min(1, s.net.airtimeAccum / (s.time - s.net.utilSince));
    s.net.airtimeAccum = 0;
    s.net.utilSince = s.time;
  }
}

// Export the capture as JSONL (one JSON event per line) — a portable trace
// any tool can parse. Schema per line:
//   {seq, t, ev, ...}  where ev ∈ send|hop|deliver|drop|bcast
//     send    {pid, kind, src, dst, hops, path}
//     hop     {pid, kind, from, to, retries, marginDb}
//     deliver {pid, kind, src, dst}
//     drop    {pid?, kind, reason, from?, to?, marginDb?}  reason: no-route|link-fail
//     bcast   {seqNo, from, to, marginDb}
function exportCaptureJSONL(s) {
  const header = { seq: -1, t: 0, ev: 'meta', radio: s.radio.id, broadcast: !!s.broadcastC2, events: s.net.cap.length };
  return [header, ...s.net.cap].map(e => JSON.stringify(e)).join('\n');
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NET, VID, makeNet, capLog, sendBroadcast, stepBcasts,
    txRadioOf, channelKeyOf, hopTimeSec, nodeIds, nodePos,
    linkUsable, linkCost, routePath, c2Tree, pathToC2,
    sendPacket, deliverPacket, stepNet, exportCaptureJSONL,
    hopDelivered, HOP_RETRIES,
  };
}

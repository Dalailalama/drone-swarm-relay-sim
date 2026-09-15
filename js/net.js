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
    // shared-channel accounting: ACTUAL on-air seconds, billed per channel at
    // the moment of transmission (never at enqueue — see stepNet), plus an
    // estimate of queued-but-unsent air per channel for latency decisions
    airAccumByChan: {}, chanPendingSec: {}, utilSince: 0, utilization: 0,
    // rolling capture log (like a Wireshark trace): last CAP_MAX events
    cap: [], capSeq: 0,
    // packet id counter — always advances, independent of capture being on,
    // so pids are unique in a trace even for packets that predate capture
    pktSeq: 0,
    // payload/video accounting (Feature: Tier-1 #4). vidDropped holds
    // tombstones for frames already counted as lost, so a frame terminates
    // exactly once no matter how many of its fragments die (finding #15).
    vid: { framesDelivered: 0, droppedFrames: 0 },
    vidDropped: new Map(),
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

// --- Air bookkeeping ---------------------------------------------------------
// COMMIT-AT-TRANSMISSION model: nothing reserves the channel in advance.
// A queued transmission starts the moment the shared-channel, per-node and
// duty clocks actually free up (retroactively within the elapsed tick, so
// several short transmissions still pipeline inside one dt), the clocks
// advance by the ACTUAL duration used, and the airtime bill records what
// really went on air. Queued work that dies before its turn — expired,
// superseded, dead sender — simply leaves the queue: there is no phantom
// reservation to unwind (findings #3/#4/#5/#16). `chanPendingSec` tracks
// queued-but-unsent air per channel as an estimate for latency decisions
// (video's freshness guard), not as a reservation.
function billAir(s, chan, secs) {
  s.net.airAccumByChan[chan] = (s.net.airAccumByChan[chan] || 0) + secs;
}

function pendAir(s, chan, secs) {
  s.net.chanPendingSec[chan] = Math.max(0, (s.net.chanPendingSec[chan] || 0) + secs);
}

// --- Broadcast flooding -------------------------------------------------------
// One packet carries the whole swarm's order table. Every node that hears a
// broadcast with a new sequence number takes its own row and re-transmits
// the packet ONCE — classic mesh flooding. No routes, no ACKs, no retries:
// each receiver rolls the packet-error dice exactly once per transmission it
// can hear, which is honestly how broadcast works.
//
// EVERY transmission — original or forwarded — goes through scheduleBcast, so
// it queues behind the shared channel, the sender's own radio and its legal
// duty cycle exactly like unicast traffic (finding #4). Queued copies expire
// by SUPERSESSION: a newer order table makes an unsent older one worthless,
// so it releases its air instead of jamming the queue (finding #5) — the
// natural TTL for state-carrying floods, and it doesn't break duty-limited
// radios whose forwards legitimately wait a long time. A hard cap bounds the
// queue against pathological fan-out.
const BCAST_QUEUE_MAX = 64;

function scheduleBcast(s, srcId, payload, bytes, rad) {
  // Supersession: drop queued (uncommitted) older tables — theirs is dead air.
  const list = s.net.bcasts;
  for (let i = list.length - 1; i >= 0; i--) {
    const q = list[i];
    if (!q.committed && !q._gone && q.payload.seq < payload.seq) {
      pendAir(s, q.chan, -q.airtime);
      capLog(s, { ev: 'drop', reason: 'bcast-superseded', from: q.srcId, seqNo: q.payload.seq });
      list.splice(i, 1);
    }
  }
  if (list.length >= BCAST_QUEUE_MAX) {
    capLog(s, { ev: 'drop', reason: 'bcast-backlog', from: srcId, seqNo: payload.seq });
    return;
  }
  const chan = channelKeyOf(rad);
  const airRate = (rad && rad.airRateKbps) || 64;
  const airtime = (bytes * 8) / (airRate * 1000);
  pendAir(s, chan, airtime);
  list.push({ srcId, payload, bytes, radio: rad, chan, airtime, tQueued: s.time, committed: false, tFire: null });
}

function sendBroadcast(s, srcId, payload, bytes, radioOverride) {
  if (srcId !== 'C2') {
    const d = nodePos(s, srcId);
    if (!d || !alive(d)) return;
  }
  const rad = radioOverride || (srcId === 'C2' ? s.radio : txRadioOf(s, srcId, null));
  scheduleBcast(s, srcId, payload, bytes, rad);
}

// --- Unified commit phase ------------------------------------------------------
// One shared channel = one timeline. Broadcasts and unicast hops are committed
// TOGETHER in earliest-eligible order: processing either queue first would let
// a fresh arrival (eligible only from "now") commit ahead of older work that
// was eligible earlier — and because the busy-clock is a single scalar that
// cannot represent a hole, the free air before the late start would be
// silently forfeited. (Measured: a 3 ms order broadcast committed first-in-
// tick threw away 0.247 s of channel and halved video throughput.)
// Ties go to the broadcast — control traffic outranks payload at equal
// eligibility, which is how real link schedulers treat command frames.

function eligibleStartBcast(s, b) {
  return Math.max(b.tQueued,
    s.net.chanBusyUntil[b.chan] || 0,
    s.net.nodeTxUntil[b.srcId] || 0,
    s.net.nodeDutyUntil[b.srcId] || 0);
}

function eligibleStartPkt(s, p) {
  return Math.max(p.tReady || 0,
    s.net.chanBusyUntil[p.res.chan] || 0,
    s.net.nodeTxUntil[p.res.from] || 0,
    s.net.nodeDutyUntil[p.res.from] || 0);
}

function commitBcast(s, b, eStart) {
  pendAir(s, b.chan, -b.airtime);
  if (b.srcId !== 'C2') {
    const d = nodePos(s, b.srcId);
    if (!d || !alive(d)) { b._gone = true; return; } // dead transmitter (B17) — never went on air
  }
  // Advance the clocks by the ACTUAL airtime, bill it once (finding #16),
  // record real emission for DF sensing.
  s.net.chanBusyUntil[b.chan] = eStart + b.airtime;
  s.net.nodeTxUntil[b.srcId] = eStart + b.airtime;
  const rad0 = b.radio || s.radio;
  if (rad0.dutyCycle && rad0.dutyCycle < 1) {
    const rest = b.airtime * (1 - rad0.dutyCycle) / rad0.dutyCycle;
    s.net.nodeDutyUntil[b.srcId] = Math.max(eStart + b.airtime, s.net.nodeDutyUntil[b.srcId] || 0) + rest;
  }
  billAir(s, b.chan, b.airtime);
  s.net.txAt[b.srcId] = eStart;
  b.committed = true;
  b.tFire = eStart + b.airtime; // reception rolls when the last bit lands
}

// One lifecycle per FRAME (finding #15): a frame terminates exactly once —
// delivered when its last fragment lands, dropped the FIRST time any of it
// is lost (fragment TTL, dead hop, failed link, or reassembly expiry).
// Late fragments of an already-dead frame are discarded without effect.
function markVidFrameDropped(s, id) {
  if (id == null || s.net.vidDropped.has(id)) return;
  s.net.vidDropped.set(id, s.time);
  s.net.vid.droppedFrames++;
  if (s.c2 && s.c2.vidReassembly) s.c2.vidReassembly.delete(id);
}

function dropPacketBookkeeping(s, p, reason, from, to, marginDb) {
  s.net.dropped++;
  if (p.kind === 'vid') markVidFrameDropped(s, p.frameId || p.pid);
  capLog(s, { ev: 'drop', reason, pid: p.pid, kind: p.kind, from, to, marginDb });
}

function commitPacket(s, p, eStart) {
  // The transmission starts NOW — evaluate the world as it is, not as it
  // was when the packet was queued (finding #3).
  pendAir(s, p.res.chan, -p.res.singleTx);
  const from = p.path[p.hop], to = p.path[p.hop + 1];
  const dFrom = from === 'C2' ? s.base : nodePos(s, from);
  if (from !== 'C2' && (!dFrom || !alive(dFrom))) {
    // A dead sender transmits nothing — it just leaves the queue.
    dropPacketBookkeeping(s, p, 'dead-src', from, to);
    p._gone = true;
    return;
  }
  const dTo = to === 'C2' ? s.base : nodePos(s, to);
  const rxAlive = to === 'C2' || (dTo && alive(dTo));
  // A dead/vanished receiver still costs the sender every attempt — it
  // transmits into silence and burns the full retry budget.
  const r = rxAlive ? hopDelivered(s, from, to) : -1;
  const attempts = r < 0 ? HOP_RETRIES + 1 : r + 1;
  const actualAir = attempts * p.res.singleTx;
  const actualDur = actualAir + (attempts - 1) * HOP_RETRY_GAP_SEC;
  s.net.chanBusyUntil[p.res.chan] = eStart + actualDur;
  s.net.nodeTxUntil[p.res.from] = eStart + actualDur;
  const dc = p.res.rad && p.res.rad.dutyCycle;
  if (dc && dc < 1) {
    const rest = actualAir * (1 - dc) / dc;
    s.net.nodeDutyUntil[p.res.from] = Math.max(eStart + actualDur, s.net.nodeDutyUntil[p.res.from] || 0) + rest;
  }
  billAir(s, p.res.chan, actualAir);
  s.net.txAt[from] = eStart; // actual emission — what a direction-finder senses
  if (r < 0) {
    dropPacketBookkeeping(s, p, rxAlive ? 'link-fail' : 'dead-dst', from, to,
      rxAlive ? +liveMarginDb(s, from, to).toFixed(1) : undefined);
    p._gone = true;
    return;
  }
  p.retries = r;
  p.fired = true;
  p.tHopStart = eStart;
  p.tArrive = eStart + actualDur + NET.procDelaySec;
}

function commitTransmissions(s) {
  for (;;) {
    let best = null, bestStart = Infinity, bestIsBcast = false;
    for (const b of s.net.bcasts) {
      if (b.committed || b._gone) continue;
      const e = eligibleStartBcast(s, b);
      if (e < bestStart) { bestStart = e; best = b; bestIsBcast = true; }
    }
    for (const p of s.net.packets) {
      if (p.fired || p._gone) continue;
      const e = eligibleStartPkt(s, p);
      if (e < bestStart) { bestStart = e; best = p; bestIsBcast = false; }
    }
    if (!best || bestStart > s.time) return;
    if (bestIsBcast) commitBcast(s, best, bestStart);
    else commitPacket(s, best, bestStart);
  }
}

function stepBcasts(s) {
  const list = s.net.bcasts;
  if (!list.length) return;
  const next = [];
  // Reception only — commits happen in commitTransmissions. Index loop on
  // purpose: a reception appends rebroadcasts to `list` (via scheduleBcast),
  // and those must be visited (uncommitted, so they land in `next`).
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b._gone) continue;
    if (!b.committed) { next.push(b); continue; }
    if (s.time < b.tFire) { next.push(b); continue; }
    if (b.srcId !== 'C2') {
      const d = nodePos(s, b.srcId);
      if (!d || !alive(d)) continue; // transmitter died mid-air — nobody hears the cut-off table
    }
    const rad = b.radio || (b.srcId === 'C2' ? s.radio : txRadioOf(s, b.srcId, null));
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
      // this node re-transmits the table once — through the same scheduler
      scheduleBcast(s, id, b.payload, b.bytes, txRadioOf(s, id, null));
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
    if (!dFrom || !alive(dFrom)) { dropPacketBookkeeping(s, p, 'dead-src', from, to); return false; }
  }
  if (to !== 'C2') {
    const dTo = nodePos(s, to);
    if (!dTo || !alive(dTo)) { dropPacketBookkeeping(s, p, 'dead-dst', from, to); return false; }
  }

  // Enqueue only. Nothing about the OUTCOME or the start time is decided
  // here — the transmission commits in stepNet when the channel/node/duty
  // clocks actually free up, and liveness, RF margin and retries are
  // evaluated at that moment against the world as it then is (finding #3).
  const rad = txRadioOf(s, from, to);
  const chan = channelKeyOf(rad);
  const airRate = (rad && rad.airRateKbps) || 64;
  const singleTxSec = (p.bytes * 8) / (airRate * 1000);
  pendAir(s, chan, singleTxSec);
  p.res = { chan, from, singleTx: singleTxSec, rad };
  p.fired = false;
  p.tHopStart = null;
  p.tArrive = null;
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
  // Committed busy time plus queued-but-unsent air: the honest backlog estimate.
  const queueDelay = Math.max(0, (s.net.chanBusyUntil[chan] || 0) - s.time)
    + (s.net.chanPendingSec[chan] || 0);
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
    if (s.net.vidDropped.has(p.frameId || p.pid)) {
      // Straggler of a frame already counted as lost: the RF delivery
      // happened, but the frame is dead — discard, never resurrect.
      return;
    }
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
  commitTransmissions(s); // shared timeline: earliest-eligible first, both queues
  stepBcasts(s);

  // Reassembly that never completes is one lost frame (via the tombstone,
  // so fragment-level drops of the same frame never double it — finding #15).
  if (s.c2 && s.c2.vidReassembly) {
    for (const [fid, ent] of s.c2.vidReassembly) {
      if (s.time - ent.at > 3.0) markVidFrameDropped(s, fid);
    }
  }
  // Tombstones outlive any straggler fragment (max TTL 10 s), then go.
  if (s.net.vidDropped.size) {
    for (const [fid, at] of s.net.vidDropped) {
      if (s.time - at > 12) s.net.vidDropped.delete(fid);
    }
  }

  let writeIdx = 0;
  const packets = s.net.packets;
  const len = packets.length;
  for (let i = 0; i < len; i++) {
    const p = packets[i];
    if (p._gone) continue; // dropped during the commit phase
    // TTL by kind (3s video, 6s telemetry, 10s commands). `??` not `||`:
    // a packet sent at t=0 has tSent=0 and must age like any other. An
    // expired packet that never transmitted hands its queued air back.
    const ttl = p.kind === 'vid' ? 3.0 : (p.kind === 'tlm' ? 6.0 : 10.0);
    if (s.time - (p.tSent ?? s.time) > ttl) {
      if (!p.fired && p.res) pendAir(s, p.res.chan, -p.res.singleTx);
      dropPacketBookkeeping(s, p, 'ttl-expired');
      continue;
    }

    if (!p.fired || s.time < p.tArrive) {
      packets[writeIdx++] = p; // waiting for its slot, or in flight
      continue;
    }

    const from = p.path[p.hop], to = p.path[p.hop + 1];
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

  // Second commit pass: arrivals above may have enqueued next hops, and
  // receptions may have queued rebroadcasts — let them claim any air still
  // free in this tick instead of idling a full dt per hop.
  commitTransmissions(s);

  // Sliding utilization estimate from ACTUAL on-air seconds, per channel —
  // independent bands are independent air, so report the busiest one rather
  // than summing unrelated spectrum into a number that can exceed 1.
  if (s.time - s.net.utilSince >= 5) {
    const w = s.time - s.net.utilSince;
    let peak = 0;
    for (const k in s.net.airAccumByChan) peak = Math.max(peak, s.net.airAccumByChan[k] / w);
    s.net.utilization = Math.min(1, peak);
    s.net.airAccumByChan = {};
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
const HOP_RETRY_GAP_SEC = 0.02; // listen-for-ACK gap between attempts

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

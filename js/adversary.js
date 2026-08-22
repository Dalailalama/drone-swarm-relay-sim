// Red-team adversary mode — an interference source that HUNTS.
//
// Honesty first: the adversary is NOT omniscient. It cannot see truth state,
// plans, or routes. What it can do is exactly what a real EW platform can:
// receive the swarm's own transmissions and direction-find them. Every
// packet hop in this sim already occupies the shared channel (net.js), so
// "who transmitted recently" is sensor-available data. The adversary walks
// toward the recency-weighted centroid of those transmissions at a limited
// ground speed — a crawling denial zone that chases whoever is talking.
//
// Pure functions here; js/swarm.js feeds them from live network state.

const ADVERSARY = {
  senseWindowSec: 20,   // how far back the DF receiver remembers emissions
  weightTauSec: 8,      // newer transmissions weigh more (exp decay)
  holdOffM: 25,         // close enough — stop jittering on top of the emitter
};

// Recency-weighted centroid of contacts [{x, y, age}] (age in seconds,
// Infinity = stale/ignored). Returns null with no fresh contacts.
function trafficCentroid(contacts, now) {
  let wx = 0, wy = 0, wsum = 0;
  for (const c of contacts) {
    const age = now - c.age;
    if (!(age >= 0) || age > ADVERSARY.senseWindowSec) continue;
    const w = Math.exp(-age / ADVERSARY.weightTauSec);
    wx += c.x * w; wy += c.y * w; wsum += w;
  }
  if (wsum <= 0) return null;
  return { x: wx / wsum, y: wy / wsum, weight: wsum };
}

// One movement step toward the target, capped at speedMs·dt. Returns the
// new position without mutating (pure/testable). Holds inside holdOffM.
function adversaryStep(pos, target, speedMs, dt) {
  if (!target) return pos;
  const dx = target.x - pos.x, dy = target.y - pos.y;
  const d = Math.hypot(dx, dy);
  if (d <= ADVERSARY.holdOffM) return pos;
  const step = Math.min(d - ADVERSARY.holdOffM, speedMs * dt);
  return { x: pos.x + dx / d * step, y: pos.y + dy / d * step };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ADVERSARY, trafficCentroid, adversaryStep };
}

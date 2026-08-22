// GPS-denied navigation — what each drone believes about its own position
// when the satellites stop answering.
//
// Inside a GPS-denial zone (jammer, urban canyon, deliberate spoof region)
// a drone falls back to dead reckoning: its believed position integrates
// airspeed with a slowly-wandering drift velocity (Ornstein-Uhlenbeck, the
// same statistics the RF shadowing uses). The error is honest and brutal —
// tens of metres within a minute, unbounded with time — which is precisely
// why nobody pretends INS works like GNSS. The drone STEERS by its belief,
// so it misses its assigned slot by exactly the amount its navigation lies;
// proximity senses (separation, obstacle push) stay on truth, because those
// are onboard sensors, not satellite receivers.
//
// Pure functions live here; js/swarm.js consumes them per tick.
if (typeof gaussian !== 'function' && typeof require === 'function') {
  // Node standalone (tests): net.js's gaussian isn't importable without a
  // module system, so provide the identical Box-Muller locally.
  gaussian = function (rng) {
    let u = 0, v = 0;
    while (!u) u = rng();
    while (!v) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

// Dead-reckoning drift: stationary gyro noise wanders the belief; moving
// through the world compounds it. 1.2 m/s of slow random heading error is
// pessimistic-but-fair for a consumer IMU without aiding.
const GPS_DENIED = {
  driftSigmaMs: 1.2,
  tauSec: 25,
};

// Is (x, y) inside any ACTIVE denial zone?
function gpsDeniedAt(zones, x, y) {
  if (!zones || !zones.length) return false;
  for (const z of zones) {
    if (z.on === false) continue;
    const dx = x - z.x, dy = y - z.y;
    if (dx * dx + dy * dy <= z.rM * z.rM) return true;
  }
  return false;
}

// One tick of the believed-position state. Returns nothing; mutates the
// drone's bel fields via the returned values (kept pure for testability):
//   healthy  → belief snaps to truth (GNSS fix re-acquired instantly;
//              the small per-report GPS noise stays applied at send time)
//   denied   → belief integrates air velocity + OU drift
function stepBelief(d, dt, rng, denied) {
  if (!denied) {
    return { belX: d.x, belY: d.y, dvx: 0, dvy: 0 };
  }
  // Ornstein-Uhlenbeck drift velocity: wanders, but doesn't run away.
  const k = Math.sqrt(2 * dt / GPS_DENIED.tauSec);
  const dvx = d.dvx + (-d.dvx * dt / GPS_DENIED.tauSec) + GPS_DENIED.driftSigmaMs * k * gaussian(rng);
  const dvy = d.dvy + (-d.dvy * dt / GPS_DENIED.tauSec) + GPS_DENIED.driftSigmaMs * k * gaussian(rng);
  return { belX: d.belX + (d.vx + dvx) * dt, belY: d.belY + (d.vy + dvy) * dt, dvx, dvy };
}

let gpsZoneSeq = 0;
function makeGpsZone(x, y, rM) {
  gpsZoneSeq += 1;
  return { id: 'GZ-' + gpsZoneSeq, x, y, rM: rM || 400, on: true };
}

// UMD-lite export so the physics is unit-testable under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GPS_DENIED, gpsDeniedAt, stepBelief, makeGpsZone };
}

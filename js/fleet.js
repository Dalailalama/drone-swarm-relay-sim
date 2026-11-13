// Heterogeneous fleet support — mixed airframes AND mixed radios in one
// mission. The pitch: long-endurance "relay wing" aircraft carrying serious
// long-range radios hold the backhaul chain, while small expendable tactical
// drones fly the mission on short-range hardware. C2 assigns roles by
// capability, not by roster position.
//
// Link physics stay honest: every radio wave belongs to a frequency. Two
// nodes can only form a link when their radios are band-compatible, and a
// mixed link's budget is computed per DIRECTION — each end transmits with
// its own power/antenna over the link's one (reciprocal) path-loss law, and
// the link is only as good as the worse direction (ACKs and retries need both).
//
// Pure functions live here so they're unit-testable under Node without a
// browser or a swarm instance. Everything consumes the same radio objects
// from js/radios.js.
if (typeof pl1m !== 'function' && typeof require === 'function') {
  // Node standalone (tests): pull in the link-physics primitives.
  ({ pl1m, pathLossExponent } = require('./radios.js'));
}

// Radios further apart than this in frequency can't hear each other at all
// (matches the out-of-band test the interference model already uses).
const BAND_COMPAT_MHZ = 150;

// Two radios hear each other only if they also speak the same air protocol
// (`air`: modulation + framing). A preset without one links to its own id.
function bandCompatible(ra, rb) {
  if (ra === rb) return true;
  const same = ra.air != null ? ra.air === rb.air : ra.id === rb.id;
  return same && Math.abs(ra.freqMHz - rb.freqMHz) <= BAND_COMPAT_MHZ;
}

// One air path has one propagation law. Each preset's `n` is a range-
// calibration fit, not channel physics, so a mixed link takes the larger
// (conservative) of the two exponents in BOTH directions and its path loss
// stays reciprocal. Identical radios keep their own exponent exactly.
function channelExponent(ra, rb) {
  if (ra === rb) return pathLossExponent(ra);
  return Math.max(pathLossExponent(ra), pathLossExponent(rb));
}

// Received strength at the RX end when TX transmits: TX's power and its own
// calibrated frequency/intercept over the link's shared exponent, antenna
// gains summed from both ends.
function rssiDirectionalDb(tx, rx, envFactor, dMetres) {
  const d = Math.max(1, dMetres / envFactor);
  const n = channelExponent(tx, rx);
  if (tx.refPowerDbm != null) {
    return tx.refPowerDbm - 10 * n * Math.log10(d) + (rx.antGainDbi - tx.antGainDbi);
  }
  const pl = pl1m(tx.freqMHz) + 10 * n * Math.log10(d);
  return tx.txDbm + tx.antGainDbi + rx.antGainDbi - pl;
}

// Margin of a link between two DIFFERENT radios: the worse of the two
// directions. With identical radios this collapses exactly to the classic
// linkMarginDb (symmetric directions), so homogeneous missions are unchanged.
function mixedLinkMarginDb(ra, rb, envFactor, dMetres) {
  if (!bandCompatible(ra, rb)) return -Infinity;
  return Math.min(
    rssiDirectionalDb(ra, rb, envFactor, dMetres) - rb.sensDbm,
    rssiDirectionalDb(rb, ra, envFactor, dMetres) - ra.sensDbm,
  );
}

// Which fleet members get the relay-wing hardware? Spread as evenly through
// the launch order as possible (so both classes mix spatially instead of the
// wing clumping at one corner of the staging circle). Deterministic.
function relayClassIndices(count, want) {
  const w = Math.max(0, Math.min(want | 0, count));
  const set = new Set();
  for (let i = 0; i < w; i++) {
    let ix = Math.floor((i + 0.5) * count / w) % count;
    while (set.has(ix)) ix = (ix + 1) % count;
    set.add(ix);
  }
  return [...set].sort((a, b) => a - b);
}

// UMD-lite export so the physics is unit-testable under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BAND_COMPAT_MHZ, bandCompatible, channelExponent, rssiDirectionalDb,
    mixedLinkMarginDb, relayClassIndices,
  };
}

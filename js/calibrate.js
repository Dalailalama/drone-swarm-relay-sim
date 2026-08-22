// Sim-to-real calibration loop — the feature that turns this simulator from
// "plausible" into "validated against measured data".
//
// Fly two radios apart, log RSSI vs distance (any CSV logger will do:
// Mission Planner, a ULog export, a pocket spectrum-scan notebook), feed the
// CSV here, and this module fits the one parameter our whole RF model hangs
// on — the path-loss exponent `n` — plus a measured-vs-model validation
// report. The output is a calibrated radio preset whose rated range now
// matches YOUR hardware, antennas, and ground, not just the datasheet.
//
// Method: log-distance path loss says RSSI(d) = A − 10·n·log10(d). That is
// LINEAR in x = log10(d), so ordinary least squares gives both A (reference
// power at 1 m, absorbing real TX power and antenna gains) and n directly,
// with RMSE and R² to say how honest the fit is.

// Node standalone (tests): pull in or re-create the few helpers this module
// borrows from js/radios.js and js/render.js in the browser.
if (typeof require === 'function' && typeof module !== 'undefined') {
  if (typeof pl1m !== 'function' || typeof pathLossExponent !== 'function') {
    ({ pl1m, pathLossExponent } = require('./radios.js'));
  }
}
if (typeof fmtDist !== 'function') {
  fmtDist = function (m) {
    return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.round(m) + ' m';
  };
}

// --- CSV parsing --------------------------------------------------------------
// Accepted header aliases (case-insensitive):
//   distance: dist | distance | d | range          (metres)
//   signal:   rssi | rssi_dbm | rssi value | signal | dbm
//   optional position instead of distance: x, y[, z] — origin = first row
//   optional time: t | time | timestamp
const CAL_ALIASES = {
  dist: ['dist', 'distance', 'd', 'range'],
  rssi: ['rssi', 'rssi_dbm', 'rssidbm', 'rssi_value', 'rssivalue', 'signal', 'dbm', 'signal_strength'],
  x: ['x', 'e', 'east'], y: ['y', 'n?'], // y alias handled loosely below
  z: ['z', 'alt', 'altitude', 'up'],
};

function findCol(header, aliases) {
  const h = header.map(s => s.trim().toLowerCase().replace(/[^a-z_]/g, ''));
  for (const a of aliases) {
    const i = h.indexOf(a);
    if (i >= 0) return i;
  }
  return -1;
}

// Returns { samples: [{dM, rssiDbm}], dropped, notes: [] } — never throws on
// messy data; it skips junk rows and says what it skipped.
function parseFlightLogCsv(text) {
  const out = { samples: [], dropped: 0, notes: [] };
  if (!text || !text.trim()) { out.notes.push('empty file'); return out; }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!lines.length) { out.notes.push('no data rows'); return out; }
  const header = lines[0].split(',').map(s => s.trim());
  const iD = findCol(header, CAL_ALIASES.dist);
  const iR = findCol(header, CAL_ALIASES.rssi);
  const iX = findCol(header, ['x', 'e', 'east']);
  const iY = findCol(header, ['y']);
  let iZ = findCol(header, ['z', 'alt', 'altitude']);
  const hasPos = iR >= 0 && iX >= 0 && iY >= 0;
  if (iD < 0 && !hasPos) { out.notes.push('need a distance column (dist/d/range) or x,y columns'); return out; }
  if (iR < 0) { out.notes.push('need an RSSI column (rssi/dbm/signal)'); return out; }
  if (hasPos && iZ < 0) iZ = -1;

  let ox = null, oy = null, oz = null;
  for (let li = 1; li < lines.length; li++) {
    const cells = lines[li].split(',').map(s => s.trim());
    const num = i => (i >= 0 && i < cells.length ? parseFloat(cells[i]) : NaN);
    let dM = num(iD);
    if (hasPos) {
      const x = num(iX), y = num(iY);
      if (!isFinite(x) || !isFinite(y)) { out.dropped++; continue; }
      if (ox === null) {
        ox = x; oy = y; oz = iZ >= 0 ? num(iZ) : 0;
        if (!isFinite(oz)) oz = 0;
        continue; // first row is the origin, not a sample
      }
      const dz = iZ >= 0 ? (num(iZ) || oz) : oz;
      dM = Math.hypot(x - ox, y - oy, (iZ >= 0 ? dz : 0) - oz);
    }
    const rssi = num(iR);
    if (!isFinite(dM) || !isFinite(rssi)) { out.dropped++; continue; }
    if (dM < 1) { out.dropped++; if (!out.notes.includes('dropped samples inside the 1 m noise floor')) out.notes.push('dropped samples inside the 1 m noise floor'); continue; }
    out.samples.push({ dM, rssiDbm: rssi });
  }
  if (!out.samples.length) out.notes.push('no usable samples');
  return out;
}

// --- Least-squares fit ----------------------------------------------------------
// Minimise squared error of RSSI over log10(distance).
function fitPathLoss(samples) {
  const n = samples.length;
  if (n < 5) return { ok: false, reason: 'need at least 5 samples, got ' + n };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of samples) {
    const x = Math.log10(Math.max(1, s.dM)), y = s.rssiDbm;
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return { ok: false, reason: 'degenerate spread — all samples at the same distance?' };
  const slope = (n * sxy - sx * sy) / denom;      // dB per decade
  const intercept = (sy - slope * sx) / n;         // RSSI at d = 1 m
  const expN = -slope / 10;
  if (!(expN > 1) || !(expN < 8)) {
    return { ok: false, reason: 'fitted exponent n=' + expN.toFixed(2) + ' outside physical range (1..8)' };
  }
  // goodness of fit
  let ssRes = 0, ssTot = 0;
  for (const s of samples) {
    const pred = intercept + slope * Math.log10(Math.max(1, s.dM));
    ssRes += (s.rssiDbm - pred) * (s.rssiDbm - pred);
  }
  const meanY = sy / n;
  for (const s of samples) ssTot += (s.rssiDbm - meanY) * (s.rssiDbm - meanY);
  const rmse = Math.sqrt(ssRes / n);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
  return { ok: true, n: expN, refPowerDbm: intercept, rmse, r2, count: n };
}

// Derive the calibrated preset numbers: keep the datasheet TX/sensitivity/
// antennas, but re-derive `rangeLosM` so the model's calibrated exponent
// EQUALS the measured one — exactly the tuning step that makes predictions
// match your field data.
function calibratePreset(fit, basePreset) {
  const budget = basePreset.txDbm + 2 * basePreset.antGainDbi - basePreset.sensDbm;
  const pl1 = pl1m(basePreset.freqMHz);
  // model n = (budget − PL(1m)) / (10·log10(rangeLosM)) → solve for rangeLosM
  const rangeLosM = Math.pow(10, (budget - pl1) / (10 * fit.n));
  return {
    id: basePreset.id + '-calibrated',
    name: basePreset.name + ' (field-calibrated)',
    freqMHz: basePreset.freqMHz,
    txDbm: basePreset.txDbm,
    sensDbm: basePreset.sensDbm,
    antGainDbi: basePreset.antGainDbi,
    airRateKbps: basePreset.airRateKbps,
    // Full precision on purpose: the model-exponent identity below is exact
    // only if this number isn't rounded.
    rangeLosM,
    hopGainDb: basePreset.hopGainDb,
    dutyCycle: basePreset.dutyCycle,
    note: 'Calibrated against ' + fit.count + ' field samples: measured path-loss exponent n=' +
      fit.n.toFixed(2) + ' (datasheet model implied ' + pathLossExponent(basePreset).toFixed(2) +
      '), RMSE ' + fit.rmse.toFixed(1) + ' dB, R² ' + fit.r2.toFixed(3) +
      '. Rated LOS range re-derived to ' + fmtDist(rangeLosM) + '.',
    source: basePreset.source,
    calibratedFrom: { nFit: fit.n, refPowerDbm: fit.refPowerDbm, rmse: fit.rmse, r2: fit.r2, samples: fit.count },
  };
}

// --- Validation report -----------------------------------------------------------
function validationReportMd(fit, basePreset, samples, parsed) {
  const L = [];
  L.push('# RF model calibration report');
  L.push('');
  L.push('_Generated by the drone swarm relay simulator\u2019s sim-to-real calibration loop. This is measured-data fitting, not flight-test certification._');
  L.push('');
  L.push('## Input');
  L.push('- **Base preset:** ' + basePreset.name + ' (' + basePreset.freqMHz + ' MHz, datasheet rated range ' + fmtDist(basePreset.rangeLosM) + ')');
  L.push('- **Samples:** ' + fit.count + ' usable' + (parsed && parsed.dropped ? ' (' + parsed.dropped + ' rows dropped)' : ''));
  if (parsed && parsed.notes.length) {
    for (const nt of parsed.notes) L.push('- Note: ' + nt);
  }
  L.push('');
  L.push('## Fit');
  L.push('- **Measured path-loss exponent:** n = ' + fit.n.toFixed(2));
  L.push('- **Reference power at 1 m:** ' + fit.refPowerDbm.toFixed(1) + ' dBm');
  L.push('- **RMSE:** ' + fit.rmse.toFixed(1) + ' dB · **R²:** ' + fit.r2.toFixed(3));
  L.push('- **Datasheet model implied:** n = ' + pathLossExponent(basePreset).toFixed(2));
  const drift = fit.n - pathLossExponent(basePreset);
  L.push('- **Environment verdict:** ' + (drift > 0.4 ? 'your environment attenuates FASTER than the datasheet assumption (clutter/foliage/antenna height).' :
    drift < -0.4 ? 'your environment attenuates SLOWER than the datasheet assumption (open ground / elevation).'
      : 'close to the datasheet assumption — the stock preset is already honest here.'));
  L.push('');
  const cal = calibratePreset(fit, basePreset);
  L.push('## Calibrated preset');
  L.push('- **Rated LOS range (re-derived):** ' + fmtDist(cal.rangeLosM) +
    ' (was ' + fmtDist(basePreset.rangeLosM) + ')');
  L.push('- Save the preset JSON next to this report; load it into a scenario to plan with your own numbers.');
  L.push('');
  L.push('## Residuals by distance band');
  L.push('');
  L.push('| Distance | Samples | Mean measured | Model (fitted) | Bias |');
  L.push('|---|---|---|---|---|');
  const bands = {};
  for (const s of samples) {
    const dec = Math.floor(Math.log10(Math.max(1, s.dM)));
    (bands[dec] = bands[dec] || []).push(s);
  }
  for (const dec of Object.keys(bands).sort()) {
    const g = bands[dec];
    const meanMeas = g.reduce((a, s) => a + s.rssiDbm, 0) / g.length;
    const meanD = Math.pow(10, g.reduce((a, s) => a + Math.log10(s.dM), 0) / g.length);
    const model = fit.refPowerDbm - 10 * fit.n * Math.log10(meanD);
    L.push('| ' + fmtDist(Math.pow(10, dec)) + '–' + fmtDist(Math.pow(10, +dec + 1)) +
      ' | ' + g.length + ' | ' + meanMeas.toFixed(1) + ' dBm | ' + model.toFixed(1) + ' dBm | ' +
      (meanMeas - model >= 0 ? '+' : '') + (meanMeas - model).toFixed(1) + ' dB |');
  }
  L.push('');
  L.push('_The simulator stays planning-grade, not certification-grade: the fitted exponent absorbs ground reflection, Fresnel loss and antenna reality for THIS setup only._');
  return L.join('\n');
}

// UMD-lite export so the pipeline is unit-testable under Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseFlightLogCsv, fitPathLoss, calibratePreset, validationReportMd, CAL_ALIASES,
  };
}

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
// power at 1 m) and n directly, with RMSE and R² to say how honest the fit is.
//
// Convention: the calibrated preset keeps the datasheet txDbm and antGainDbi
// as the hardware's own figures; the residual of A against them is treated
// as CHANNEL loss, shared by every emitter on that channel — jammers included
// (radios.js refLossDb). If the offset is really reduced TX power or cable
// loss on your own radio, edit txDbm in the saved preset instead.
//
// Censoring: radios only log RSSI for packets they RECEIVE, so near the edge
// of range the weak tail is missing. Fitting only what was received biases n
// low and the re-derived range optimistic (~15% in a synthetic n=3 test flown
// to 1.3x range). So a row with a distance but a blank (or 'lost') RSSI is a
// lost packet, not junk: the fit treats it as left-censored below the radio's
// sensitivity (Tobit likelihood, solved by EM), with a small distance-blind
// loss rate fitted alongside so collisions at short range don't read as a
// weak link. A log that drops lost packets entirely can't be corrected —
// fit it only on distances where reception is still reliable.

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
//   (a unit suffix is fine: distance_m, 'Distance (m)', 'RSSI (dBm)'; cells may be quoted)
//   optional position instead of distance: x|east, y|north[, z] — origin = first row
//   optional time: t | time | timestamp
const CAL_ALIASES = {
  dist: ['dist', 'distance', 'd', 'range'],
  rssi: ['rssi', 'rssi_dbm', 'rssidbm', 'rssi_value', 'rssivalue', 'signal', 'dbm', 'signal_strength'],
  x: ['x', 'e', 'east'], y: ['y', 'n', 'north'],
  z: ['z', 'alt', 'altitude', 'up'],
};

// Headers may carry units: 'distance_m', 'Distance (m)', 'RSSI (dBm)'.
// Match the bare name first, then with a trailing unit suffix stripped.
function findCol(header, aliases) {
  const h = header.map(s => s.trim().replace(/^"|"$/g, '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z_]/g, '').replace(/_+$/, ''));
  const bare = h.map(s => s.replace(/_?(m|dbm|meters?|metres?)$/, ''));
  for (const names of [h, bare]) {
    for (const a of aliases) {
      const i = names.indexOf(a);
      if (i >= 0) return i;
    }
  }
  return -1;
}

// A numeric cell, optionally quoted and optionally suffixed with its own
// unit (m / dBm). Any other suffix ('1.5 km') is NaN, never a truncation.
const CAL_CELL_RE = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(m|dbm)?$/i;

// An RSSI cell that means "nothing was received", not a malformed number.
const CAL_LOST_RE = /^(|lost|nan|n\/?a|null|none|-)$/i;

// Returns { samples: [{dM, rssiDbm}], lost: [{dM}], dropped, notes: [] } —
// never throws on messy data; it skips junk rows and says what it skipped.
// `lost` holds rows with a distance but no RSSI: packets that never arrived.
function parseFlightLogCsv(text) {
  const out = { samples: [], lost: [], dropped: 0, notes: [] };
  if (!text || !text.trim()) { out.notes.push('empty file'); return out; }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!lines.length) { out.notes.push('no data rows'); return out; }
  const header = lines[0].split(',').map(s => s.trim());
  const iD = findCol(header, CAL_ALIASES.dist);
  const iR = findCol(header, CAL_ALIASES.rssi);
  const iX = findCol(header, CAL_ALIASES.x);
  const iY = findCol(header, CAL_ALIASES.y);
  let iZ = findCol(header, ['z', 'alt', 'altitude']);
  const hasPos = iR >= 0 && iX >= 0 && iY >= 0;
  if (iD < 0 && !hasPos) { out.notes.push('need a distance column (dist/d/range) or x,y columns'); return out; }
  if (iR < 0) { out.notes.push('need an RSSI column (rssi/dbm/signal)'); return out; }
  if (hasPos && iZ < 0) iZ = -1;

  const UNIT_NOTE = 'dropped cells with an unknown unit (e.g. "1.5 km") — give distances in metres and RSSI in dBm';
  let ox = null, oy = null, oz = null;
  for (let li = 1; li < lines.length; li++) {
    const cells = lines[li].split(',').map(s => s.trim().replace(/^"(.*)"$/, '$1').trim());
    const num = i => {
      if (i < 0 || i >= cells.length) return NaN;
      const m = CAL_CELL_RE.exec(cells[i]);
      if (m) return parseFloat(m[1]);
      if (/^[-+]?[\d.]/.test(cells[i]) && !out.notes.includes(UNIT_NOTE)) out.notes.push(UNIT_NOTE);
      return NaN;
    };
    let dM = num(iD);
    if (hasPos) {
      const x = num(iX), y = num(iY);
      if (!isFinite(x) || !isFinite(y)) { out.dropped++; continue; }
      if (ox === null) {
        ox = x; oy = y; oz = iZ >= 0 ? num(iZ) : 0;
        if (!isFinite(oz)) oz = 0;
        continue; // first row is the origin, not a sample
      }
      const vz = iZ >= 0 ? num(iZ) : null;
      const dz = (vz !== null && isFinite(vz)) ? vz : oz;
      dM = Math.hypot(x - ox, y - oy, (iZ >= 0 ? dz : 0) - oz);
    }
    const rssi = num(iR);
    if (!isFinite(dM) || !isFinite(rssi)) {
      if (isFinite(dM) && dM >= 1 && CAL_LOST_RE.test(iR < cells.length ? cells[iR] : '')) out.lost.push({ dM });
      else out.dropped++;
      continue;
    }
    if (dM < 1) { out.dropped++; if (!out.notes.includes('dropped samples inside the 1 m noise floor')) out.notes.push('dropped samples inside the 1 m noise floor'); continue; }
    out.samples.push({ dM, rssiDbm: rssi });
  }
  // Received power in dBm is negative; a positive median means device-scale
  // RSSI (SiK/MAVLink RADIO_STATUS is 0..254), which would fit as nonsense.
  if (out.samples.length) {
    const sorted = out.samples.map(s => s.rssiDbm).sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    if (med > 0) {
      out.notes.push('RSSI median is +' + med.toFixed(0) + ' — looks like device units (e.g. MAVLink RADIO_STATUS ' +
        '0..254), not dBm; convert to dBm first (SiK: dBm ≈ raw/1.9 − 127)');
      out.dropped += out.samples.length + out.lost.length;
      out.samples = [];
      out.lost = [];
    }
  }
  if (!out.samples.length) out.notes.push('no usable samples');
  else if (out.lost.length) {
    out.notes.push(out.lost.length + ' rows with a distance but no RSSI kept as lost packets (fitted as below sensitivity)');
  }
  return out;
}

// --- Least-squares fit ----------------------------------------------------------
// Acceptance gates: the slope is only determined if the distances span enough
// of a decade, and a fit is only a calibration if its 95% CI on n is tight.
const CAL_MIN_SPAN_DECADES = 0.5;
const CAL_MAX_N_CI95 = 0.5;
// The ONE acceptance window for a calibrated preset — main.js's preset
// sanitizer uses these same bounds, so a fit that passes here is never
// silently dropped on registration or scenario import.
const CAL_N_RANGE = [1.2, 6.5];
const CAL_REF_POWER_RANGE = [-120, 40];   // dBm at 1 m

// Two-sided 95% Student-t quantile, Cornish-Fisher expansion in 1/df (within
// ~1% of the table for df >= 3, which is all a 5-sample floor allows).
function t975(df) {
  const z = 1.959963985, z3 = z * z * z, z5 = z3 * z * z, z7 = z5 * z * z;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df * df) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df * df * df);
}

// Standard normal lower tail at a: log Φ(a) and the inverse Mills ratio
// φ(a)/Φ(a). Numerical Recipes' erfc (fractional error < 1.2e-7 everywhere),
// rearranged so neither underflows deep in the tail, where Φ itself is 0.
function calNormLowerTail(a) {
  const z = Math.abs(a) / Math.SQRT2, t = 1 / (1 + 0.5 * z);
  const p = -1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  // erfc(z) = t·exp(−z² + p) and Φ(a) = erfc(−a/√2) / 2.
  if (a < 0) return { logPhi: Math.log(0.5 * t) - z * z + p, mills: 2 * Math.exp(-p) / (Math.sqrt(2 * Math.PI) * t) };
  const phi = 1 - 0.5 * t * Math.exp(-z * z + p);
  return { logPhi: Math.log(phi), mills: Math.exp(-z * z) / (Math.sqrt(2 * Math.PI) * phi) };
}

// Censored (Tobit) maximum likelihood for RSSI = a + b·x + N(0, s²), x =
// log10(d), when a lost row only says "RSSI was below floorDbm" — mixed with
// a distance-blind loss rate eps (collisions, interference), so one packet
// lost at 20 m isn't imputed as a reading at the sensitivity floor there.
// EM: impute each lost row's expected RSSI under the truncated normal, refit
// by weighted least squares, repeat from the received-only line. The CI on b
// comes from the observed information (numerical Hessian of the likelihood).
function fitCensoredLine(obs, lostX, floorDbm, a0, b0) {
  const nObs = obs.length, nAll = nObs + lostX.length;
  let a = a0, b = b0, eps = 0.05, ss0 = 0;
  for (const o of obs) ss0 += (o.y - a - b * o.x) * (o.y - a - b * o.x);
  let s = Math.max(0.5, Math.sqrt(ss0 / nObs));
  const w = new Array(lostX.length), ey = new Array(lostX.length), vy = new Array(lostX.length);
  for (let it = 0; it < 2000; it++) {
    let sw = nObs, swx = 0, swy = 0, rand = 0;
    for (const o of obs) { swx += o.x; swy += o.y; }
    for (let i = 0; i < lostX.length; i++) {
      const mu = a + b * lostX[i], al = (floorDbm - mu) / s;
      const tail = calNormLowerTail(al);
      const pSig = (1 - eps) * Math.exp(tail.logPhi);
      w[i] = eps + pSig > 0 ? pSig / (eps + pSig) : 1;  // P(lost to weak signal | lost)
      ey[i] = mu - s * tail.mills;
      vy[i] = s * s * Math.max(0, 1 - al * tail.mills - tail.mills * tail.mills);
      sw += w[i]; swx += w[i] * lostX[i]; swy += w[i] * ey[i]; rand += 1 - w[i];
    }
    const xm = swx / sw, ym = swy / sw;
    let sxx = 0, sxy = 0;
    for (const o of obs) { sxx += (o.x - xm) * (o.x - xm); sxy += (o.x - xm) * (o.y - ym); }
    for (let i = 0; i < lostX.length; i++) {
      const dx = lostX[i] - xm;
      sxx += w[i] * dx * dx; sxy += w[i] * dx * (ey[i] - ym);
    }
    const bN = sxy / sxx, aN = ym - bN * xm;
    let ss = 0;
    for (const o of obs) ss += (o.y - aN - bN * o.x) * (o.y - aN - bN * o.x);
    for (let i = 0; i < lostX.length; i++) {
      const r = ey[i] - aN - bN * lostX[i];
      ss += w[i] * (r * r + vy[i]);
    }
    const sN = Math.sqrt(ss / sw), epsN = rand / nAll;
    const done = Math.abs(aN - a) < 1e-7 && Math.abs(bN - b) < 1e-7 && Math.abs(sN - s) < 1e-7 && Math.abs(epsN - eps) < 1e-7;
    a = aN; b = bN; s = sN; eps = epsN;
    if (done) break;
  }
  const logEps = eps > 0 ? Math.log(eps) : -Infinity, log1mEps = Math.log(1 - eps);
  const ll = (aa, bb, ls) => {
    const sd = Math.exp(ls);
    let L = 0;
    for (const o of obs) { const r = (o.y - aa - bb * o.x) / sd; L -= ls + 0.5 * r * r; }
    for (const x of lostX) {
      const lq = log1mEps + calNormLowerTail((floorDbm - aa - bb * x) / sd).logPhi;
      const m = Math.max(logEps, lq);
      L += m + Math.log(Math.exp(logEps - m) + Math.exp(lq - m));
    }
    return L;
  };
  const p = [a, b, Math.log(s)], h = [1e-2, 1e-2, 1e-3];
  const at = (i, di, j, dj) => { const q = p.slice(); q[i] += di; q[j] += dj; return ll(q[0], q[1], q[2]); };
  const I = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];      // observed information = −Hessian
  const l0 = ll(p[0], p[1], p[2]);
  for (let i = 0; i < 3; i++) {
    I[i][i] = -(at(i, h[i], i, 0) - 2 * l0 + at(i, -h[i], i, 0)) / (h[i] * h[i]);
    for (let j = i + 1; j < 3; j++) {
      I[i][j] = I[j][i] = -(at(i, h[i], j, h[j]) - at(i, h[i], j, -h[j]) - at(i, -h[i], j, h[j]) +
        at(i, -h[i], j, -h[j])) / (4 * h[i] * h[j]);
    }
  }
  const det = I[0][0] * (I[1][1] * I[2][2] - I[1][2] * I[2][1]) - I[0][1] * (I[1][0] * I[2][2] - I[1][2] * I[2][0]) +
    I[0][2] * (I[1][0] * I[2][1] - I[1][1] * I[2][0]);
  const varB = (I[0][0] * I[2][2] - I[0][2] * I[2][0]) / det;
  const nCi95 = varB > 0 && isFinite(varB) ? t975(nAll - 3) * Math.sqrt(varB) / 10 : Infinity;
  return { intercept: a, slope: b, sigma: s, randomLossFrac: eps, nCi95 };
}

// Minimise squared error of RSSI over log10(distance). Centred sums: the raw
// n·Σx² − (Σx)² form cancels to a nonzero residue at large N, which once let
// 1000 samples logged at ONE distance pass as a fit. With censor = { lost:
// [{dM}], floorDbm } (lost packets and the radio's sensitivity), the line is
// the censored fit above instead, so the missing weak tail doesn't flatten it.
function fitPathLoss(samples, censor) {
  const n = samples.length;
  if (n < 5) return { ok: false, reason: 'need at least 5 samples, got ' + n };
  let sx = 0, sy = 0, xMin = Infinity, xMax = -Infinity;
  for (const s of samples) {
    const x = Math.log10(Math.max(1, s.dM));
    sx += x; sy += s.rssiDbm;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
  }
  const xBar = sx / n, meanY = sy / n;
  let sxx = 0, sxy = 0;
  for (const s of samples) {
    const dx = Math.log10(Math.max(1, s.dM)) - xBar;
    sxx += dx * dx; sxy += dx * (s.rssiDbm - meanY);
  }
  if (!(xMax > xMin) || sxx <= 1e-12 * n) return { ok: false, reason: 'degenerate spread — all samples at the same distance?' };
  const span = xMax - xMin;
  if (span < CAL_MIN_SPAN_DECADES) {
    return { ok: false, reason: 'distance span too narrow (' + span.toFixed(2) + ' decade, need ' +
      CAL_MIN_SPAN_DECADES + ') — exponent not determined; log from near to far' };
  }
  let slope = sxy / sxx;                            // dB per decade
  let intercept = meanY - slope * xBar;             // RSSI at d = 1 m
  const lost = censor && isFinite(censor.floorDbm) ? (censor.lost || []).filter(l => isFinite(l.dM) && l.dM >= 1) : [];
  let cens = null;
  if (lost.length) {
    cens = fitCensoredLine(samples.map(s => ({ x: Math.log10(Math.max(1, s.dM)), y: s.rssiDbm })),
      lost.map(l => Math.log10(l.dM)), censor.floorDbm, intercept, slope);
    slope = cens.slope; intercept = cens.intercept;
  }
  const expN = -slope / 10;
  if (!(intercept <= CAL_REF_POWER_RANGE[1])) {
    return { ok: false, reason: 'fitted reference power ' + intercept.toFixed(0) + ' dBm at 1 m is not physical — ' +
      'the RSSI column is probably in device units (e.g. MAVLink RADIO_STATUS 0..254), not dBm' };
  }
  if (!(intercept >= CAL_REF_POWER_RANGE[0])) {
    return { ok: false, reason: 'fitted reference power ' + intercept.toFixed(0) + ' dBm at 1 m is below ' +
      CAL_REF_POWER_RANGE[0] + ' dBm — check the RSSI units and the distance column' };
  }
  if (!(expN >= CAL_N_RANGE[0]) || !(expN <= CAL_N_RANGE[1])) {
    return { ok: false, reason: 'fitted exponent n=' + expN.toFixed(2) + ' outside physical range (' +
      CAL_N_RANGE[0] + '..' + CAL_N_RANGE[1] + ')' };
  }
  // goodness of fit
  let ssRes = 0, ssTot = 0;
  for (const s of samples) {
    const pred = intercept + slope * Math.log10(Math.max(1, s.dM));
    ssRes += (s.rssiDbm - pred) * (s.rssiDbm - pred);
  }
  for (const s of samples) ssTot += (s.rssiDbm - meanY) * (s.rssiDbm - meanY);
  const rmse = Math.sqrt(ssRes / n);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;
  // 95% CI half-width on n: SE(slope) = sqrt(ssRes/(N−2)/Sxx), n = −slope/10.
  const nCi95 = cens ? cens.nCi95 : t975(n - 2) * Math.sqrt(ssRes / (n - 2) / sxx) / 10;
  if (!(nCi95 <= CAL_MAX_N_CI95)) {
    return { ok: false, reason: 'exponent not determined: n=' + expN.toFixed(2) + ' ± ' + nCi95.toFixed(2) +
      ' (95% CI wider than ±' + CAL_MAX_N_CI95 + ') — more samples or a wider distance span needed' };
  }
  return { ok: true, n: expN, nCi95, refPowerDbm: intercept, rmse, r2, count: n, spanDecades: span,
    lost: lost.length, floorDbm: cens ? censor.floorDbm : null, randomLossFrac: cens ? cens.randomLossFrac : null };
}

// Derive the calibrated preset numbers: keep the datasheet TX/sensitivity/
// antennas, but re-derive `rangeLosM` so the model's calibrated exponent
// EQUALS the measured one — exactly the tuning step that makes predictions
// match your field data.
function calibratePreset(fit, basePreset) {
  const rangeLosM = Math.pow(10, (fit.refPowerDbm - basePreset.sensDbm) / (10 * fit.n));
  return {
    id: basePreset.id + '-calibrated',
    name: basePreset.name + ' (field-calibrated)',
    freqMHz: basePreset.freqMHz,
    air: basePreset.air,
    txDbm: basePreset.txDbm,
    sensDbm: basePreset.sensDbm,
    antGainDbi: basePreset.antGainDbi,
    airRateKbps: basePreset.airRateKbps,
    // Full precision on purpose: the model-exponent identity below is exact
    // only if this number isn't rounded.
    rangeLosM,
    refPowerDbm: fit.refPowerDbm,
    nFit: fit.n,
    hopGainDb: basePreset.hopGainDb,
    jamSirDb: basePreset.jamSirDb,
    dutyCycle: basePreset.dutyCycle,
    note: 'Calibrated against ' + fit.count + ' field samples: measured path-loss exponent n=' +
      fit.n.toFixed(2) + ' (datasheet model implied ' + pathLossExponent(basePreset).toFixed(2) +
      '), RMSE ' + fit.rmse.toFixed(1) + ' dB, R² ' + fit.r2.toFixed(3) +
      '. Rated LOS range re-derived to ' + fmtDist(rangeLosM) + '.',
    source: basePreset.source,
    calibratedFrom: { nFit: fit.n, nCi95: fit.nCi95, refPowerDbm: fit.refPowerDbm, rmse: fit.rmse, r2: fit.r2, samples: fit.count },
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
  L.push('- **Measured path-loss exponent:** n = ' + fit.n.toFixed(2) +
    (fit.nCi95 != null ? ' ± ' + fit.nCi95.toFixed(2) + ' (95% CI)' : ''));
  L.push('- **Reference power at 1 m:** ' + fit.refPowerDbm.toFixed(1) + ' dBm');
  L.push('- **RMSE:** ' + fit.rmse.toFixed(1) + ' dB · **R²:** ' + fit.r2.toFixed(3));
  if (fit.lost) {
    L.push('- **Lost packets:** ' + fit.lost + ' rows with no RSSI, fitted as censored below the ' + fit.floorDbm +
      ' dBm sensitivity (distance-blind loss rate ' + (fit.randomLossFrac * 100).toFixed(1) + '%)');
  }
  L.push('- **Datasheet model implied:** n = ' + pathLossExponent(basePreset).toFixed(2));
  const drift = fit.n - pathLossExponent(basePreset);
  L.push('- **Exponent drift:** ' + (drift >= 0 ? '+' : '') + drift.toFixed(2) +
    ' (slope only — the intercept matters as much, so the verdict below uses the predicted range)');
  // Verdict on what planning sees: slope AND intercept together, via the
  // re-derived range against the datasheet's rated range.
  const cal = calibratePreset(fit, basePreset);
  const rangeRatio = cal.rangeLosM / basePreset.rangeLosM;
  L.push('- **Environment verdict:** ' + (rangeRatio < 0.8 ? 'your environment attenuates FASTER than the datasheet assumption (clutter/foliage/antenna height) — the link reaches ' +
    Math.round(rangeRatio * 100) + '% of the rated range.' :
    rangeRatio > 1.25 ? 'your environment attenuates SLOWER than the datasheet assumption (open ground / elevation) — the link reaches ' +
      Math.round(rangeRatio * 100) + '% of the rated range.'
      : 'close to the datasheet assumption — the stock preset is already honest here.'));
  L.push('');
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
    CAL_N_RANGE, CAL_REF_POWER_RANGE,
  };
}

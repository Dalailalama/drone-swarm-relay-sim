// Batch statistics — the aggregation layer behind Monte Carlo mission runs.
// Pure functions: feed them per-run rows, get confidence-report numbers out.

function mean(xs) {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdev(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) * (x - m);
  return Math.sqrt(ss / (n - 1));
}

// Linear-interpolation percentile on a sorted copy (p in 0..100).
function percentile(xs, p) {
  if (!xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Two-sided 95% Student-t critical value t(0.975, df). Exact table to df 30,
// then 1.96 + 2.4/df (within 0.003 of the table at df 40, 60 and 120).
const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
function tCrit975(df) {
  if (!(df >= 1)) return NaN;
  return df < T975.length ? T975[Math.floor(df)] : 1.96 + 2.4 / df;
}

// 95% confidence interval on the MEAN over n seeds: mean ± t·sd/√n. A run
// count of 3 gives ±2.48 sd, not the ±1 sd a bare "±" suggests; one run has
// no interval at all.
function ci95(xs) {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs), h = tCrit975(n - 1) * stdev(xs) / Math.sqrt(n);
  return { lo: m - h, hi: m + h };
}

// Below this many runs a sample p05/p95 cannot estimate the tails (at n = 5
// the sample p95 falls under the true p95 most of the time), so the report
// prints the observed min/max instead.
const TAIL_MIN_N = 20;

// Group rows by a key and summarize the metrics that matter to a buyer:
// link uptime distribution, packet loss, payload delivery, contact.
// Metric names are optional per row; missing ones come back as null fields.
function summarizeGroups(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [key, rs] of groups) {
    const pick = f => rs.map(r => (typeof r[f] === 'number' && isFinite(r[f]) ? r[f] : null)).filter(v => v !== null);
    const stat = f => {
      const xs = pick(f);
      return xs.length ? {
        n: xs.length,
        mean: mean(xs),
        sd: stdev(xs),
        ci95: ci95(xs),
        p05: percentile(xs, 5),
        p95: percentile(xs, 95),
        min: Math.min(...xs),
        max: Math.max(...xs),
      } : null;
    };
    out.push({ cell: key, runs: rs.length, uptime: stat('uptimePct'), dropped: stat('droppedPct'), vidLoss: stat('vidLossPct'), freshFrac: stat('freshFrac'), maxNavErrM: stat('maxNavErrM') });
  }
  // stable order: insertion
  return out;
}

// scale lets a 0..1 fraction print as a percentage like the other columns.
// Every cell says its own n: a metric can be missing from some runs.
function fmtStat(st, digits, suffix, scale) {
  if (!st) return '—';
  const k = scale || 1;
  const f = v => (k * v).toFixed(digits);
  if (st.n < 2 || !st.ci95) return f(st.mean) + suffix + ' (n=' + st.n + ', no interval)';
  const tails = st.n >= TAIL_MIN_N
    ? 'p05 ' + f(st.p05) + ', p95 ' + f(st.p95)
    : 'min ' + f(st.min) + ', max ' + f(st.max);
  // A percentage cannot leave 0..100 however wide the interval is.
  const clip = v => (suffix === '%' ? Math.min(100 / k, Math.max(0, v)) : v);
  return f(st.mean) + suffix + ' [95% CI ' + f(clip(st.ci95.lo)) + ', ' + f(clip(st.ci95.hi)) + '] (n=' + st.n + ', ' + tails + ')';
}

// Markdown confidence report over summarized groups.
function reportMd(label, summary, metaLines) {
  const L = [];
  L.push('# Monte Carlo batch report — ' + label);
  L.push('');
  L.push('_' + summary.reduce((a, g) => a + g.runs, 0) + ' seeded simulation runs. Numbers are distributions across seeds, not single flights. Simulation results, not flight-test data._');
  L.push('');
  for (const line of metaLines || []) L.push('- ' + line);
  L.push('');
  L.push('| Cell | Runs | Link uptime | Packet drop | Video chunk loss | C2 contact |');
  L.push('|---|---|---|---|---|---|');
  for (const g of summary) {
    L.push('| ' + String(g.cell).replace(/\|/g, '\\|') + ' | ' + g.runs + ' | ' + fmtStat(g.uptime, 1, '%') +
      ' | ' + fmtStat(g.dropped, 1, '%') + ' | ' + fmtStat(g.vidLoss, 1, '%') +
      ' | ' + fmtStat(g.freshFrac, 1, '%', 100) + ' |');
  }
  L.push('');
  L.push('_uptime = share of the mission with an end-to-end route from C2 to the objective area._');
  const anyTails = summary.some(g => ['uptime', 'dropped', 'vidLoss', 'freshFrac'].some(f => g[f] && g[f].n >= TAIL_MIN_N));
  L.push('_Each cell: mean [95% CI on the mean, Student t over its n runs]; ' +
    (anyTails ? 'sample 5th/95th percentiles where n >= ' + TAIL_MIN_N + ', ' : '') +
    'observed min/max below ' + TAIL_MIN_N + ' runs, where a sample cannot estimate the tails._');
  return L.join('\n');
}

function escapeCsvField(val) {
  if (val == null) return '';
  if (typeof val === 'number') return String(Math.round(val * 1000) / 1000);
  let s = String(val);
  // Spreadsheets evaluate a text cell starting with = + - @ tab or CR even
  // inside RFC 4180 quotes (CWE-1236); a leading ' makes it plain text.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const CSV_COLUMNS = ['cell', 'seed', 'uptimePct', 'freshFrac', 'delivered', 'droppedPct', 'vidLossPct', 'maxNavErrM'];
function toCsv(rows) {
  const head = CSV_COLUMNS.join(',');
  const lines = rows.map(r => CSV_COLUMNS.map(c => escapeCsvField(r[c])).join(','));
  return [head, ...lines].join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mean, stdev, percentile, tCrit975, ci95, summarizeGroups, reportMd, toCsv, CSV_COLUMNS };
}

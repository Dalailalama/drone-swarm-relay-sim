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

function fmtStat(st, digits, suffix) {
  if (!st) return '—';
  return st.mean.toFixed(digits) + suffix + ' ±' + st.sd.toFixed(digits) +
    ' (p05 ' + st.p05.toFixed(digits) + ', p95 ' + st.p95.toFixed(digits) + ')';
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
    L.push('| ' + g.cell + ' | ' + g.runs + ' | ' + fmtStat(g.uptime, 1, '%') +
      ' | ' + fmtStat(g.dropped, 1, '%') + ' | ' + fmtStat(g.vidLoss, 1, '%') +
      ' | ' + fmtStat(g.freshFrac, 1, '') + ' |');
  }
  L.push('');
  L.push('_uptime = share of the mission with an end-to-end route from C2 to the objective area._');
  return L.join('\n');
}

// CSV of raw per-run rows (stable column order).
const CSV_COLUMNS = ['cell', 'seed', 'uptimePct', 'freshFrac', 'delivered', 'droppedPct', 'vidLossPct', 'maxNavErrM'];
function toCsv(rows) {
  const head = CSV_COLUMNS.join(',');
  const lines = rows.map(r => CSV_COLUMNS.map(c => {
    const v = r[c];
    return typeof v === 'number' ? (Math.round(v * 1000) / 1000) : (v == null ? '' : v);
  }).join(','));
  return [head, ...lines].join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mean, stdev, percentile, summarizeGroups, reportMd, toCsv, CSV_COLUMNS };
}

#!/usr/bin/env node
// Batch REST API — the metered-cloud-service seed, zero dependencies.
//
//   node tools/server.js [--port 8090] [--host 127.0.0.1]
//
//   GET  /api/health          -> {ok:true}
//   POST /api/batch           -> body: batch config JSON (same schema as
//                                tools/batch.js)  => {summary, md, csv}
//   GET  /api/schema          -> the documented config contract + limits
//
// Every request runs the same runBatch() the CLI uses. Guardrails from
// LIMITS apply (max cells/seeds/duration), so one bad request can't wedge
// the process for an hour.

const http = require('node:http');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { validateConfig, LIMITS, maxBatchWallMs, estimateWallMs } = require('./batch.js');

// Oversize bodies are answered, not hung up on (soak finding R13): the old
// code destroyed the socket mid-upload, so the client saw ECONNRESET instead
// of an error it could act on. Past the cap we stop buffering and just drain
// (memory stays bounded; Node's request timeout bounds the time), then 413.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (tooLarge) return;
      if (size > maxBytes) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) reject(err('request body exceeds ' + maxBytes + ' bytes', 413));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json' });
  res.end(body);
}

// Bounded worker pool (finding #14): the old code spawned one unbounded
// worker per request with no queue, no timeout, no client-disconnect
// cancellation and no exit-without-result handling — a burst of requests
// (or one dead client) could pile CPU-bound threads forever. Now: at most
// `workers` concurrent runs, a bounded wait queue (overflow answers 429), a
// hard per-run time budget (504 + terminate), and a client who hangs up
// takes their worker down with them.
// The time budget follows each request's own pace (review). A fixed 5 min sat
// under the ~18 min the largest admissible batch takes at batch.js's rates, and
// one global figure derived from those rates is only as good as the rates,
// which batch.js says are stale (a jammed batch can run an order of magnitude
// slower). So the worker reports progress every few sim-seconds and the server
// re-arms the kill timer from it: the budget is TIMEOUT_MARGIN x the batch's
// projected total at the pace it has actually shown, where the absolute rate
// cancels out. Only before the first report does the static per-request
// estimate stand in. The budget is never under FLOOR_MS (the old 5 min, so a
// hang is caught no later than before) nor over CEILING_MS (twice the largest
// batch the validator admits, ~36 min at those rates).
const TIMEOUT_MARGIN = 2;
const FLOOR_MS = 5 * 60 * 1000;
const POOL_DEFAULTS = {
  workers: 2, queue: 8, floorMs: FLOOR_MS,
  ceilingMs: Math.ceil(TIMEOUT_MARGIN * maxBatchWallMs()),
};

// Wall ms a running batch may take in all, counted from when its worker
// started. `fraction` is the share of the batch its worker last reported
// done (0 = nothing yet), `elapsedMs` the wall time so far.
function batchBudgetMs(state, policy) {
  const f = Math.min(1, state.fraction || 0);
  const raw = f > 0
    ? policy.margin * state.elapsedMs / f
    : policy.margin * state.estimateMs;
  // A missing or garbled input must not reach setTimeout (NaN fires at once).
  return Math.min(policy.ceilingMs, Math.max(policy.floorMs, Number.isFinite(raw) ? raw : policy.floorMs));
}

const SPLIT_ADVICE = ' — split it into smaller batches (fewer runs, a shorter duration or a smaller ' +
  'fleet), or run it with tools/batch.js, which has none';

// Which limit tripped, so the 504 tells the client what to change.
function overBudgetMessage(why) {
  if (why.fixedMs != null) return 'batch run exceeded the ' + why.fixedMs + ' ms time budget' + SPLIT_ADVICE;
  if (why.budgetMs >= why.ceilingMs) {
    return 'batch run exceeded the ' + why.ceilingMs + ' ms limit the server gives any batch' + SPLIT_ADVICE;
  }
  if (why.fraction > 0) {
    return 'batch run stopped making progress (' + Math.round(why.fraction * 100) + '% done after ' +
      why.elapsedMs + ' ms)' + SPLIT_ADVICE;
  }
  return 'batch run reported no progress within ' + why.budgetMs + ' ms' + SPLIT_ADVICE;
}

function makePool(opts, stats) {
  const workers = opts.workers != null ? opts.workers : POOL_DEFAULTS.workers;
  const queueMax = opts.queue != null ? opts.queue : POOL_DEFAULTS.queue;
  // An explicit timeoutMs is one fixed hard budget for every batch (progress is
  // ignored); otherwise the budget follows each batch's pace within [floor, ceiling].
  const fixedMs = opts.timeoutMs != null ? opts.timeoutMs : null;
  const ceilingMs = fixedMs != null ? fixedMs : (opts.ceilingMs != null ? opts.ceilingMs : POOL_DEFAULTS.ceilingMs);
  const policy = {
    margin: TIMEOUT_MARGIN,
    floorMs: Math.min(ceilingMs, opts.floorMs != null ? opts.floorMs : POOL_DEFAULTS.floorMs),
    ceilingMs,
  };
  const batchPath = path.resolve(opts.workerBatchPath || path.join(__dirname, 'batch.js')).replace(/\\/g, '/');
  const workerScript = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { runBatch } = require('${batchPath}');
    try {
      const result = runBatch(workerData, null, f => parentPort.postMessage({ progress: f }));
      parentPort.postMessage({ ok: true, result });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: err.message });
    }
  `;
  let active = 0;
  const waiting = [];

  function pump() {
    while (active < workers && waiting.length) {
      const job = waiting.shift();
      if (job.cancelled) continue;
      active++;
      stats.active = active;
      stats.peak = Math.max(stats.peak, active);
      start(job).finally(() => { active--; stats.active = active; pump(); });
    }
  }

  function start(job) {
    return new Promise(done => {
      const worker = new Worker(workerScript, { eval: true, workerData: job.cfg });
      const startedAt = Date.now();
      let settled = false;
      let fraction = 0, budgetMs = 0, killTimer = null;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        fn(arg);
        done();
      };
      const expire = () => {
        stats.timedOut++;
        worker.terminate();
        finish(job.reject, err(overBudgetMessage({
          fixedMs, budgetMs, ceilingMs, fraction, elapsedMs: Date.now() - startedAt,
        }), 504));
      };
      // (Re)arm the kill timer for the budget the batch's pace allows right now.
      const arm = () => {
        const elapsedMs = Date.now() - startedAt;
        budgetMs = fixedMs != null ? fixedMs
          : batchBudgetMs({ estimateMs: job.estimateMs, elapsedMs, fraction }, policy);
        clearTimeout(killTimer);
        killTimer = setTimeout(expire, Math.max(0, startedAt + budgetMs - Date.now()));
      };
      arm();
      job.cancel = () => {
        stats.terminated++;
        worker.terminate();
        finish(job.reject, err('client disconnected', 499));
      };
      worker.on('message', msg => {
        if (msg && typeof msg.progress === 'number') {
          // A pace report: only the pace-following budget reads it.
          if (!settled && fixedMs == null && msg.progress > fraction) {
            fraction = Math.min(1, msg.progress);
            arm();
          }
          return;
        }
        if (msg.ok) finish(job.resolve, msg.result);
        else finish(job.reject, err(msg.error, 500));
      });
      worker.on('error', e => finish(job.reject, err(e.message, 500)));
      worker.on('exit', code => {
        // A worker that dies without posting a result is an answer too.
        finish(job.reject, err('worker exited (code ' + code + ') without a result', 500));
      });
    });
  }

  return {
    timeoutMs: ceilingMs,
    submit(cfg, req, res) {
      return new Promise((resolve, reject) => {
        if (active >= workers && waiting.length >= queueMax) {
          reject(err('server busy — ' + active + ' running, queue full', 429));
          return;
        }
        let finished = false;
        const job = {
          cfg, estimateMs: estimateWallMs(cfg), cancelled: false, cancel: null,
          resolve: v => { finished = true; resolve(v); },
          reject: e => { finished = true; reject(e); },
        };
        // A client that hangs up takes its work with it — queued or running.
        // The RESPONSE's close is the premature-termination signal; the
        // request stream also "closes" on normal completion.
        res.on('close', () => {
          if (finished || res.writableEnded) return;
          job.cancelled = true;
          if (job.cancel) job.cancel();
        });
        waiting.push(job);
        pump();
      });
    },
  };
}

function err(msg, code) {
  const e = new Error(msg);
  e.httpCode = code;
  return e;
}

function createApp(opts) {
  const stats = { active: 0, peak: 0, timedOut: 0, terminated: 0 };
  const pool = makePool(opts || {}, stats);
  const allowedOrigins = (opts && opts.allowedOrigins) || [];
  const app = http.createServer(async (req, res) => {
    try {
      // No auth here: a browser page on any site could otherwise POST
      // text/plain without a preflight and burn the workers (CSRF).
      // Browsers always send Origin cross-origin; curl and the CLI do not.
      if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
        return send(res, 403, JSON.stringify({ error: 'cross-origin requests are not allowed' }));
      }
      if (req.method === 'GET' && req.url === '/api/health') {
        return send(res, 200, JSON.stringify({ ok: true, limits: LIMITS }));
      }
      if (req.method === 'GET' && req.url === '/api/schema') {
        return send(res, 200, JSON.stringify({
          POST: '/api/batch',
          body: {
            label: 'string',
            radio: 'rfd900x | sik-v3 | lora868 | doodle-rm | silvus-sc4400 | rajant-es1 | xbee900 | espnow | elrs24',
            env: 'open | suburban | urban',
            airframe: 'micro | q450 | x8',
            terrain: 'flat | rolling | urban | mixed',
            count: 'number of drones',
            altitudeM: 'AGL metres (or sweep it)',
            spacingPct: 'hop spacing %',
            durationSec: 'sim seconds per run (30..' + LIMITS.maxDurationSec + ')',
            seeds: 'array of seed ints (<= ' + LIMITS.maxSeedsPerCell + ')',
            mission: { targetX: 'metres east', targetY: 'metres south' },
            features: 'videoOn/videoKbps(<= ' + LIMITS.maxVideoKbps + ')/spectrumAgility/lpiMode/adversaryMode/hetero/relayWing/.../jammers[]/gpsZones[]',
            sweep: '[{ name, altitudeM?, spacingPct? }, ...] — each cell is a parameter variation',
            note: 'unknown fields are rejected (422); far objectives on short-range radios are budgeted by relay-planning cost',
          },
          response: { summary: 'per-cell uptime/loss/contact distributions', md: 'markdown report', csv: 'raw per-run rows' },
        }, null, 1));
      }
      if (req.method === 'POST' && req.url === '/api/batch') {
        let cfg;
        try {
          cfg = JSON.parse(await readBody(req, 256 * 1024));
        } catch (e) {
          if (e.httpCode === 413) return send(res, 413, JSON.stringify({ error: e.message }));
          return send(res, 400, JSON.stringify({ error: 'bad JSON: ' + e.message }));
        }
        const invalid = validateConfig(cfg);
        if (invalid) return send(res, 422, JSON.stringify({ error: invalid }));
        const t0 = Date.now();
        const result = await pool.submit(cfg, req, res);
        return send(res, 200, JSON.stringify({
          label: cfg.label || '',
          runs: result.rows.length,
          wallMs: Date.now() - t0,
          summary: result.summary,
          md: result.md,
          csv: result.csv,
        }));
      }
      send(res, 404, JSON.stringify({ error: 'not found — try GET /api/schema' }));
    } catch (e) {
      if (e.httpCode === 499 || res.writableEnded || res.destroyed) return; // client already gone
      send(res, e.httpCode || 500, JSON.stringify({ error: e.message }));
    }
  });
  app.batchStats = stats;
  app.batchTimeoutMs = pool.timeoutMs;
  return app;
}

// Loopback by default: there is no auth, so exposing the API beyond this
// machine needs --host plus a reverse proxy that authenticates.
const DEFAULT_HOST = '127.0.0.1';

module.exports = { createApp, DEFAULT_HOST, batchBudgetMs };

// --- CLI ----------------------------------------------------------------------
if (require.main === module) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
  };
  const port = +arg('--port', 8090);
  const host = arg('--host', DEFAULT_HOST);
  const app = createApp();
  app.listen(port, host, () => {
    const a = app.address();
    console.log('[batch-api] listening on ' + a.address + ':' + a.port + '  (POST /api/batch, GET /api/schema)');
  });
}

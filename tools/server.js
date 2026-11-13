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
const { validateConfig, LIMITS, maxBatchWallMs } = require('./batch.js');

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
// The time budget follows the work budgets the validator admits (review): a
// fixed 5 min sat under the ~18 min the largest admissible batch takes at
// batch.js's rates, so an accepted batch could hold a worker for 5 minutes
// and then 504. Twice that estimate leaves room for a slower machine.
const TIMEOUT_MARGIN = 2;
const POOL_DEFAULTS = { workers: 2, queue: 8, timeoutMs: Math.ceil(TIMEOUT_MARGIN * maxBatchWallMs()) };

function makePool(opts, stats) {
  const workers = opts.workers != null ? opts.workers : POOL_DEFAULTS.workers;
  const queueMax = opts.queue != null ? opts.queue : POOL_DEFAULTS.queue;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : POOL_DEFAULTS.timeoutMs;
  const batchPath = path.resolve(__dirname, 'batch.js').replace(/\\/g, '/');
  const workerScript = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { runBatch } = require('${batchPath}');
    try {
      const result = runBatch(workerData);
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
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        fn(arg);
        done();
      };
      const killTimer = setTimeout(() => {
        stats.timedOut++;
        worker.terminate();
        // Past a budget sized for the largest admissible batch, say what to
        // do: this machine runs slower than the limits assume.
        finish(job.reject, err('batch run exceeded the ' + timeoutMs + ' ms time budget — split it into smaller ' +
          'batches (fewer runs, a shorter duration or a smaller fleet), or run it with tools/batch.js, which has none', 504));
      }, timeoutMs);
      job.cancel = () => {
        stats.terminated++;
        worker.terminate();
        finish(job.reject, err('client disconnected', 499));
      };
      worker.on('message', msg => {
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
    timeoutMs,
    submit(cfg, req, res) {
      return new Promise((resolve, reject) => {
        if (active >= workers && waiting.length >= queueMax) {
          reject(err('server busy — ' + active + ' running, queue full', 429));
          return;
        }
        let finished = false;
        const job = {
          cfg, cancelled: false, cancel: null,
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

module.exports = { createApp, DEFAULT_HOST };

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

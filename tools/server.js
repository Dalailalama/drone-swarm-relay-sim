#!/usr/bin/env node
// Batch REST API — the metered-cloud-service seed, zero dependencies.
//
//   node tools/server.js [--port 8090]
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
const { runBatch, validateConfig, LIMITS } = require('./batch.js');

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json' });
  res.end(body);
}

function createApp() {
  return http.createServer(async (req, res) => {
    try {
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
            features: 'videoOn/videoKbps/spectrumAgility/lpiMode/adversaryMode/hetero/relayWing/.../jammers[]/gpsZones[]',
            sweep: '[{ name, altitudeM?, spacingPct? }, ...] — each cell is a parameter variation',
          },
          response: { summary: 'per-cell uptime/loss/contact distributions', md: 'markdown report', csv: 'raw per-run rows' },
        }, null, 1));
      }
      if (req.method === 'POST' && req.url === '/api/batch') {
        let cfg;
        try {
          cfg = JSON.parse(await readBody(req, 256 * 1024));
        } catch (e) {
          return send(res, 400, JSON.stringify({ error: 'bad JSON: ' + e.message }));
        }
        const invalid = validateConfig(cfg);
        if (invalid) return send(res, 422, JSON.stringify({ error: invalid }));
        const t0 = Date.now();
        const result = runBatch(cfg);
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
      send(res, 500, JSON.stringify({ error: e.message }));
    }
  });
}

module.exports = { createApp };

// --- CLI ----------------------------------------------------------------------
if (require.main === module) {
  const port = (() => {
    const i = process.argv.indexOf('--port');
    return i >= 0 && process.argv[i + 1] ? +process.argv[i + 1] : 8090;
  })();
  createApp().listen(port, () => console.log('[batch-api] listening on http://localhost:' + port +
    '  (POST /api/batch, GET /api/schema)'));
}

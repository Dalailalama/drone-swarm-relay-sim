// Headless simulation harness for integration tests.
// Loads the sim's browser-global modules into one shared vm context in the
// same script order index.html uses (minus DOM-only files), then hands back
// the context so tests can call makeSwarm/stepSwarm directly. Deterministic:
// everything is seeded, so assertions can be exact.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');

function loadSim(files) {
  const ctx = vm.createContext({ console, Math, Date, JSON, isFinite, parseFloat, parseInt });
  ctx.globalThis = ctx;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  }
  return ctx;
}

// Everything pure enough to run under Node, in dependency order.
const CORE = [
  'radios.js', 'airframes.js', 'fleet.js', 'net.js', 'terrain.js',
  'swarm.js', 'render.js',
];

function loadCore(extra) {
  return loadSim([...CORE, ...(extra || [])]);
}

module.exports = { loadSim, loadCore };

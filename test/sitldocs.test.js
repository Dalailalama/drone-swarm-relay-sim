// Audit (sitl-readme-stale): sitl/README.md still described the issue #12
// bug (READY "above 1 m"), an AGL wire altitude, a protocol table without
// service/service_ack/origin, and listed half of the files in sitl/.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SITL = path.join(__dirname, '..', 'sitl');
const readme = fs.readFileSync(path.join(SITL, 'README.md'), 'utf8');

test('sitl/README.md mentions every script and suite in sitl/', () => {
  const missing = fs.readdirSync(SITL).filter(f => /\.(py|sh)$/.test(f) && !readme.includes(f));
  assert.deepStrictEqual(missing, [], 'not documented in sitl/README.md: ' + missing.join(', '));
});

test('sitl/README.md states the takeoff-altitude READY rule and the origin-relative datum', () => {
  assert.ok(!/above 1 m/.test(readme), 'README still says READY once "above 1 m" (the #12 bug)');
  assert.ok(/within 1 m of the takeoff altitude/.test(readme), 'READY rule (takeoff_alt - 1 m) not stated');
  assert.ok(!/height\s+above ground in metres/.test(readme), 'wire alt is origin-relative, not AGL');
  assert.ok(readme.includes('docs/PROTOCOL.md'), 'the wire protocol must point at docs/PROTOCOL.md');
});

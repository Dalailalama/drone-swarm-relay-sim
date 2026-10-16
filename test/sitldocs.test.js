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

// Audit (bridge-doc-fact-errors): bridge.py said GUIDED is requested with the
// legacy SET_MODE message (pymavlink's set_mode() sends COMMAND_LONG
// MAV_CMD_DO_SET_MODE), that it subtracts the origin from telemetry (the
// browser applies it), and both it and run_ardupilot_sitl.sh described a
// MAVProxy --out link the launcher does not use (--serial0=udpclient).
test('bridge.py and run_ardupilot_sitl.sh describe what the code does', () => {
  const bridge = fs.readFileSync(path.join(SITL, 'bridge.py'), 'utf8');
  const launcher = fs.readFileSync(path.join(SITL, 'run_ardupilot_sitl.sh'), 'utf8');
  assert.ok(!/via the legacy (MAVLink )?SET_MODE|legacy-message approach/.test(bridge), 'set_mode() sends MAV_CMD_DO_SET_MODE, not SET_MODE');
  assert.ok(!/minus origin XY/.test(bridge), 'the bridge does not subtract the origin; the browser applies it');
  for (const [name, text] of [['bridge.py', bridge], ['run_ardupilot_sitl.sh', launcher]]) {
    assert.ok(!/--out=udp/.test(text), name + ' describes a MAVProxy --out link; the launcher uses --serial0=udpclient');
  }
});

// Review (sitl-gcs-failsafe-off): the bridge sends each vehicle a 1 Hz GCS
// heartbeat so ArduCopter's GCS-loss failsafe can catch a dead bridge, but
// run_ardupilot_sitl.sh never enabled that failsafe (FS_GCS_ENABLE defaults
// to 0), so a crashed bridge left every vehicle flying its last setpoint.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const launcher = fs.readFileSync(path.join(__dirname, '..', 'sitl', 'run_ardupilot_sitl.sh'), 'utf8');
// Shell lines without comments, backslash continuations joined.
const code = launcher.replace(/\\\r?\n/g, ' ').split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');

test('run_ardupilot_sitl.sh starts every instance with the GCS-loss failsafe on RTL, overridable by env var', () => {
  assert.match(code, /^FS_GCS_ENABLE="\$\{FS_GCS_ENABLE:-1\}"$/m, 'FS_GCS_ENABLE must default to 1 (RTL) and honour the environment');
  const write = code.match(/^\s*(?:echo|printf)\s+"FS_GCS_ENABLE[ ,]\$\{?FS_GCS_ENABLE\}?(?:\\n)?"\s*>\s*"\$(\w+)"\s*$/m);
  assert.ok(write, 'the launcher must write FS_GCS_ENABLE into an ArduPilot parameter file');
  const launch = code.split('\n').find(l => /"\$SIM_VEHICLE"\s+-v\s+ArduCopter\b/.test(l));
  assert.ok(launch, 'sim_vehicle.py invocation not found');
  assert.ok(launch.includes('--add-param-file="$' + write[1] + '"'),
    'every sim_vehicle.py instance must load that file with --add-param-file: ' + launch);
  assert.match(launcher, /FS_GCS_ENABLE\D[^\n]*\bRTL\b/, 'the comments must say the default failsafe action is RTL');
});

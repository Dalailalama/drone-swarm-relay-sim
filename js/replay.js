// Mission replay engine — reproduce missions from timestamped capture files.
//
// A capture (.jsonl) exported with Packet Capture contains:
//   Line 1: meta event { seed, settings, userActions, ... }
//   Lines 2+: network and state packet trace
//
// replayMission() boots an identical simulation using the recorded seed and
// configuration, steps physics and network at canonical SIM_DT_SEC, dispatches
// recorded user actions at their exact timestamps, and reproduces the mission
// with deterministic parity.

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./swarm.js'),
      require('./radios.js'),
      require('./airframes.js'),
      require('./terrain.js')
    );
  } else {
    root.Replay = factory(root, root, root, root);
    root.replayMission = root.Replay.replayMission;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SwarmMod, RadiosMod, AirframesMod, TerrainMod) {
  'use strict';

  const SIM_DT_SEC = SwarmMod.SIM_DT_SEC || 0.05;

  function parseCapture(input) {
    if (Array.isArray(input)) return input;
    if (typeof input === 'string') {
      return input.trim().split(/\r?\n/).map(line => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);
    }
    return [];
  }

  function applyReplayAction(s, act, core) {
    if (!act || !act.type) return;
    if (act.type === 'kill') {
      const d = s.drones.find(x => x.id === act.id);
      const killFn = (core && core.killDrone) || SwarmMod.killDrone || (typeof killDrone === 'function' ? killDrone : null);
      if (d && killFn) {
        killFn(s, d);
      } else if (d) {
        d.mode = 'dead';
        d.vx = d.vy = 0;
      }
    } else if (act.type === 'target') {
      s.target.x = act.x;
      s.target.y = act.y;
    } else if (act.type === 'base') {
      s.base.x = act.x;
      s.base.y = act.y;
    } else if (act.type === 'jammer_add' && act.jammer) {
      if (!s.jammers) s.jammers = [];
      s.jammers.push({ ...act.jammer });
    } else if (act.type === 'jammer_move') {
      const j = s.jammers && s.jammers.find(x => x.id === act.id);
      if (j) { j.x = act.x; j.y = act.y; }
    } else if (act.type === 'jammer_toggle') {
      const j = s.jammers && s.jammers.find(x => x.id === act.id);
      if (j) { j.on = act.on; }
    } else if (act.type === 'zone_add' && act.zone) {
      if (!s.gpsZones) s.gpsZones = [];
      s.gpsZones.push({ ...act.zone });
    } else if (act.type === 'zone_move') {
      const z = s.gpsZones && s.gpsZones.find(x => x.id === act.id);
      if (z) { z.x = act.x; z.y = act.y; }
    } else if (act.type === 'zone_toggle') {
      const z = s.gpsZones && s.gpsZones.find(x => x.id === act.id);
      if (z) { z.on = act.on; }
    } else if (act.type === 'jammer_power') {
      const j = s.jammers && s.jammers.find(x => x.id === act.id);
      if (j) { j.erpDbm = act.erpDbm; }
    } else if (act.type === 'jammer_remove') {
      s.jammers = (s.jammers || []).filter(x => x.id !== act.id);
    } else if (act.type === 'jammer_clear') {
      s.jammers = [];
    } else if (act.type === 'zone_remove') {
      s.gpsZones = (s.gpsZones || []).filter(x => x.id !== act.id);
    } else if (act.type === 'wind') {
      s.wind.x = act.x;
      s.wind.y = act.y;
    } else if (act.type === 'set' && REPLAY_SETTABLE.has(act.key)) {
      s[act.key] = act.value; // whitelisted: a capture file cannot write arbitrary swarm fields
    } else if (act.type === 'env') {
      s.envFactor = act.envFactor;
      s.shadowSigmaDb = act.shadowSigmaDb;
    } else if (act.type === 'terrain' && act.gen) {
      const mk = (core && core.makeTerrain) || TerrainMod.makeTerrain || (typeof makeTerrain === 'function' ? makeTerrain : null);
      if (mk) s.terrain = mk(act.name, act.gen);
    }
  }
  // Mission settings the page's controls change mid-run ({type:'set'}).
  const REPLAY_SETTABLE = new Set(['altitudeM', 'deployFrac', 'corridorRouting', 'broadcastC2',
    'spectrumAgility', 'lpiMode', 'videoOn', 'videoKbps', 'adversaryMode']);

  // A replay that advances in slices, so the page can yield between them
  // instead of freezing the tab for the whole mission (audit
  // ui-render/replay-button-blocking-and-invisible). replayMission() below
  // runs one to the end in a single call; the trajectory is identical.
  function startReplay(captureInput, options) {
    const opts = options || {};
    const events = parseCapture(captureInput);
    if (!events.length) throw new Error('Empty or invalid capture input');

    const meta = events.find(e => e.ev === 'meta') || events[0];
    const settings = meta.settings || {};
    const seed = meta.seed != null ? meta.seed : 42;

    // In the page, RadiosMod/AirframesMod are `window`, but radios.js and
    // airframes.js declare RADIOS/AIRFRAMES as top-level `const` — shared
    // across scripts, never window properties (soak finding R15: every
    // in-page replay died on an undefined radio).
    const radios = RadiosMod.RADIOS || (typeof RADIOS !== 'undefined' ? RADIOS : []);
    const airframes = AirframesMod.AIRFRAMES || (typeof AIRFRAMES !== 'undefined' ? AIRFRAMES : []);
    const radio = radios.find(r => r.id === (settings.radio || meta.radio)) || radios[0];
    const airframe = airframes.find(a => a.id === settings.airframe) || airframes[1] || airframes[0];

    const core = opts.core || opts.ctx || (typeof window !== 'undefined' ? window : globalThis);
    const makeTerrainFn = core.makeTerrain || TerrainMod.makeTerrain || (typeof makeTerrain === 'function' ? makeTerrain : null);
    const indexBuildingsFn = core.indexBuildings || TerrainMod.indexBuildings || (typeof indexBuildings === 'function' ? indexBuildings : null);
    let terrain;
    if (settings.terrain === 'custom' && settings.terrainCustom) {
      // A generator-less map (OSM, hand-built) travels as its geometry (R16).
      const c = settings.terrainCustom;
      const t = { seed: c.seed, groundAmpM: c.groundAmpM || 0, groundScaleM: c.groundScaleM || 1, buildings: (c.buildings || []).map(b => ({ ...b })) };
      terrain = t.buildings.length && indexBuildingsFn ? indexBuildingsFn(t) : Object.assign(t, { _maxRoofAlt: t.groundAmpM });
    } else if (makeTerrainFn && settings.terrainGen) {
      terrain = makeTerrainFn(settings.terrain, settings.terrainGen); // the generator's exact inputs (R16)
    } else if (makeTerrainFn) {
      terrain = (!settings.terrain || settings.terrain === 'flat')
        ? makeTerrainFn('flat')
        : makeTerrainFn(settings.terrain, { // legacy capture: best-effort guess
            distM: Math.hypot((settings.target ? settings.target.x : 2000) - (settings.base ? settings.base.x : 0),
                              (settings.target ? settings.target.y : 0) - (settings.base ? settings.base.y : 0)),
            altM: settings.altitudeM || 50,
            seed,
          });
    } else {
      terrain = { type: 'flat', groundAmpM: 0, groundScaleM: 1, buildings: [] };
    }
    const relayAirframe = settings.relayWing > 0 ? airframes.find(a => a.id === settings.relayAirframe) || null : null;
    const relayRadio = settings.relayWing > 0 ? radios.find(r => r.id === settings.relayRadio) || null : null;

    const makeSwarmFn = core.makeSwarm || SwarmMod.makeSwarm || (typeof makeSwarm === 'function' ? makeSwarm : null);
    if (!makeSwarmFn) throw new Error('makeSwarm function not available in environment');

    const stepSwarmFn = core.stepSwarm || SwarmMod.stepSwarm || (typeof stepSwarm === 'function' ? stepSwarm : null);
    if (!stepSwarmFn) throw new Error('stepSwarm function not available in environment');

    const s = makeSwarmFn({
      terrain,
      seed,
      count: settings.count || 5,
      radio,
      airframe,
      baseX: settings.base ? settings.base.x : 0,
      baseY: settings.base ? settings.base.y : 0,
      targetX: settings.target ? settings.target.x : 1500,
      targetY: settings.target ? settings.target.y : -300,
      altitudeM: settings.altitudeM != null ? settings.altitudeM : 50,
      deployFrac: settings.deployFrac != null ? settings.deployFrac : 0.8,
      corridorRouting: settings.corridorRouting !== false,
      broadcastC2: settings.broadcastC2 != null ? !!settings.broadcastC2 : (meta.broadcast != null ? !!meta.broadcast : true),
      spectrumAgility: !!settings.spectrumAgility,
      lpiMode: !!settings.lpiMode,
      videoOn: !!settings.videoOn,
      videoKbps: settings.videoKbps || 250,
      adversaryMode: !!settings.adversaryMode,
      windX: settings.wind ? settings.wind.x : 0,
      windY: settings.wind ? settings.wind.y : 0,
      envFactor: settings.envFactor != null ? settings.envFactor : 1,
      shadowSigmaDb: settings.shadowSigmaDb || 0,
      relayWing: relayAirframe && relayRadio ? settings.relayWing : 0,
      relayAirframe,
      relayRadio,
      jammers: Array.isArray(settings.jammers) ? settings.jammers : undefined,
      gpsZones: Array.isArray(settings.gpsZones) ? settings.gpsZones : undefined,
      baseVel: settings.baseVel ? { x: settings.baseVel.x || 0, y: settings.baseVel.y || 0 } : undefined,
      targetVel: settings.targetVel ? { x: settings.targetVel.x || 0, y: settings.targetVel.y || 0 } : undefined,
      captureOn: true,
    });

    const userActions = (meta.userActions || []).slice().sort((a, b) => a.t - b.t);
    let actionIdx = 0;

    // Determine simulation duration to replay
    let untilTime = opts.untilTime;
    if (untilTime == null) {
      let maxEventT = 0;
      for (const e of events) {
        if (typeof e.t === 'number' && e.t > maxEventT) maxEventT = e.t;
      }
      for (const a of userActions) {
        if (typeof a.t === 'number' && a.t > maxEventT) maxEventT = a.t;
      }
      untilTime = maxEventT > 0 ? maxEventT : 10;
    }

    return {
      swarm: s,
      untilTime,
      get done() { return s.time >= untilTime; },
      // Run at most maxSteps fixed steps; true once the capture's end is reached.
      advance(maxSteps) {
        for (let n = 0; n < maxSteps && s.time < untilTime; n++) {
          while (actionIdx < userActions.length && userActions[actionIdx].t <= s.time) {
            applyReplayAction(s, userActions[actionIdx], core);
            actionIdx++;
          }
          stepSwarmFn(s, SIM_DT_SEC);
          if (typeof opts.onStep === 'function') {
            opts.onStep(s, SIM_DT_SEC);
          }
        }
        if (s.time < untilTime) return false;
        // Process any remaining actions at terminal boundary
        while (actionIdx < userActions.length && userActions[actionIdx].t <= s.time) {
          applyReplayAction(s, userActions[actionIdx], core);
          actionIdx++;
        }
        return true;
      },
      result() {
        return {
          swarm: s,
          time: s.time,
          delivered: s.net ? s.net.delivered : 0,
          dropped: s.net ? s.net.dropped : 0,
          dronePositions: s.drones.map(d => ({ id: d.id, x: d.x, y: d.y, mode: d.mode, batteryPct: d.batteryPct })),
          parity: deliveryParity(events, s),
        };
      },
    };
  }

  // Deliveries the capture recorded vs. deliveries the replay produced, over
  // the time both packet logs cover (each is a rolling window, and a capture
  // switched on late starts mid-mission). The window opens just after the
  // later first event, so a step the rolling trim cut in half never counts.
  function deliveryParity(events, s) {
    const capt = events.filter(e => e.ev !== 'meta' && typeof e.t === 'number');
    const rep = (s.net && s.net.cap) || [];
    if (!capt.length || !rep.length) return null;
    const from = Math.max(capt[0].t, rep[0].t), to = capt[capt.length - 1].t;
    const count = list => list.filter(e => e.ev === 'deliver' && e.t > from && e.t <= to).length;
    return { from, to, captured: count(capt), replayed: count(rep) };
  }

  function replayMission(captureInput, options) {
    const run = startReplay(captureInput, options);
    run.advance(Infinity);
    return run.result();
  }

  return {
    parseCapture,
    replayMission,
    startReplay,
  };
});

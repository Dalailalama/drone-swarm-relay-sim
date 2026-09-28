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
    }
  }

  function replayMission(captureInput, options) {
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

    while (s.time < untilTime) {
      while (actionIdx < userActions.length && userActions[actionIdx].t <= s.time) {
        applyReplayAction(s, userActions[actionIdx], core);
        actionIdx++;
      }
      stepSwarmFn(s, SIM_DT_SEC);
      if (typeof opts.onStep === 'function') {
        opts.onStep(s, SIM_DT_SEC);
      }
    }

    // Process any remaining actions at terminal boundary
    while (actionIdx < userActions.length && userActions[actionIdx].t <= s.time) {
      applyReplayAction(s, userActions[actionIdx], core);
      actionIdx++;
    }

    return {
      swarm: s,
      time: s.time,
      delivered: s.net ? s.net.delivered : 0,
      dropped: s.net ? s.net.dropped : 0,
      dronePositions: s.drones.map(d => ({ id: d.id, x: d.x, y: d.y, mode: d.mode, batteryPct: d.batteryPct })),
    };
  }

  return {
    parseCapture,
    replayMission,
  };
});

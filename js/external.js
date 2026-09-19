// External vehicle mode — the SITL bridge, browser side.
//
// Normally stepDrone integrates our own point-mass physics. In external mode
// the drones are flown by REAL autopilot firmware (ArduPilot/PX4 SITL) or a
// mock vehicle server, reached over a WebSocket bridge:
//
//   this sim  <--WebSocket JSON-->  bridge.py  <--MAVLink/UDP-->  SITL
//
// Everything else in the swarm stays exactly as it is: C2 planning, ETX
// routing, the tether rule, coverage learning, failsafes — all still run and
// all still consume drone positions. The ONLY change is where those positions
// come from and where motion goals go. Each tick we:
//   1. overwrite every externalized drone's x,y (and velocity estimate) with
//      the latest telemetry the vehicles reported,
//   2. let the full swarm logic run (it computes each drone's goal exactly as
//      before, via goalFor -> corridorGoal -> tetherGoal),
//   3. send those goals out to the vehicles instead of integrating physics.
//
// Coordinate frame matches sitl/README.md: x = East, y = South, alt = metres.

(function () {
  // Sustained bridge-side heartbeat loss (seconds) before a frozen vehicle is
  // declared down. A brief UDP/SITL gap must not permanently kill a drone.
  const EXT_LOST_DEAD_SEC = 10;
  // Telemetry freshness by LOCAL receipt age (finding #9): a socket that
  // stays open while telemetry stops must not leave the last sample "current"
  // forever. Stale policy, stated plainly: the vehicle freezes at its last
  // known position (radio keeps computing on that best estimate, battery
  // bills hover), and a SUSTAINED stall escalates through the same
  // lost-heartbeat ladder to 'dead'.
  const EXT_STALE_SEC = 3;

  function wallSec() {
    return (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) / 1000;
  }

  const ExternalMode = {
    ws: null,
    connected: false,
    ready: false,
    controlMode: 'internal', // 'internal' | 'external'
    ids: null,          // vehicle ids the bridge reports
    vehicleStates: {},
    origin: null,
    services: {},
    serviceSeq: 0,
    expectedCount: 0,
    telem: {},
    prev: {},           // id -> {x, y, t} for velocity estimation
    lastGoalSent: 0,
    status: 'disconnected',
    onStatus: null,     // UI callback(text)
  };

  function setStatus(s, text) {
    ExternalMode.status = text;
    if (ExternalMode.onStatus) ExternalMode.onStatus(text);
    if (s) logEvent(s, 'External: ' + text, 'info');
  }

  function captureOrigin(s) {
    return Object.freeze({ frame: 'common-local-origin', x: s.base.x, y: s.base.y,
      groundM: terrainGroundAt(s.terrain, s.base.x, s.base.y) });
  }

  function refreshReadiness(s) {
    const states = Object.values(ExternalMode.vehicleStates);
    const n = states.filter(v => v.ready === true && v.state === 'ready').length;
    const total = Math.max(ExternalMode.expectedCount, states.length);
    ExternalMode.ready = n > 0;
    const failed = states.filter(v => String(v.state).startsWith('failed:')).length;
    const text = n === total && n > 0 ? 'vehicles ready (' + n + ') — flying under external control'
      : (failed === total && total > 0 ? 'all vehicles failed' : n > 0 ? 'vehicles partially ready' : 'vehicles initializing')
        + ' (' + n + '/' + total + ' confirmed ready)';
    if (ExternalMode.status !== text) setStatus(s, text);
  }

  function sampleAge(t, prefix) {
    if (!t || !Number.isSafeInteger(t[prefix + 'Seq']) || t[prefix + 'Seq'] <= 0 ||
        !Number.isFinite(t[prefix + 'At'])) return Infinity;
    return wallSec() - t[prefix + 'At'];
  }

  function positionFresh(t) {
    return ExternalMode.connected && t && t.connected === true &&
      wallSec() - t.rxAt < EXT_STALE_SEC && sampleAge(t, 'position') >= 0 &&
      sampleAge(t, 'position') < EXT_STALE_SEC;
  }

  function vehicleReady(id) {
    const t = ExternalMode.telem[id], v = ExternalMode.vehicleStates[id];
    return positionFresh(t) && v && v.ready === true && v.state === 'ready' &&
      t.ready === true && t.state === 'ready' && t.armed === true;
  }

  function grounded(id) {
    const t = ExternalMode.telem[id];
    return positionFresh(t) && t.armed === false && Number.isFinite(t.heartbeatAge) &&
      t.heartbeatAge >= 0 && t.heartbeatAge + wallSec() - t.rxAt < EXT_STALE_SEC &&
      t.landed === true && sampleAge(t, 'landed') >= 0 && sampleAge(t, 'landed') < EXT_STALE_SEC;
  }

  function serviceSend(id, action, extra) {
    const svc = ExternalMode.services[id];
    if (!svc || !ExternalMode.connected) return;
    svc.pendingAction = action;
    svc.lastAction = action;
    svc.lastSentAt = wallSec();
    svc.retries = (svc.retries || 0) + 1;
    ExternalMode.ws.send(JSON.stringify({ type: 'service', id, requestId: svc.id, action, ...extra }));
  }

  function dispatchServiceAction(s, id, action, extra) {
    const svc = ExternalMode.services[id];
    if (!svc || svc.phase === 'failed') return false;
    const now = wallSec();
    const isSameAction = (svc.pendingAction === action || svc.lastAction === action);
    if (!isSameAction) {
      serviceSend(id, action, extra);
      return true;
    }
    const elapsed = now - (svc.lastSentAt || 0);
    if (elapsed < 0.5) return false;
    if ((svc.retries || 0) < 5) {
      serviceSend(id, action, extra);
      return true;
    }
    svc.phase = 'failed';
    svc.pendingAction = null;
    setStatus(s, 'service ' + action + ' failed: retries exhausted');
    return false;
  }

  function externalServiceGrounded(id) {
    const svc = ExternalMode.services[id], t = ExternalMode.telem[id];
    return svc && t && svc.id === t.serviceId && t.state === 'swapping' && grounded(id);
  }

  function externalServiceComplete(s, d) {
    const svc = ExternalMode.services[d.id], t = ExternalMode.telem[d.id];
    if (!svc || !t || t.serviceId !== svc.id) return false;
    if (svc.phase === 'failed') return false;
    if (t.state === 'swapping' && grounded(d.id) && (svc.phase === 'swapping' || svc.phase === 'completing')) {
      dispatchServiceAction(s, d.id, 'complete');
    }
    if (t.state === 'swapped' && grounded(d.id) && (svc.phase === 'swapped' || svc.phase === 'completing')) {
      dispatchServiceAction(s, d.id, 'relaunch', { alt: s.altitudeM });
    }
    if ((svc.phase === 'relaunch' || svc.pendingAction === 'relaunch') && t.servicePhase === null && vehicleReady(d.id)) {
      delete ExternalMode.services[d.id];
      return true;
    }
    return false;
  }

  // Connect to a bridge/mock at wsUrl and prepare `count` vehicles at altM.
  function externalConnect(getSwarm, wsUrl, count, altM) {
    externalDisconnect();
    ExternalMode.controlMode = 'external';
    ExternalMode.origin = captureOrigin(getSwarm());
    ExternalMode.expectedCount = count;
    let ws;
    try { ws = new WebSocket(wsUrl); }
    catch (e) { setStatus(getSwarm(), 'bad URL: ' + e.message); return; }
    ExternalMode.ws = ws;
    setStatus(getSwarm(), 'connecting to ' + wsUrl + '…');

    // Every handler answers for ONE socket (finding #10): a reconnect makes a
    // new socket, and the old one's delayed close/error/message events must
    // not touch the state the new connection owns.
    ws.onopen = () => {
      if (ExternalMode.ws !== ws) return;
      ExternalMode.connected = true;
      ws.send(JSON.stringify({ type: 'init', count, alt: altM, origin: ExternalMode.origin }));
      setStatus(getSwarm(), 'connected — initializing ' + count + ' vehicles…');
    };
    ws.onclose = () => {
      if (ExternalMode.ws !== ws) return; // a ghost of a replaced connection
      ExternalMode.connected = false;
      ExternalMode.ready = false;
      // Keep controlMode = 'external' so internal physics doesn't take over;
      // vehicles remain frozen in place until user explicitly disconnects.
      setStatus(getSwarm(), 'disconnected — positions frozen under external hold (click Disconnect to resume internal physics)');
    };
    ws.onerror = () => {
      if (ExternalMode.ws !== ws) return;
      setStatus(getSwarm(), 'socket error (is the bridge running?)');
    };
    ws.onmessage = (ev) => {
      if (ExternalMode.ws !== ws) return;
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      const s = getSwarm();
      if (m.type === 'ready') {
        ExternalMode.ids = Array.isArray(m.ids) ? m.ids : [];
        ExternalMode.expectedCount = ExternalMode.ids.length;
        for (const v of m.vehicles || []) {
          if (!ExternalMode.telem[v.id]) ExternalMode.vehicleStates[v.id] = { ready: v.ready === true, state: v.state };
        }
        refreshReadiness(s);
      } else if (m.type === 'service_ack') {
        const svc = ExternalMode.services[m.id];
        if (svc && svc.id === m.requestId && svc.pendingAction === m.action) {
          if (m.accepted) {
            svc.phase = (m.action === 'land') ? 'landing'
                      : (m.action === 'authorize') ? 'swapping'
                      : (m.action === 'complete') ? 'swapped'
                      : (m.action === 'relaunch') ? 'relaunch'
                      : svc.phase;
            svc.pendingAction = null;
            svc.lastAction = null;
            svc.retries = 0;
          } else {
            if (m.retryable !== false && (svc.retries || 0) < 5) {
              svc.pendingAction = null;
            } else {
              svc.phase = 'failed';
              svc.pendingAction = null;
              setStatus(s, 'service ' + m.action + ' failed: ' + (m.code || 'rejected'));
            }
          }
        }
      } else if (m.type === 'telemetry') {
        for (const v of m.vehicles || []) {
          const prev = ExternalMode.telem[v.id];
          const now = wallSec();
          const t = { ...v, rxAt: now };
          for (const prefix of ['position', 'landed']) {
            const seq = v[prefix + 'Seq'], age = v[prefix + 'Age'];
            const advanced = Number.isSafeInteger(seq) && seq > 0 && (!prev || seq > (prev[prefix + 'Seq'] || 0));
            const at = Number.isFinite(age) && age >= 0 ? now - age : -Infinity;
            t[prefix + 'Seq'] = Math.max(seq || 0, prev ? prev[prefix + 'Seq'] || 0 : 0);
            t[prefix + 'At'] = advanced ? at : Math.min(at, prev ? prev[prefix + 'At'] : -Infinity);
            if (prefix === 'position') {
              if (advanced && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.alt)) {
                if (prev && Number.isFinite(prev.positionAt)) ExternalMode.prev[v.id] = prev;
                t.x = v.x; t.y = v.y; t.alt = v.alt;
              } else {
                t.x = prev && prev.x; t.y = prev && prev.y; t.alt = prev && prev.alt;
                if (!prev || seq < prev.positionSeq) t.positionAt = -Infinity;
              }
              if (![t.x, t.y, t.alt].every(Number.isFinite)) t.positionAt = -Infinity;
            }
          }
          ExternalMode.telem[v.id] = t;
          ExternalMode.vehicleStates[v.id] = { ready: v.ready === true, state: v.state };
          const svc = ExternalMode.services[v.id];
          if (svc && svc.id === v.serviceId && svc.phase !== 'failed') {
            if (v.state === 'landing' || v.servicePhase === 'landing') {
              if (svc.pendingAction === 'land') { svc.pendingAction = null; svc.lastAction = null; svc.retries = 0; }
            }
            if (v.state === 'landed' && grounded(v.id) && (svc.phase === 'landing' || svc.phase === 'landed')) {
              if (svc.pendingAction === 'land') { svc.pendingAction = null; svc.lastAction = null; svc.retries = 0; }
              if (svc.phase !== 'swapping') {
                dispatchServiceAction(s, v.id, 'authorize');
              }
            }
            if (v.state === 'swapping') {
              svc.phase = 'swapping';
              if (svc.pendingAction === 'authorize') { svc.pendingAction = null; svc.lastAction = null; svc.retries = 0; }
            }
            if (v.state === 'swapped') {
              svc.phase = 'swapped';
              if (svc.pendingAction === 'complete') { svc.pendingAction = null; svc.lastAction = null; svc.retries = 0; }
            }
          }
        }
        refreshReadiness(s);
      } else if (m.type === 'status') {
        setStatus(s, m.msg);
      }
    };
  }

  // Re-init the bridge to a new vehicle count (e.g. the count slider moved
  // mid-flight). Without this the sim would rebuild DR-1..DR-M while the
  // bridge still has DR-1..DR-N, so the extra drones get no telemetry and
  // freeze. The bridge respawns to match and replies with a fresh 'ready'.
  function externalReinit(getSwarm, count, altM) {
    if (!ExternalMode.ws || !ExternalMode.connected) return;
    ExternalMode.ready = false;
    ExternalMode.ids = null;
    ExternalMode.vehicleStates = {};
    ExternalMode.telem = {};
    ExternalMode.prev = {};
    ExternalMode.lastGoalSent = 0;
    ExternalMode.services = {};
    ExternalMode.expectedCount = count;
    ExternalMode.ws.send(JSON.stringify({ type: 'init', count, alt: altM, origin: ExternalMode.origin }));
    setStatus(getSwarm(), 're-initializing ' + count + ' vehicles…');
  }

  function externalDisconnect() {
    ExternalMode.controlMode = 'internal';
    if (ExternalMode.ws) {
      try { ExternalMode.ws.close(); } catch (e) {}
    }
    ExternalMode.ws = null;
    ExternalMode.connected = false;
    ExternalMode.ready = false;
    ExternalMode.ids = null;
    ExternalMode.vehicleStates = {};
    ExternalMode.telem = {};
    ExternalMode.prev = {};
    ExternalMode.services = {};
    ExternalMode.origin = null;
    ExternalMode.lastGoalSent = 0;
  }

  function externalActive() {
    return ExternalMode.controlMode === 'external';
  }

  // Called at the TOP of each swarm tick when active: pull real positions into
  // the sim's drones so all downstream logic sees ground truth from the
  // vehicles. Velocity is estimated from consecutive telemetry so heading
  // arrows and the "moving" battery-drain flag still work.
  function externalPullPositions(s) {
    if (!ExternalMode.connected) {
      for (const d of s.drones) {
        d.vx = 0;
        d.vy = 0;
      }
      return;
    }
    for (const d of s.drones) {
      const t = ExternalMode.telem[d.id];
      if (!t) {
        d.vx = 0;
        d.vy = 0;
        continue;
      }
      if (!positionFresh(t)) {
        // Bridge lost this vehicle's heartbeat — or the whole telemetry
        // stream stalled while the socket idled open (finding #9: freshness
        // is judged by LOCAL receipt age, never by the last sample's claim).
        // Freeze in place but keep it recoverable — a brief gap must not
        // permanently kill a drone that's still flying. Only a SUSTAINED
        // loss escalates to 'dead'.
        d.vx = d.vy = 0;
        if (d.extLostSince == null) d.extLostSince = s.time;
        else if (alive(d) && s.time - d.extLostSince > EXT_LOST_DEAD_SEC) {
          d.mode = 'dead';
          d.endpointDeadAt = s.time;
          if (typeof interruptEndpointAttempts === 'function') interruptEndpointAttempts(s, d.id);
          logEvent(s, d.id + ' vehicle link lost >' + EXT_LOST_DEAD_SEC + 's — marking down', 'error');
        }
        continue;
      }
      if (d.extLostSince != null) {
        d.extLostSince = null;
        // Vehicle heartbeat returned — revive a drone we'd given up on.
        if (d.mode === 'dead') {
          const svc = ExternalMode.services && ExternalMode.services[d.id];
          if (svc && (svc.phase === 'landed' || svc.phase === 'swapping' || svc.phase === 'swapped')) {
            d.mode = 'landed';
          } else {
            d.mode = 'ok';
          }
          d.endpointDeadAt = null;
          d.lastC2 = s.time;
        }
      }
      const p = ExternalMode.prev[d.id];
      d.vx = d.vy = 0;
      if (p && t.positionAt > p.positionAt && t.positionAt - p.positionAt < EXT_STALE_SEC) {
        const dt = t.positionAt - p.positionAt;
        d.vx = (t.x - p.x) / dt;
        d.vy = (t.y - p.y) / dt;
      }
      d.x = t.x + ExternalMode.origin.x;
      d.y = t.y + ExternalMode.origin.y;
      // The bridge reports -LOCAL_POSITION_NED.z: height above the LAUNCH
      // ORIGIN (MAVLink local NED is origin-relative — see MAV_FRAME). The
      // RF model wants AGL at the vehicle's CURRENT position; over terrain
      // the two differ by the ground-height difference (finding #25).
      if (t.alt != null) {
        d.altM = t.alt
          + ExternalMode.origin.groundM
          - terrainGroundAt(s.terrain, d.x, d.y);
      }
    }
  }

  // Called at the END of each tick when active: ship the goal each drone's own
  // logic just decided (relay slot / mission loiter / rescue / RTL), throttled
  // to ~2 Hz. We recompute the same goal the motion integrator would have used.
  function externalPushGoals(s) {
    // A relaunch/reset rebuilds the swarm with time 0. If sim time has gone
    // backward relative to our last send, adopt the new clock immediately —
    // otherwise the throttle below would suppress every goal for as many
    // seconds as the previous flight lasted.
    if (s.time < ExternalMode.lastGoalSent) ExternalMode.lastGoalSent = 0;
    if (s.time - ExternalMode.lastGoalSent < 0.5) return;
    ExternalMode.lastGoalSent = s.time;
    const goals = [];
    for (const d of s.drones) {
      if (!alive(d) || d.goalX == null) continue;
      if (!vehicleReady(d.id)) continue;
      const svc = ExternalMode.services[d.id];
      const overPad = (d.mode === 'rtb' || d.mode === 'rtl') && dist2d(d, s.base) < DRONE.landThresholdM;
      const origin = ExternalMode.origin;
      if (svc) {
        if (overPad && svc.phase === 'landing' && svc.phase !== 'failed') {
          dispatchServiceAction(s, d.id, 'land', { groundAlt: terrainGroundAt(s.terrain, d.x, d.y) - origin.groundM });
        }
        continue;
      }
      // Ship the exact goal stepDrone vetted this tick (cached on the drone),
      // not a fresh goalFor call — recomputing would double-advance orbitPhase.
      const g = clipGoalToNoFly(s, d, { x: d.goalX, y: d.goalY });
      if (overPad) {
        ExternalMode.services[d.id] = { id: String(++ExternalMode.serviceSeq), phase: 'landing' };
        dispatchServiceAction(s, d.id, 'land', { groundAlt: terrainGroundAt(s.terrain, d.x, d.y) - origin.groundM });
        continue;
      }
      goals.push({ id: d.id, x: g.x - origin.x, y: g.y - origin.y,
        alt: s.altitudeM + terrainGroundAt(s.terrain, g.x, g.y) - origin.groundM });
    }
    if (ExternalMode.ws && ExternalMode.connected) {
      ExternalMode.ws.send(JSON.stringify({ type: 'goals', goals }));
    }
  }

  function externalServiceActive(id) {
    const svc = ExternalMode.services && ExternalMode.services[id];
    return Boolean(svc && svc.phase !== 'failed');
  }

  // Expose to main.js and the sim loop.
  window.ExternalMode = ExternalMode;
  window.externalConnect = externalConnect;
  window.externalDisconnect = externalDisconnect;
  window.externalActive = externalActive;
  window.externalReinit = externalReinit;
  window.externalPullPositions = externalPullPositions;
  window.externalPushGoals = externalPushGoals;
  window.externalServiceGrounded = externalServiceGrounded;
  window.externalServiceComplete = externalServiceComplete;
  window.externalServiceActive = externalServiceActive;
})();

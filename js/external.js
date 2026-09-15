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
    telem: {},          // id -> {x, y, alt, connected, t}
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

  // Connect to a bridge/mock at wsUrl and prepare `count` vehicles at altM.
  function externalConnect(getSwarm, wsUrl, count, altM) {
    externalDisconnect();
    ExternalMode.controlMode = 'external';
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
      ws.send(JSON.stringify({ type: 'init', count, alt: altM }));
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
        ExternalMode.ids = m.ids;
        ExternalMode.ready = true;
        setStatus(s, 'vehicles ready (' + m.ids.length + ') — flying under external control');
      } else if (m.type === 'telemetry') {
        for (const v of m.vehicles) {
          const prev = ExternalMode.telem[v.id];
          if (prev) ExternalMode.prev[v.id] = { x: prev.x, y: prev.y, t: prev.t };
          ExternalMode.telem[v.id] = { x: v.x, y: v.y, alt: v.alt, connected: v.connected, t: m.t, rxAt: wallSec() };
        }
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
    ExternalMode.telem = {};
    ExternalMode.prev = {};
    ExternalMode.lastGoalSent = 0;
    ExternalMode.ws.send(JSON.stringify({ type: 'init', count, alt: altM }));
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
    ExternalMode.telem = {};
    ExternalMode.prev = {};
  }

  function externalActive() {
    return ExternalMode.controlMode === 'external';
  }

  // Called at the TOP of each swarm tick when active: pull real positions into
  // the sim's drones so all downstream logic sees ground truth from the
  // vehicles. Velocity is estimated from consecutive telemetry so heading
  // arrows and the "moving" battery-drain flag still work.
  function externalPullPositions(s) {
    if (!ExternalMode.connected || !ExternalMode.ready) {
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
      const stale = t.rxAt != null && (wallSec() - t.rxAt) > EXT_STALE_SEC;
      if (!t.connected || stale) {
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
          logEvent(s, d.id + ' vehicle link lost >' + EXT_LOST_DEAD_SEC + 's — marking down', 'error');
        }
        continue;
      }
      if (d.extLostSince != null) {
        d.extLostSince = null;
        // Vehicle heartbeat returned — revive a drone we'd given up on.
        if (!alive(d)) { d.mode = 'ok'; d.lastC2 = s.time; }
      }
      const p = ExternalMode.prev[d.id];
      if (p && t.t > p.t) {
        const dt = t.t - p.t;
        d.vx = (t.x - p.x) / dt;
        d.vy = (t.y - p.y) / dt;
      }
      d.x = t.x;
      d.y = t.y;
      // The bridge reports -LOCAL_POSITION_NED.z: height above the LAUNCH
      // ORIGIN (MAVLink local NED is origin-relative — see MAV_FRAME). The
      // RF model wants AGL at the vehicle's CURRENT position; over terrain
      // the two differ by the ground-height difference (finding #25).
      if (t.alt != null) {
        d.altM = t.alt
          + terrainGroundAt(s.terrain, s.base.x, s.base.y)
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
      // Ship the exact goal stepDrone vetted this tick (cached on the drone),
      // not a fresh goalFor call — recomputing would double-advance orbitPhase.
      // Two external-only vets (finding #11): the leg is clipped short of any
      // known no-fly building (the autopilot has no obstacle map), and an
      // RTB/RTL drone over the pad is commanded to DESCEND — touchdown is
      // confirmed by telemetry before anyone calls it landed.
      const g = clipGoalToNoFly(s, d, { x: d.goalX, y: d.goalY });
      const overPad = (d.mode === 'rtb' || d.mode === 'rtl') && dist2d(d, s.base) < DRONE.landThresholdM * 2;
      goals.push({ id: d.id, x: g.x, y: g.y, alt: overPad ? 0 : s.altitudeM });
    }
    if (ExternalMode.ws && ExternalMode.connected) {
      ExternalMode.ws.send(JSON.stringify({ type: 'goals', goals }));
    }
  }

  // Expose to main.js and the sim loop.
  window.ExternalMode = ExternalMode;
  window.externalConnect = externalConnect;
  window.externalDisconnect = externalDisconnect;
  window.externalActive = externalActive;
  window.externalReinit = externalReinit;
  window.externalPullPositions = externalPullPositions;
  window.externalPushGoals = externalPushGoals;
})();

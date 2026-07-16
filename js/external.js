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
  const ExternalMode = {
    ws: null,
    connected: false,
    ready: false,
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
    let ws;
    try { ws = new WebSocket(wsUrl); }
    catch (e) { setStatus(getSwarm(), 'bad URL: ' + e.message); return; }
    ExternalMode.ws = ws;
    setStatus(getSwarm(), 'connecting to ' + wsUrl + '…');

    ws.onopen = () => {
      ExternalMode.connected = true;
      ws.send(JSON.stringify({ type: 'init', count, alt: altM }));
      setStatus(getSwarm(), 'connected — initializing ' + count + ' vehicles…');
    };
    ws.onclose = () => {
      ExternalMode.connected = false;
      ExternalMode.ready = false;
      setStatus(getSwarm(), 'disconnected');
    };
    ws.onerror = () => setStatus(getSwarm(), 'socket error (is the bridge running?)');
    ws.onmessage = (ev) => {
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
          ExternalMode.telem[v.id] = { x: v.x, y: v.y, alt: v.alt, connected: v.connected, t: m.t };
        }
      } else if (m.type === 'status') {
        setStatus(s, m.msg);
      }
    };
  }

  function externalDisconnect() {
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
    return ExternalMode.ready && ExternalMode.connected;
  }

  // Called at the TOP of each swarm tick when active: pull real positions into
  // the sim's drones so all downstream logic sees ground truth from the
  // vehicles. Velocity is estimated from consecutive telemetry so heading
  // arrows and the "moving" battery-drain flag still work.
  function externalPullPositions(s) {
    for (const d of s.drones) {
      const t = ExternalMode.telem[d.id];
      if (!t) continue;
      const p = ExternalMode.prev[d.id];
      if (p && t.t > p.t) {
        const dt = t.t - p.t;
        d.vx = (t.x - p.x) / dt;
        d.vy = (t.y - p.y) / dt;
      }
      d.x = t.x;
      d.y = t.y;
      // A vehicle the bridge reports as disconnected is treated as lost.
      if (!t.connected && alive(d)) { d.mode = 'dead'; d.vx = d.vy = 0; }
    }
  }

  // Called at the END of each tick when active: ship the goal each drone's own
  // logic just decided (relay slot / mission loiter / rescue / RTL), throttled
  // to ~2 Hz. We recompute the same goal the motion integrator would have used.
  function externalPushGoals(s) {
    if (s.time - ExternalMode.lastGoalSent < 0.5) return;
    ExternalMode.lastGoalSent = s.time;
    const goals = [];
    for (const d of s.drones) {
      if (!alive(d)) continue;
      const goal = tetherGoal(s, d, corridorGoal(s, d, goalFor(s, d)));
      goals.push({ id: d.id, x: goal.x, y: goal.y, alt: s.altitudeM });
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
  window.externalPullPositions = externalPullPositions;
  window.externalPushGoals = externalPushGoals;
})();

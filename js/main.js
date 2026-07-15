// Main controller: UI wiring, sim loop, camera, interaction.

(function () {
  const cv = document.getElementById('map');
  const ctx = cv.getContext('2d');

  // --- UI elements ----------------------------------------------------------
  const el = id => document.getElementById(id);
  const radioSel = el('radioSel'), envSel = el('envSel');
  const countRange = el('countRange'), countOut = el('countOut');
  const endurRange = el('endurRange'), endurOut = el('endurOut');
  const distRange = el('distRange'), distOut = el('distOut');
  const speedBtns = Array.from(document.querySelectorAll('[data-speed]'));
  const statusPill = el('statusPill'), specCard = el('specCard');
  const hopsBody = el('hopsBody'), fleetBody = el('fleetBody'), eventLog = el('eventLog');
  const killBtn = el('killBtn'), resetBtn = el('resetBtn');
  const kpiRelays = el('kpiRelays'), kpiMission = el('kpiMission'), kpiThroughput = el('kpiThroughput'), kpiClock = el('kpiClock');

  RADIOS.forEach(r => {
    const o = document.createElement('option');
    o.value = r.id; o.textContent = r.name;
    radioSel.appendChild(o);
  });
  ENVIRONMENTS.forEach(e => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.name;
    envSel.appendChild(o);
  });

  // --- State ----------------------------------------------------------------
  let radio = RADIOS[0];
  let env = ENVIRONMENTS[0];
  let timeScale = 5;
  let paused = false;
  let swarm = null;
  let selected = null;
  const view = { cx: 0, cy: 0, pxPerM: 1 };

  function usable() { return usableRangeM(radio, env.factor); }

  function defaultTargetDist() { return usable() * 2.4; } // far enough to need 2 relays

  function resetSwarm() {
    const dist = +distRange.value / 100 * defaultTargetDist();
    swarm = makeSwarm({
      count: +countRange.value,
      enduranceMin: +endurRange.value,
      targetX: dist, targetY: -dist * 0.25,
      radio, envFactor: env.factor,
    });
    selected = null;
    fitView();
    logEvent(swarm, 'Swarm launched: ' + swarm.drones.length + ' drones on ' + radio.name, 'info');
  }

  let viewFitted = false;
  function fitView() {
    if (!cv.width || !cv.height) { viewFitted = false; return; } // pane not sized yet, retry on resize
    const pad = 1.35;
    const spanX = Math.abs(swarm.target.x - swarm.base.x) + usable();
    const spanY = Math.abs(swarm.target.y - swarm.base.y) + usable();
    view.pxPerM = Math.min(cv.width / (spanX * pad), cv.height / (spanY * pad));
    view.cx = (swarm.base.x + swarm.target.x) / 2;
    view.cy = (swarm.base.y + swarm.target.y) / 2;
    viewFitted = true;
  }

  function updateSpecCard() {
    const u = usable();
    specCard.innerHTML =
      '<div class="spec-row"><span>Frequency</span><b>' + radio.freqMHz + ' MHz</b></div>' +
      '<div class="spec-row"><span>TX power</span><b>' + radio.txDbm + ' dBm (' + Math.round(Math.pow(10, radio.txDbm / 10)) + ' mW)</b></div>' +
      '<div class="spec-row"><span>RX sensitivity</span><b>' + radio.sensDbm + ' dBm</b></div>' +
      '<div class="spec-row"><span>Air data rate</span><b>' + (radio.airRateKbps >= 1000 ? (radio.airRateKbps / 1000) + ' Mbps' : radio.airRateKbps + ' kbps') + '</b></div>' +
      '<div class="spec-row"><span>Rated LOS range</span><b>' + fmtDist(radio.rangeLosM) + '</b></div>' +
      '<div class="spec-row"><span>Usable here (' + env.name.split(' ')[0].toLowerCase() + ', ' + FADE_MARGIN_DB + ' dB fade)</span><b>' + fmtDist(u) + '</b></div>' +
      '<p class="spec-note">' + radio.note + '</p>';
  }

  // --- Controls -------------------------------------------------------------
  radioSel.addEventListener('change', () => {
    radio = RADIOS.find(r => r.id === radioSel.value);
    swarm.radio = radio;
    updateSpecCard();
    resetSwarm();
  });
  envSel.addEventListener('change', () => {
    env = ENVIRONMENTS.find(e => e.id === envSel.value);
    swarm.envFactor = env.factor;
    updateSpecCard();
    logEvent(swarm, 'Environment: ' + env.name + ' — usable range now ' + fmtDist(usable()), 'warn');
  });
  countRange.addEventListener('input', () => { countOut.textContent = countRange.value; });
  countRange.addEventListener('change', resetSwarm);
  endurRange.addEventListener('input', () => {
    endurOut.textContent = endurRange.value + ' min';
    if (swarm) swarm.enduranceMin = +endurRange.value;
  });
  distRange.addEventListener('input', () => {
    const dist = +distRange.value / 100 * defaultTargetDist();
    distOut.textContent = fmtDist(dist);
    if (swarm) { swarm.target.x = dist; swarm.target.y = -dist * 0.25; }
  });
  speedBtns.forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.speed;
    if (v === 'pause') { paused = !paused; b.textContent = paused ? 'Resume' : 'Pause'; }
    else { timeScale = +v; paused = false; document.querySelector('[data-speed="pause"]').textContent = 'Pause'; }
    speedBtns.forEach(x => x.classList.toggle('active', x === b && v !== 'pause'));
  }));
  killBtn.addEventListener('click', () => {
    if (selected && alive(selected)) { killDrone(swarm, selected); }
  });
  resetBtn.addEventListener('click', resetSwarm);

  // --- Canvas interaction ---------------------------------------------------
  let dragMode = null; // 'target' | 'pan'
  let lastMouse = null;

  function canvasPos(e) {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
  }

  cv.addEventListener('pointerdown', e => {
    const p = canvasPos(e);
    const w = screenToWorld(view, cv, p.x, p.y);
    const tScreen = worldToScreen(view, cv, swarm.target.x, swarm.target.y);
    if (Math.hypot(p.x - tScreen.x, p.y - tScreen.y) < 26) {
      dragMode = 'target';
    } else {
      // Drone hit test (screen space)
      let hit = null;
      for (const d of swarm.drones) {
        const s = worldToScreen(view, cv, d.x, d.y);
        if (Math.hypot(p.x - s.x, p.y - s.y) < 14) { hit = d; break; }
      }
      if (hit) { selected = hit; dragMode = null; }
      else dragMode = 'pan';
    }
    lastMouse = p;
    cv.setPointerCapture(e.pointerId);
  });

  cv.addEventListener('pointermove', e => {
    const p = canvasPos(e);
    if (dragMode === 'target') {
      const w = screenToWorld(view, cv, p.x, p.y);
      swarm.target.x = w.x; swarm.target.y = w.y;
    } else if (dragMode === 'pan' && lastMouse) {
      view.cx -= (p.x - lastMouse.x) / view.pxPerM;
      view.cy -= (p.y - lastMouse.y) / view.pxPerM;
    }
    lastMouse = p;
  });

  cv.addEventListener('pointerup', () => { dragMode = null; lastMouse = null; });

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const p = canvasPos(e);
    const before = screenToWorld(view, cv, p.x, p.y);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    view.pxPerM = Math.min(20, Math.max(0.001, view.pxPerM * factor));
    const after = screenToWorld(view, cv, p.x, p.y);
    view.cx += before.x - after.x;
    view.cy += before.y - after.y;
  }, { passive: false });

  // --- Panels ---------------------------------------------------------------
  function fmtSimClock(t) {
    const m = Math.floor(t / 60), sec = Math.floor(t % 60);
    return 'T+' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  function updatePanels(status) {
    const relays = swarm.relays.length;
    const airborne = swarm.drones.filter(alive).length;
    kpiRelays.textContent = relays;
    kpiMission.textContent = status.missionCount;
    kpiThroughput.textContent = status.connected
      ? (chainThroughputKbps(radio, status.hops.length) >= 1000
        ? (chainThroughputKbps(radio, status.hops.length) / 1000).toFixed(1) + ' Mbps'
        : chainThroughputKbps(radio, status.hops.length).toFixed(chainThroughputKbps(radio, status.hops.length) < 10 ? 1 : 0) + ' kbps')
      : '—';
    kpiClock.textContent = fmtSimClock(swarm.time);

    if (!status.missionCount && !airborne) {
      statusPill.textContent = 'Swarm down';
      statusPill.className = 'pill lost';
    } else if (status.connected) {
      statusPill.textContent = 'Connected — ' + status.hops.length + ' hop' + (status.hops.length > 1 ? 's' : '');
      statusPill.className = 'pill ok';
    } else {
      const anyDegraded = status.hops.some(h => h.state !== 'lost');
      statusPill.textContent = status.hops.some(h => h.state === 'lost') ? 'Link lost — repositioning' : 'Degraded';
      statusPill.className = 'pill ' + (anyDegraded ? 'warn' : 'lost');
    }

    hopsBody.innerHTML = status.hops.map((h, i) =>
      '<tr class="' + h.state + '"><td>' + h.a.label + ' → ' + h.b.label + '</td><td>' + fmtDist(h.distM) +
      '</td><td>' + h.rssiDbm.toFixed(0) + '</td><td>' + h.marginDb.toFixed(0) + '</td></tr>'
    ).join('') || '<tr><td colspan="4" class="dim">no links</td></tr>';

    fleetBody.innerHTML = swarm.drones.map(d => {
      const sel = d === selected ? ' style="outline:1px solid #e2e8f0;"' : '';
      return '<div class="fleet-row role-' + d.role + '"' + sel + ' data-id="' + d.id + '">' +
        '<span class="dot"></span><span class="fid">' + d.id + '</span>' +
        '<span class="frole">' + d.role + '</span>' +
        '<span class="fbat"><span class="fbat-fill" style="width:' + d.batteryPct.toFixed(0) + '%"></span></span>' +
        '<span class="fpct">' + d.batteryPct.toFixed(0) + '%</span></div>';
    }).join('');

    eventLog.innerHTML = swarm.events.slice().reverse().map(ev =>
      '<div class="ev ev-' + ev.kind + '"><span class="ev-t">' + fmtSimClock(ev.t) + '</span>' + ev.msg + '</div>'
    ).join('');

    killBtn.disabled = !(selected && alive(selected));
    killBtn.textContent = selected ? 'Kill ' + selected.id : 'Kill drone (select one)';
  }

  fleetBody.addEventListener('click', e => {
    const row = e.target.closest('.fleet-row');
    if (row) selected = swarm.drones.find(d => d.id === row.dataset.id) || null;
  });

  // --- Loop -------------------------------------------------------------------
  function resize() {
    const r = cv.parentElement.getBoundingClientRect();
    cv.width = Math.floor(r.width);
    cv.height = Math.floor(r.height);
    if (swarm && !viewFitted) fitView(); // first real layout after a hidden/zero-size load
  }
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(cv.parentElement);

  let lastT = performance.now();
  let panelAccum = 0;
  function frame(now) {
    const realDt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;

    let status;
    if (!paused) {
      let simDt = realDt * timeScale;
      // substep so physics stays stable at high time scales
      const maxStep = 0.25;
      while (simDt > 0) {
        const step = Math.min(maxStep, simDt);
        status = stepSwarm(swarm, step);
        simDt -= step;
      }
    }
    if (!status) status = chainStatus(swarm);

    render(ctx, cv, view, swarm, status, selected, usable());

    panelAccum += realDt;
    if (panelAccum > 0.2) { updatePanels(status); panelAccum = 0; }

    requestAnimationFrame(frame);
  }

  // --- Boot -------------------------------------------------------------------
  resize();
  countOut.textContent = countRange.value;
  endurOut.textContent = endurRange.value + ' min';
  updateSpecCard();
  resetSwarm();
  distOut.textContent = fmtDist(+distRange.value / 100 * defaultTargetDist());
  document.querySelector('[data-speed="5"]').classList.add('active');
  requestAnimationFrame(frame);
})();

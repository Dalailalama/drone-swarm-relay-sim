// Main controller: UI wiring, sim loop, camera, interaction.

(function () {
  const cv = document.getElementById('map');
  const ctx = cv.getContext('2d');

  // --- UI elements ----------------------------------------------------------
  const el = id => document.getElementById(id);
  const radioSel = el('radioSel'), envSel = el('envSel');
  const airframeSel = el('airframeSel'), airframeInfo = el('airframeInfo');
  const countRange = el('countRange'), countOut = el('countOut');
  const distRange = el('distRange'), distOut = el('distOut');
  const altRange = el('altRange'), altOut = el('altOut');
  const windSpdRange = el('windSpdRange'), windSpdOut = el('windSpdOut');
  const windDirRange = el('windDirRange'), windDirOut = el('windDirOut');
  const spacingRange = el('spacingRange'), spacingOut = el('spacingOut'), spacingInfo = el('spacingInfo');
  const corridorChk = el('corridorChk'), corridorOut = el('corridorOut');
  const terrainSel = el('terrainSel'), coverageChk = el('coverageChk');
  const bcastChk = el('bcastChk');
  const captureChk = el('captureChk'), captureOut = el('captureOut'), exportBtn = el('exportBtn');
  const wsUrl = el('wsUrl'), extConnectBtn = el('extConnectBtn'), extStatus = el('extStatus');
  const viewBtn = el('viewBtn');
  const speedBtns = Array.from(document.querySelectorAll('[data-speed]'));
  const statusPill = el('statusPill'), specCard = el('specCard');
  const hopsBody = el('hopsBody'), fleetBody = el('fleetBody'), eventLog = el('eventLog');
  const chanLine = el('chanLine');
  const killBtn = el('killBtn'), resetBtn = el('resetBtn');
  const kpiRelays = el('kpiRelays'), kpiMission = el('kpiMission'), kpiThroughput = el('kpiThroughput'), kpiClock = el('kpiClock');
  const kpiContact = el('kpiContact'), kpiPackets = el('kpiPackets');

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
  AIRFRAMES.forEach(a => {
    const o = document.createElement('option');
    o.value = a.id; o.textContent = a.name;
    airframeSel.appendChild(o);
  });

  // --- State ----------------------------------------------------------------
  let radio = RADIOS[0];
  let env = ENVIRONMENTS[0];
  let airframe = AIRFRAMES[1]; // 450-class default
  airframeSel.value = airframe.id;
  let timeScale = 5;
  let paused = false;
  let swarm = null;
  let selected = null;
  let selectedJammer = null;
  const view = { cx: 0, cy: 0, pxPerM: 1 };

  function usable() { return usableRangeM(radio, env.factor); }

  function defaultTargetDist() { return usable() * 2.4; } // far enough to need 2 relays

  let missionSeq = 0;
  function resetSwarm() {
    const dist = +distRange.value / 100 * defaultTargetDist();
    missionSeq += 1;
    const tX = dist, tY = -dist * 0.25;
    const terrain = makeTerrain(terrainSel.value, {
      distM: Math.hypot(tX, tY), altM: +altRange.value,
      targetX: tX, targetY: tY, seed: 42 + missionSeq,
    });
    swarm = makeSwarm({
      terrain,
      count: +countRange.value,
      airframe,
      altitudeM: +altRange.value,
      deployFrac: +spacingRange.value / 100,
      corridorRouting: corridorChk.checked,
      broadcastC2: bcastChk.checked,
      captureOn: captureChk.checked,
      windX: +windSpdRange.value * Math.cos(+windDirRange.value * Math.PI / 180),
      windY: +windSpdRange.value * Math.sin(+windDirRange.value * Math.PI / 180),
      targetX: dist, targetY: -dist * 0.25,
      radio, envFactor: env.factor,
      shadowSigmaDb: env.shadowSigmaDb,
      seed: 42 + missionSeq,
    });
    selected = null; selectedJammer = null;
    swarm.showCoverage = coverageChk.checked;
    cam3D = view3D ? makeCamera3D(swarm) : null;
    fitView();
    logEvent(swarm, 'Swarm launched: ' + swarm.drones.length + ' drones on ' + radio.name, 'info');
  }

  // Full scenario capture — every setting plus placed interference sources —
  // so a demo/study is reproducible and shareable as one JSON file.
  function currentScenario() {
    return {
      version: 1, radio: radio.id, env: env.id, airframe: airframe.id,
      count: +countRange.value, altitudeM: +altRange.value, spacingPct: +spacingRange.value,
      distancePct: +distRange.value, terrain: terrainSel.value,
      windSpd: +windSpdRange.value, windDir: +windDirRange.value,
      corridor: corridorChk.checked, broadcast: bcastChk.checked, coverage: coverageChk.checked,
      target: { x: swarm.target.x, y: swarm.target.y },
      jammers: swarm.jammers.map(j => ({ x: j.x, y: j.y, erpDbm: j.erpDbm, band: j.band, altM: j.altM, on: j.on })),
    };
  }
  function applyScenario(sc) {
    if (sc.radio) { radioSel.value = sc.radio; radio = RADIOS.find(r => r.id === sc.radio) || radio; }
    if (sc.env) { envSel.value = sc.env; env = ENVIRONMENTS.find(e => e.id === sc.env) || env; }
    if (sc.airframe) { airframeSel.value = sc.airframe; airframe = AIRFRAMES.find(a => a.id === sc.airframe) || airframe; }
    if (sc.count != null) { countRange.value = sc.count; countOut.textContent = sc.count; }
    if (sc.altitudeM != null) { altRange.value = sc.altitudeM; altOut.textContent = sc.altitudeM + ' m'; }
    if (sc.spacingPct != null) spacingRange.value = sc.spacingPct;
    if (sc.distancePct != null) distRange.value = sc.distancePct;
    if (sc.terrain) terrainSel.value = sc.terrain;
    if (sc.windSpd != null) windSpdRange.value = sc.windSpd;
    if (sc.windDir != null) windDirRange.value = sc.windDir;
    if (sc.corridor != null) corridorChk.checked = sc.corridor;
    if (sc.broadcast != null) bcastChk.checked = sc.broadcast;
    if (sc.coverage != null) coverageChk.checked = sc.coverage;
    updateSpecCard(); updateAirframeInfo(); applySpacing();
    resetSwarm();
    if (sc.target) { swarm.target.x = sc.target.x; swarm.target.y = sc.target.y; }
    if (sc.jammers) sc.jammers.forEach(j => swarm.jammers.push({ id: 'JX-load' + Math.round(j.x) + '_' + Math.round(j.y), ...j }));
    fitView(); updateJammerPanel();
    logEvent(swarm, 'Scenario loaded', 'info');
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
      '<div class="spec-row"><span>Radio horizon (C2 &rarr; ' + (altRange ? altRange.value : 50) + ' m)</span><b>' + fmtDist(radioHorizonM(2, +altRange.value)) + '</b></div>' +
      '<p class="spec-note">' + radio.note + '</p>';
    applySpacing(); // hop-margin readout depends on radio + environment
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
    swarm.shadowSigmaDb = env.shadowSigmaDb;
    updateSpecCard();
    logEvent(swarm, 'Environment: ' + env.name + ' — usable range now ' + fmtDist(usable()), 'warn');
  });
  countRange.addEventListener('input', () => { countOut.textContent = countRange.value; });
  countRange.addEventListener('change', () => {
    resetSwarm();
    // If a bridge is flying the swarm, respawn its vehicles to the new count
    // so DR-1..DR-N stays in lockstep with the sim's drones.
    if (externalActive()) externalReinit(() => swarm, +countRange.value, +altRange.value);
  });
  airframeSel.addEventListener('change', () => {
    airframe = AIRFRAMES.find(a => a.id === airframeSel.value);
    updateAirframeInfo();
    resetSwarm();
  });

  function updateAirframeInfo() {
    airframeInfo.innerHTML =
      airframe.massKg + ' kg &middot; ' + airframe.batteryWh + ' Wh &middot; hover <b>' +
      Math.round(hoverPowerW(airframe)) + ' W</b> &middot; endurance <b>~' +
      Math.round(hoverEnduranceMin(airframe)) + ' min</b> &middot; ' + airframe.maxSpeedMs + ' m/s<br>' +
      airframe.note;
  }
  distRange.addEventListener('input', () => {
    const dist = +distRange.value / 100 * defaultTargetDist();
    distOut.textContent = fmtDist(dist);
    if (swarm) { swarm.target.x = dist; swarm.target.y = -dist * 0.25; }
  });
  altRange.addEventListener('input', () => {
    altOut.textContent = altRange.value + ' m';
    if (swarm) swarm.altitudeM = +altRange.value;
    updateSpecCard();
  });
  function applyWind() {
    const spd = +windSpdRange.value;
    const rad = +windDirRange.value * Math.PI / 180;
    windSpdOut.textContent = spd + ' m/s';
    windDirOut.textContent = windDirRange.value + '°';
    if (swarm) { swarm.wind.x = spd * Math.cos(rad); swarm.wind.y = spd * Math.sin(rad); }
  }
  windSpdRange.addEventListener('input', applyWind);
  windDirRange.addEventListener('input', applyWind);

  function applySpacing() {
    const frac = +spacingRange.value / 100;
    spacingOut.textContent = spacingRange.value + '%';
    if (swarm) swarm.deployFrac = frac;
    const hopM = usable() * frac;
    const margin = linkMarginDb(radio, env.factor, hopM);
    const loss = (1 - pktSuccessProb(margin)) * 100;
    spacingInfo.innerHTML = 'Hops of ' + fmtDist(hopM) + ' &middot; nominal margin <b>' +
      margin.toFixed(1) + ' dB</b> &middot; pkt loss ~' + (loss < 1 ? '<1' : loss.toFixed(0)) + '%' +
      (margin < 3 ? ' — fragile: shadowing swings will break these links' : '');
  }
  spacingRange.addEventListener('input', applySpacing);
  corridorChk.addEventListener('change', () => {
    if (swarm) swarm.corridorRouting = corridorChk.checked;
    corridorOut.textContent = corridorChk.checked ? 'transits follow the chain' : 'straight-line transits';
  });
  terrainSel.addEventListener('change', resetSwarm);
  coverageChk.addEventListener('change', () => {
    if (swarm) swarm.showCoverage = coverageChk.checked;
  });
  bcastChk.addEventListener('change', () => {
    if (swarm) swarm.broadcastC2 = bcastChk.checked;
  });
  captureChk.addEventListener('change', () => {
    if (swarm) swarm.captureOn = captureChk.checked;
    captureOut.textContent = captureChk.checked ? 'recording…' : 'off';
    exportBtn.disabled = !captureChk.checked;
  });
  ExternalMode.onStatus = (text) => { extStatus.textContent = text; };
  extConnectBtn.addEventListener('click', () => {
    if (externalActive() || ExternalMode.ws) {
      externalDisconnect();
      extConnectBtn.textContent = 'Fly via bridge';
      extStatus.textContent = 'off — drones flown by built-in physics';
    } else {
      externalConnect(() => swarm, wsUrl.value.trim(), +countRange.value, +altRange.value);
      extConnectBtn.textContent = 'Disconnect bridge';
    }
  });
  exportBtn.addEventListener('click', () => {
    if (!swarm) return;
    download(exportCaptureJSONL(swarm), 'swarm-capture-' + Math.floor(swarm.time) + 's.jsonl', 'application/x-ndjson');
  });

  // --- Interference sources ---------------------------------------------------
  const addJammerBtn = el('addJammerBtn'), jammerPanel = el('jammerPanel');
  const jammerPowerRow = el('jammerPowerRow'), jammerPowerRange = el('jammerPowerRange'), jammerPowerOut = el('jammerPowerOut');
  const jammerBtnRow = el('jammerBtnRow'), jammerToggleBtn = el('jammerToggleBtn'), jammerRemoveBtn = el('jammerRemoveBtn');

  function updateJammerPanel() {
    const j = selectedJammer;
    const on = j && j.on !== false;
    jammerPowerRow.style.display = j ? 'flex' : 'none';
    jammerBtnRow.style.display = j ? 'flex' : 'none';
    if (j) {
      jammerPowerRange.value = j.erpDbm;
      jammerPowerOut.textContent = j.erpDbm + ' dBm';
      jammerToggleBtn.textContent = on ? 'Turn off' : 'Turn on';
      jammerPanel.innerHTML = 'Source <b>' + j.id + '</b> — ' + (on ? 'active, denial radius <b>' + fmtDist(jammerDenialRadiusM(swarm, j)) + '</b> for the current radio' : 'off') + '. Drag it on the map.';
    } else {
      jammerPanel.textContent = swarm.jammers.length + ' source' + (swarm.jammers.length === 1 ? '' : 's') + ' placed. Click one to tune it.';
    }
  }
  window.updateJammerPanel = updateJammerPanel; // pointer handler calls it on select
  addJammerBtn.addEventListener('click', () => {
    const j = makeJammer(view.cx, view.cy, +jammerPowerRange.value);
    swarm.jammers.push(j);
    selectedJammer = j;
    updateJammerPanel();
  });
  jammerPowerRange.addEventListener('input', () => {
    jammerPowerOut.textContent = jammerPowerRange.value + ' dBm';
    if (selectedJammer) { selectedJammer.erpDbm = +jammerPowerRange.value; updateJammerPanel(); }
  });
  jammerToggleBtn.addEventListener('click', () => {
    if (!selectedJammer) return;
    selectedJammer.on = selectedJammer.on === false;
    updateJammerPanel();
  });
  jammerRemoveBtn.addEventListener('click', () => {
    if (!selectedJammer) return;
    swarm.jammers = swarm.jammers.filter(j => j !== selectedJammer);
    selectedJammer = null;
    updateJammerPanel();
  });

  // --- Scenario save/load + after-action report ------------------------------
  function download(text, name, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
    a.download = name; a.click();
    URL.revokeObjectURL(a.href);
  }
  el('saveScenarioBtn').addEventListener('click', () => {
    download(JSON.stringify(currentScenario(), null, 1), 'scenario-' + terrainSel.value + '.json', 'application/json');
  });
  el('loadScenarioBtn').addEventListener('click', () => el('loadScenarioInput').click());
  el('loadScenarioInput').addEventListener('change', ev => {
    const file = ev.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { try { applyScenario(JSON.parse(reader.result)); } catch (e) { alert('Bad scenario file: ' + e.message); } };
    reader.readAsText(file);
    ev.target.value = '';
  });
  el('reportBtn').addEventListener('click', () => {
    download(afterActionReport(swarm), 'after-action-T' + Math.floor(swarm.time) + 's.md', 'text/markdown');
  });
  speedBtns.forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.speed;
    if (v === 'pause') { paused = !paused; b.textContent = paused ? 'Resume' : 'Pause'; }
    else { timeScale = +v; paused = false; document.querySelector('[data-speed="pause"]').textContent = 'Pause'; }
    // Highlight the button matching the current speed — pause/resume must not
    // clear it, since timeScale is unchanged across a pause.
    speedBtns.forEach(x => x.classList.toggle('active', x.dataset.speed === String(timeScale)));
  }));
  killBtn.addEventListener('click', () => {
    if (selected && alive(selected)) { killDrone(swarm, selected); }
  });
  resetBtn.addEventListener('click', resetSwarm);

  // --- Canvas interaction ---------------------------------------------------
  let dragMode = null; // 'target' | 'pan' | 'orbit'
  let lastMouse = null;

  // --- 3D view ----------------------------------------------------------------
  let view3D = false;
  let cam3D = null;
  viewBtn.addEventListener('click', () => {
    view3D = !view3D;
    viewBtn.textContent = view3D ? '2D map' : '3D view';
    if (view3D && !cam3D) cam3D = makeCamera3D(swarm);
  });

  function canvasPos(e) {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
  }

  cv.addEventListener('pointerdown', e => {
    const p = canvasPos(e);
    if (view3D) {
      dragMode = 'orbit'; lastMouse = p;
      cv.setPointerCapture(e.pointerId);
      return;
    }
    const w = screenToWorld(view, cv, p.x, p.y);
    // Interference source hit test first (they're draggable, like the target)
    let jHit = null;
    for (const j of swarm.jammers) {
      const js = worldToScreen(view, cv, j.x, j.y);
      if (Math.hypot(p.x - js.x, p.y - js.y) < 16) { jHit = j; break; }
    }
    const tScreen = worldToScreen(view, cv, swarm.target.x, swarm.target.y);
    if (jHit) {
      selectedJammer = jHit; dragMode = 'jammer'; updateJammerPanel();
    } else if (Math.hypot(p.x - tScreen.x, p.y - tScreen.y) < 26) {
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
    if (dragMode === 'orbit' && lastMouse) {
      orbitCamera3D(cam3D, p.x - lastMouse.x, p.y - lastMouse.y);
      lastMouse = p;
      return;
    }
    if (dragMode === 'target') {
      const w = screenToWorld(view, cv, p.x, p.y);
      swarm.target.x = w.x; swarm.target.y = w.y;
    } else if (dragMode === 'jammer' && selectedJammer) {
      const w = screenToWorld(view, cv, p.x, p.y);
      selectedJammer.x = w.x; selectedJammer.y = w.y;
    } else if (dragMode === 'pan' && lastMouse) {
      view.cx -= (p.x - lastMouse.x) / view.pxPerM;
      view.cy -= (p.y - lastMouse.y) / view.pxPerM;
    }
    lastMouse = p;
  });

  cv.addEventListener('pointerup', () => { dragMode = null; lastMouse = null; });

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    if (view3D) {
      zoomCamera3D(cam3D, e.deltaY < 0 ? 1 / 1.15 : 1.15);
      return;
    }
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
    kpiRelays.textContent = status.relayCount;
    kpiMission.textContent = status.missionCount;
    kpiContact.textContent = status.freshCount + '/' + status.aliveCount;
    kpiPackets.textContent = swarm.net.delivered.toLocaleString();
    // Payload capacity: hop-divided air rate, minus what C2 traffic is already
    // burning, capped by any legal duty cycle.
    const effKbps = chainThroughputKbps(radio, status.hops.length)
      * Math.max(0, 1 - swarm.net.utilization) * (radio.dutyCycle ?? 1);
    kpiThroughput.textContent = status.connected
      ? (effKbps >= 1000 ? (effKbps / 1000).toFixed(1) + ' Mbps'
        : effKbps.toFixed(effKbps < 10 ? 1 : 0) + ' kbps')
      : '—';
    chanLine.textContent = 'Channel busy ' + (swarm.net.utilization * 100).toFixed(1) + '% with C2 traffic'
      + (radio.dutyCycle ? ' · ' + (radio.dutyCycle * 100) + '% legal duty cycle' : '');
    kpiClock.textContent = fmtSimClock(swarm.time);

    if (!status.aliveCount) {
      statusPill.textContent = 'Swarm down';
      statusPill.className = 'pill lost';
    } else if (status.connected) {
      statusPill.textContent = 'Connected — ' + status.hops.length + ' hop' + (status.hops.length > 1 ? 's' : '');
      statusPill.className = 'pill ok';
    } else if (status.freshCount > 0) {
      statusPill.textContent = 'Flock out of contact — C2 sees ' + status.freshCount + '/' + status.aliveCount;
      statusPill.className = 'pill warn';
    } else {
      statusPill.textContent = 'All contact lost';
      statusPill.className = 'pill lost';
    }

    hopsBody.innerHTML = status.hops.map((h, i) =>
      '<tr class="' + h.state + '"><td>' + h.a.label + ' → ' + h.b.label + '</td><td>' + fmtDist(h.distM) +
      '</td><td>' + h.marginDb.toFixed(0) + ' dB</td><td>' + (h.lossPct < 1 ? '<1' : h.lossPct.toFixed(0)) + '%</td></tr>'
    ).join('') || '<tr><td colspan="4" class="dim">no links</td></tr>';

    fleetBody.innerHTML = swarm.drones.map(d => {
      const sel = d === selected ? ' style="outline:1px solid #e2e8f0;"' : '';
      const role = effRole(d);
      return '<div class="fleet-row role-' + role + '"' + sel + ' data-id="' + d.id + '">' +
        '<span class="dot"></span><span class="fid">' + d.id + '</span>' +
        '<span class="frole">' + role + '</span>' +
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
      // Real vehicles fly in real time — no fast-forward when a bridge is
      // driving the drones; force 1x so sim time tracks the wall clock.
      const scale = (typeof externalActive === 'function' && externalActive()) ? 1 : timeScale;
      let simDt = realDt * scale;
      // substep so physics stays stable at high time scales
      const maxStep = 0.25;
      while (simDt > 0) {
        const step = Math.min(maxStep, simDt);
        status = stepSwarm(swarm, step);
        simDt -= step;
      }
    }
    if (!status) status = chainStatus(swarm);

    if (view3D) renderView3D(ctx, cv, swarm, status, cam3D, selected);
    else render(ctx, cv, view, swarm, status, selected, usable());

    panelAccum += realDt;
    if (panelAccum > 0.2) { updatePanels(status); panelAccum = 0; }

    requestAnimationFrame(frame);
  }

  // Debug/inspection handle (also handy from the devtools console)
  window.sim = {
    get swarm() { return swarm; },
    get radio() { return radio; },
    view,
    setTimeScale(v) { timeScale = v; },
  };

  // --- Boot -------------------------------------------------------------------
  resize();
  countOut.textContent = countRange.value;
  updateAirframeInfo();
  updateSpecCard();
  applySpacing();
  resetSwarm();
  distOut.textContent = fmtDist(+distRange.value / 100 * defaultTargetDist());
  document.querySelector('[data-speed="5"]').classList.add('active');
  requestAnimationFrame(frame);
})();

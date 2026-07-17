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
  let forcedSeed = null; // set by applyScenario so a loaded scenario is exact
  function resetSwarm() {
    const dist = +distRange.value / 100 * defaultTargetDist();
    missionSeq += 1;
    const tX = dist, tY = -dist * 0.25;
    const terrainSeed = forcedSeed != null ? forcedSeed : 42 + missionSeq;
    const terrain = makeTerrain(terrainSel.value, {
      distM: Math.hypot(tX, tY), altM: +altRange.value,
      targetX: tX, targetY: tY, seed: terrainSeed,
      density: +cityDensityRange.value / 100, heightScale: +cityHeightRange.value / 100,
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
      seed: terrainSeed,
    });
    selected = null; selectedJammer = null;
    swarm._terrainSeed = terrainSeed;
    swarm.showCoverage = coverageChk.checked;
    cam3D = view3D ? makeCamera3D(swarm) : null;
    if (typeof updateJammerPanel === 'function') updateJammerPanel();
    if (typeof updateCityLabels === 'function') updateCityLabels();
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
      cityDensity: +cityDensityRange.value, cityHeight: +cityHeightRange.value,
      seed: swarm._terrainSeed,
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
    if (sc.cityDensity != null) cityDensityRange.value = sc.cityDensity;
    if (sc.cityHeight != null) cityHeightRange.value = sc.cityHeight;
    if (sc.windSpd != null) windSpdRange.value = sc.windSpd;
    if (sc.windDir != null) windDirRange.value = sc.windDir;
    if (sc.corridor != null) corridorChk.checked = sc.corridor;
    if (sc.broadcast != null) bcastChk.checked = sc.broadcast;
    if (sc.coverage != null) coverageChk.checked = sc.coverage;
    updateSpecCard(); updateAirframeInfo(); applySpacing();
    forcedSeed = sc.seed != null ? sc.seed : null; // exact same map if the file has a seed
    resetSwarm();
    forcedSeed = null;
    if (sc.target) { swarm.target.x = sc.target.x; swarm.target.y = sc.target.y; }
    if (sc.jammers) sc.jammers.forEach(j => swarm.jammers.push({ id: 'JX-load' + Math.round(j.x) + '_' + Math.round(j.y), ...j }));
    fitView(); updateJammerPanel(); if (typeof updateCityLabels === 'function') updateCityLabels();
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
    if (typeof updateCityLabels === 'function') updateCityLabels();
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

  // --- City density / height sliders — regenerate the buildings live (same
  // seed, same mission) so you can dial from a couple of buildings to a dense
  // metropolis without relaunching.
  const cityDensityRange = el('cityDensityRange'), cityDensityOut = el('cityDensityOut');
  const cityHeightRange = el('cityHeightRange'), cityHeightOut = el('cityHeightOut');
  const cityNote = el('cityNote');
  function updateCityLabels() {
    const nB = swarm ? swarm.terrain.buildings.length : 0;
    cityDensityOut.textContent = nB ? nB.toLocaleString() : '0';
    const maxBH = swarm && swarm.terrain.buildings.length
      ? Math.round(Math.max.apply(null, swarm.terrain.buildings.map(b => b.heightM))) : 0;
    cityHeightOut.textContent = '≤' + Math.round(35 + (+cityHeightRange.value / 100) * 265) + ' m';
    // Guide the user when towers rise above the flight altitude.
    const alt = swarm ? swarm.altitudeM : +altRange.value;
    if (maxBH > alt + 5) {
      cityNote.style.display = 'block';
      cityNote.innerHTML = 'Towers reach <b>' + maxBH + ' m</b>, above your <b>' + alt + ' m</b> altitude — the swarm must weave through the streets (a dense tall city can be impassable). Raise <b>Altitude AGL</b> above the towers to fly over it (use a longer-range radio, since the climb lengthens the link to the ground station).';
    } else {
      cityNote.style.display = 'none';
    }
  }
  window.updateCityLabels = updateCityLabels;
  function regenerateCity() {
    if (!swarm) return;
    const tX = swarm.target.x, tY = swarm.target.y;
    swarm.terrain = makeTerrain(terrainSel.value, {
      distM: Math.hypot(tX, tY), altM: swarm.altitudeM,
      targetX: tX, targetY: tY, seed: swarm._terrainSeed || 42,
      density: +cityDensityRange.value / 100, heightScale: +cityHeightRange.value / 100,
    });
    updateCityLabels();
  }
  cityDensityRange.addEventListener('input', regenerateCity);
  cityHeightRange.addEventListener('input', regenerateCity);

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
  const addJammerBtn = el('addJammerBtn'), clearJammersBtn = el('clearJammersBtn');
  const jammerIntro = el('jammerIntro'), jammerPanel = el('jammerPanel');
  const jammerPowerRow = el('jammerPowerRow'), jammerPowerRange = el('jammerPowerRange'), jammerPowerOut = el('jammerPowerOut');
  const jammerBtnRow = el('jammerBtnRow'), jammerToggleBtn = el('jammerToggleBtn'), jammerRemoveBtn = el('jammerRemoveBtn');

  function updateJammerPanel() {
    const j = selectedJammer;
    const on = j && j.on !== false;
    const count = swarm.jammers.length;
    clearJammersBtn.style.display = count ? 'inline-block' : 'none';
    jammerPowerRow.style.display = j ? 'flex' : 'none';
    jammerBtnRow.style.display = j ? 'flex' : 'none';
    jammerPanel.style.display = count ? 'block' : 'none';
    if (j) {
      jammerPowerRange.value = j.erpDbm;
      jammerPowerOut.textContent = j.erpDbm + ' dBm';
      jammerToggleBtn.textContent = on ? 'Turn off' : 'Turn on';
      jammerPanel.innerHTML = '<b>' + count + '</b> source' + (count === 1 ? '' : 's') + ' placed · editing <b>' + j.id + '</b>: ' +
        (on ? 'red zone radius <b>' + fmtDist(jammerDenialRadiusM(swarm, j)) + '</b>' : 'off') +
        '. Drag it on the map; raise Strength for a bigger zone.';
    } else if (count) {
      jammerPanel.innerHTML = '<b>' + count + '</b> source' + (count === 1 ? '' : 's') + ' placed. Click one on the map to move or tune it.';
    }
  }
  window.updateJammerPanel = updateJammerPanel; // pointer handler calls it on select

  addJammerBtn.addEventListener('click', () => {
    // Spread new sources along the mission corridor so they don't pile up on
    // one spot, and place the first just BESIDE the chain (zone edge grazing
    // it) so you see the swarm route around rather than a total blackout.
    const erp = +jammerPowerRange.value;
    const R = jammerDenialRadiusM(swarm, { erpDbm: erp, on: true, band: 'all' }) || usable() * 0.4;
    const n = swarm.jammers.length;
    const B = swarm.base, T = swarm.target;
    const L = Math.hypot(T.x - B.x, T.y - B.y) || 1;
    const ux = (T.x - B.x) / L, uy = (T.y - B.y) / L, px = -uy, py = ux;
    const alongF = 0.5 + ((n % 3) - 1) * 0.14;              // 0.36 / 0.5 / 0.64 along the corridor
    const off = (R * 0.9 + Math.floor(n / 2) * R * 0.6) * ((n % 2) ? -1 : 1); // beside it, alternating, spreading out
    const j = makeJammer(B.x + ux * L * alongF + px * off, B.y + uy * L * alongF + py * off, erp);
    swarm.jammers.push(j);
    selectedJammer = j;
    updateJammerPanel();
  });
  clearJammersBtn.addEventListener('click', () => {
    swarm.jammers = []; selectedJammer = null; updateJammerPanel();
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
    // Keep the panel useful: fall to the next remaining source instead of
    // hiding all controls (which looked like the whole thing vanished).
    selectedJammer = swarm.jammers[swarm.jammers.length - 1] || null;
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
  let dragMode = null; // 'target' | 'pan' | 'orbit' | 'jammer' | 'pinch'
  let lastMouse = null;
  const pointers = new Map(); // active pointers on the canvas — 2 fingers = pinch zoom
  let lastPinch = null;       // { dist, mid } of the previous pinch frame

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
    pointers.set(e.pointerId, p);
    // Second finger down → pinch zoom takes over whatever drag was happening.
    if (pointers.size === 2) {
      dragMode = 'pinch'; lastPinch = null; lastMouse = null;
      cv.setPointerCapture(e.pointerId);
      return;
    }
    // Hit radii are in canvas px: scale with DPR, and widen for fingers.
    const hitU = (window.uiScale || 1) * (e.pointerType === 'touch' ? 1.6 : 1);
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
      if (Math.hypot(p.x - js.x, p.y - js.y) < 16 * hitU) { jHit = j; break; }
    }
    const tScreen = worldToScreen(view, cv, swarm.target.x, swarm.target.y);
    if (jHit) {
      selectedJammer = jHit; dragMode = 'jammer'; updateJammerPanel();
    } else if (Math.hypot(p.x - tScreen.x, p.y - tScreen.y) < 26 * hitU) {
      dragMode = 'target';
    } else {
      // Drone hit test (screen space)
      let hit = null;
      for (const d of swarm.drones) {
        const s = worldToScreen(view, cv, d.x, d.y);
        if (Math.hypot(p.x - s.x, p.y - s.y) < 14 * hitU) { hit = d; break; }
      }
      if (hit) { selected = hit; dragMode = null; }
      else dragMode = 'pan';
    }
    lastMouse = p;
    cv.setPointerCapture(e.pointerId);
  });

  cv.addEventListener('pointermove', e => {
    const p = canvasPos(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (dragMode === 'pinch') {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (lastPinch && dist > 0 && lastPinch.dist > 0) {
        const factor = dist / lastPinch.dist;
        if (view3D) {
          zoomCamera3D(cam3D, 1 / factor);
        } else {
          // Zoom about the pinch midpoint (same math as the wheel handler)…
          const before = screenToWorld(view, cv, mid.x, mid.y);
          view.pxPerM = Math.min(20, Math.max(0.001, view.pxPerM * factor));
          const after = screenToWorld(view, cv, mid.x, mid.y);
          view.cx += before.x - after.x;
          view.cy += before.y - after.y;
          // …and let two fingers pan with the midpoint drift.
          view.cx -= (mid.x - lastPinch.mid.x) / view.pxPerM;
          view.cy -= (mid.y - lastPinch.mid.y) / view.pxPerM;
        }
      }
      lastPinch = { dist, mid };
      return;
    }
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

  cv.addEventListener('pointerup', e => {
    pointers.delete(e.pointerId);
    if (dragMode === 'pinch') {
      // Keep pinching only while two fingers remain; one finger left ends it
      // cleanly rather than falling back into a surprise pan.
      if (pointers.size < 2) { dragMode = null; lastPinch = null; }
    } else {
      dragMode = null;
    }
    lastMouse = null;
  });
  cv.addEventListener('pointercancel', e => {
    pointers.delete(e.pointerId);
    dragMode = null; lastPinch = null; lastMouse = null;
  });

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
    // Back the canvas at native device resolution (capped at 3×) so phones get
    // a crisp image instead of an upscaled blur. All fixed screen-px drawing
    // (fonts, line widths, markers) multiplies by window.uiScale to stay the
    // same physical size; world content scales through fitView/pxPerM.
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    window.uiScale = dpr;
    cv.width = Math.floor(r.width * dpr);
    cv.height = Math.floor(r.height * dpr);
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

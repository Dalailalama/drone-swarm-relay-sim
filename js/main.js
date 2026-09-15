// Main controller: UI wiring, sim loop, camera, interaction.

(function () {
  const cv = document.getElementById('map');
  const ctx = cv.getContext('2d');

  // --- UI elements ----------------------------------------------------------
  const el = id => document.getElementById(id);
  const radioSel = el('radioSel'), envSel = el('envSel');
  const airframeSel = el('airframeSel'), airframeInfo = el('airframeInfo');
  const heteroChk = el('heteroChk'), heteroRow = el('heteroRow'), heteroInfo = el('heteroInfo');
  const wingRange = el('wingRange'), wingOut = el('wingOut');
  const relayAirframeSel = el('relayAirframeSel'), relayRadioSel = el('relayRadioSel');
  const countRange = el('countRange'), countOut = el('countOut');
  const distRange = el('distRange'), distOut = el('distOut');
  const altRange = el('altRange'), altOut = el('altOut');
  const windSpdRange = el('windSpdRange'), windSpdOut = el('windSpdOut');
  const windDirRange = el('windDirRange'), windDirOut = el('windDirOut');
  const spacingRange = el('spacingRange'), spacingOut = el('spacingOut'), spacingInfo = el('spacingInfo');
  const corridorChk = el('corridorChk'), corridorOut = el('corridorOut');
  const agilityChk = el('agilityChk'), agilityOut = el('agilityOut');
  const lpiChk = el('lpiChk'), lpiOut = el('lpiOut');
  const videoChk = el('videoChk'), videoOut = el('videoOut');
  const videoKbpsRow = el('videoKbpsRow'), videoKbpsRange = el('videoKbpsRange'), videoKbpsOut = el('videoKbpsOut');
  const payloadInfo = el('payloadInfo');
  const advChk = el('advChk');
  const terrainSel = el('terrainSel'), coverageChk = el('coverageChk');
  const cityDensityRange = el('cityDensityRange'), cityDensityOut = el('cityDensityOut');
  const cityHeightRange = el('cityHeightRange'), cityHeightOut = el('cityHeightOut');
  const cityNote = el('cityNote');
  const osmRow = el('osmRow'), osmPlace = el('osmPlace'), osmNote = el('osmNote');
  const osmRadiusRange = el('osmRadiusRange'), osmRadiusOut = el('osmRadiusOut'), osmLoadBtn = el('osmLoadBtn');
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

  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function syncExternalBridge() {
    if (typeof externalActive === 'function' && externalActive() && typeof externalReinit === 'function') {
      externalReinit(() => swarm, +countRange.value, +altRange.value);
    }
  }

  // The ids shipped with the app — a scenario file must never rewrite these
  // definitions in place (finding #7): imports that collide land beside the
  // original under a marked id instead of silently corrupting its physics.
  const BUILTIN_RADIO_IDS = new Set(RADIOS.map(r => r.id));

  // Imported presets are UNTRUSTED scenario data (finding #7): whitelist the
  // fields, validate every number against loose physical sanity bounds, cap
  // every string. A preset that lies about a number is rejected whole — a
  // wrong link budget is worse than a missing radio.
  const PRESET_NUM_FIELDS = {
    freqMHz: [30, 60000], txDbm: [-20, 60], sensDbm: [-140, -50],
    antGainDbi: [-10, 30], airRateKbps: [0.05, 2e6], rangeLosM: [10, 5e6],
    dutyCycle: [0.0001, 1], refPowerDbm: [-120, 40], nFit: [1.2, 6.5], hopGainDb: [-10, 30],
  };
  function sanitizeRadioPreset(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,48}$/.test(id)) return null;
    const p = { id };
    p.name = String(raw.name || id).slice(0, 60);
    p.note = String(raw.note || '').slice(0, 400);
    if (raw.source != null) p.source = String(raw.source).slice(0, 200);
    if (raw.band != null) p.band = String(raw.band).slice(0, 16);
    if (raw.calibrated != null) p.calibrated = !!raw.calibrated;
    for (const k of Object.keys(PRESET_NUM_FIELDS)) {
      if (raw[k] == null) continue;
      const v = +raw[k];
      const lo = PRESET_NUM_FIELDS[k][0], hi = PRESET_NUM_FIELDS[k][1];
      if (!isFinite(v) || v < lo || v > hi) return null;
      p[k] = v;
    }
    for (const k of ['freqMHz', 'txDbm', 'sensDbm', 'airRateKbps', 'rangeLosM']) {
      if (p[k] == null) return null; // unusable by the link-budget math
    }
    return p;
  }

  function registerRadioPreset(raw) {
    const preset = sanitizeRadioPreset(raw);
    if (!preset) return null;
    if (BUILTIN_RADIO_IDS.has(preset.id)) {
      preset.id = preset.id + '-imported';
      if (!/\(imported\)$/.test(preset.name)) preset.name = preset.name + ' (imported)';
    }
    let existing = RADIOS.find(r => r.id === preset.id);
    if (existing) {
      Object.assign(existing, preset); // re-import of a custom preset updates it
      return existing;
    }
    RADIOS.push(preset);
    [radioSel, relayRadioSel, calRadioSel].forEach(sel => {
      if (!sel) return;
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.name + (preset.calibrated ? ' (Calibrated)' : '');
      sel.appendChild(opt);
    });
    return preset;
  }

  function resetControlsToDefaults() {
    radioSel.value = RADIOS[0].id;
    radio = RADIOS[0];
    envSel.value = ENVIRONMENTS[0].id;
    env = ENVIRONMENTS[0];
    airframeSel.value = AIRFRAMES[1].id;
    airframe = AIRFRAMES[1];
    heteroChk.checked = false;
    wingRange.value = 4;
    wingOut.textContent = '4';
    relayAirframeSel.value = 'x8';
    relayRadioSel.value = 'rfd900x';
    countRange.value = 10;
    countOut.textContent = '10';
    altRange.value = 50;
    altOut.textContent = '50 m';
    distRange.value = 100;
    distOut.textContent = '—';
    spacingRange.value = 80;
    spacingOut.textContent = '80%';
    corridorChk.checked = true;
    agilityChk.checked = false;
    lpiChk.checked = false;
    advChk.checked = false;
    videoChk.checked = false;
    videoKbpsRange.value = 500;
    videoKbpsOut.textContent = '500 kbps';
    if (videoKbpsRow) videoKbpsRow.style.display = 'none';
    terrainSel.value = 'flat';
    cityDensityRange.value = 40;
    cityHeightRange.value = 40;
    windSpdRange.value = 0;
    windSpdOut.textContent = '0 m/s';
    windDirRange.value = 0;
    windDirOut.textContent = '0°';
    coverageChk.checked = true;
    bcastChk.checked = true;
    captureChk.checked = false;
    captureOut.textContent = 'off';
    exportBtn.disabled = true;
    if (osmPlace) osmPlace.value = '';
    if (osmRadiusRange) osmRadiusRange.value = 1200;
    if (osmRadiusOut) osmRadiusOut.textContent = '1.2 km';
    osmArea = null;
    osmLoadToken++;
    updateHeteroRow();
    updateOsmRow();
  }

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
    const r = o.cloneNode(); r.textContent = a.name;
    relayAirframeSel.appendChild(r);
  });
  RADIOS.forEach(r0 => {
    const o = document.createElement('option');
    o.value = r0.id; o.textContent = r0.name;
    relayRadioSel.appendChild(o);
  });
  // Default relay wing: the endurance airframe on the long-range radio.
  relayAirframeSel.value = 'x8';
  relayRadioSel.value = 'rfd900x';

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
  function resetSwarm(geom) {
    let tX, tY, baseX = 0, baseY = 0;
    if (geom && geom.target) {
      tX = geom.target.x;
      tY = geom.target.y;
      if (geom.base) {
        baseX = geom.base.x;
        baseY = geom.base.y;
      }
      const span = Math.hypot(tX - baseX, tY - baseY);
      distOut.textContent = fmtDist(span);
    } else {
      const dist = +distRange.value / 100 * defaultTargetDist();
      distOut.textContent = fmtDist(dist);
      tX = dist;
      tY = -dist * 0.25;
    }
    missionSeq += 1;
    const terrainSeed = forcedSeed != null ? forcedSeed : 42 + missionSeq;
    let terrain;
    if (terrainSel.value === 'osm' && osmArea) {
      // Real place: buildings are centered on the corridor midpoint (like the
      // procedural city), plus small cleared staging areas at the GCS and the
      // objective — you'd stage in a lot, not on somebody's roof.
      const cx = (tX + baseX) / 2, cy = (tY + baseY) / 2;
      const bs = osmArea.buildings.map(b => ({ x: b.x + cx, y: b.y + cy, w: b.w, d: b.d, heightM: b.heightM, estimated: b.estimated }));
      osmArea.cleared = osmClearZones(bs, [{ x: baseX, y: baseY, rM: 70 }, { x: tX, y: tY, rM: 60 }]);
      terrain = indexBuildings({ seed: terrainSeed, groundAmpM: 0, groundScaleM: 1, buildings: bs });
      // Pin the fetched area's geographic center to the corridor midpoint —
      // this is what lets the renderer draw the real map under the mission.
      terrain.geoAnchor = { lat: osmArea.lat, lon: osmArea.lon, x: cx, y: cy };
    } else {
      terrain = makeTerrain(terrainSel.value === 'osm' ? 'flat' : terrainSel.value, {
        distM: Math.hypot(tX - baseX, tY - baseY), altM: +altRange.value,
        baseX, baseY, targetX: tX, targetY: tY, seed: terrainSeed,
        density: +cityDensityRange.value / 100, heightScale: +cityHeightRange.value / 100,
      });
    }
    swarm = makeSwarm({
      terrain,
      count: +countRange.value,
      airframe,
      altitudeM: +altRange.value,
      deployFrac: +spacingRange.value / 100,
      corridorRouting: corridorChk.checked,
      broadcastC2: bcastChk.checked,
      captureOn: captureChk.checked,
      spectrumAgility: agilityChk.checked,
      lpiMode: lpiChk.checked,
      videoOn: videoChk.checked,
      videoKbps: +videoKbpsRange.value,
      adversaryMode: advChk.checked,
      windX: +windSpdRange.value * Math.cos(+windDirRange.value * Math.PI / 180),
      windY: +windSpdRange.value * Math.sin(+windDirRange.value * Math.PI / 180),
      baseX, baseY, targetX: tX, targetY: tY,
      radio, envFactor: env.factor,
      shadowSigmaDb: env.shadowSigmaDb,
      seed: terrainSeed,
      // Heterogeneous fleet: the relay wing flies its own airframe + radio.
      relayWing: heteroChk.checked ? +wingRange.value : 0,
      relayAirframe: AIRFRAMES.find(a => a.id === relayAirframeSel.value) || null,
      relayRadio: RADIOS.find(r => r.id === relayRadioSel.value) || null,
    });
    selected = null; selectedJammer = null; selectedZone = null;
    swarm._terrainSeed = terrainSeed;
    swarm.showCoverage = coverageChk.checked;
    cam3D = view3D ? makeCamera3D(swarm) : null;
    if (typeof updateJammerPanel === 'function') updateJammerPanel();
    if (typeof updateZonePanel === 'function') updateZonePanel();
    if (typeof updateCityLabels === 'function') updateCityLabels();
    updateOsmNote();
    fitView();
    syncExternalBridge();
    logEvent(swarm, 'Swarm launched: ' + swarm.drones.length + ' drones on ' + radio.name, 'info');
  }

  // Full scenario capture — every setting plus placed interference sources —
  // so a demo/study is reproducible and shareable as one JSON file.
  function currentScenario() {
    return {
      version: 1, radio: radio.id, env: env.id, airframe: airframe.id,
      hetero: heteroChk.checked,
      relayWing: +wingRange.value, relayAirframe: relayAirframeSel.value, relayRadio: relayRadioSel.value,
      count: +countRange.value, altitudeM: +altRange.value, spacingPct: +spacingRange.value,
      distancePct: +distRange.value, terrain: terrainSel.value,
      windSpd: +windSpdRange.value, windDir: +windDirRange.value,
      corridor: corridorChk.checked, broadcast: bcastChk.checked, coverage: coverageChk.checked,
      cityDensity: +cityDensityRange.value, cityHeight: +cityHeightRange.value,
      seed: swarm._terrainSeed,
      base: { x: swarm.base.x, y: swarm.base.y },
      osm: (terrainSel.value === 'osm' && osmArea)
        ? { lat: osmArea.lat, lon: osmArea.lon, radiusM: osmArea.radiusM, name: osmArea.name }
        : undefined,
      target: { x: swarm.target.x, y: swarm.target.y },
      jammers: swarm.jammers.map(j => ({ x: j.x, y: j.y, erpDbm: j.erpDbm, band: j.band, altM: j.altM, on: j.on })),
      gpsZones: (swarm.gpsZones || []).map(z => ({ x: z.x, y: z.y, rM: z.rM, on: z.on })),
      baseVelMps: (swarm.baseVel && (swarm.baseVel.x || swarm.baseVel.y)) ? { x: swarm.baseVel.x, y: swarm.baseVel.y } : undefined,
      targetVelMps: (swarm.targetVel && (swarm.targetVel.x || swarm.targetVel.y)) ? { x: swarm.targetVel.x, y: swarm.targetVel.y } : undefined,
      spectrumAgility: !!swarm.spectrumAgility,
      lpiMode: !!swarm.lpiMode,
      videoBackhaul: !!swarm.videoOn,
      videoKbps: swarm.videoKbps || 0,
      adversaryMode: !!swarm.adversaryMode,
    };
  }
  function applyScenario(sc) {
    resetControlsToDefaults();
    // Imported presets may be re-id'd (built-in collision) or rejected
    // (failed validation) — follow what registration actually produced,
    // never the file's claim (finding #7).
    if (sc.radioPreset) {
      const reg = registerRadioPreset(sc.radioPreset);
      if (reg && sc.radio === sc.radioPreset.id) sc.radio = reg.id;
    }
    if (typeof sc.radio === 'object' && sc.radio.id) {
      const reg = registerRadioPreset(sc.radio);
      sc.radio = reg ? reg.id : null;
    }
    if (sc.relayRadioPreset) {
      const reg = registerRadioPreset(sc.relayRadioPreset);
      if (reg && sc.relayRadio === sc.relayRadioPreset.id) sc.relayRadio = reg.id;
    }
    if (typeof sc.relayRadio === 'object' && sc.relayRadio.id) {
      const reg = registerRadioPreset(sc.relayRadio);
      sc.relayRadio = reg ? reg.id : null;
    }
    if (sc.radio) {
      const match = RADIOS.find(r => r.id === sc.radio);
      if (match) { radioSel.value = match.id; radio = match; }
    }
    if (sc.env) { envSel.value = sc.env; env = ENVIRONMENTS.find(e => e.id === sc.env) || env; }
    if (sc.airframe) { airframeSel.value = sc.airframe; airframe = AIRFRAMES.find(a => a.id === sc.airframe) || airframe; }
    if (sc.hetero != null) { heteroChk.checked = !!sc.hetero; updateHeteroRow(); }
    if (sc.relayWing != null) { wingRange.value = sc.relayWing; wingOut.textContent = sc.relayWing; }
    if (sc.relayAirframe) relayAirframeSel.value = sc.relayAirframe;
    if (sc.relayRadio) relayRadioSel.value = sc.relayRadio;
    if (sc.count != null) { countRange.value = sc.count; countOut.textContent = sc.count; }
    if (sc.altitudeM != null) { altRange.value = sc.altitudeM; altOut.textContent = sc.altitudeM + ' m'; }
    if (sc.spacingPct != null) { spacingRange.value = sc.spacingPct; spacingOut.textContent = sc.spacingPct + '%'; }
    if (sc.distancePct != null) distRange.value = sc.distancePct;
    if (sc.terrain) terrainSel.value = sc.terrain;
    if (sc.cityDensity != null) cityDensityRange.value = sc.cityDensity;
    if (sc.cityHeight != null) cityHeightRange.value = sc.cityHeight;
    if (sc.windSpd != null) { windSpdRange.value = sc.windSpd; windSpdOut.textContent = sc.windSpd + ' m/s'; }
    if (sc.windDir != null) { windDirRange.value = sc.windDir; windDirOut.textContent = sc.windDir + '°'; }
    if (sc.corridor != null) corridorChk.checked = sc.corridor;
    if (sc.spectrumAgility != null) agilityChk.checked = !!sc.spectrumAgility;
    if (sc.lpiMode != null) lpiChk.checked = !!sc.lpiMode;
    if (sc.adversaryMode != null) { advChk.checked = !!sc.adversaryMode; }
    if (sc.videoKbps != null) {
      videoKbpsRange.value = sc.videoKbps;
      videoKbpsOut.textContent = sc.videoKbps + ' kbps';
    }
    if (sc.videoBackhaul != null) {
      videoChk.checked = !!sc.videoBackhaul;
    } else if (sc.videoOn != null) {
      videoChk.checked = !!sc.videoOn;
    }
    videoKbpsRow.style.display = videoChk.checked ? 'flex' : 'none';
    if (sc.broadcast != null) bcastChk.checked = sc.broadcast;
    if (sc.coverage != null) coverageChk.checked = sc.coverage;
    if (sc.osm) {
      osmPlace.value = sc.osm.name || (sc.osm.lat + ', ' + sc.osm.lon);
      if (sc.osm.radiusM) { osmRadiusRange.value = sc.osm.radiusM; osmRadiusOut.textContent = fmtDist(sc.osm.radiusM); }
    }
    updateOsmRow();
    updateSpecCard(); updateAirframeInfo(); applySpacing();
    forcedSeed = sc.seed != null ? sc.seed : null; // exact same map if the file has a seed
    resetSwarm({ base: sc.base, target: sc.target });
    forcedSeed = null;
    const applyMissionOverrides = () => {
      if (sc.base) { swarm.base.x = sc.base.x; swarm.base.y = sc.base.y; }
      if (sc.target) { swarm.target.x = sc.target.x; swarm.target.y = sc.target.y; }
      swarm.jammers.length = 0;
      if (sc.jammers) sc.jammers.forEach(j => swarm.jammers.push({ id: 'JX-load' + Math.round(j.x) + '_' + Math.round(j.y), ...j }));
      swarm.gpsZones.length = 0;
      if (sc.gpsZones) sc.gpsZones.forEach(z => swarm.gpsZones.push({ id: 'GZ-load' + Math.round(z.x) + '_' + Math.round(z.y), ...z }));
      // Moving-mission dynamics (mission library): convoy base, drifting front.
      swarm.baseVel = sc.baseVelMps ? { x: sc.baseVelMps.x, y: sc.baseVelMps.y } : { x: 0, y: 0 };
      swarm.targetVel = sc.targetVelMps ? { x: sc.targetVelMps.x, y: sc.targetVelMps.y } : { x: 0, y: 0 };
      if (sc.spectrumAgility != null && 'spectrumAgility' in swarm) swarm.spectrumAgility = !!sc.spectrumAgility;
      fitView(); updateJammerPanel(); updateZonePanel(); if (typeof updateCityLabels === 'function') updateCityLabels();
    };
    applyMissionOverrides();
    logEvent(swarm, 'Scenario loaded', 'info');
    // A real-area scenario stores coordinates, not buildings: refetch from OSM
    // (needs internet), then re-pin the mission on the refreshed swarm.
    if (sc.terrain === 'osm' && sc.osm) {
      loadOsmArea(sc.osm.lat, sc.osm.lon, sc.osm.radiusM || 1200, sc.osm.name || null)
        .then(applyMissionOverrides)
        .catch(() => {}); // the note already explains the failure
    }
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
      '<p class="spec-note">' + escHtml(radio.note) + '</p>'; // preset strings are data, never markup (finding #7)
    applySpacing(); // hop-margin readout depends on radio + environment
  }

  // --- Controls -------------------------------------------------------------
  radioSel.addEventListener('change', () => {
    radio = RADIOS.find(r => r.id === radioSel.value);
    swarm.radio = radio;
    updateSpecCard();
    applyAgility();
    resetSwarm();
  });
  envSel.addEventListener('change', () => {
    env = ENVIRONMENTS.find(e => e.id === envSel.value);
    swarm.envFactor = env.factor;
    swarm.shadowSigmaDb = env.shadowSigmaDb;
    updateSpecCard();
    logEvent(swarm, 'Environment: ' + env.name + ' — usable range now ' + fmtDist(usable()), 'warn');
  });
  countRange.addEventListener('input', () => {
    countOut.textContent = countRange.value;
    el('scaleNote').style.display = +countRange.value >= 60 ? 'block' : 'none';
  });
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

  // --- Mixed fleet (heterogeneous swarms) -------------------------------------
  function updateHeteroRow() {
    heteroRow.style.display = heteroChk.checked ? 'block' : 'none';
    if (!heteroChk.checked) return;
    const waf = AIRFRAMES.find(a => a.id === relayAirframeSel.value);
    const wr = RADIOS.find(r => r.id === relayRadioSel.value);
    wingOut.textContent = wingRange.value;
    if (waf && wr) {
      const bandOk = bandCompatible(wr, radio);
      heteroInfo.innerHTML =
        '<b>Relay wing:</b> ' + escHtml(waf.name) + ' (~' + Math.round(hoverEnduranceMin(waf)) +
        ' min hover) on <b>' + escHtml(wr.name) + '</b> — usable ' + fmtDist(usableRangeM(wr, env.factor)) +
        (bandOk ? '' : ' <b style="color:var(--lost)">· different band from the tactical radio: the wing can bridge C2↔wing and wing↔wing, but tactical drones only link to their own kind</b>') +
        '.<br><b>Tactical:</b> ' + escHtml(airframe.name) + ' on ' + escHtml(radio.name) + ' — usable ' + fmtDist(usableRangeM(radio, env.factor)) + '.';
    }
  }
  heteroChk.addEventListener('change', () => { updateHeteroRow(); resetSwarm(); });
  wingRange.addEventListener('input', () => { wingOut.textContent = wingRange.value; });
  wingRange.addEventListener('change', () => { if (heteroChk.checked) resetSwarm(); });
  relayAirframeSel.addEventListener('change', () => { updateHeteroRow(); if (heteroChk.checked) resetSwarm(); });
  relayRadioSel.addEventListener('change', () => { updateHeteroRow(); if (heteroChk.checked) resetSwarm(); });
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
  // --- EW waveforms: spectrum agility + LPI/LPD --------------------------------
  function applyAgility() {
    if (!swarm) return;
    swarm.spectrumAgility = agilityChk.checked;
    const r = radio.hopGainDb;
    agilityOut.textContent = agilityChk.checked
      ? (r ? '+' + r + ' dB anti-jam on ' + radio.name.split(' ')[0] : 'no hopping capability on this radio')
      : 'frequency-hopping anti-jam';
  }
  function applyLpi() {
    if (!swarm) return;
    swarm.lpiMode = lpiChk.checked;
    lpiOut.textContent = lpiChk.checked ? '\u22123 dB budget · +6 dB denial rejection' : 'harder to detect, harder to jam';
  }
  agilityChk.addEventListener('change', () => {
    applyAgility();
    if (swarm) logEvent(swarm, 'Spectrum agility ' + (swarm.spectrumAgility ? 'ON — frequency hopping active' : 'off'), 'info');
  });
  lpiChk.addEventListener('change', () => {
    applyLpi();
    if (swarm) logEvent(swarm, 'LPI/LPD waveform ' + (swarm.lpiMode ? 'ON — trading link budget for survivability' : 'off'), 'info');
  });
  // --- Video backhaul -----------------------------------------------------------
  function applyVideo() {
    if (!swarm) return;
    swarm.videoOn = videoChk.checked;
    swarm.videoKbps = +videoKbpsRange.value;
    videoKbpsRow.style.display = videoChk.checked ? 'flex' : 'none';
    videoOut.textContent = videoChk.checked
      ? swarm.videoKbps + ' kbps · C2 schedules who streams'
      : 'payload competes for the chain';
  }
  videoChk.addEventListener('change', () => {
    applyVideo();
    if (swarm) logEvent(swarm, 'Video backhaul ' + (swarm.videoOn ? 'ON — C2 scheduling payload turns at ' + swarm.videoKbps + ' kbps' : 'off'), 'info');
  });
  videoKbpsRange.addEventListener('input', () => {
    videoKbpsOut.textContent = videoKbpsRange.value + ' kbps';
    applyVideo();
  });
  terrainSel.addEventListener('change', () => { updateOsmRow(); resetSwarm(); });

  // --- City density / height sliders — regenerate the buildings live (same
  // seed, same mission) so you can dial from a couple of buildings to a dense
  // metropolis without relaunching.
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
    if (!swarm || terrainSel.value === 'osm') return; // real buildings aren't dialable
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

  // --- Real areas from OpenStreetMap ------------------------------------------
  // The place box + Load button fetch actual building footprints and heights
  // for anywhere on Earth (js/osm.js) and drop the swarm over them.
  let osmArea = null; // { lat, lon, radiusM, name, buildings (centered on 0,0), dropped, cleared }
  const OSM_INTRO = osmNote.innerHTML;
  let osmLoadToken = 0;

  function updateOsmRow() {
    const isOsm = terrainSel.value === 'osm';
    osmRow.style.display = isOsm ? 'block' : 'none';
    // Real buildings aren't dialable — hide the procedural-city sliders.
    cityDensityRange.closest('.ctl-row').style.display = isOsm ? 'none' : '';
    cityHeightRange.closest('.ctl-row').style.display = isOsm ? 'none' : '';
  }

  function updateOsmNote() {
    if (terrainSel.value !== 'osm') return;
    if (!osmArea) { osmNote.innerHTML = OSM_INTRO; return; }
    const n = osmArea.buildings.length;
    const nEst = osmArea.buildings.reduce((a, b) => a + (b.estimated ? 1 : 0), 0);
    const pctMeasured = n ? Math.round(100 * (1 - nEst / n)) : 0;
    osmNote.innerHTML = '<b>' + escHtml(osmArea.name) + '</b>: <b>' + n.toLocaleString() + '</b> real buildings' +
      (pctMeasured > 0
        ? ' (' + pctMeasured + '% have surveyed heights; the rest are estimated from floor counts)'
        : ' (heights estimated from floor counts — OSM rarely has them surveyed)') +
      (osmArea.dropped ? ' &middot; kept the ' + OSM_MAX_BUILDINGS.toLocaleString() + ' largest of ' + (n + osmArea.dropped).toLocaleString() : '') +
      (osmArea.cleared ? ' &middot; ' + osmArea.cleared + ' cleared for the staging areas' : '') +
      '. Ground is flat in this version. Buildings &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener" style="color:var(--accent)">OpenStreetMap</a> contributors (ODbL).';
  }

  async function loadOsmArea(lat, lon, radiusM, name) {
    const token = ++osmLoadToken;
    osmLoadBtn.disabled = true; osmLoadBtn.textContent = 'Loading…';
    osmNote.innerHTML = 'Fetching real buildings from OpenStreetMap&hellip;';
    try {
      const area = await osmFetchArea(lat, lon, radiusM);
      if (token !== osmLoadToken) return;
      if (!area.buildings.length) throw new Error('No mapped buildings there — try a bigger radius or a denser place');
      area.name = name || (lat.toFixed(4) + ', ' + lon.toFixed(4));
      osmArea = area;
      resetSwarm();
      syncTakOrigin();
      logEvent(swarm, 'Real area loaded: ' + escHtml(area.name) + ' — ' + area.buildings.length + ' buildings', 'info');
    } catch (e) {
      if (token !== osmLoadToken) return;
      osmNote.innerHTML = '<b style="color:var(--lost)">' + escHtml(e.message) + '</b> &middot; This feature needs internet, and the free OSM servers are sometimes busy — try again in a minute.';
      throw e;
    } finally {
      if (token === osmLoadToken) {
        osmLoadBtn.disabled = false; osmLoadBtn.textContent = 'Load real area';
      }
    }
  }

  osmLoadBtn.addEventListener('click', async () => {
    const txt = osmPlace.value.trim();
    if (!txt) { osmNote.innerHTML = 'Type a place name or paste <b>lat, lon</b> first.'; return; }
    const r = +osmRadiusRange.value;
    let ll = osmParseLatLon(txt), name = null;
    if (!ll) {
      osmNote.innerHTML = 'Finding the place&hellip;';
      try {
        const g = await osmGeocode(txt);
        ll = g; name = (g.name || txt).split(',').slice(0, 2).join(',');
      } catch (e) {
        osmNote.innerHTML = '<b style="color:var(--lost)">' + e.message + '</b> &middot; Check the spelling, or paste coordinates as <b>lat, lon</b>.';
        return;
      }
    }
    await loadOsmArea(ll.lat, ll.lon, r, name).catch(() => {}); // note shows the error
  });
  osmRadiusRange.addEventListener('input', () => { osmRadiusOut.textContent = fmtDist(+osmRadiusRange.value); });

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
      jammerPanel.innerHTML = '<b>' + count + '</b> source' + (count === 1 ? '' : 's') + ' placed · editing <b>' + escHtml(j.id) + '</b>: ' +
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

  // --- GPS-denied zones (navigation denial, not RF denial) --------------------
  const addGpsZoneBtn = el('addGpsZoneBtn');
  const zonePanel = el('zonePanel'), zoneBtnRow = el('zoneBtnRow');
  const zoneToggleBtn = el('zoneToggleBtn'), zoneRemoveBtn = el('zoneRemoveBtn');
  let selectedZone = null;

  function updateZonePanel() {
    const z = selectedZone;
    const count = swarm.gpsZones ? swarm.gpsZones.length : 0;
    zoneBtnRow.style.display = z ? 'flex' : 'none';
    if (z) {
      zoneToggleBtn.textContent = z.on === false ? 'Turn on' : 'Turn off';
      zonePanel.style.display = 'block';
      zonePanel.innerHTML = 'Editing <b>' + escHtml(z.id) + '</b> — a <b>' + fmtDist(z.rM) +
        '</b> radius where GNSS is denied. Drones cross it on dead reckoning: their reported positions drift, and C2 plans around that.';
    } else {
      zonePanel.style.display = count ? 'block' : 'none';
      if (count) zonePanel.innerHTML = '<b>' + count + '</b> GPS-denied zone' + (count === 1 ? '' : 's') +
        '. Click one on the map to move or toggle it.';
    }
  }
  window.updateZonePanel = updateZonePanel;

  // --- Red-team adversary mode ---------------------------------------------------
  advChk.addEventListener('change', () => {
    if (swarm) swarm.adversaryMode = advChk.checked;
    if (swarm && advChk.checked) logEvent(swarm, 'RED TEAM: interference sources now direction-find swarm traffic', 'error');
  });

  addGpsZoneBtn.addEventListener('click', () => {
    // First outage lands astride the mid-corridor (where the chain lives);
    // later ones stagger along it so multiple zones don't stack.
    const n = swarm.gpsZones.length;
    const B = swarm.base, T = swarm.target;
    const L = Math.hypot(T.x - B.x, T.y - B.y) || 1;
    const ux = (T.x - B.x) / L, uy = (T.y - B.y) / L, px = -uy, py = ux;
    const f = 0.5 + ((n % 3) - 1) * 0.16;
    const off = Math.floor(n / 3) * 300 * ((n % 2) ? -1 : 1);
    const rM = Math.max(150, Math.min(800, usable() * 0.5));
    const z = makeGpsZone(B.x + ux * L * f + px * off, B.y + uy * L * f + py * off, rM);
    swarm.gpsZones.push(z);
    selectedJammer = null; selectedZone = z;
    updateZonePanel(); updateJammerPanel();
  });
  zoneToggleBtn.addEventListener('click', () => {
    if (!selectedZone) return;
    selectedZone.on = selectedZone.on === false;
    updateZonePanel();
  });
  zoneRemoveBtn.addEventListener('click', () => {
    if (!selectedZone) return;
    swarm.gpsZones = swarm.gpsZones.filter(z => z !== selectedZone);
    selectedZone = swarm.gpsZones[swarm.gpsZones.length - 1] || null;
    updateZonePanel();
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

  // --- DDIL scenario pack (bundled one-click demos) ---------------------------
  const packSel = el('packSel'), packBlurb = el('packBlurb'), loadPackBtn = el('loadPackBtn');
  SCENARIO_PACK.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = p.title;
    packSel.appendChild(o);
  });
  function syncPackBlurb() {
    const p = SCENARIO_PACK[+packSel.value || 0];
    if (p) packBlurb.textContent = p.blurb;
  }
  packSel.addEventListener('change', syncPackBlurb);
  syncPackBlurb();
  loadPackBtn.addEventListener('click', () => {
    const p = SCENARIO_PACK[+packSel.value || 0];
    if (!p) return;
    applyScenario(p.scenario);
    logEvent(swarm, 'Loaded scenario: ' + p.title, 'info');
  });

  // --- Vertical mission library (with moving-mission dynamics) -----------------
  const missionSel = el('missionSel'), missionBlurb = el('missionBlurb'), loadMissionBtn = el('loadMissionBtn');
  MISSION_LIBRARY.forEach((m, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = m.vertical + ' — ' + m.title;
    missionSel.appendChild(o);
  });
  function syncMissionBlurb() {
    const m = MISSION_LIBRARY[+missionSel.value || 0];
    if (!m) return;
    missionBlurb.innerHTML = '<b>' + m.title + '</b><br>' + m.blurb +
      '<ul style="margin:6px 0 0 16px; padding:0;">' +
      m.checklist.map(c => '<li>' + c + '</li>').join('') + '</ul>';
  }
  missionSel.addEventListener('change', syncMissionBlurb);
  syncMissionBlurb();
  loadMissionBtn.addEventListener('click', () => {
    const m = MISSION_LIBRARY[+missionSel.value || 0];
    if (!m) return;
    const sc = Object.assign({}, m.scenario);
    if (m.dynamics && m.dynamics.baseVelMps) sc.baseVelMps = m.dynamics.baseVelMps;
    if (m.dynamics && m.dynamics.targetVelMps) sc.targetVelMps = m.dynamics.targetVelMps;
    applyScenario(sc);
    logEvent(swarm, 'Mission loaded: ' + m.title +
      (sc.baseVelMps ? ' — command vehicle moving at ' + Math.hypot(sc.baseVelMps.x, sc.baseVelMps.y).toFixed(1) + ' m/s' : '') +
      (sc.targetVelMps ? ' — objective drifting' : ''), 'info');
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

  // --- Sim-to-real calibration loop --------------------------------------------
  const calRadioSel = el('calRadioSel'), calPickBtn = el('calPickBtn');
  const calFileInput = el('calFileInput'), calFitBtn = el('calFitBtn');
  const calResult = el('calResult'), calOutRow = el('calOutRow');
  RADIOS.forEach(r => {
    const o = document.createElement('option');
    o.value = r.id; o.textContent = r.name;
    calRadioSel.appendChild(o);
  });
  let calText = null, calReport = null, calPresetJson = null;

  calPickBtn.addEventListener('click', () => calFileInput.click());
  calFileInput.addEventListener('change', ev => {
    const file = ev.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      calText = String(reader.result || '');
      calFitBtn.disabled = !calText;
      if (calText) calResult.textContent = file.name + ' loaded (' + file.size + ' bytes) — ready to fit.';
      calOutRow.style.display = 'none';
    };
    reader.readAsText(file);
    ev.target.value = '';
  });
  calFitBtn.addEventListener('click', () => {
    if (!calText) return;
    const basePreset = RADIOS.find(r => r.id === calRadioSel.value) || radio;
    const parsed = parseFlightLogCsv(calText);
    const fit = fitPathLoss(parsed.samples);
    if (!fit.ok) {
      calResult.innerHTML = '<b style="color:var(--lost)">Fit failed:</b> ' + escHtml(fit.reason) +
        (parsed.notes.length ? '<br>' + parsed.notes.map(escHtml).join('<br>') : '');
      return;
    }
    const cal = calibratePreset(fit, basePreset);
    registerRadioPreset(cal);
    calReport = validationReportMd(fit, basePreset, parsed.samples, parsed);
    calPresetJson = JSON.stringify(cal, null, 1);
    const dsN = pathLossExponent(basePreset);
    const drift = fit.n - dsN;
    calResult.innerHTML =
      '<b>Fit complete</b> — ' + fit.count + ' samples<br>' +
      'measured n = <b>' + fit.n.toFixed(2) + '</b> (datasheet model: ' + dsN.toFixed(2) +
        ', drift ' + (drift >= 0 ? '+' : '') + drift.toFixed(2) + ')<br>' +
      'RMSE <b>' + fit.rmse.toFixed(1) + ' dB</b> · R² <b>' + fit.r2.toFixed(3) + '</b><br>' +
      're-derived rated range: <b>' + fmtDist(cal.rangeLosM) + '</b> (was ' + fmtDist(basePreset.rangeLosM) + ')';
    calOutRow.style.display = 'flex';
  });
  el('calReportBtn').addEventListener('click', () => {
    if (calReport) download(calReport, 'rf-calibration-report.md', 'text/markdown');
  });
  el('calPresetBtn').addEventListener('click', () => {
    if (calPresetJson) download(calPresetJson, 'radio-preset-calibrated.json', 'application/json');
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

  // --- ATAK / TAK (Cursor-on-Target) --------------------------------------------
  const takLat = el('takLat'), takLon = el('takLon');
  const takExportBtn = el('takExportBtn'), takImportBtn = el('takImportBtn'), takImportInput = el('takImportInput');
  const takClearBtn = el('takClearBtn'), takList = el('takList');
  const takWsInput = el('takWs'), takConnectBtn = el('takConnectBtn'), takStatus = el('takStatus');

  function takAnchor() {
    // A loaded real area pins the exact geographic anchor; otherwise the
    // operator-entered origin converts local metres to lat/lon.
    const geo = swarm && swarm.terrain && swarm.terrain.geoAnchor;
    if (geo) return makeTakAnchor(geo.lat, geo.lon, geo.x, geo.y);
    const lat = parseFloat(takLat.value);
    const lon = parseFloat(takLon.value);
    return makeTakAnchor(!isNaN(lat) ? lat : 38.8977, !isNaN(lon) ? lon : -77.0365, 0, 0);
  }
  function syncTakOrigin() {
    const geo = swarm && swarm.terrain && swarm.terrain.geoAnchor;
    if (geo) {
      takLat.value = geo.lat.toFixed(7);
      takLon.value = geo.lon.toFixed(7);
    }
  }
  window.syncTakOrigin = syncTakOrigin;

  takExportBtn.addEventListener('click', () => {
    if (!swarm) return;
    const xml = buildCotFromSwarm(swarm, takAnchor());
    download(xml.join('\n'), 'cot-snapshot-T' + Math.floor(swarm.time) + 's.xml', 'application/xml');
    logEvent(swarm, 'ATAK: exported ' + xml.length + ' CoT atoms', 'info');
  });

  function renderTakList() {
    const marks = swarm.takMarks || [];
    takClearBtn.style.display = marks.length ? 'inline-block' : 'none';
    if (!marks.length) {
      takList.textContent = '';
      return;
    }
    takList.innerHTML = '<b>' + marks.length + '</b> imported mark' + (marks.length === 1 ? '' : 's') + ':<br>' +
      marks.map((m, i) =>
        '<div>' + escHtml(m.callsign) + ' <button class="tak-obj" data-i="' + i +
        '" style="font-size:10px; padding:1px 6px;">objective</button></div>').join('');
  }
  takList.addEventListener('click', ev => {
    const btn = ev.target.closest('.tak-obj');
    if (!btn) return;
    const m = swarm.takMarks[+btn.dataset.i];
    if (!m) return;
    swarm.target.x = m.x; swarm.target.y = m.y;
    logEvent(swarm, 'ATAK: objective moved to imported mark "' + m.callsign + '"', 'info');
  });
  takClearBtn.addEventListener('click', () => { swarm.takMarks = []; renderTakList(); });
  takImportBtn.addEventListener('click', () => takImportInput.click());
  takImportInput.addEventListener('change', ev => {
    const file = ev.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const anchor = takAnchor();
        const marks = parseCoTFile(String(reader.result || '')).map(m => {
          const loc = latLonToLocal(anchor, m.lat, m.lon);
          return Object.assign({}, m, loc);
        });
        swarm.takMarks = marks;
        renderTakList();
        logEvent(swarm, 'ATAK: imported ' + marks.length + ' CoT marks from ' + file.name, 'info');
      } catch (e) {
        alert('Could not parse CoT file: ' + e.message);
      }
    };
    reader.readAsText(file);
    ev.target.value = '';
  });

  // Live stream to sitl/tak_bridge.py -> UDP multicast -> real ATAK clients.
  let takWs = null, takTimer = null;
  function takStreamOnce() {
    if (!swarm || !takWs || takWs.readyState !== WebSocket.OPEN) return;
    takWs.send(buildCotFromSwarm(swarm, takAnchor(), Date.now() / 1000).join('\n'));
  }
  takConnectBtn.addEventListener('click', () => {
    if (takWs) {
      clearInterval(takTimer); takTimer = null;
      try { takWs.close(); } catch (_) { /* already gone */ }
      takWs = null;
      takConnectBtn.textContent = 'Stream to TAK';
      takStatus.textContent = 'off — use Export for one-shot snapshots';
      return;
    }
    let url = takWsInput.value.trim();
    if (!url) return;
    // Bare host:port is a common paste; normalize so WebSocket constructor accepts it.
    if (!/^wss?:\/\//.test(url)) url = 'ws://' + url;
    try { takWs = new WebSocket(url); } catch (e) { takStatus.textContent = 'bad URL: ' + e.message; return; }
    takWs.onopen = () => {
      takConnectBtn.textContent = 'Disconnect TAK stream';
      takStatus.textContent = 'streaming to ' + url + ' every 5 s — run sitl/tak_bridge.py to reach real ATAK clients';
      takStreamOnce();
      takTimer = setInterval(takStreamOnce, 5000);
    };
    takWs.onclose = () => {
      clearInterval(takTimer); takTimer = null; takWs = null;
      takConnectBtn.textContent = 'Stream to TAK';
      takStatus.textContent = 'bridge closed';
    };
    takWs.onerror = () => { takStatus.textContent = 'bridge unreachable — is tak_bridge.py running?'; };
  });

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
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
      return;
    }
    // Hit radii are in canvas px: scale with DPR, and widen for fingers.
    const hitU = (window.uiScale || 1) * (e.pointerType === 'touch' ? 1.6 : 1);
    if (view3D) {
      dragMode = 'orbit'; lastMouse = p;
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
      return;
    }
    const w = screenToWorld(view, cv, p.x, p.y);
    // Interference source hit test first (they're draggable, like the target)
    let jHit = null;
    for (const j of swarm.jammers) {
      const js = worldToScreen(view, cv, j.x, j.y);
      if (Math.hypot(p.x - js.x, p.y - js.y) < 16 * hitU) { jHit = j; break; }
    }
    let zHit = null;
    for (const z of (swarm.gpsZones || [])) {
      const zs = worldToScreen(view, cv, z.x, z.y);
      if (Math.hypot(p.x - zs.x, p.y - zs.y) < 16 * hitU) { zHit = z; break; }
    }
    const tScreen = worldToScreen(view, cv, swarm.target.x, swarm.target.y);
    const bScreen = worldToScreen(view, cv, swarm.base.x, swarm.base.y);
    if (jHit) {
      selectedJammer = jHit; selectedZone = null; dragMode = 'jammer'; updateJammerPanel(); updateZonePanel();
    } else if (zHit) {
      selectedZone = zHit; selectedJammer = null; dragMode = 'zone'; updateZonePanel(); updateJammerPanel();
    } else if (Math.hypot(p.x - tScreen.x, p.y - tScreen.y) < 26 * hitU) {
      dragMode = 'target';
    } else if (Math.hypot(p.x - bScreen.x, p.y - bScreen.y) < 26 * hitU) {
      dragMode = 'base'; // the operator moves too — chain re-plans live
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
    } else if (dragMode === 'base') {
      const w = screenToWorld(view, cv, p.x, p.y);
      swarm.base.x = w.x; swarm.base.y = w.y;
    } else if (dragMode === 'jammer' && selectedJammer) {
      const w = screenToWorld(view, cv, p.x, p.y);
      selectedJammer.x = w.x; selectedJammer.y = w.y;
    } else if (dragMode === 'zone' && selectedZone) {
      const w = screenToWorld(view, cv, p.x, p.y);
      selectedZone.x = w.x; selectedZone.y = w.y;
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
    kpiThroughput.textContent = status.fleetConnected
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
    } else if (status.fleetConnected) {
      // Fleet is linked but nobody is on station yet — say so, don't claim
      // the objective link exists before it does (finding #6).
      statusPill.textContent = 'Linked — en route to objective';
      statusPill.className = 'pill warn';
    } else if (status.freshCount > 0) {
      statusPill.textContent = 'Flock out of contact — C2 sees ' + status.freshCount + '/' + status.aliveCount;
      statusPill.className = 'pill warn';
    } else {
      statusPill.textContent = 'All contact lost';
      statusPill.className = 'pill lost';
    }

    hopsBody.innerHTML = status.hops.map((h, i) =>
      '<tr class="' + escHtml(h.state) + '"><td>' + escHtml(h.a.label) + ' → ' + escHtml(h.b.label) + '</td><td>' + fmtDist(h.distM) +
      '</td><td>' + h.marginDb.toFixed(0) + ' dB</td><td>' + (h.lossPct < 1 ? '<1' : h.lossPct.toFixed(0)) + '%</td></tr>'
    ).join('') || '<tr><td colspan="4" class="dim">no links</td></tr>';

    fleetBody.innerHTML = swarm.drones.map(d => {
      const sel = d === selected ? ' style="outline:1px solid #e2e8f0;"' : '';
      const role = effRole(d);
      return '<div class="fleet-row role-' + escHtml(role) + '"' + sel + ' data-id="' + escHtml(d.id) + '">' +
        '<span class="dot"></span><span class="fid">' + escHtml(d.id) +
        (d.cls === 'relay' ? ' \u25c6' : '') + (swarm.c2.vidGrantee === d.id ? ' \u25cf' : '') + '</span>' +
        '<span class="frole">' + escHtml(role) + '</span>' +
        '<span class="fbat"><span class="fbat-fill" style="width:' + d.batteryPct.toFixed(0) + '%"></span></span>' +
        '<span class="fpct">' + d.batteryPct.toFixed(0) + '%</span></div>';
    }).join('');

    eventLog.innerHTML = swarm.events.slice().reverse().map(ev =>
      '<div class="ev ev-' + escHtml(ev.kind) + '"><span class="ev-t">' + fmtSimClock(ev.t) + '</span>' + escHtml(ev.msg) + '</div>'
    ).join('');

    if (swarm.videoOn) {
      const v = swarm.net.vid;
      const total = v.framesDelivered + v.droppedFrames;
      const loss = total ? (100 * v.droppedFrames / total).toFixed(1) + '% loss' : 'no data yet';
      payloadInfo.innerHTML =
        '<b>' + escHtml(swarm.c2.vidGrantee || 'nobody') + '</b> has the channel at <b>' +
        swarm.videoKbps + ' kbps</b> · chunks ' + v.framesDelivered.toLocaleString() +
        ' delivered (' + loss + ') · chain busy ' + (swarm.net.utilization * 100).toFixed(0) + '%' +
        '<br><span style="color:var(--dim)">● streaming · ◆ relay wing — one streamer at a time; video eats the same airtime C2 needs.</span>';
    } else {
      payloadInfo.textContent = 'Video backhaul off — enable it in Mission setup to see who gets to stream, and what it costs the chain.';
    }

    killBtn.disabled = !(selected && alive(selected));
    killBtn.textContent = selected ? 'Kill ' + selected.id : 'Kill drone (select one)';
    // Basemap credit is legally required whenever the real map is on screen —
    // and it now shows in BOTH views (3D drapes the tiles onto the ground).
    mapAttrib.style.display = swarm.terrain.geoAnchor ? 'block' : 'none';
  }

  const mapAttrib = el('mapAttrib');
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
  let simAccum = 0;
  const FIXED_SIM_STEP_SEC = 0.05; // 20 Hz fixed simulation timestep
  function frame(now) {
    const realDt = Math.min(0.2, (now - lastT) / 1000);
    lastT = now;

    let status;
    if (!paused) {
      // Real vehicles fly in real time — no fast-forward when a bridge is
      // driving the drones; force 1x so sim time tracks the wall clock.
      const scale = (typeof externalActive === 'function' && externalActive()) ? 1 : timeScale;
      simAccum += realDt * scale;
      if (simAccum > 1.0) simAccum = 1.0;
      while (simAccum >= FIXED_SIM_STEP_SEC) {
        status = stepSwarm(swarm, FIXED_SIM_STEP_SEC);
        simAccum -= FIXED_SIM_STEP_SEC;
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
  updateOsmRow();
  updateHeteroRow();
  syncTakOrigin();
  updateAirframeInfo();
  updateSpecCard();
  applySpacing();
  applyAgility();
  applyLpi();
  applyVideo();
  resetSwarm();
  distOut.textContent = fmtDist(+distRange.value / 100 * defaultTargetDist());
  document.querySelector('[data-speed="5"]').classList.add('active');
  requestAnimationFrame(frame);
})();

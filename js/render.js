// Canvas renderer. World units are metres; `view` maps world → screen.
// view = { cx, cy, pxPerM }  (cx,cy = world point at canvas centre)

const COLORS = {
  grid: 'rgba(138,136,122,0.10)',
  gridMajor: 'rgba(138,136,122,0.22)',
  ring: 'rgba(111,159,230,0.08)',
  ringEdge: 'rgba(111,159,230,0.30)',
  linkOk: '#8fd960',
  linkDegraded: '#e0a63c',
  linkLost: '#e06050',
  base: '#a5a293',
  target: '#6f9fe6',
  mission: '#7fc95e',
  relay: '#e6b345',
  rtb: '#a48fe0',
  rtl: '#a48fe0',
  hold: '#d970a8',
  relink: '#5ecfcf',
  rescue: '#6f9fe6',
  landed: '#8a887a',
  dead: '#e06050',
  text: '#d6d4c8',
  textDim: '#8a887a',
  packetCmd: '#6f9fe6',
  packetTlm: '#e8e6da',
};

function worldToScreen(view, cv, x, y) {
  return {
    x: cv.width / 2 + (x - view.cx) * view.pxPerM,
    y: cv.height / 2 + (y - view.cy) * view.pxPerM,
  };
}

function screenToWorld(view, cv, sx, sy) {
  return {
    x: view.cx + (sx - cv.width / 2) / view.pxPerM,
    y: view.cy + (sy - cv.height / 2) / view.pxPerM,
  };
}

function fmtDist(m) {
  return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.round(m) + ' m';
}

function niceStep(target) {
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  for (const mult of [1, 2, 5, 10]) {
    if (pow * mult >= target) return pow * mult;
  }
  return pow * 10;
}

function drawGrid(ctx, cv, view) {
  const U = window.uiScale || 1;
  const step = niceStep(120 / view.pxPerM); // ~gridline every 120px
  const tl = screenToWorld(view, cv, 0, 0);
  const br = screenToWorld(view, cv, cv.width, cv.height);
  ctx.lineWidth = 1 * U;
  for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
    const s = worldToScreen(view, cv, x, 0);
    ctx.strokeStyle = Math.round(x / step) % 5 === 0 ? COLORS.gridMajor : COLORS.grid;
    ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, cv.height); ctx.stroke();
  }
  for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
    const s = worldToScreen(view, cv, 0, y);
    ctx.strokeStyle = Math.round(y / step) % 5 === 0 ? COLORS.gridMajor : COLORS.grid;
    ctx.beginPath(); ctx.moveTo(0, s.y); ctx.lineTo(cv.width, s.y); ctx.stroke();
  }
}

// Terrain layer: hillshaded ground rendered to a cached offscreen canvas
// (recomputed only when the camera moves), plus building footprints.
// Buildings taller than the swarm's altitude get a red edge — those are
// the ones that block both flight paths and radio.
let terrainLayer = { key: '', canvas: null };

function drawTerrain(ctx, cv, view, s) {
  const U = window.uiScale || 1;
  const t = s.terrain;
  const hasGround = t.groundAmpM > 0;
  if (!hasGround && !t.buildings.length) return;

  if (hasGround) {
    const key = [Math.round(view.cx), Math.round(view.cy), view.pxPerM.toFixed(5), cv.width, cv.height, t.seed, t.groundAmpM].join('|');
    if (terrainLayer.key !== key) {
      const q = 4;
      const w = Math.max(1, Math.floor(cv.width / q)), h = Math.max(1, Math.floor(cv.height / q));
      const off = document.createElement('canvas'); off.width = w; off.height = h;
      const octx = off.getContext('2d');
      const img = octx.createImageData(w, h);
      const stepM = q / view.pxPerM;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const wpt = screenToWorld(view, cv, px * q, py * q);
          const g = terrainGroundAt(t, wpt.x, wpt.y);
          const gE = terrainGroundAt(t, wpt.x + stepM, wpt.y);
          const hn = Math.min(1, g / t.groundAmpM);
          const slope = Math.max(-1, Math.min(1, (g - gE) / Math.max(1, stepM) * 2));
          const base = 40 + hn * 92 + slope * 24;
          const i = (py * w + px) * 4;
          img.data[i] = base * 1.0;
          img.data[i + 1] = base * 0.97;
          img.data[i + 2] = base * 0.78;
          img.data[i + 3] = g < 1 ? 0 : 110 + hn * 100;
        }
      }
      octx.putImageData(img, 0, 0);
      terrainLayer = { key, canvas: off };
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(terrainLayer.canvas, 0, 0, cv.width, cv.height);
  }

  for (const b of t.buildings) {
    const p = worldToScreen(view, cv, b.x - b.w / 2, b.y - b.d / 2);
    const wpx = b.w * view.pxPerM, dpx = b.d * view.pxPerM;
    if (wpx < 1.2) continue;
    const tall = b.heightM > s.altitudeM;
    ctx.fillStyle = tall ? 'rgba(122,74,66,0.55)' : 'rgba(138,136,122,0.28)';
    ctx.fillRect(p.x, p.y, wpx, dpx);
    if (tall) {
      ctx.strokeStyle = 'rgba(224,96,80,0.55)'; ctx.lineWidth = 1 * U;
      ctx.strokeRect(p.x, p.y, wpx, dpx);
    }
  }
}

// C2's learned coverage map: green where a packet provably arrived, red where
// a drone sat in silence. Unknown cells stay unpainted — honesty by omission.
function drawCoverage(ctx, cv, view, s) {
  if (!s.showCoverage || !s.c2.cov.size) return;
  const cell = s.covCellM, px = cell * view.pxPerM;
  if (px < 1.5) return;
  for (const [key, e] of s.c2.cov) {
    const [i, j] = key.split(',').map(Number);
    const p = worldToScreen(view, cv, i * cell, j * cell);
    if (p.x < -px || p.y < -px || p.x > cv.width || p.y > cv.height) continue;
    ctx.fillStyle = e.bad > e.good ? 'rgba(224,96,80,0.16)' : 'rgba(127,201,94,0.08)';
    ctx.fillRect(p.x, p.y, px, px);
  }
}

// Interference / denied-RF sources: a pulsing emitter with its denial-zone
// ring (where it raises the noise floor to the radio's sensitivity). Selected
// source gets a dashed halo so the operator can drag/tune it.
function drawJammers(ctx, cv, view, s, selected, timeSec) {
  if (!s.jammers) return;
  const U = window.uiScale || 1;
  for (const j of s.jammers) {
    const c = worldToScreen(view, cv, j.x, j.y);
    const rM = jammerDenialRadiusM(s, j);
    const r = rM * view.pxPerM;
    if (j.on !== false && r > 3 && r < 8000) {
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(224,96,80,0.10)'; ctx.fill();
      ctx.strokeStyle = 'rgba(224,96,80,0.5)'; ctx.lineWidth = 1 * U; ctx.setLineDash([4 * U, 5 * U]);
      ctx.stroke(); ctx.setLineDash([]);
    }
    // expanding wave rings to signal an active emitter
    if (j.on !== false) {
      for (let k = 0; k < 3; k++) {
        const ph = ((timeSec * 0.6 + k / 3) % 1);
        ctx.beginPath(); ctx.arc(c.x, c.y, (6 + ph * 22) * U, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(224,96,80,' + (0.5 * (1 - ph)).toFixed(2) + ')';
        ctx.lineWidth = 1.5 * U; ctx.stroke();
      }
    }
    if (j === selected) {
      ctx.beginPath(); ctx.arc(c.x, c.y, 15 * U, 0, Math.PI * 2);
      ctx.strokeStyle = '#e8e6da'; ctx.lineWidth = 1.5 * U; ctx.setLineDash([3 * U, 3 * U]);
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.beginPath(); ctx.arc(c.x, c.y, 6 * U, 0, Math.PI * 2);
    ctx.fillStyle = j.on === false ? '#8a887a' : '#e06050'; ctx.fill();
    ctx.font = (11 * U) + 'px "IBM Plex Mono", monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = j.on === false ? '#8a887a' : '#e06050';
    ctx.fillText((j.on === false ? 'off · ' : '') + j.erpDbm + ' dBm', c.x, c.y + 22 * U);
  }
}

function drawRangeRing(ctx, cv, view, node, rangeM) {
  const U = window.uiScale || 1;
  const c = worldToScreen(view, cv, node.x, node.y);
  const r = rangeM * view.pxPerM;
  if (r < 4 || r > 6000) return;
  ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.ring; ctx.fill();
  ctx.strokeStyle = COLORS.ringEdge; ctx.lineWidth = 1 * U; ctx.setLineDash([5 * U, 6 * U]);
  ctx.stroke(); ctx.setLineDash([]);
}

function drawLinks(ctx, cv, view, hops, timeSec, connected) {
  const U = window.uiScale || 1;
  for (const hop of hops) {
    const a = worldToScreen(view, cv, hop.a.x, hop.a.y);
    const b = worldToScreen(view, cv, hop.b.x, hop.b.y);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    if (hop.state === 'ok') { ctx.strokeStyle = COLORS.linkOk; ctx.setLineDash([]); }
    else if (hop.state === 'degraded') { ctx.strokeStyle = COLORS.linkDegraded; ctx.setLineDash([8 * U, 5 * U]); }
    else { ctx.strokeStyle = COLORS.linkLost; ctx.setLineDash([3 * U, 6 * U]); }
    ctx.lineWidth = 2 * U;
    ctx.stroke(); ctx.setLineDash([]);

    // Hop label: distance + margin
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    ctx.font = (11 * U) + 'px "Segoe UI", sans-serif';
    ctx.fillStyle = hop.state === 'ok' ? COLORS.linkOk : hop.state === 'degraded' ? COLORS.linkDegraded : COLORS.linkLost;
    ctx.textAlign = 'center';
    ctx.fillText(fmtDist(hop.distM) + '  ' + hop.marginDb.toFixed(0) + ' dB', mx, my - 6 * U);
  }

}

// Real packets from the network layer, drawn mid-flight on their current hop.
function drawPackets(ctx, cv, view, s) {
  const U = window.uiScale || 1;
  for (const p of s.net.packets) {
    const a = nodePos(s, p.path[p.hop]);
    const b = nodePos(s, p.path[p.hop + 1]);
    if (!a || !b) continue;
    const span = p.tArrive - p.tHopStart;
    const frac = span > 0 ? Math.min(1, Math.max(0, (s.time - p.tHopStart) / span)) : 1;
    const sa = worldToScreen(view, cv, a.x, a.y);
    const sb = worldToScreen(view, cv, b.x, b.y);
    ctx.beginPath();
    ctx.arc(sa.x + (sb.x - sa.x) * frac, sa.y + (sb.y - sa.y) * frac, 2.5 * U, 0, Math.PI * 2);
    ctx.fillStyle = p.kind === 'cmd' ? COLORS.packetCmd : COLORS.packetTlm;
    ctx.fill();
  }
}

function drawBase(ctx, cv, view, base) {
  const U = window.uiScale || 1;
  const c = worldToScreen(view, cv, base.x, base.y);
  ctx.fillStyle = COLORS.base;
  ctx.fillRect(c.x - 10 * U, c.y - 6 * U, 20 * U, 12 * U);
  ctx.beginPath(); ctx.moveTo(c.x, c.y - 6 * U); ctx.lineTo(c.x, c.y - 20 * U);
  ctx.strokeStyle = COLORS.base; ctx.lineWidth = 2 * U; ctx.stroke();
  ctx.beginPath(); ctx.arc(c.x, c.y - 22 * U, 3 * U, 0, Math.PI * 2); ctx.fill();
  ctx.font = (12 * U) + 'px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.text;
  ctx.fillText('C2 ground station', c.x, c.y + 26 * U);
}

function drawTarget(ctx, cv, view, target) {
  const U = window.uiScale || 1;
  const c = worldToScreen(view, cv, target.x, target.y);
  ctx.strokeStyle = COLORS.target; ctx.lineWidth = 2 * U;
  ctx.beginPath(); ctx.arc(c.x, c.y, 12 * U, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(c.x - 18 * U, c.y); ctx.lineTo(c.x - 6 * U, c.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(c.x + 6 * U, c.y); ctx.lineTo(c.x + 18 * U, c.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(c.x, c.y - 18 * U); ctx.lineTo(c.x, c.y - 6 * U); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(c.x, c.y + 6 * U); ctx.lineTo(c.x, c.y + 18 * U); ctx.stroke();
  ctx.font = (12 * U) + 'px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.target;
  ctx.fillText('mission target', c.x, c.y + 32 * U);
}

function droneColor(d) {
  const r = effRole(d);
  return COLORS[r] || COLORS.dead;
}

function drawDrone(ctx, cv, view, d, selected) {
  const U = window.uiScale || 1;
  const c = worldToScreen(view, cv, d.x, d.y);
  const a = Math.atan2(d.vy, d.vx || 0.001);
  const col = droneColor(d);

  if (selected) {
    ctx.beginPath(); ctx.arc(c.x, c.y, 14 * U, 0, Math.PI * 2);
    ctx.strokeStyle = '#e8e6da'; ctx.lineWidth = 1.5 * U; ctx.setLineDash([3 * U, 3 * U]);
    ctx.stroke(); ctx.setLineDash([]);
  }

  ctx.save(); ctx.translate(c.x, c.y);
  if (d.mode === 'dead') {
    ctx.strokeStyle = col; ctx.lineWidth = 2 * U;
    ctx.beginPath(); ctx.moveTo(-5 * U, -5 * U); ctx.lineTo(5 * U, 5 * U); ctx.moveTo(5 * U, -5 * U); ctx.lineTo(-5 * U, 5 * U); ctx.stroke();
  } else if (d.mode === 'landed') {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(0, 0, 4 * U, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(9 * U, 0); ctx.lineTo(-7 * U, 5.5 * U); ctx.lineTo(-4 * U, 0); ctx.lineTo(-7 * U, -5.5 * U); ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
  }
  ctx.restore();

  // Battery arc
  if (alive(d)) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, 11 * U, -Math.PI / 2, -Math.PI / 2 + (d.batteryPct / 100) * Math.PI * 2);
    ctx.strokeStyle = d.batteryPct > 40 ? 'rgba(127,201,94,0.5)' : d.batteryPct > 20 ? 'rgba(230,179,69,0.6)' : 'rgba(224,96,80,0.7)';
    ctx.lineWidth = 2 * U; ctx.stroke();
  }

  ctx.font = (10 * U) + 'px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.textDim;
  ctx.fillText(d.id, c.x, c.y + 24 * U);
}

// C2's memory of where each lost drone was last heard — ghost markers the
// operator (and the rescue logic) work from. When a drone is visibly sitting
// on its own ghost (the common case: it froze right where it went dark), the
// text label is dropped so it doesn't collide with the drone's ID label.
function drawLostMarkers(ctx, cv, view, s) {
  const U = window.uiScale || 1;
  for (const [id, e] of Object.entries(s.c2.lost)) {
    const c = worldToScreen(view, cv, e.x, e.y);
    let droneNearby = false;
    for (const d of s.drones) {
      const p = worldToScreen(view, cv, d.x, d.y);
      if (Math.hypot(p.x - c.x, p.y - c.y) < 26) { droneNearby = true; break; }
    }
    ctx.beginPath(); ctx.arc(c.x, c.y, 10 * U, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.lost; ctx.lineWidth = 1.5 * U; ctx.setLineDash([3 * U, 4 * U]);
    ctx.stroke(); ctx.setLineDash([]);
    if (!droneNearby) {
      ctx.font = (11 * U) + 'px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.lost;
      ctx.fillText('?', c.x, c.y + 4 * U);
      ctx.fillStyle = COLORS.textDim;
      ctx.fillText(id + ' last seen', c.x, c.y - 16 * U);
    }
  }
}

function drawWind(ctx, cv, s) {
  const U = window.uiScale || 1;
  const spd = Math.hypot(s.wind.x, s.wind.y);
  if (spd < 0.5) return;
  const cx = cv.width - 52 * U, cy = 46 * U, ang = Math.atan2(s.wind.y, s.wind.x);
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
  ctx.strokeStyle = COLORS.text; ctx.lineWidth = 2 * U;
  ctx.beginPath(); ctx.moveTo(-14 * U, 0); ctx.lineTo(12 * U, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(12 * U, 0); ctx.lineTo(5 * U, -5 * U); ctx.moveTo(12 * U, 0); ctx.lineTo(5 * U, 5 * U); ctx.stroke();
  ctx.restore();
  ctx.font = (11 * U) + 'px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.text;
  ctx.fillText(spd.toFixed(0) + ' m/s wind', cx, cy + 22 * U);
}

function drawScaleBar(ctx, cv, view) {
  const U = window.uiScale || 1;
  const step = niceStep(90 / view.pxPerM);
  const px = step * view.pxPerM;
  const x0 = 18 * U, y0 = cv.height - 22 * U;
  ctx.strokeStyle = COLORS.text; ctx.lineWidth = 2 * U;
  ctx.beginPath();
  ctx.moveTo(x0, y0 - 5 * U); ctx.lineTo(x0, y0); ctx.lineTo(x0 + px, y0); ctx.lineTo(x0 + px, y0 - 5 * U);
  ctx.stroke();
  ctx.font = (11 * U) + 'px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.text;
  ctx.fillText(fmtDist(step), x0 + px / 2, y0 - 8 * U);
}

function render(ctx, cv, view, s, status, selected, usable) {
  ctx.clearRect(0, 0, cv.width, cv.height);
  // Georeferenced mission → the real map is the ground; otherwise the grid.
  if (!drawTiles(ctx, cv, view, s.terrain.geoAnchor)) drawGrid(ctx, cv, view);
  drawTerrain(ctx, cv, view, s);
  drawCoverage(ctx, cv, view, s);
  drawJammers(ctx, cv, view, s, selected, s.time);

  // Coverage rings around every transmitting chain node
  for (const node of status.nodes) {
    if (node.kind !== 'mission') drawRangeRing(ctx, cv, view, node, usable);
  }

  drawLinks(ctx, cv, view, status.hops, s.time, status.connected);
  drawPackets(ctx, cv, view, s);
  drawLostMarkers(ctx, cv, view, s);
  drawBase(ctx, cv, view, s.base);
  drawTarget(ctx, cv, view, s.target);
  for (const d of s.drones) drawDrone(ctx, cv, view, d, d === selected);
  drawWind(ctx, cv, s);
  drawScaleBar(ctx, cv, view);
}

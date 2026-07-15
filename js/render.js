// Canvas renderer. World units are metres; `view` maps world → screen.
// view = { cx, cy, pxPerM }  (cx,cy = world point at canvas centre)

const COLORS = {
  grid: 'rgba(148,163,184,0.10)',
  gridMajor: 'rgba(148,163,184,0.22)',
  ring: 'rgba(56,189,248,0.10)',
  ringEdge: 'rgba(56,189,248,0.28)',
  linkOk: '#34d399',
  linkDegraded: '#fbbf24',
  linkLost: '#f87171',
  base: '#94a3b8',
  target: '#38bdf8',
  mission: '#34d399',
  relay: '#fbbf24',
  rtb: '#a78bfa',
  rtl: '#a78bfa',
  hold: '#f472b6',
  relink: '#22d3ee',
  rescue: '#60a5fa',
  landed: '#64748b',
  dead: '#ef4444',
  text: '#cbd5e1',
  textDim: '#64748b',
  packetCmd: '#38bdf8',
  packetTlm: '#e2e8f0',
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
  const step = niceStep(120 / view.pxPerM); // ~gridline every 120px
  const tl = screenToWorld(view, cv, 0, 0);
  const br = screenToWorld(view, cv, cv.width, cv.height);
  ctx.lineWidth = 1;
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
          img.data[i] = base * 0.9;
          img.data[i + 1] = base;
          img.data[i + 2] = base * 0.96;
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
    ctx.fillStyle = tall ? 'rgba(120,86,96,0.5)' : 'rgba(71,85,105,0.38)';
    ctx.fillRect(p.x, p.y, wpx, dpx);
    if (tall) {
      ctx.strokeStyle = 'rgba(248,113,113,0.5)'; ctx.lineWidth = 1;
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
    ctx.fillStyle = e.bad > e.good ? 'rgba(248,113,113,0.16)' : 'rgba(52,211,153,0.08)';
    ctx.fillRect(p.x, p.y, px, px);
  }
}

function drawRangeRing(ctx, cv, view, node, rangeM) {
  const c = worldToScreen(view, cv, node.x, node.y);
  const r = rangeM * view.pxPerM;
  if (r < 4 || r > 6000) return;
  ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.ring; ctx.fill();
  ctx.strokeStyle = COLORS.ringEdge; ctx.lineWidth = 1; ctx.setLineDash([5, 6]);
  ctx.stroke(); ctx.setLineDash([]);
}

function drawLinks(ctx, cv, view, hops, timeSec, connected) {
  for (const hop of hops) {
    const a = worldToScreen(view, cv, hop.a.x, hop.a.y);
    const b = worldToScreen(view, cv, hop.b.x, hop.b.y);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    if (hop.state === 'ok') { ctx.strokeStyle = COLORS.linkOk; ctx.setLineDash([]); }
    else if (hop.state === 'degraded') { ctx.strokeStyle = COLORS.linkDegraded; ctx.setLineDash([8, 5]); }
    else { ctx.strokeStyle = COLORS.linkLost; ctx.setLineDash([3, 6]); }
    ctx.lineWidth = 2;
    ctx.stroke(); ctx.setLineDash([]);

    // Hop label: distance + margin
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.fillStyle = hop.state === 'ok' ? COLORS.linkOk : hop.state === 'degraded' ? COLORS.linkDegraded : COLORS.linkLost;
    ctx.textAlign = 'center';
    ctx.fillText(fmtDist(hop.distM) + '  ' + hop.marginDb.toFixed(0) + ' dB', mx, my - 6);
  }

}

// Real packets from the network layer, drawn mid-flight on their current hop.
function drawPackets(ctx, cv, view, s) {
  for (const p of s.net.packets) {
    const a = nodePos(s, p.path[p.hop]);
    const b = nodePos(s, p.path[p.hop + 1]);
    if (!a || !b) continue;
    const span = p.tArrive - p.tHopStart;
    const frac = span > 0 ? Math.min(1, Math.max(0, (s.time - p.tHopStart) / span)) : 1;
    const sa = worldToScreen(view, cv, a.x, a.y);
    const sb = worldToScreen(view, cv, b.x, b.y);
    ctx.beginPath();
    ctx.arc(sa.x + (sb.x - sa.x) * frac, sa.y + (sb.y - sa.y) * frac, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = p.kind === 'cmd' ? COLORS.packetCmd : COLORS.packetTlm;
    ctx.fill();
  }
}

function drawBase(ctx, cv, view, base) {
  const c = worldToScreen(view, cv, base.x, base.y);
  ctx.fillStyle = COLORS.base;
  ctx.fillRect(c.x - 10, c.y - 6, 20, 12);
  ctx.beginPath(); ctx.moveTo(c.x, c.y - 6); ctx.lineTo(c.x, c.y - 20);
  ctx.strokeStyle = COLORS.base; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.arc(c.x, c.y - 22, 3, 0, Math.PI * 2); ctx.fill();
  ctx.font = '12px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.text;
  ctx.fillText('C2 ground station', c.x, c.y + 26);
}

function drawTarget(ctx, cv, view, target) {
  const c = worldToScreen(view, cv, target.x, target.y);
  ctx.strokeStyle = COLORS.target; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(c.x, c.y, 12, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(c.x - 18, c.y); ctx.lineTo(c.x - 6, c.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(c.x + 6, c.y); ctx.lineTo(c.x + 18, c.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(c.x, c.y - 18); ctx.lineTo(c.x, c.y - 6); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(c.x, c.y + 6); ctx.lineTo(c.x, c.y + 18); ctx.stroke();
  ctx.font = '12px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.target;
  ctx.fillText('mission target', c.x, c.y + 32);
}

function droneColor(d) {
  const r = effRole(d);
  return COLORS[r] || COLORS.dead;
}

function drawDrone(ctx, cv, view, d, selected) {
  const c = worldToScreen(view, cv, d.x, d.y);
  const a = Math.atan2(d.vy, d.vx || 0.001);
  const col = droneColor(d);

  if (selected) {
    ctx.beginPath(); ctx.arc(c.x, c.y, 14, 0, Math.PI * 2);
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
    ctx.stroke(); ctx.setLineDash([]);
  }

  ctx.save(); ctx.translate(c.x, c.y);
  if (d.mode === 'dead') {
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-5, -5); ctx.lineTo(5, 5); ctx.moveTo(5, -5); ctx.lineTo(-5, 5); ctx.stroke();
  } else if (d.mode === 'landed') {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-7, 5.5); ctx.lineTo(-4, 0); ctx.lineTo(-7, -5.5); ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
  }
  ctx.restore();

  // Battery arc
  if (alive(d)) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, 11, -Math.PI / 2, -Math.PI / 2 + (d.batteryPct / 100) * Math.PI * 2);
    ctx.strokeStyle = d.batteryPct > 40 ? 'rgba(52,211,153,0.5)' : d.batteryPct > 20 ? 'rgba(251,191,36,0.6)' : 'rgba(248,113,113,0.7)';
    ctx.lineWidth = 2; ctx.stroke();
  }

  ctx.font = '10px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.textDim;
  ctx.fillText(d.id, c.x, c.y + 24);
}

// C2's memory of where each lost drone was last heard — ghost markers the
// operator (and the rescue logic) work from. When a drone is visibly sitting
// on its own ghost (the common case: it froze right where it went dark), the
// text label is dropped so it doesn't collide with the drone's ID label.
function drawLostMarkers(ctx, cv, view, s) {
  for (const [id, e] of Object.entries(s.c2.lost)) {
    const c = worldToScreen(view, cv, e.x, e.y);
    let droneNearby = false;
    for (const d of s.drones) {
      const p = worldToScreen(view, cv, d.x, d.y);
      if (Math.hypot(p.x - c.x, p.y - c.y) < 26) { droneNearby = true; break; }
    }
    ctx.beginPath(); ctx.arc(c.x, c.y, 10, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.lost; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]);
    ctx.stroke(); ctx.setLineDash([]);
    if (!droneNearby) {
      ctx.font = '11px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.lost;
      ctx.fillText('?', c.x, c.y + 4);
      ctx.fillStyle = COLORS.textDim;
      ctx.fillText(id + ' last seen', c.x, c.y - 16);
    }
  }
}

function drawWind(ctx, cv, s) {
  const spd = Math.hypot(s.wind.x, s.wind.y);
  if (spd < 0.5) return;
  const cx = cv.width - 52, cy = 46, ang = Math.atan2(s.wind.y, s.wind.x);
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
  ctx.strokeStyle = COLORS.text; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(12, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(5, -5); ctx.moveTo(12, 0); ctx.lineTo(5, 5); ctx.stroke();
  ctx.restore();
  ctx.font = '11px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.text;
  ctx.fillText(spd.toFixed(0) + ' m/s wind', cx, cy + 22);
}

function drawScaleBar(ctx, cv, view) {
  const step = niceStep(90 / view.pxPerM);
  const px = step * view.pxPerM;
  const x0 = 18, y0 = cv.height - 22;
  ctx.strokeStyle = COLORS.text; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0 - 5); ctx.lineTo(x0, y0); ctx.lineTo(x0 + px, y0); ctx.lineTo(x0 + px, y0 - 5);
  ctx.stroke();
  ctx.font = '11px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.text;
  ctx.fillText(fmtDist(step), x0 + px / 2, y0 - 8);
}

function render(ctx, cv, view, s, status, selected, usable) {
  ctx.clearRect(0, 0, cv.width, cv.height);
  drawGrid(ctx, cv, view);
  drawTerrain(ctx, cv, view, s);
  drawCoverage(ctx, cv, view, s);

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

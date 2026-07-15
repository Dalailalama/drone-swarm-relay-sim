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
  landed: '#64748b',
  dead: '#ef4444',
  text: '#cbd5e1',
  textDim: '#64748b',
  packet: '#e2e8f0',
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

  // Animated packets flowing along healthy chain
  if (connected && hops.length) {
    const phase = (timeSec % 2) / 2;
    for (const hop of hops) {
      if (hop.state === 'lost') break;
      const a = worldToScreen(view, cv, hop.a.x, hop.a.y);
      const b = worldToScreen(view, cv, hop.b.x, hop.b.y);
      const p = { x: a.x + (b.x - a.x) * phase, y: a.y + (b.y - a.y) * phase };
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.packet; ctx.fill();
    }
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
  if (d.role === 'mission') return COLORS.mission;
  if (d.role === 'relay') return COLORS.relay;
  if (d.role === 'rtb') return COLORS.rtb;
  if (d.role === 'landed') return COLORS.landed;
  return COLORS.dead;
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
  if (d.role === 'dead') {
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-5, -5); ctx.lineTo(5, 5); ctx.moveTo(5, -5); ctx.lineTo(-5, 5); ctx.stroke();
  } else if (d.role === 'landed') {
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

  // Coverage rings around every transmitting chain node
  for (const node of status.nodes) {
    if (node.kind !== 'mission') drawRangeRing(ctx, cv, view, node, usable);
  }

  drawLinks(ctx, cv, view, status.hops, s.time, status.connected);
  drawBase(ctx, cv, view, s.base);
  drawTarget(ctx, cv, view, s.target);
  for (const d of s.drones) drawDrone(ctx, cv, view, d, d === selected);
  drawScaleBar(ctx, cv, view);
}

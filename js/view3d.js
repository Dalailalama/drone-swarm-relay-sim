// 3D perspective view — a FASTER-style tactical rendering of the same truth
// state js/render.js draws top-down, but from an orbiting eye instead of
// straight overhead. No WebGL, no libraries: a hand-rolled camera projects
// world points to screen pixels, and every visible face (terrain quads,
// building boxes) gets painter's-algorithm sorted back-to-front and filled
// with flat canvas polygons. Slower than a GPU, plenty fast for a swarm sim.
//
// World convention (shared with the rest of the sim): x is east, y is SOUTH-
// positive (screen-style, not math-style), height h points up. We treat that
// as 3D (x, y, z=height) and let y double as "depth going away" when the
// camera looks roughly north — nothing here assumes a right-handed world,
// only a right-handed *camera* basis (forward/right/up), which is all the
// projection math needs.

// --- Tiny vec3 helpers (kept local; the rest of the sim doesn't need 3D) ----

function v3sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }

function v3cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function v3dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

function v3norm(a) {
  const len = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

// Fixed "sun" for lambert shading, shared by terrain and building faces —
// mostly overhead, leaning slightly northwest, so flat ground reads bright
// and vertical walls split into a lit pair and a shadowed pair.
const LIGHT_DIR = v3norm({ x: -0.5, y: -0.3, z: 0.8 });

// Max buildings drawn in the 3D view at once (nearest-to-view are kept) so a
// dense city of thousands stays smooth. The 2D map draws all of them.
const BUILDING_RENDER_CAP = 420;

// --- Camera ------------------------------------------------------------

// Orbit camera aimed at the midpoint of base/target, framed to fit the whole
// corridor. Only touches s.base/s.target — callers may pass a stub swarm.
function makeCamera3D(s) {
  const cx = (s.base.x + s.target.x) / 2;
  const cy = (s.base.y + s.target.y) / 2;
  const spreadM = Math.hypot(s.target.x - s.base.x, s.target.y - s.base.y);
  const dist = Math.max(400, Math.min(200000, 1.8 * spreadM));
  return { yaw: -2.4, pitch: 0.62, dist, cx, cy };
}

// Project a world point (x, y, z=height) to screen pixels + view-axis depth.
// Returns null for anything at or behind the eye — the camera has no
// business drawing what it can't see, and dividing by ~0 depth would blow up
// the projection anyway.
function project3D(cam, cvW, cvH, x, y, z) {
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const cyw = Math.cos(cam.yaw), syw = Math.sin(cam.yaw);

  const lookAt = { x: cam.cx, y: cam.cy, z: 0 };
  const eye = {
    x: cam.cx + cam.dist * cp * cyw,
    y: cam.cy + cam.dist * cp * syw,
    z: cam.dist * sp,
  };

  const forward = v3norm(v3sub(lookAt, eye));
  const right = v3norm(v3cross(forward, { x: 0, y: 0, z: 1 }));
  const upv = v3cross(right, forward); // already unit: right, forward are orthonormal

  const v = v3sub({ x, y, z }, eye);
  const depth = v3dot(v, forward);
  if (depth < 1) return null;

  const f = cvH * 1.1; // focal length in px — picked so a typical corridor fills the canvas
  return {
    x: cvW / 2 + (v3dot(v, right) * f) / depth,
    y: cvH / 2 - (v3dot(v, upv) * f) / depth,
    depth,
  };
}

// Mouse-drag orbit: yaw spins freely, pitch is clamped so the camera can
// never flip past looking straight down or dip below the horizon.
function orbitCamera3D(cam, dxPx, dyPx) {
  // Drag-to-grab feel: pushing the cursor right should swing the scene right
  // (the camera orbits the other way), so negate the horizontal delta.
  cam.yaw -= dxPx * 0.008;
  cam.pitch = Math.max(0.15, Math.min(1.45, cam.pitch + dyPx * 0.005));
  return cam;
}

// Scroll-wheel zoom: factor >1 zooms out, <1 zooms in. Clamped so the rig
// can't collapse into the origin or fly off past useful render range.
function zoomCamera3D(cam, factor) {
  cam.dist = Math.max(200, Math.min(400000, cam.dist * factor));
  return cam;
}

// --- Shading helpers -----------------------------------------------------

function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }

// Ground fill: blends low->high terrain colors by height, then darkens or
// brightens by up to 25% from the quad's own lambert term. Opaque — this is
// the ground, it should fully occlude whatever painter-sorts behind it.
function terrainQuadColor(avgHeightM, lambert) {
  const t = Math.max(0, Math.min(1, avgHeightM / 150));
  const lo = [34, 35, 27], hi = [128, 126, 100];
  const shade = 1 + Math.max(-1, Math.min(1, lambert)) * 0.25;
  const r = clamp255((lo[0] + (hi[0] - lo[0]) * t) * shade);
  const g = clamp255((lo[1] + (hi[1] - lo[1]) * t) * shade);
  const b = clamp255((lo[2] + (hi[2] - lo[2]) * t) * shade);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// Building walls are flat boxes with constant cardinal normals, so their
// lambert term is a fixed number per direction — no per-vertex work needed.
const WALL_LAMBERT = {
  north: v3dot({ x: 0, y: -1, z: 0 }, LIGHT_DIR),
  east: v3dot({ x: 1, y: 0, z: 0 }, LIGHT_DIR),
  south: v3dot({ x: 0, y: 1, z: 0 }, LIGHT_DIR),
  west: v3dot({ x: -1, y: 0, z: 0 }, LIGHT_DIR),
  top: v3dot({ x: 0, y: 0, z: 1 }, LIGHT_DIR),
};

// Maps a lambert term to an alpha in a readable band — this is what makes
// two of a building's four walls read as the lit pair and two as the
// shadowed pair, without ever needing to know where the camera is.
function wallAlpha(lambert) {
  return Math.max(0.35, Math.min(0.92, 0.72 + lambert * 0.22));
}

// Projects a quad's centroid (for depth-sort) and all 4 corners (for the
// actual polygon). Drops the whole quad if any of those five projections
// fails — a partially-behind-camera quad isn't worth drawing wrong.
function addQuad(items, cam, cv, p1, p2, p3, p4, fill, stroke, lineWidth) {
  const ctr = {
    x: (p1.x + p2.x + p3.x + p4.x) / 4,
    y: (p1.y + p2.y + p3.y + p4.y) / 4,
    z: (p1.z + p2.z + p3.z + p4.z) / 4,
  };
  const cd = project3D(cam, cv.width, cv.height, ctr.x, ctr.y, ctr.z);
  if (!cd) return;
  const s1 = project3D(cam, cv.width, cv.height, p1.x, p1.y, p1.z);
  const s2 = project3D(cam, cv.width, cv.height, p2.x, p2.y, p2.z);
  const s3 = project3D(cam, cv.width, cv.height, p3.x, p3.y, p3.z);
  const s4 = project3D(cam, cv.width, cv.height, p4.x, p4.y, p4.z);
  if (!s1 || !s2 || !s3 || !s4) return;
  items.push({ depth: cd.depth, pts: [s1, s2, s3, s4], fill, stroke, lineWidth: lineWidth || 1 });
}

const ROLE_COLOR_3D = {
  mission: '#7fc95e',
  relay: '#e6b345',
  hold: '#d970a8',
  relink: '#5ecfcf',
  rtl: '#a48fe0',
  rtb: '#a48fe0',
};

// --- Main render -----------------------------------------------------------

function renderView3D(ctx, cv, s, status, cam, selected) {
  ctx.clearRect(0, 0, cv.width, cv.height); // transparent — host page supplies the bg

  // Terrain: a large SQUARE centered on the scene, so the ground fills the
  // view in every direction (a real landscape surrounds you) rather than a
  // thin strip along the path. Sized to roughly the camera's reach.
  const cxm = (s.base.x + s.target.x) / 2, cym = (s.base.y + s.target.y) / 2;
  const scspan = Math.hypot(s.target.x - s.base.x, s.target.y - s.base.y);
  const half = Math.max(scspan * 1.9 + 400, 800);
  const x0 = cxm - half, x1 = cxm + half, y0 = cym - half, y1 = cym + half;
  const spanX = x1 - x0, spanY = y1 - y0;

  // Flat/urban ground has no relief to resolve — a coarse mesh is enough and
  // far cheaper; only terrain with actual hills gets the fine grid.
  const gridN = s.terrain.groundAmpM > 0 ? 48 : 24;
  const stride = gridN + 1;

  // Sample every grid corner exactly once per call and cache it — each
  // interior corner is shared by up to 4 quads, so this is ~1/4 the
  // terrainGroundAt calls a naive per-quad sample would cost.
  const heights = new Array(stride * stride);
  for (let j = 0; j < stride; j++) {
    const wy = y0 + (spanY * j) / gridN;
    for (let i = 0; i < stride; i++) {
      const wx = x0 + (spanX * i) / gridN;
      heights[j * stride + i] = terrainGroundAt(s.terrain, wx, wy);
    }
  }

  const items = [];

  for (let j = 0; j < gridN; j++) {
    for (let i = 0; i < gridN; i++) {
      const xL = x0 + (spanX * i) / gridN, xR = x0 + (spanX * (i + 1)) / gridN;
      const yT = y0 + (spanY * j) / gridN, yB = y0 + (spanY * (j + 1)) / gridN;
      const h00 = heights[j * stride + i];
      const h10 = heights[j * stride + i + 1];
      const h01 = heights[(j + 1) * stride + i];
      const h11 = heights[(j + 1) * stride + i + 1];
      const p1 = { x: xL, y: yT, z: h00 };
      const p2 = { x: xR, y: yT, z: h10 };
      const p3 = { x: xR, y: yB, z: h11 };
      const p4 = { x: xL, y: yB, z: h01 };

      const normal = v3norm(v3cross(v3sub(p2, p1), v3sub(p4, p1)));
      const lambert = v3dot(normal, LIGHT_DIR);
      const avgH = (h00 + h10 + h01 + h11) / 4;
      addQuad(items, cam, cv, p1, p2, p3, p4, terrainQuadColor(avgH, lambert), 'rgba(138,136,122,0.07)', 1);
    }
  }

  // Buildings — extruded boxes. Walls shade by fixed cardinal lambert (see
  // WALL_LAMBERT); anything that pokes above the swarm's flight altitude
  // gets a red edge so it reads as an obstacle, not just scenery.
  // A very dense city can have thousands of buildings; keep 3D smooth by
  // rendering a uniformly-thinned subset (every k-th building) up to
  // BUILDING_RENDER_CAP, so the whole box stays populated but bounded. No
  // per-frame sort or allocation. The 2D map still draws every building.
  const allB = s.terrain.buildings || [];
  const bStride = allB.length > BUILDING_RENDER_CAP ? Math.ceil(allB.length / BUILDING_RENDER_CAP) : 1;
  for (let bi = 0; bi < allB.length; bi += bStride) {
    const b = allB[bi];
    if (b.x < x0 || b.x > x1 || b.y < y0 || b.y > y1) continue; // outside the rendered ground
    const base = terrainGroundAt(s.terrain, b.x, b.y);
    const top = base + b.heightM;
    const hw = b.w / 2, hd = b.d / 2;
    const edgeStroke = b.heightM > s.altitudeM ? 'rgba(224,96,80,0.5)' : 'rgba(19,20,16,0.55)';

    const BFL = { x: b.x - hw, y: b.y - hd, z: base };
    const BFR = { x: b.x + hw, y: b.y - hd, z: base };
    const BBR = { x: b.x + hw, y: b.y + hd, z: base };
    const BBL = { x: b.x - hw, y: b.y + hd, z: base };
    const TFL = { x: b.x - hw, y: b.y - hd, z: top };
    const TFR = { x: b.x + hw, y: b.y - hd, z: top };
    const TBR = { x: b.x + hw, y: b.y + hd, z: top };
    const TBL = { x: b.x - hw, y: b.y + hd, z: top };

    const wallFill = (lambert) => 'rgba(90,89,76,' + wallAlpha(lambert).toFixed(2) + ')';
    const topFill = 'rgba(120,118,103,' + wallAlpha(WALL_LAMBERT.top).toFixed(2) + ')';

    addQuad(items, cam, cv, BFL, BFR, TFR, TFL, wallFill(WALL_LAMBERT.north), edgeStroke, 1);
    addQuad(items, cam, cv, BFR, BBR, TBR, TFR, wallFill(WALL_LAMBERT.east), edgeStroke, 1);
    addQuad(items, cam, cv, BBR, BBL, TBL, TBR, wallFill(WALL_LAMBERT.south), edgeStroke, 1);
    addQuad(items, cam, cv, BBL, BFL, TFL, TBL, wallFill(WALL_LAMBERT.west), edgeStroke, 1);
    addQuad(items, cam, cv, TFL, TFR, TBR, TBL, topFill, edgeStroke, 1);
  }

  // Painter's algorithm: farthest first, nearest last.
  items.sort((a, b) => b.depth - a.depth);
  for (const it of items) {
    ctx.beginPath();
    ctx.moveTo(it.pts[0].x, it.pts[0].y);
    ctx.lineTo(it.pts[1].x, it.pts[1].y);
    ctx.lineTo(it.pts[2].x, it.pts[2].y);
    ctx.lineTo(it.pts[3].x, it.pts[3].y);
    ctx.closePath();
    ctx.fillStyle = it.fill;
    ctx.fill();
    if (it.stroke) {
      ctx.strokeStyle = it.stroke;
      ctx.lineWidth = it.lineWidth;
      ctx.stroke();
    }
  }

  // Radio links, drawn above the terrain/buildings so they read as an
  // overlay rather than something the mesh could occlude mid-hop.
  for (const hop of status.hops) {
    const altA = terrainGroundAt(s.terrain, hop.a.x, hop.a.y) + (hop.a.id === 'C2' ? 2 : s.altitudeM);
    const altB = terrainGroundAt(s.terrain, hop.b.x, hop.b.y) + (hop.b.id === 'C2' ? 2 : s.altitudeM);
    const pa = project3D(cam, cv.width, cv.height, hop.a.x, hop.a.y, altA);
    const pb = project3D(cam, cv.width, cv.height, hop.b.x, hop.b.y, altB);
    if (!pa || !pb) continue;
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
    if (hop.state === 'ok') { ctx.strokeStyle = '#7fc95e'; ctx.setLineDash([]); }
    else if (hop.state === 'degraded') { ctx.strokeStyle = '#e6b345'; ctx.setLineDash([8, 5]); }
    else { ctx.strokeStyle = '#e06050'; ctx.setLineDash([3, 6]); }
    ctx.lineWidth = 1.5;
    ctx.stroke(); ctx.setLineDash([]);
  }

  // Drones: a stem from the ground point up to flight altitude, then the
  // drone itself as a colored dot. Dead drones get a ground-level x instead;
  // landed drones sit flush with the mesh and aren't worth drawing twice.
  for (const d of s.drones) {
    if (d.mode === 'dead') {
      const groundAlt = terrainGroundAt(s.terrain, d.x, d.y);
      const gp = project3D(cam, cv.width, cv.height, d.x, d.y, groundAlt);
      if (!gp) continue;
      ctx.strokeStyle = '#e06050'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(gp.x - 5, gp.y - 5); ctx.lineTo(gp.x + 5, gp.y + 5);
      ctx.moveTo(gp.x + 5, gp.y - 5); ctx.lineTo(gp.x - 5, gp.y + 5);
      ctx.stroke();
      continue;
    }
    if (d.mode === 'landed') continue;

    const groundAlt = terrainGroundAt(s.terrain, d.x, d.y);
    const altitude = groundAlt + s.altitudeM;
    const gp = project3D(cam, cv.width, cv.height, d.x, d.y, groundAlt);
    const dp = project3D(cam, cv.width, cv.height, d.x, d.y, altitude);
    if (!gp || !dp) continue;

    ctx.strokeStyle = 'rgba(138,136,122,0.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(gp.x, gp.y); ctx.lineTo(dp.x, dp.y); ctx.stroke();

    ctx.beginPath(); ctx.arc(gp.x, gp.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(138,136,122,0.5)'; ctx.fill();

    const role = effRole(d);
    const col = ROLE_COLOR_3D[role] || '#a48fe0';

    if (d === selected) {
      ctx.beginPath(); ctx.arc(dp.x, dp.y, 9, 0, Math.PI * 2);
      ctx.strokeStyle = '#e8e6da'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.stroke(); ctx.setLineDash([]);
    }

    ctx.beginPath(); ctx.arc(dp.x, dp.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();

    ctx.font = '10px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(120,118,103,1)';
    ctx.fillText(d.id, dp.x, dp.y + 14);
  }

  // C2 mast — a tall marker (12 m, well above real gear) purely so it reads
  // clearly against the terrain mesh from any camera angle.
  {
    const groundAlt = terrainGroundAt(s.terrain, s.base.x, s.base.y);
    const gp = project3D(cam, cv.width, cv.height, s.base.x, s.base.y, groundAlt);
    const tp = project3D(cam, cv.width, cv.height, s.base.x, s.base.y, groundAlt + 12);
    if (gp && tp) {
      ctx.strokeStyle = '#a5a293'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(gp.x, gp.y); ctx.lineTo(tp.x, tp.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(tp.x, tp.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#a5a293'; ctx.fill();
      ctx.font = '12px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = '#a5a293';
      ctx.fillText('C2', tp.x, tp.y - 10);
    }
  }

  // Target crosshair, ground-level.
  {
    const groundAlt = terrainGroundAt(s.terrain, s.target.x, s.target.y);
    const tp = project3D(cam, cv.width, cv.height, s.target.x, s.target.y, groundAlt);
    if (tp) {
      ctx.strokeStyle = '#6f9fe6'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(tp.x, tp.y, 12, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tp.x - 18, tp.y); ctx.lineTo(tp.x - 6, tp.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tp.x + 6, tp.y); ctx.lineTo(tp.x + 18, tp.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tp.x, tp.y - 18); ctx.lineTo(tp.x, tp.y - 6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(tp.x, tp.y + 6); ctx.lineTo(tp.x, tp.y + 18); ctx.stroke();
      ctx.font = '12px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = '#6f9fe6';
      ctx.fillText('target', tp.x, tp.y + 32);
    }
  }

  // Interference sources: a ground denial-zone ring (projected as a perspective
  // ellipse) plus an emitter mast, matching the 2D view so the operator sees
  // the same red zone in both.
  for (const j of (s.jammers || [])) {
    const g = terrainGroundAt(s.terrain, j.x, j.y);
    const R = typeof jammerDenialRadiusM === 'function' ? jammerDenialRadiusM(s, j) : 0;
    const col = j.on === false ? '#8a887a' : '#e06050';
    if (j.on !== false && R > 3) {
      const N = 48, ring = [];
      for (let k = 0; k < N; k++) {
        const a = k / N * Math.PI * 2;
        const rx = j.x + Math.cos(a) * R, ry = j.y + Math.sin(a) * R;
        const rp = project3D(cam, cv.width, cv.height, rx, ry, terrainGroundAt(s.terrain, rx, ry));
        if (rp) ring.push(rp);
      }
      if (ring.length > 8) {
        ctx.beginPath(); ctx.moveTo(ring[0].x, ring[0].y);
        for (let k = 1; k < ring.length; k++) ctx.lineTo(ring[k].x, ring[k].y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(224,96,80,0.10)'; ctx.fill();
        ctx.strokeStyle = 'rgba(224,96,80,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
        ctx.stroke(); ctx.setLineDash([]);
      }
    }
    const base = project3D(cam, cv.width, cv.height, j.x, j.y, g);
    const top = project3D(cam, cv.width, cv.height, j.x, j.y, g + (j.altM || 15) + 10);
    if (base && top) {
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(top.x, top.y, 4, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      ctx.font = '11px "IBM Plex Mono", monospace'; ctx.textAlign = 'center'; ctx.fillStyle = col;
      ctx.fillText((j.on === false ? 'off · ' : '') + j.erpDbm + ' dBm', top.x, top.y - 10);
    }
  }
}

// UMD-lite export so the camera math is unit-testable under Node.
// renderView3D needs a live canvas context, so it stays browser-only.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { makeCamera3D, project3D, orbitCamera3D, zoomCamera3D };
}

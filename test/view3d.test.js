// 3D view unit tests — run with:  node --test test/view3d.test.js
// These pin down the camera math: the projection contract (screen center,
// behind-camera culling, monotonic depth) and the orbit/zoom clamps that
// keep the rig from flipping upside down or collapsing into the origin.

const { test } = require('node:test');
const assert = require('node:assert');

const V = require('../js/view3d.js');
const vm = require('node:vm');
const { loadUI } = require('./helpers/dom.js');

const STUB_SWARM = { base: { x: 0, y: 0 }, target: { x: 1000, y: 0 } };

for (const [name, mutate] of [
  ['target x +3000m', s => { s.target.x += 3000; }],
  ['target y +3000m', s => { s.target.y += 3000; }],
  ['base x +3000m', s => { s.base.x += 3000; }],
  ['base y +3000m', s => { s.base.y += 3000; }],
  ['ground amplitude', s => { s.terrain.groundAmpM += 50; }],
  ['ground scale', s => { s.terrain.groundScaleM += 100; }],
  ['terrain seed', s => { s.terrain.seed += 1; }],
  ['building x', s => { s.terrain.buildings[0].x += 100; }],
  ['building y', s => { s.terrain.buildings[0].y += 100; }],
  ['building width', s => { s.terrain.buildings[0].w += 50; }],
  ['building depth', s => { s.terrain.buildings[0].d += 50; }],
  ['building height', s => { s.terrain.buildings[0].heightM += 50; }],
  ['building replacement', s => { s.terrain.buildings = [{ x: 10, y: 20, w: 60, d: 80, heightM: 120 }]; }],
  ['terrain replacement', s => { s.terrain = { ...s.terrain, groundAmpM: 10 }; }],
  ['flight altitude', s => { s.altitudeM = 200; }],
  ['canvas width', (s, cam, cv) => { cv.width += 100; }],
  ['canvas height', (s, cam, cv) => { cv.height += 100; }],
  ...['yaw', 'pitch', 'dist', 'cx', 'cy'].map(k => ['small camera ' + k,
    (s, cam) => { cam[k] += k === 'yaw' || k === 'pitch' ? 0.000001 : 0.001; }]),
]) {
  test('F14 cached render equals forced rebuild after ' + name, () => {
    const { ctx, document } = loadUI({ scripts: ['js/terrain.js', 'js/view3d.js'] });
    const s = {
      base: { x: 0, y: 0 }, target: { x: 1000, y: 0 }, altitudeM: 70, drones: [],
      terrain: { seed: 42, groundAmpM: 100, groundScaleM: 800,
        buildings: [{ x: 300, y: 0, w: 70, d: 90, heightM: 90 }] },
    };
    const cv = document.createElement('canvas');
    cv.width = 800; cv.height = 600;
    const cam = ctx.makeCamera3D(s);
    const render = () => {
      ctx.renderView3D(cv.getContext('2d'), cv, s, { hops: [] }, cam, null);
      return vm.runInContext('view3dScene.items', ctx);
    };
    const original = render();
    assert.strictEqual(render(), original, 'unchanged frame must reuse the cache');
    mutate(s, cam, cv);
    const cached = render();
    vm.runInContext('view3dScene.items = null', ctx);
    const rebuilt = render();
    assert.notStrictEqual(JSON.stringify(rebuilt), JSON.stringify(original), 'mutation must affect the static scene');
    assert.ok(JSON.stringify(cached) === JSON.stringify(rebuilt), 'cached geometry must equal a forced rebuild');
    assert.strictEqual(render(), rebuilt, 'new state must be cached again');
  });
}

test('F14 ground texture invalidates for every bound and anchor coordinate', () => {
  const { ctx } = loadUI({ scripts: ['js/osm.js', 'js/tiles.js', 'js/view3d.js'] });
  ctx.tileGet = () => ({ ok: true, img: {} });
  const anchor = { x: 0, y: 0, lat: 40, lon: -74 };
  const bounds = [-800, -800, 800, 800];
  let previous = ctx.buildGroundTexture(anchor, ...bounds, 0);
  assert.strictEqual(ctx.buildGroundTexture(anchor, ...bounds, 0), previous);
  for (const mutate of [
    () => { bounds[0] += 0.01; }, () => { bounds[1] += 0.01; },
    () => { bounds[2] += 0.01; }, () => { bounds[3] += 1; },
    () => { anchor.lat += 0.000001; }, () => { anchor.lon += 0.000001; },
    () => { anchor.x += 100; }, () => { anchor.y += 100; },
  ]) {
    mutate();
    const current = ctx.buildGroundTexture(anchor, ...bounds, 0);
    assert.notStrictEqual(current, previous);
    assert.strictEqual(ctx.buildGroundTexture(anchor, ...bounds, 0), current);
    previous = current;
  }
});

test('makeCamera3D centers between base and target', () => {
  const cam = V.makeCamera3D(STUB_SWARM);
  assert.strictEqual(cam.cx, 500);
  assert.strictEqual(cam.cy, 0);
});

test('project3D of the lookAt point lands within 1px of canvas center', () => {
  const cam = V.makeCamera3D(STUB_SWARM);
  const p = V.project3D(cam, 800, 600, cam.cx, cam.cy, 0);
  assert.ok(p, 'lookAt point must project');
  assert.ok(Math.abs(p.x - 400) < 1, 'x should be ~canvas center: ' + p.x);
  assert.ok(Math.abs(p.y - 300) < 1, 'y should be ~canvas center: ' + p.y);
});

test('project3D: a point behind the camera returns null', () => {
  const cam = V.makeCamera3D(STUB_SWARM);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const cyw = Math.cos(cam.yaw), syw = Math.sin(cam.yaw);
  const eye = {
    x: cam.cx + cam.dist * cp * cyw,
    y: cam.cy + cam.dist * cp * syw,
    z: cam.dist * sp,
  };
  // Step further from lookAt, past the eye — this is "behind" the camera.
  const behind = {
    x: eye.x + cp * cyw * 50,
    y: eye.y + cp * syw * 50,
    z: eye.z + sp * 50,
  };
  const p = V.project3D(cam, 800, 600, behind.x, behind.y, behind.z);
  assert.strictEqual(p, null);
});

test('project3D: points farther along the view axis get larger depth', () => {
  const cam = V.makeCamera3D(STUB_SWARM);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const cyw = Math.cos(cam.yaw), syw = Math.sin(cam.yaw);
  // Points beyond lookAt, moving away from the eye along the boresight.
  const near = V.project3D(cam, 800, 600,
    cam.cx - cp * cyw * 100, cam.cy - cp * syw * 100, -sp * 100);
  const far = V.project3D(cam, 800, 600,
    cam.cx - cp * cyw * 5000, cam.cy - cp * syw * 5000, -sp * 5000);
  assert.ok(near && far, 'both points must project');
  assert.ok(far.depth > near.depth, 'farther point should have larger depth');
});

test('orbitCamera3D clamps pitch to [0.15, 1.45]', () => {
  const cam = V.makeCamera3D(STUB_SWARM);
  V.orbitCamera3D(cam, 0, 100000);
  assert.ok(Math.abs(cam.pitch - 1.45) < 1e-9, 'pitch should clamp to max: ' + cam.pitch);
  V.orbitCamera3D(cam, 0, -100000);
  assert.ok(Math.abs(cam.pitch - 0.15) < 1e-9, 'pitch should clamp to min: ' + cam.pitch);
});

test('zoomCamera3D clamps dist to [200, 400000]', () => {
  const cam = V.makeCamera3D(STUB_SWARM);
  V.zoomCamera3D(cam, 0.00001);
  assert.ok(Math.abs(cam.dist - 200) < 1e-9, 'dist should clamp to min: ' + cam.dist);
  V.zoomCamera3D(cam, 1e9);
  assert.ok(Math.abs(cam.dist - 400000) < 1e-9, 'dist should clamp to max: ' + cam.dist);
});

// Audit ui-render/project3d-recomputes-basis: the camera basis (4 trig calls,
// 2 normalisations, 2 cross products) was rebuilt for EVERY projected vertex,
// ~34k times per scene rebuild. It must be built once per frame, and the
// hoisted projector must give exactly what project3D gives.
test('makeProjector matches project3D bit-for-bit, including culled points', () => {
  const cams = [V.makeCamera3D(STUB_SWARM), { yaw: 0.7, pitch: 1.2, dist: 900, cx: -300, cy: 450 },
    { yaw: -3.1, pitch: 0.12, dist: 5000, cx: 2000, cy: -800 }];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let culled = 0;
  for (const cam of cams) {
    const proj = V.makeProjector(cam, 1024, 700);
    for (let i = 0; i < 400; i++) {
      const x = (rnd() - 0.5) * 12000, y = (rnd() - 0.5) * 12000, z = rnd() * 600;
      const a = proj(x, y, z), b = V.project3D(cam, 1024, 700, x, y, z);
      assert.deepStrictEqual(a, b);
      if (!b) culled++;
    }
  }
  assert.ok(culled > 0, 'the sample must include behind-camera points');
});

test('a full 3D scene rebuild builds the camera basis once, not per vertex', () => {
  const { ctx, document } = loadUI({ scripts: ['js/terrain.js', 'js/view3d.js'] });
  const s = {
    base: { x: 0, y: 0 }, target: { x: 1000, y: 0 }, altitudeM: 70, drones: [],
    terrain: { seed: 42, groundAmpM: 100, groundScaleM: 800,
      buildings: [{ x: 300, y: 0, w: 70, d: 90, heightM: 90 }] },
  };
  const cv = document.createElement('canvas');
  cv.width = 800; cv.height = 600;
  const cam = ctx.makeCamera3D(s);
  // The basis is the only cross product taken against world-up (0,0,1);
  // terrain normals cross two ground edges.
  const realCross = ctx.v3cross;
  let bases = 0;
  ctx.v3cross = (a, b) => {
    if (b.x === 0 && b.y === 0 && b.z === 1) bases++;
    return realCross(a, b);
  };
  ctx.renderView3D(cv.getContext('2d'), cv, s, { hops: [] }, cam, null);
  assert.ok(vm.runInContext('view3dScene.items.length', ctx) > 1000, 'the rebuild projected the full ground mesh');
  assert.ok(bases <= 2, 'camera basis built ' + bases + ' times in one frame');
});

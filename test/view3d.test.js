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
  const { ctx } = loadUI({ scripts: ['js/tiles.js', 'js/view3d.js'] });
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

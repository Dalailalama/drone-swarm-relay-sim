// 3D view unit tests — run with:  node --test test/view3d.test.js
// These pin down the camera math: the projection contract (screen center,
// behind-camera culling, monotonic depth) and the orbit/zoom clamps that
// keep the rig from flipping upside down or collapsing into the origin.

const { test } = require('node:test');
const assert = require('node:assert');

const V = require('../js/view3d.js');

const STUB_SWARM = { base: { x: 0, y: 0 }, target: { x: 1000, y: 0 } };

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

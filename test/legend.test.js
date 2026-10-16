// Audit ui-render/legend-role-colors: the 'relink' and 'rescue' legend
// entries had no swatch (no ::before background), 'landed' was missing from
// the legend, and the 3D view painted rescue drones in the RTB violet
// because ROLE_COLOR_3D had no rescue (or landed) entry.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadUI } = require('./helpers/dom.js');

const ROOT = path.join(__dirname, '..');
const ROLES = ['mission', 'relay', 'hold', 'relink', 'rescue', 'rtb', 'rtl', 'landed'];

test('every legend entry has a swatch colour, and landed is listed', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
  const legend = html.match(/<div id="legend"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(legend, 'legend block found');
  const classes = [...legend[1].matchAll(/class="(lg-[\w-]+)"/g)].map(m => m[1]);
  assert.ok(classes.includes('lg-landed'), 'landed has a legend entry');
  for (const c of classes) {
    assert.match(css, new RegExp('#legend \\.' + c + '::before\\s*\\{\\s*background:'), c + ' needs a swatch colour');
  }
});

test('3D drone colours match the 2D role colours', () => {
  const { ctx } = loadUI();
  const COLORS = vm.runInContext('COLORS', ctx);
  const R3 = vm.runInContext('ROLE_COLOR_3D', ctx);
  for (const r of ROLES) assert.strictEqual(R3[r], COLORS[r], r + ' must match between 2D and 3D');
});

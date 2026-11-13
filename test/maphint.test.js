// Browser check (review): the first-run tip is a flex row of text + "Got it",
// but the global `select, button { width: 100% }` rule stretched the button
// across the whole tip, squeezing the text into a ~55 px column (the tip grew
// to ~330 px tall and covered the map). The tip's own button rule must undo
// the global width.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('the first-run tip button does not inherit the global 100% button width', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
  assert.match(css, /select,\s*button\s*\{[^}]*width:\s*100%/, 'global button width rule moved; re-check this test');
  const rule = css.match(/#mapHint\s+button\s*\{([^}]*)\}/);
  assert.ok(rule, '#mapHint button rule exists');
  assert.match(rule[1], /width:\s*auto/, '#mapHint button must reset width so the tip text gets the row');
});

// Browser check (review): at bottom: 34px the tip sat over the map scale bar's
// distance label (drawn on the canvas ~30-41 px above the map's bottom edge),
// on desktop and on a 375 px phone alike — the tip spans the map's left edge
// at any width, so only vertical clearance keeps the label readable. It must
// still clear the basemap credit below it.
test('the first-run tip clears both the scale bar and the basemap credit', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
  const px = (rule, prop) => {
    const m = new RegExp('(?:^|[;\\s{])' + prop + ':\\s*(\\d+(?:\\.\\d+)?)px').exec(rule);
    return m ? +m[1] : null;
  };
  // Every rule that targets #mapHint itself, media queries included.
  const hintRules = [...css.matchAll(/#mapHint\s*\{([^}]*)\}/g)].map(m => m[1]);
  const bottoms = hintRules.map(r => px(r, 'bottom')).filter(v => v != null);
  assert.ok(bottoms.length, '#mapHint sets a bottom offset');

  // The scale bar as the page draws it: highest ink is the label's baseline
  // plus a full font size (a conservative ascender), in CSS px.
  const { loadUI } = require('./helpers/dom.js');
  const { ctx } = loadUI();
  const H = 600, ink = [];
  let font = '';
  const g = {
    set font(f) { font = f; }, get font() { return font; },
    beginPath() {}, stroke() {},
    moveTo(x, y) { ink.push(y); }, lineTo(x, y) { ink.push(y); },
    fillText(t, x, y) { ink.push(y - parseFloat(font)); },
  };
  ctx.drawScaleBar(g, { width: 800, height: H }, { pxPerM: 1 });
  const U = ctx.uiScale || 1;
  const scaleTop = (H - Math.min(...ink)) / U;
  assert.ok(scaleTop > 30 && scaleTop < 80, 'scale bar extent looks wrong: ' + scaleTop);

  // The credit: its bottom offset, padding and a 1.5-line box of its font.
  const attrib = css.match(/#mapAttrib\s*\{([^}]*)\}/)[1];
  const pad = /padding:\s*(\d+)px/.exec(attrib);
  const creditTop = px(attrib, 'bottom') + 2 * (pad ? +pad[1] : 0) + 1.5 * px(attrib, 'font-size');

  for (const b of bottoms) {
    assert.ok(b >= scaleTop + 2, 'tip bottom ' + b + 'px covers the scale bar (top at ' + scaleTop.toFixed(1) + 'px)');
    assert.ok(b >= creditTop, 'tip bottom ' + b + 'px covers the basemap credit (top at ' + creditTop + 'px)');
  }
});

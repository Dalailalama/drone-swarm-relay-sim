// Accessibility and mobile-layout findings (audit cluster D-a11y-mobile).
//  Landscape phones: the narrow-screen block stacks the map (min-height
//      300px) above the panel, so at ~812x375 the whole control panel was a
//      37px scroller under the map.
//  Unlabelled selects: eight <select>s and the map canvas had no label, so
//      assistive tech announced them by their current value.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Body of the first @media block whose condition matches `re` ('' if none).
function mediaBlock(re) {
  const at = CSS.search(re);
  if (at < 0) return '';
  let i = CSS.indexOf('{', at) + 1, depth = 1;
  const start = i;
  while (depth && i < CSS.length) { if (CSS[i] === '{') depth++; else if (CSS[i] === '}') depth--; i++; }
  return CSS.slice(start, i - 1);
}

test('short landscape phones go back to side-by-side instead of a 37px panel strip', () => {
  const body = mediaBlock(/@media[^{]*max-height:\s*\d+px[^{]*orientation:\s*landscape/);
  assert.ok(body, 'no short-landscape @media block');
  assert.match(body, /main\s*\{[^}]*flex-direction:\s*row/, 'main must lay out as a row');
  assert.match(body, /#mapWrap\s*\{[^}]*min-height:\s*0/, 'the map must drop its 300px min-height');
  assert.ok(CSS.lastIndexOf('@media (max-width: 820px) {') < CSS.search(/orientation:\s*landscape/),
    'the landscape block must come after the stacked block so it wins');
});

test('every select, visible input and the map canvas has an accessible name', () => {
  const tags = [...HTML.matchAll(/<(select|input|canvas)\b([^>]*)>/g)];
  const unnamed = [];
  for (const [, tag, attrs] of tags) {
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (/type="file"/.test(attrs) && /display:\s*none/.test(attrs)) continue; // driven by a labelled button
    const named = /\baria-label(ledby)?="[^"]+"/.test(attrs) || /\btitle="[^"]+"/.test(attrs)
      || (id && HTML.includes('for="' + id + '"'));
    if (!named) unnamed.push(tag + '#' + id);
  }
  assert.deepStrictEqual(unnamed, [], 'controls whose name falls back to their current value');
});

test('keyboard users can select a drone from the fleet list and kill it, and zoom/pan/select on the map', () => {
  const { loadUI } = require('./helpers/dom.js');
  const { ctx, el, fire } = loadUI();
  const frames = () => { for (let i = 0; i < 20; i++) ctx.__raf.pump(16); }; // panels refresh every 0.2 s
  frames();
  const row = el('fleetBody').children[1];
  assert.strictEqual(row.getAttribute('tabindex'), '0', 'fleet rows must be in the tab order');
  assert.strictEqual(row.getAttribute('role'), 'button');
  const ev = fire('fleetBody', 'keydown', { key: 'Enter', target: row });
  assert.ok(ev.defaultPrevented, 'Enter on a row is handled');
  assert.ok(!el('killBtn').disabled, 'Kill must enable without waiting for a frame');
  assert.strictEqual(el('killBtn').textContent, 'Kill ' + row.dataset.id);
  frames();
  assert.strictEqual(row.getAttribute('aria-pressed'), 'true', 'the selected row says so');

  assert.strictEqual(el('map').getAttribute('tabindex'), '0', 'the map must be focusable');
  const z0 = ctx.sim.view.pxPerM;
  fire('map', 'keydown', { key: '+' });
  assert.ok(ctx.sim.view.pxPerM > z0, '+ zooms in');
  const cx0 = ctx.sim.view.cx;
  fire('map', 'keydown', { key: 'ArrowRight' });
  assert.ok(ctx.sim.view.cx > cx0, 'arrows pan');
  fire('map', 'keydown', { key: ']' });
  assert.ok(el('killBtn').textContent.startsWith('Kill ') && el('killBtn').textContent !== 'Kill ' + row.dataset.id,
    '] moves the selection to the next drone');
  const unused = fire('map', 'keydown', { key: 'q' });
  assert.ok(!unused.defaultPrevented, 'keys the map does not use are left alone');
});

test('link-state changes and the event log are live regions', () => {
  assert.match(HTML, /<span id="statusPill"[^>]*\brole="status"/, '#statusPill must be role=status');
  assert.match(HTML, /<span id="statusPill"[^>]*\baria-live="polite"/);
  assert.match(HTML, /<div id="eventLog"[^>]*\brole="log"/, '#eventLog must be role=log');
  assert.match(HTML, /<div id="eventLog"[^>]*\baria-live="polite"/);
});

test('the page loads nothing from a third-party origin at startup (no Google Fonts)', () => {
  const external = [...HTML.matchAll(/<(link|script)\b[^>]*\b(href|src)="(https?:)?\/\/[^"]*"[^>]*>/g)].map(m => m[0]);
  assert.deepStrictEqual(external, [], 'every visit leaked the operator IP to the font host');
  assert.ok(!/@import\s+url\(\s*['"]?https?:/.test(CSS), 'no remote @import in style.css');
});

// WCAG 2.x relative-luminance contrast ratio between two #rrggbb colours.
function contrast(a, b) {
  const lum = hex => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('text tokens meet WCAG AA 4.5:1 on every panel surface they are drawn on', () => {
  const tok = {};
  for (const m of CSS.match(/:root\s*\{[^}]*\}/)[0].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) tok[m[1]] = m[2];
  const pairs = [];
  for (const fg of ['dim', 'dim-2', 'text', 'text-2', 'ok', 'warn', 'lost']) pairs.push([fg, 'panel-2']);
  pairs.push(['dim', 'panel'], ['dim', 'bg']);
  const low = pairs.map(([f, b]) => [f + ' on ' + b, contrast(tok[f], tok[b])]).filter(([, r]) => r < 4.5)
    .map(([n, r]) => n + ' ' + r.toFixed(2));
  assert.deepStrictEqual(low, []);
});

test('a Content-Security-Policy contains any future unescaped innerHTML sink', () => {
  const m = HTML.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, 'index.html must carry a CSP meta (static servers set no header)');
  const dir = Object.fromEntries(m[1].split(';').map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepStrictEqual(dir['script-src'], ["'self'"], 'scripts only from the page origin, no inline/eval');
  assert.deepStrictEqual(dir['object-src'], ["'none'"]);
  for (const need of ['ws:', 'wss:']) assert.ok(dir['connect-src'].includes(need), 'bridges run on any host: ' + need);
  // The basemap host is read from tiles.js so a provider change cannot leave the CSP blocking every tile.
  const tileOrigin = fs.readFileSync(path.join(ROOT, 'js', 'tiles.js'), 'utf8').match(/img\.src = '(https:\/\/[^/']+)\//)[1];
  assert.ok(dir['img-src'].includes(tileOrigin), 'basemap tiles still load from ' + tileOrigin);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(HTML), 'no inline <script> bodies');
  assert.ok(!/\son[a-z]+="/.test(HTML), 'no inline on* handlers');
});

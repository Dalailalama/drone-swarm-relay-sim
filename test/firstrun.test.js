// No in-app first-run guidance (audit ui-render/no-first-run-guidance): that
// the target and C2 are draggable, that a drone is selected by clicking it
// (needed for Kill), and how to zoom or orbit in 3D were only in the README.
// A dismissible tip now sits on the map; dismissal is remembered per browser,
// and blocked storage only means it is not remembered.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, __m: m };
}

test('the map tip shows on first visit, names the gestures, and stays dismissed', () => {
  const store = memoryStorage();
  const first = loadUI({ globals: { localStorage: store } });
  const hint = first.el('mapHint');
  assert.notStrictEqual(hint.style.display, 'none', 'the tip shows on a first visit');
  const text = hint.textContent.toLowerCase();
  for (const w of ['drag', 'target', 'c2', 'kill', 'zoom', '3d']) assert.ok(text.includes(w), 'the tip mentions ' + w + ': ' + text);
  first.el('mapHintClose').click();
  assert.strictEqual(hint.style.display, 'none', 'dismiss hides it');
  assert.ok(store.__m.size === 1, 'and remembers it');
  const again = loadUI({ globals: { localStorage: store } });
  assert.strictEqual(again.el('mapHint').style.display, 'none', 'a second visit starts without it');
});

test('blocked storage still shows the tip and lets it be dismissed', () => {
  const boom = () => { throw new Error('SecurityError'); };
  const ui = loadUI({ globals: { localStorage: { getItem: boom, setItem: boom, removeItem: boom } } });
  assert.notStrictEqual(ui.el('mapHint').style.display, 'none');
  ui.el('mapHintClose').click();
  assert.strictEqual(ui.el('mapHint').style.display, 'none');
});

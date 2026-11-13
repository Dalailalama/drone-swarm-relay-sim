// CoT uids are globally unique on a TAK net — the newest event for a uid
// overwrites all earlier ones — so two simulator tabs (or two operators)
// streaming through tak_bridge.py with fixed SIM-* uids overwrote each
// other's tracks. Each page now draws its own uid prefix at load.
const { test } = require('node:test');
const assert = require('node:assert');
const { webcrypto } = require('node:crypto');
const { loadUI } = require('./helpers/dom.js');

const exportUids = ui => {
  ui.fire('takExportBtn', 'click');
  const dl = ui.ctx.__downloads[ui.ctx.__downloads.length - 1];
  return [...dl.text.matchAll(/uid="([^"]*)"/g)].map(m => m[1]);
};

test('two simulator pages export disjoint CoT uids, each stable across exports', () => {
  const a = loadUI({ globals: { crypto: webcrypto } });
  const b = loadUI({ globals: { crypto: webcrypto } });
  const pa = a.el('takUid').value, pb = b.el('takUid').value;
  assert.match(pa, /^SIM-[0-9a-f]{6}$/, 'the TAK panel shows this page\'s uid prefix');
  assert.notStrictEqual(pa, pb);
  const ua = exportUids(a), ub = exportUids(b);
  assert.ok(ua.length >= 3 && ua.every(u => u.startsWith(pa + '-')), ua.join(' '));
  assert.ok(ua.every(u => !ub.includes(u)), 'pages share a uid: ' + ua.filter(u => ub.includes(u)).join(' '));
  assert.deepStrictEqual(exportUids(a), ua, 'a page keeps its uids from one export to the next');
});

test('an operator-set uid prefix is used verbatim; blank falls back to the page\'s own', () => {
  const ui = loadUI({ globals: { crypto: webcrypto } });
  const own = ui.el('takUid').value;
  ui.el('takUid').value = 'ALPHA-2';
  assert.ok(exportUids(ui).includes('ALPHA-2-DR-1'));
  ui.el('takUid').value = '  ';
  assert.ok(exportUids(ui).includes(own + '-DR-1'));
});

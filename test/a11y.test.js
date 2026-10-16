// Accessibility and mobile-layout findings (audit cluster D-a11y-mobile).
//  Landscape phones: the narrow-screen block stacks the map (min-height
//      300px) above the panel, so at ~812x375 the whole control panel was a
//      37px scroller under the map.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

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

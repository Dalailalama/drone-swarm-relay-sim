// Finding #27 (review of ffb35e6, B43): CoT attribute parsing used
// ["']([^"']*)["'] — either quote character terminated either quoting
// style, so callsign="O'Brien" imported as "O". Quotes must match their
// opening delimiter; the opposite quote inside is data.
const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../js/tak.js');

function oneEvent(attrs) {
  return '<?xml version="1.0"?><event uid="m1" type="a-f-G" how="h-g-i-g-o">' +
    '<point lat="28.1" lon="77.2" hae="55" ce="10" le="10"/>' +
    '<detail><contact callsign=' + attrs + '/></detail></event>';
}

test('regression #27: an apostrophe inside a double-quoted callsign is data', () => {
  const marks = T.parseCoTFile(oneEvent('"O\'Brien"'));
  assert.strictEqual(marks.length, 1);
  assert.strictEqual(marks[0].callsign, "O'Brien",
    'got "' + marks[0].callsign + '"');
});

test('regression #27: double quotes inside a single-quoted callsign are data', () => {
  const marks = T.parseCoTFile(oneEvent('\'says "hello"\''));
  assert.strictEqual(marks.length, 1);
  assert.strictEqual(marks[0].callsign, 'says "hello"');
});

test('entities still unescape after the quote fix (round trip)', () => {
  const marks = T.parseCoTFile(oneEvent('"A &amp; B &quot;C&quot; &apos;D&apos;"'));
  assert.strictEqual(marks.length, 1);
  assert.strictEqual(marks[0].callsign, 'A & B "C" \'D\'');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCaptionFromText, splitCaptionFromWords } from '../.test-build/transcription/caption-splitter.js';

const MAX_LINE = 42;
const MAX_LINES = 2;

function assertLayout(captions) {
  for (const c of captions) {
    const lines = c.text.split('\n');
    assert.ok(lines.length <= MAX_LINES, `caption has ${lines.length} lines: ${JSON.stringify(c.text)}`);
    for (const line of lines) {
      assert.ok(line.length <= MAX_LINE, `line too long: ${JSON.stringify(line)}`);
    }
  }
}

test('splitCaptionFromText wraps to 42 chars x 2 lines', () => {
  const text = 'This is a fairly long sentence that should be wrapped across multiple caption cards without exceeding limits.';
  const captions = splitCaptionFromText(text, 0, 10);
  assert.ok(captions.length >= 1);
  assertLayout(captions);
});

test('splitCaptionFromText enforces minimum duration', () => {
  const captions = splitCaptionFromText('Short.', 5, 5.1);
  assert.ok(captions.length === 1);
  assert.ok(captions[0].end - captions[0].start >= 1.0 - 1e-9);
});

test('splitCaptionFromText keeps starts monotonic', () => {
  const text = 'First sentence here. Second sentence follows! Third one asks a question? Fourth wraps things up.';
  const captions = splitCaptionFromText(text, 0, 12);
  for (let i = 1; i < captions.length; i++) {
    assert.ok(captions[i].start >= captions[i - 1].start);
  }
  assertLayout(captions);
});

test('splitCaptionFromWords splits on long pauses', () => {
  const words = [
    { text: 'hello', start: 0, end: 0.4 },
    { text: 'there', start: 0.5, end: 0.9 },
    { text: 'friend', start: 2.0, end: 2.4 },
  ];
  const captions = splitCaptionFromWords(words);
  assert.equal(captions.length, 2);
  assert.equal(captions[0].text, 'hello there');
  assert.equal(captions[1].text, 'friend');
});

test('splitCaptionFromWords respects char budget', () => {
  const words = [];
  for (let i = 0; i < 60; i++) {
    words.push({ text: 'word' + i, start: i * 0.3, end: i * 0.3 + 0.25 });
  }
  const captions = splitCaptionFromWords(words);
  assertLayout(captions);
  const joined = captions.map(c => c.text.replace(/\n/g, ' ')).join(' ');
  assert.equal(joined, words.map(w => w.text).join(' '));
});

test('splitCaptionFromWords drops malformed words', () => {
  const captions = splitCaptionFromWords([
    { text: '  ', start: 0, end: 1 },
    { text: 'ok', start: NaN, end: 1 },
    { text: 'kept', start: 0, end: 0.5 },
  ]);
  assert.equal(captions.length, 1);
  assert.equal(captions[0].text, 'kept');
});

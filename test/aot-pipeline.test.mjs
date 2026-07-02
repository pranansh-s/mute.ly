import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AotPipeline, CaptionCache } from '../.test-build/transcription/aot-pipeline.js';

class FakeVideo extends EventTarget {
  currentTime = 0;
  playbackRate = 1;
  duration = 100;
  paused = false;
}

function chunk(index, duration = 1000) {
  const startTime = index * 25;
  const endTime = Math.min(startTime + 30, duration);
  const ownedEnd = Math.min(startTime + 25, duration);
  return {
    key: `${Math.round(startTime * 10)}_${Math.round(endTime * 10)}`,
    index,
    startTime,
    endTime,
    ownedEnd,
  };
}

test('CaptionCache finds caption covering current time', () => {
  const cache = new CaptionCache();
  cache.set(chunk(0), [{ start: 2, end: 4, text: 'hello' }]);
  assert.equal(cache.find(3)?.text, 'hello');
  assert.equal(cache.find(10), null);
});

test('CaptionCache replaces captions when chunk key for an index changes', () => {
  const cache = new CaptionCache();
  cache.set(chunk(0, Infinity), [{ start: 2, end: 4, text: 'stale' }]);
  const reclamped = chunk(0, 28);
  cache.set(reclamped, [{ start: 2, end: 4, text: 'fresh' }]);
  assert.equal(cache.find(3)?.text, 'fresh');
});

test('CaptionCache merges duplicate overlap text across chunks', () => {
  const cache = new CaptionCache();
  cache.set(chunk(0), [{ start: 20, end: 24.9, text: 'same words' }]);
  cache.set(chunk(1), [{ start: 25, end: 27, text: 'same words' }]);
  const hit = cache.find(26);
  assert.equal(hit?.text, 'same words');
});

test('CaptionCache evicts oldest chunks beyond limit', () => {
  const cache = new CaptionCache();
  for (let i = 0; i <= 510; i++) {
    cache.set(chunk(i, Infinity), [{ start: i * 25 + 1, end: i * 25 + 2, text: 'c' + i }]);
  }
  assert.equal(cache.find(1.5), null);
  assert.equal(cache.find(510 * 25 + 1.5)?.text, 'c510');
});

test('AotPipeline stops re-dispatching a chunk after repeated audio-unavailable drops', async () => {
  const calls = new Map();
  const client = {
    transcribeAOT: async (startTime, endTime) => {
      const key = `${startTime}_${endTime}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return { dropped: true, dropReason: 'audio-unavailable' };
    },
    stopAOT: () => {},
    abortActiveAOT: () => {},
  };

  const pipeline = new AotPipeline(client, () => {});
  const video = new FakeVideo();
  pipeline.start(video);
  pipeline.updateBufferedDuration(100);

  await new Promise(r => setTimeout(r, 150));
  pipeline.destroy();

  assert.ok(calls.size > 0, 'expected at least one dispatch');
  for (const [key, count] of calls) {
    assert.ok(count <= 3, `chunk ${key} dispatched ${count} times`);
  }
  assert.ok(calls.size >= 4, `expected pipeline to advance past failing chunks, saw ${calls.size}`);
});

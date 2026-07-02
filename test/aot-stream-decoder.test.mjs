import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AotStreamDecoder } from '../.test-build/audio/aot-stream-decoder.js';

function makeDecoder() {
  const events = { errors: [], transcribed: [], empty: [], dropped: [], ready: [] };
  const decoder = new AotStreamDecoder(
    () => {},
    duration => events.ready.push(duration),
    message => events.errors.push(message),
    (audio, request) => events.transcribed.push({ audio, request }),
    request => events.empty.push(request),
    request => events.dropped.push(request)
  );
  return { decoder, events };
}

function sineBytes(seconds, freq = 440, amplitude = 0.5) {
  const samples = new Float32Array(Math.round(seconds * 16000));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / 16000);
  }
  return new Uint8Array(samples.buffer);
}

test('feed + transcribeSlice yields audio of requested length', () => {
  const { decoder, events } = makeDecoder();
  decoder.beginStream();
  decoder.feed(sineBytes(2), 0);
  decoder.transcribeSlice({ id: 1, startTime: 0, endTime: 1, mode: 'vod' });
  assert.equal(events.errors.length, 0);
  assert.equal(events.transcribed.length, 1);
  assert.equal(events.transcribed[0].audio.length, 16000);
  let peak = 0;
  for (const v of events.transcribed[0].audio) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.1, `expected audible slice, peak ${peak}`);
});

test('sequence gap fails the stream instead of desyncing', () => {
  const { decoder, events } = makeDecoder();
  decoder.beginStream();
  decoder.feed(sineBytes(1), 0);
  decoder.feed(sineBytes(1), 2);
  assert.equal(events.errors.length, 1);
  assert.match(events.errors[0], /PCM_GAP/);
  decoder.transcribeSlice({ id: 2, startTime: 0, endTime: 0.5, mode: 'vod' });
  assert.equal(events.dropped.length, 1);
});

test('slice beyond buffered audio is dropped', () => {
  const { decoder, events } = makeDecoder();
  decoder.beginStream();
  decoder.feed(sineBytes(1), 0);
  decoder.transcribeSlice({ id: 3, startTime: 0.5, endTime: 2, mode: 'vod' });
  assert.equal(events.dropped.length, 1);
  assert.equal(events.transcribed.length, 0);
});

test('finalize reports max of computed and reported duration', () => {
  const { decoder, events } = makeDecoder();
  decoder.beginStream();
  decoder.feed(sineBytes(2), 0);
  decoder.finalizeStream(1.5);
  assert.equal(events.ready.length, 1);
  assert.ok(Math.abs(events.ready[0] - 2) < 0.01);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_DURATION_SECONDS,
  CHUNK_STRIDE_SECONDS,
  computeNeededChunks,
  getChunkIndex,
  getChunkKey,
  getChunkWindow,
  pickPending,
} from '../.test-build/transcription/aot-scheduler.js';

test('getChunkKey rounds to tenths', () => {
  assert.equal(getChunkKey(0, 30), '0_300');
  assert.equal(getChunkKey(25.04, 55.06), '250_551');
});

test('getChunkIndex maps time to stride index', () => {
  assert.equal(getChunkIndex(0), 0);
  assert.equal(getChunkIndex(24.9), 0);
  assert.equal(getChunkIndex(25), 1);
  assert.equal(getChunkIndex(-5), 0);
});

test('getChunkWindow clamps to duration', () => {
  const w = getChunkWindow(3, 100);
  assert.equal(w.startTime, 75);
  assert.equal(w.endTime, 100);
  assert.equal(w.ownedEnd, 100);
  assert.equal(w.key, getChunkKey(75, 100));
});

test('getChunkWindow full window mid-video', () => {
  const w = getChunkWindow(1, 1000);
  assert.equal(w.startTime, CHUNK_STRIDE_SECONDS);
  assert.equal(w.endTime, CHUNK_STRIDE_SECONDS + CHUNK_DURATION_SECONDS);
  assert.equal(w.ownedEnd, 2 * CHUNK_STRIDE_SECONDS);
});

test('computeNeededChunks respects duration bound', () => {
  const chunks = computeNeededChunks(0, 1, 100);
  assert.deepEqual(chunks.map(c => c.index), [0, 1, 2, 3]);
});

test('computeNeededChunks extends lookahead at high playback rate', () => {
  const normal = computeNeededChunks(0, 1, 10_000);
  const fast = computeNeededChunks(0, 1.5, 10_000);
  assert.equal(fast.length, normal.length + 1);
});

test('computeNeededChunks handles unknown duration', () => {
  const chunks = computeNeededChunks(30, 1, Infinity);
  assert.equal(chunks[0].index, 1);
  assert.ok(chunks.every(c => Number.isFinite(c.endTime)));
});

test('pickPending filters cached, active, unbuffered, duplicate chunks', () => {
  const needed = computeNeededChunks(0, 1, 200);
  const cachedKey = needed[0].key;
  const activeKey = needed[1].key;
  const pending = pickPending(needed, k => k === cachedKey, activeKey, 90);
  assert.ok(pending.every(c => c.key !== cachedKey && c.key !== activeKey));
  assert.ok(pending.every(c => c.endTime <= 90));
  assert.equal(new Set(pending.map(c => c.key)).size, pending.length);
});

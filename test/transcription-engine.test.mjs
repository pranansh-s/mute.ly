import { test } from 'node:test';
import assert from 'node:assert/strict';

const listeners = [];
const sent = [];
globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener: fn => listeners.push(fn),
      removeListener: fn => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
    sendMessage: async msg => {
      sent.push(msg);
      return { ok: true };
    },
  },
};

const { TranscriptionEngine } = await import('../.test-build/transcription/transcription-engine.js');

const dispatch = msg => {
  for (const fn of [...listeners]) fn(msg);
};
const result = (id, text) => ({ _fromOffscreen: true, type: 'result', id, result: { text } });
const tick = () => new Promise(r => setTimeout(r, 10));
const liveIds = () => sent.filter(m => m?.data?.type === 'transcribe_live').map(m => m.data.id);

function makeEngine(captions) {
  const engine = new TranscriptionEngine(committed => {
    if (committed) captions.push(committed);
  });
  engine.initialize('live');
  dispatch({ _fromOffscreen: true, type: 'ready', mode: 'live', device: 'wasm' });
  return engine;
}

test('overlapping live utterances both render', async () => {
  sent.length = 0;
  const captions = [];
  const engine = makeEngine(captions);

  engine.transcribeLive(new Float32Array(1600));
  engine.transcribeLive(new Float32Array(1600));
  await tick();

  const ids = liveIds();
  assert.equal(ids.length, 2);
  dispatch(result(ids[0], 'the quick brown fox jumps over a dog'));
  dispatch(result(ids[1], 'and then the cat ran up the tall tree'));
  await tick();

  assert.deepEqual(captions, [
    'the quick brown fox jumps over a dog',
    'and then the cat ran up the tall tree',
  ]);
  engine.destroy();
});

test('seek reset discards in-flight live results', async () => {
  sent.length = 0;
  const captions = [];
  const engine = makeEngine(captions);

  engine.transcribeLive(new Float32Array(1600));
  await tick();
  const ids = liveIds();
  assert.equal(ids.length, 1);

  engine.resetLiveSession();
  dispatch(result(ids[0], 'this stale text must never render'));
  await tick();

  assert.deepEqual(captions, []);
  engine.destroy();
});

/**
 * Whisper Web Worker — runs inside the offscreen document.
 *
 * Type checking is skipped for this file because Vite builds it with a
 * module alias (`vite.worker.config.ts`) that points `@huggingface/transformers`
 * to its browser bundle. TypeScript's module resolution can't follow that alias,
 * so direct imports appear unresolved even though they work at build time.
 */
// @ts-nocheck
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = location.origin + '/assets/';

const MODEL_BY_KIND = {
  tiny: 'onnx-community/whisper-tiny.en',
  base: 'onnx-community/whisper-base.en',
};

const transcribers = new Map();
const loadPromises = new Map();
const lastLoadProgressByModel = new Map();
let currentProcessingId = null;
let abortCurrentChunk = false;

function reportProgress(modelKind) {
  return (progress) => {
    if (progress.status === 'progress' && progress.total) {
      const lastLoadProgress = Math.round((progress.loaded / progress.total) * 100);
      lastLoadProgressByModel.set(modelKind, lastLoadProgress);
      self.postMessage({
        type: 'loading',
        progress: lastLoadProgress,
        modelKind,
      });
    }
  };
}

async function loadModel(modelKind = 'base') {
  const modelId = MODEL_BY_KIND[modelKind] ?? MODEL_BY_KIND.base;
  const transcriber = transcribers.get(modelKind);

  if (transcriber) {
    self.postMessage({ type: 'ready', modelKind });
    return true;
  }

  if (!loadPromises.has(modelKind)) {
    lastLoadProgressByModel.set(modelKind, 0);
    self.postMessage({ type: 'loading', progress: 0, modelKind });

    const loadPromise = (async () => {
      try {
        const nextTranscriber = await pipeline(
          'automatic-speech-recognition',
          modelId,
          {
            device: 'wasm',
            dtype: 'q8',
            progress_callback: reportProgress(modelKind),
          }
        );

        transcribers.set(modelKind, nextTranscriber);
        self.postMessage({ type: 'ready', modelKind });
      } catch (err) {
        transcribers.delete(modelKind);
        console.error('[WhisperWorker] Failed to load model:', err);
        self.postMessage({ type: 'error', message: 'Model load failed' });
      } finally {
        loadPromises.delete(modelKind);
      }
    })();

    loadPromises.set(modelKind, loadPromise);
  } else {
    self.postMessage({
      type: 'loading',
      progress: lastLoadProgressByModel.get(modelKind) ?? 0,
      modelKind,
    });
  }

  const loadPromise = loadPromises.get(modelKind);
  await loadPromise;
  return transcribers.has(modelKind);
}

self.onmessage = async (e) => {
  const { type, audio, id, tabId, clientId, modelKind = 'base' } = e.data;

  if (type === 'load') {
    await loadModel(modelKind);
    return;
  }

  if (type === 'abort_chunk') {
    if (id === currentProcessingId) {
      abortCurrentChunk = true;
    }
    return;
  }

  if (type === 'transcribe') {
    currentProcessingId = id;
    abortCurrentChunk = false;

    const modelReady = transcribers.has(modelKind) || await loadModel(modelKind);
    const transcriber = transcribers.get(modelKind);
    if (!modelReady || !transcriber) {
      currentProcessingId = null;
      self.postMessage({ type: 'result', id, tabId, clientId, result: { dropped: true, dropReason: 'model-unavailable' } });
      return;
    }

    try {
      const result = await transcriber(new Float32Array(audio), {
        max_new_tokens: e.data.return_timestamps ? 256 : 96,
        ...(e.data.return_timestamps ? { return_timestamps: true } : {}),
        callback_function: () => {
          if (abortCurrentChunk) {
            throw new Error('ABORTED');
          }
        },
      });
      self.postMessage({ type: 'result', id, tabId, clientId, result });
    } catch (err: any) {
      if (err.message === 'ABORTED') {
        self.postMessage({ type: 'result', id, tabId, clientId, result: { dropped: true, dropReason: 'aborted' } });
      } else {
        console.error('[WhisperWorker] Transcription error:', err);
        self.postMessage({ type: 'result', id, tabId, clientId, result: { dropped: true, dropReason: 'transcription-error' } });
      }
    } finally {
      if (currentProcessingId === id) {
        currentProcessingId = null;
      }
    }
  }
};

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

let transcriber = null;
let isLoading = false;

function reportProgress(progress) {
  if (progress.status === 'progress' && progress.total) {
    self.postMessage({
      type: 'loading',
      progress: Math.round((progress.loaded / progress.total) * 100),
    });
  }
}

async function loadModel() {
  if (transcriber || isLoading) return;
  isLoading = true;
  self.postMessage({ type: 'loading', progress: 0 });

  try {
    transcriber = await pipeline(
      'automatic-speech-recognition',
      'onnx-community/whisper-base.en',
      {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: reportProgress,
      }
    );

    isLoading = false;
    self.postMessage({ type: 'ready' });
  } catch (err) {
    isLoading = false;
    console.error('[WhisperWorker] Failed to load model:', err);
    self.postMessage({ type: 'error' });
  }
}

self.onmessage = async (e) => {
  const { type, audio, id } = e.data;

  if (type === 'load') {
    await loadModel();
    return;
  }

  if (type === 'transcribe') {
    if (!transcriber) await loadModel();
    if (!transcriber) {
      self.postMessage({ type: 'result', id, result: { text: '' } });
      return;
    }

    try {
      const result = await transcriber(new Float32Array(audio), {
        max_new_tokens: 256,
        ...(e.data.return_timestamps ? { return_timestamps: true } : {})
      });
      self.postMessage({ type: 'result', id, result });
    } catch (err) {
      console.error('[WhisperWorker] Transcription error:', err);
      self.postMessage({ type: 'result', id, result: { text: '' } });
    }
  }
};

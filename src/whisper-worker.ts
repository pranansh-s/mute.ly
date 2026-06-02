type WhisperModelKind = 'tiny' | 'base';
type ModelLoadProgress = {
  status?: string;
  loaded?: number;
  total?: number;
};
type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<any>;

import * as Transformers from '@huggingface/transformers';

const { pipeline, env } = Transformers as any;

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 4);
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = location.origin + '/assets/';

const MODEL_BY_KIND: Record<WhisperModelKind, string> = {
  tiny: 'onnx-community/whisper-tiny.en',
  base: 'onnx-community/whisper-base.en',
};

const transcribers = new Map<WhisperModelKind, Transcriber>();
const loadPromises = new Map<WhisperModelKind, Promise<void>>();
const lastLoadProgressByModel = new Map<WhisperModelKind, number>();
let currentProcessingId: number | null = null;
let abortCurrentChunk = false;

function reportProgress(modelKind: WhisperModelKind) {
  return (progress: ModelLoadProgress) => {
    if (progress.status === 'progress' && progress.total && typeof progress.loaded === 'number') {
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

async function loadModel(modelKind: WhisperModelKind = 'base') {
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
        console.error('[mutely:whisper] Failed to load model:', err);
        self.postMessage({ type: 'error', message: 'Model load failed', modelKind });
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

self.onmessage = async (e: MessageEvent<any>) => {
  const { type, audio, id, tabId, clientId } = e.data;
  const modelKind = (e.data.modelKind ?? 'base') as WhisperModelKind;

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
        max_new_tokens: e.data.return_timestamps ? 256 : 64,
        num_beams: 1,
        ...(e.data.return_timestamps ? { return_timestamps: true } : {}),
        callback_function: () => {
          if (abortCurrentChunk) {
            throw new Error('ABORTED');
          }
        },
      });
      self.postMessage({ type: 'result', id, tabId, clientId, result });
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'ABORTED') {
        self.postMessage({ type: 'result', id, tabId, clientId, result: { dropped: true, dropReason: 'aborted' } });
      } else {
        console.error('[mutely:whisper] Transcription error:', err);
        self.postMessage({ type: 'result', id, tabId, clientId, result: { dropped: true, dropReason: 'transcription-error' } });
      }
    } finally {
      if (currentProcessingId === id) {
        currentProcessingId = null;
      }
    }
  }
};

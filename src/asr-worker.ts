import * as Transformers from '@huggingface/transformers';
import type { AsrMode, AsrDevice, WorkerCommand } from './core/types';

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<any>;

const { pipeline, env } = Transformers as any;

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 4);
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = location.origin + '/assets/';

const MODEL_BY_MODE: Record<AsrMode, string> = {
  live: 'onnx-community/moonshine-base-ONNX',
  vod: 'onnx-community/whisper-base.en',
};

const MAX_NEW_TOKENS_VOD = 256;

const transcribers = new Map<AsrMode, Transcriber>();
const loadPromises = new Map<AsrMode, Promise<void>>();
const lastLoadProgressByMode = new Map<AsrMode, number>();
let detectedDevice: AsrDevice | null = null;
let currentProcessingId: number | null = null;
let abortCurrentChunk = false;

console.info('[mutely:asr] crossOriginIsolated:', self.crossOriginIsolated);

async function detectDevice(): Promise<AsrDevice> {
  if (detectedDevice) return detectedDevice;
  try {
    const gpu = (navigator as any).gpu;
    if (gpu && typeof gpu.requestAdapter === 'function') {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        detectedDevice = 'webgpu';
        self.postMessage({ type: 'device', device: detectedDevice });
        return detectedDevice;
      }
    }
  } catch (err) {
    console.debug('[mutely:asr] WebGPU detect failed, using WASM:', err);
  }
  detectedDevice = 'wasm';
  self.postMessage({ type: 'device', device: detectedDevice });
  return detectedDevice;
}

function reportProgress(mode: AsrMode) {
  return (progress: { status?: string; loaded?: number; total?: number }) => {
    if (progress.status === 'progress' && progress.total && typeof progress.loaded === 'number') {
      const percent = Math.round((progress.loaded / progress.total) * 100);
      lastLoadProgressByMode.set(mode, percent);
      self.postMessage({ type: 'loading', progress: percent, mode });
    }
  };
}

async function loadModel(mode: AsrMode): Promise<boolean> {
  if (transcribers.has(mode)) {
    self.postMessage({ type: 'ready', mode, device: detectedDevice });
    return true;
  }

  if (!loadPromises.has(mode)) {
    lastLoadProgressByMode.set(mode, 0);
    self.postMessage({ type: 'loading', progress: 0, mode });

    const loadPromise = (async () => {
      try {
        const device = await detectDevice();
        const modelId = MODEL_BY_MODE[mode];

        const nextTranscriber = await pipeline(
          'automatic-speech-recognition',
          modelId,
          {
            device,
            dtype: 'q8',
            progress_callback: reportProgress(mode),
          }
        );

        transcribers.set(mode, nextTranscriber);
        self.postMessage({ type: 'ready', mode, device });
      } catch (err) {
        transcribers.delete(mode);
        console.error('[mutely:asr] Model load failed:', err);
        if (detectedDevice === 'webgpu') {
          detectedDevice = 'wasm';
          self.postMessage({ type: 'device', device: detectedDevice });
          try {
            const fallback = await pipeline(
              'automatic-speech-recognition',
              MODEL_BY_MODE[mode],
              {
                device: 'wasm',
                dtype: 'q8',
                progress_callback: reportProgress(mode),
              }
            );
            transcribers.set(mode, fallback);
            self.postMessage({ type: 'ready', mode, device: 'wasm' });
            return;
          } catch (fallbackErr) {
            console.error('[mutely:asr] WASM fallback failed:', fallbackErr);
          }
        }
        self.postMessage({ type: 'error', message: 'Model load failed', mode });
      } finally {
        loadPromises.delete(mode);
      }
    })();

    loadPromises.set(mode, loadPromise);
  } else {
    self.postMessage({
      type: 'loading',
      progress: lastLoadProgressByMode.get(mode) ?? 0,
      mode,
    });
  }

  await loadPromises.get(mode);
  return transcribers.has(mode);
}

self.onmessage = async (e: MessageEvent<WorkerCommand>) => {
  const msg = e.data;

  if (msg.type === 'load') {
    await loadModel(msg.mode);
    return;
  }

  if (msg.type === 'abort_chunk') {
    if (msg.id === currentProcessingId) abortCurrentChunk = true;
    return;
  }

  const { type, audio, id, tabId, clientId, sessionId, mode } = msg;
  currentProcessingId = id;
  abortCurrentChunk = false;

  const ready = transcribers.has(mode) || await loadModel(mode);
  const transcriber = transcribers.get(mode);
  if (!ready || !transcriber) {
    currentProcessingId = null;
    self.postMessage({ type: 'result', id, sessionId, tabId, clientId, result: { dropped: true, dropReason: 'model-unavailable' } });
    return;
  }

  try {
    const isLive = type === 'transcribe_live';
    const options: Record<string, unknown> = {
      num_beams: 1,
      callback_function: () => {
        if (abortCurrentChunk) throw new Error('ABORTED');
      },
    };
    if (!isLive) {
      options.max_new_tokens = MAX_NEW_TOKENS_VOD;
      options.return_timestamps = true;
    }

    const floatAudio = audio instanceof Float32Array ? audio : new Float32Array(audio);
    const result = await transcriber(floatAudio, options);
    self.postMessage({ type: 'result', id, sessionId, tabId, clientId, result });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'ABORTED') {
      self.postMessage({ type: 'result', id, sessionId, tabId, clientId, result: { dropped: true, dropReason: 'aborted' } });
    } else {
      console.error('[mutely:asr] Transcription error:', err);
      self.postMessage({ type: 'result', id, sessionId, tabId, clientId, result: { dropped: true, dropReason: 'transcription-error' } });
    }
  } finally {
    if (currentProcessingId === id) currentProcessingId = null;
  }
};

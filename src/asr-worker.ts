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
  live: 'onnx-community/whisper-tiny.en',
  vod: 'onnx-community/whisper-base.en',
};

const MAX_NEW_TOKENS_LIVE = 224;
const MAX_NEW_TOKENS_AOT = 444;
const VOD_NUM_BEAMS = 4;
const VOD_TEMPERATURE_FALLBACK = [0.0, 0.2, 0.4];
const VOD_NO_SPEECH_THRESHOLD = 0.6;
const VOD_LOGPROB_THRESHOLD = -1.0;
const VOD_COMPRESSION_RATIO_THRESHOLD = 2.4;

const transcribers = new Map<AsrMode, Transcriber>();
const loadPromises = new Map<AsrMode, Promise<void>>();
const lastLoadProgressByMode = new Map<AsrMode, number>();
let detectedDevice: AsrDevice | null = null;
let currentProcessingId: number | null = null;
let abortCurrentChunk = false;

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

function dtypeFor(_mode: AsrMode, device: AsrDevice): string {
  // whisper-tiny/base.en quantized variants: q8 works on both WebGPU and WASM
  // for these checkpoints. fp16 encoder + q4 decoder is an optimization to
  // revisit once we swap to models that ship those variants.
  return device === 'webgpu' ? 'q8' : 'q8';
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
        const dtype = dtypeFor(mode, device);
        const modelId = MODEL_BY_MODE[mode];

        const nextTranscriber = await pipeline(
          'automatic-speech-recognition',
          modelId,
          {
            device,
            dtype,
            progress_callback: reportProgress(mode),
          }
        );

        transcribers.set(mode, nextTranscriber);
        self.postMessage({ type: 'ready', mode, device });
      } catch (err) {
        transcribers.delete(mode);
        console.error('[mutely:asr] Model load failed:', err);
        // WebGPU init can fail late; force WASM fallback once.
        if (detectedDevice === 'webgpu') {
          detectedDevice = 'wasm';
          self.postMessage({ type: 'device', device: detectedDevice });
          try {
            const fallback = await pipeline(
              'automatic-speech-recognition',
              MODEL_BY_MODE[mode],
              {
                device: 'wasm',
                dtype: dtypeFor(mode, 'wasm'),
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

  // transcribe_live | transcribe_aot
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
      max_new_tokens: isLive ? MAX_NEW_TOKENS_LIVE : MAX_NEW_TOKENS_AOT,
      num_beams: isLive ? 1 : VOD_NUM_BEAMS,
      callback_function: () => {
        if (abortCurrentChunk) throw new Error('ABORTED');
      },
    };
    if (!isLive) {
      options.return_timestamps = true;
      options.no_speech_threshold = VOD_NO_SPEECH_THRESHOLD;
      options.logprob_threshold = VOD_LOGPROB_THRESHOLD;
      options.compression_ratio_threshold = VOD_COMPRESSION_RATIO_THRESHOLD;
      options.condition_on_previous_text = false;
      options.temperature = VOD_TEMPERATURE_FALLBACK;
    }

    const result = await transcriber(new Float32Array(audio), options);
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

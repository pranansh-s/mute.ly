import type { SpeechActivityWindow, WhisperModelKind } from '../types';
import { preprocessAudio } from './audio-preprocessor';

export interface TranscribeAOTRequest {
  id: number;
  startTime: number;
  endTime: number;
  return_timestamps: boolean;
  clientId?: string;
  tabId?: number;
  speechActivity?: SpeechActivityWindow[];
  modelKind: WhisperModelKind;
}

const SAMPLE_RATE = 16000;
const STREAM_READ_TIMEOUT_MS = 90_000;
const PROGRESS_INTERVAL_SECONDS = 2;
const RMS_SILENCE_THRESHOLD = 0.0001;
const VAD_FRAME_SECONDS = 0.02;
const VAD_MIN_SPEECH_SECONDS = 0.12;
const VAD_MERGE_GAP_SECONDS = 0.22;
const VAD_LEADING_PAD_SECONDS = 0.04;
const VAD_TRAILING_PAD_SECONDS = 0.18;
const VAD_MIN_RMS_THRESHOLD = 0.0025;
const VAD_MAX_RMS_THRESHOLD = 0.018;

interface PcmSegment {
  startSample: number;
  audio: Float32Array;
}

export class AotStreamDecoder {
  private audioChunks: PcmSegment[] = [];
  private bufferedSamples = 0;
  private streamAbort: AbortController | null = null;

  constructor(
    private readonly onProgress: (bufferedSeconds: number) => void,
    private readonly onReady: (duration: number) => void,
    private readonly onError: (message: string) => void,
    private readonly onTranscribe: (audio: Float32Array, request: TranscribeAOTRequest) => void,
    private readonly onEmptyResult: (request: TranscribeAOTRequest) => void,
    private readonly onDroppedResult: (request: TranscribeAOTRequest) => void
  ) {}

  public cancelStream() {
    if (this.streamAbort) {
      this.streamAbort.abort();
      this.streamAbort = null;
    }

    this.audioChunks = [];
    this.bufferedSamples = 0;
  }

  public async loadStream(url: string) {
    this.cancelStream();

    const abort = new AbortController();
    this.streamAbort = abort;

    try {
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      let lastProgress = 0;
      let leftoverBuffer = new Uint8Array(0);

      while (true) {
        if (abort.signal.aborted) return;

        const readResult = await readWithTimeout(reader);
        if (abort.signal.aborted) {
          reader.cancel().catch(() => {});
          return;
        }

        const { done, value } = readResult;
        if (done) break;

        const samples = decodePcmChunk(value, leftoverBuffer);
        leftoverBuffer = samples.leftover;
        if (samples.audio.length === 0) continue;

        this.audioChunks.push({
          startSample: this.bufferedSamples,
          audio: samples.audio,
        });
        this.bufferedSamples += samples.audio.length;

        const bufferedSeconds = this.bufferedSamples / SAMPLE_RATE;
        if (bufferedSeconds - lastProgress >= PROGRESS_INTERVAL_SECONDS) {
          this.onProgress(bufferedSeconds);
          lastProgress = bufferedSeconds;
        }
      }

      if (abort.signal.aborted) return;

      const totalDuration = this.bufferedSamples / SAMPLE_RATE;
      this.streamAbort = null;
      this.onReady(totalDuration);
    } catch (error: unknown) {
      if (abort.signal.aborted) return;

      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[mutely:offscreen] AOT Stream Error:', error);
      this.streamAbort = null;
      this.audioChunks = [];
      this.bufferedSamples = 0;
      this.onError(`Audio stream failed: ${message}`);
    }
  }

  public transcribeSlice(request: TranscribeAOTRequest) {
    try {
      if (this.bufferedSamples === 0) {
        this.onDroppedResult(request);
        return;
      }

      if (
        !Number.isFinite(request.startTime) ||
        !Number.isFinite(request.endTime) ||
        request.endTime <= request.startTime
      ) {
        this.onDroppedResult(request);
        return;
      }

      const startSample = Math.floor(request.startTime * SAMPLE_RATE);
      const endSample = Math.floor(request.endTime * SAMPLE_RATE);

      if (startSample < 0 || endSample <= startSample) {
        this.onDroppedResult(request);
        return;
      }

      if (endSample > this.bufferedSamples) {
        this.onDroppedResult(request);
        return;
      }

      const slice = this.copySlice(startSample, endSample);
      preprocessAudio(slice);

      const rms = calculateRms(slice);
      const isSliceSilent = slice.length === 0 || rms < RMS_SILENCE_THRESHOLD;

      if (isSliceSilent) {
        this.onEmptyResult(request);
        return;
      }

      const sliceStartTime = startSample / SAMPLE_RATE;
      const sliceEndTime = endSample / SAMPLE_RATE;
      this.onTranscribe(slice, {
        ...request,
        speechActivity: detectSpeechActivity(slice, sliceStartTime, sliceEndTime),
      });
    } catch (error: unknown) {
      this.onDroppedResult(request);
    }
  }

  private copySlice(startSample: number, endSample: number) {
    const output = new Float32Array(endSample - startSample);
    let targetOffset = 0;
    let chunkIndex = this.findFirstChunk(startSample);

    while (chunkIndex < this.audioChunks.length) {
      const { startSample: chunkStart, audio } = this.audioChunks[chunkIndex];
      const chunkEnd = chunkStart + audio.length;

      if (chunkStart >= endSample) break;

      const from = Math.max(0, startSample - chunkStart);
      const to = Math.min(audio.length, endSample - chunkStart);
      output.set(audio.subarray(from, to), targetOffset);
      targetOffset += to - from;
      chunkIndex++;
    }

    return output;
  }

  private findFirstChunk(startSample: number) {
    let lo = 0;
    let hi = this.audioChunks.length - 1;
    let match = this.audioChunks.length;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const chunk = this.audioChunks[mid];
      const chunkEnd = chunk.startSample + chunk.audio.length;

      if (chunkEnd > startSample) {
        match = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    return match;
  }
}

async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Stream hung')), STREAM_READ_TIMEOUT_MS);
  });

  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function decodePcmChunk(value: Uint8Array, leftoverBuffer: Uint8Array) {
  let chunk = value;

  if (leftoverBuffer.length > 0) {
    chunk = new Uint8Array(leftoverBuffer.length + value.length);
    chunk.set(leftoverBuffer);
    chunk.set(value, leftoverBuffer.length);
  }

  const remainder = chunk.length % 4;
  const leftover = remainder > 0 ? chunk.slice(chunk.length - remainder) : new Uint8Array(0);
  const aligned = remainder > 0 ? chunk.subarray(0, chunk.length - remainder) : chunk;

  if (aligned.length === 0) {
    return { audio: new Float32Array(0), leftover };
  }

  const alignedCopy = new Uint8Array(aligned);
  return {
    audio: new Float32Array(alignedCopy.buffer, alignedCopy.byteOffset, alignedCopy.length / 4),
    leftover,
  };
}

function calculateRms(audio: Float32Array) {
  if (audio.length === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < audio.length; i++) {
    sumSquares += audio[i] * audio[i];
  }

  return Math.sqrt(sumSquares / audio.length);
}

function detectSpeechActivity(
  audio: Float32Array,
  absoluteStartTime: number,
  absoluteEndTime: number
): SpeechActivityWindow[] {
  const frameSize = Math.max(1, Math.floor(SAMPLE_RATE * VAD_FRAME_SECONDS));
  const frameRms: number[] = [];

  for (let offset = 0; offset < audio.length; offset += frameSize) {
    const end = Math.min(offset + frameSize, audio.length);
    let sumSquares = 0;

    for (let i = offset; i < end; i++) {
      sumSquares += audio[i] * audio[i];
    }

    frameRms.push(Math.sqrt(sumSquares / Math.max(1, end - offset)));
  }

  if (frameRms.length === 0) return [];

  const threshold = getAdaptiveVadThreshold(frameRms);
  const windows: SpeechActivityWindow[] = [];
  let activeStartFrame: number | null = null;

  for (let frame = 0; frame < frameRms.length; frame++) {
    const isActive = frameRms[frame] >= threshold;

    if (isActive && activeStartFrame === null) {
      activeStartFrame = frame;
    } else if (!isActive && activeStartFrame !== null) {
      pushActivityWindow(windows, activeStartFrame, frame, absoluteStartTime, absoluteEndTime);
      activeStartFrame = null;
    }
  }

  if (activeStartFrame !== null) {
    pushActivityWindow(windows, activeStartFrame, frameRms.length, absoluteStartTime, absoluteEndTime);
  }

  return mergeActivityWindows(windows);
}

function getAdaptiveVadThreshold(frameRms: number[]) {
  const sorted = [...frameRms].sort((a, b) => a - b);
  const noiseIndex = Math.floor(sorted.length * 0.2);
  const noiseFloor = sorted[Math.min(noiseIndex, sorted.length - 1)] ?? 0;
  return clamp(noiseFloor * 3, VAD_MIN_RMS_THRESHOLD, VAD_MAX_RMS_THRESHOLD);
}

function pushActivityWindow(
  windows: SpeechActivityWindow[],
  startFrame: number,
  endFrame: number,
  absoluteStartTime: number,
  absoluteEndTime: number
) {
  const start = absoluteStartTime + startFrame * VAD_FRAME_SECONDS;
  const end = absoluteStartTime + endFrame * VAD_FRAME_SECONDS;

  if (end - start < VAD_MIN_SPEECH_SECONDS) return;

  windows.push({
    start: Math.max(absoluteStartTime, start - VAD_LEADING_PAD_SECONDS),
    end: Math.min(absoluteEndTime, end + VAD_TRAILING_PAD_SECONDS),
  });
}

function mergeActivityWindows(windows: SpeechActivityWindow[]) {
  const merged: SpeechActivityWindow[] = [];

  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.start <= previous.end + VAD_MERGE_GAP_SECONDS) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }

  return merged;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

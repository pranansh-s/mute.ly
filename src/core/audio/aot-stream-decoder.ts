import type { AsrMode } from '../types';
import { preprocessAudio } from './audio-preprocessor';

export interface TranscribeAOTRequest {
  id: number;
  startTime: number;
  endTime: number;
  clientId?: string;
  tabId?: number;
  mode: AsrMode;
}

const SAMPLE_RATE = 16000;
const PROGRESS_INTERVAL_SECONDS = 2;
const RMS_SILENCE_THRESHOLD = 0.0001;

interface PcmSegment {
  startSample: number;
  audio: Float32Array;
}

export class AotStreamDecoder {
  private audioChunks: PcmSegment[] = [];
  private bufferedSamples = 0;
  private streamActive = false;
  private leftoverBuffer = new Uint8Array(0);
  private lastProgressSeconds = 0;

  constructor(
    private readonly onProgress: (bufferedSeconds: number) => void,
    private readonly onReady: (duration: number) => void,
    private readonly onError: (message: string) => void,
    private readonly onTranscribe: (audio: Float32Array, request: TranscribeAOTRequest) => void,
    private readonly onEmptyResult: (request: TranscribeAOTRequest) => void,
    private readonly onDroppedResult: (request: TranscribeAOTRequest) => void
  ) {}

  public cancelStream() {
    this.streamActive = false;
    this.audioChunks = [];
    this.bufferedSamples = 0;
    this.leftoverBuffer = new Uint8Array(0);
    this.lastProgressSeconds = 0;
  }

  public beginStream() {
    this.cancelStream();
    this.streamActive = true;
  }

  public feed(bytes: Uint8Array) {
    if (!this.streamActive || bytes.length === 0) return;

    const samples = decodePcmChunk(bytes, this.leftoverBuffer);
    this.leftoverBuffer = samples.leftover;
    if (samples.audio.length === 0) return;

    this.audioChunks.push({
      startSample: this.bufferedSamples,
      audio: samples.audio,
    });
    this.bufferedSamples += samples.audio.length;

    const bufferedSeconds = this.bufferedSamples / SAMPLE_RATE;
    if (bufferedSeconds - this.lastProgressSeconds >= PROGRESS_INTERVAL_SECONDS) {
      this.onProgress(bufferedSeconds);
      this.lastProgressSeconds = bufferedSeconds;
    }
  }

  public finalizeStream(durationSeconds?: number) {
    if (!this.streamActive) return;
    this.streamActive = false;
    const computed = this.bufferedSamples / SAMPLE_RATE;
    const total = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
      ? Math.max(durationSeconds, computed)
      : computed;
    this.onReady(total);
  }

  public failStream(message: string) {
    if (!this.streamActive) return;
    this.streamActive = false;
    this.audioChunks = [];
    this.bufferedSamples = 0;
    this.leftoverBuffer = new Uint8Array(0);
    this.onError(message);
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

      if (startSample < 0 || endSample <= startSample || endSample > this.bufferedSamples) {
        this.onDroppedResult(request);
        return;
      }

      const slice = this.copySlice(startSample, endSample);
      preprocessAudio(slice);

      const rms = calculateRms(slice);
      if (slice.length === 0 || rms < RMS_SILENCE_THRESHOLD) {
        this.onEmptyResult(request);
        return;
      }

      this.onTranscribe(slice, request);
    } catch {
      this.onDroppedResult(request);
    }
  }

  private copySlice(startSample: number, endSample: number) {
    const output = new Float32Array(endSample - startSample);
    let targetOffset = 0;
    let chunkIndex = this.findFirstChunk(startSample);

    while (chunkIndex < this.audioChunks.length) {
      const { startSample: chunkStart, audio } = this.audioChunks[chunkIndex];
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
  for (let i = 0; i < audio.length; i++) sumSquares += audio[i] * audio[i];
  return Math.sqrt(sumSquares / audio.length);
}

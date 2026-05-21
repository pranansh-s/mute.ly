import { isHallucination } from './hallucination-filter';
import type { OffscreenClient } from './offscreen-client';
import type { TranscriptionResult } from '../types';

const CHUNK_DURATION = 30;
const CHUNK_STRIDE = 25;
const LOOKAHEAD = 4;

interface CaptionTimestamp {
  start: number;
  end: number;
  text: string;
}

export class AotPipeline {
  private client: OffscreenClient;
  private videoElement: HTMLVideoElement | null = null;
  private onCaption: (text: string, isPartial: boolean) => void;

  private completedChunks = new Set<number>();

  private inFlightChunk: number | null = null;
  private processingQueue: number[] = [];
  private isProcessing = false;

  private captionTimestamps: CaptionTimestamp[] = [];
  private captionsSorted = false;
  private totalChunks = Infinity;
  private audioDuration = Infinity;
  private bufferedDuration = 0;

  /** AbortController for the current drain loop — aborted on seek/destroy. */
  private drainController: AbortController | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private renderTimer: ReturnType<typeof setInterval> | null = null;

  private lastText = '';
  private isStarted = false;

  constructor(client: OffscreenClient, onCaption: (text: string, isPartial: boolean) => void) {
    this.client = client;
    this.onCaption = onCaption;
  }

  public start(videoElement: HTMLVideoElement) {
    this.videoElement = videoElement;
    this.isStarted = true;
    
    // We don't know total duration yet
    this.totalChunks = Infinity;
    this.audioDuration = Infinity;

    // Queue the initial window around the current playback position
    this.queueAroundPlayback();
    this.startDrain();

    // Poll every 500ms to queue new chunks as playback advances
    this.pollTimer = setInterval(() => this.queueAroundPlayback(), 500);
    // Render captions at ~20fps
    this.renderTimer = setInterval(() => this.renderCaptions(), 50);

    // On seek, abort current processing and re-prioritize
    videoElement.addEventListener('seeking', this.handleSeek);
  }

  public updateBufferedDuration(seconds: number) {
    this.bufferedDuration = seconds;
    this.queueAroundPlayback(); // Kick the queue if we have new data
  }

  public finalize(totalDuration: number) {
    this.audioDuration = totalDuration;
    this.bufferedDuration = totalDuration;
    this.totalChunks = Math.ceil(totalDuration / CHUNK_STRIDE);
    this.queueAroundPlayback();
  }

  private queueAroundPlayback() {
    if (!this.videoElement || !this.isStarted) return;

    const currentChunk = Math.floor(this.videoElement.currentTime / CHUNK_STRIDE);

    for (let i = currentChunk; i <= Math.min(currentChunk + LOOKAHEAD, this.totalChunks - 1); i++) {
      // Only queue chunks whose audio data is fully buffered
      // (conservative: we need at least the chunk's duration, but checking stride + some margin is simpler)
      const chunkEndTime = (i + 1) * CHUNK_STRIDE;
      if (chunkEndTime > this.bufferedDuration) break;

      // Skip chunks already completed, currently in-flight, or already in the queue
      if (i >= 0 && !this.completedChunks.has(i) && this.inFlightChunk !== i && !this.processingQueue.includes(i)) {
        this.processingQueue.push(i);
      }
    }

    // Kick the drain loop if it's idle
    if (!this.isProcessing && this.processingQueue.length > 0) {
      this.startDrain();
    }
  }

  private handleSeek = () => {
    if (!this.videoElement || !this.isStarted) return;

    const targetChunk = Math.floor(this.videoElement.currentTime / CHUNK_STRIDE);
    const neededChunks = new Set<number>();

    for (let i = targetChunk; i <= Math.min(targetChunk + LOOKAHEAD, this.totalChunks - 1); i++) {
      if (i >= 0 && !this.completedChunks.has(i)) {
        neededChunks.add(i);
      }
    }

    // Is the currently in-flight chunk still needed?
    const inFlightStillNeeded = this.inFlightChunk !== null && neededChunks.has(this.inFlightChunk);

    if (!inFlightStillNeeded) {
      // Abort the current in-flight chunk because it's no longer needed
      this.abortDrain();
      this.inFlightChunk = null;
    }

    // Keep only the chunks in processingQueue that are still needed
    this.processingQueue = this.processingQueue.filter(chunk => neededChunks.has(chunk));

    // Add any needed chunks that are NOT in flight and NOT in processingQueue
    for (const chunk of neededChunks) {
      if (this.inFlightChunk !== chunk && !this.processingQueue.includes(chunk)) {
        this.processingQueue.push(chunk);
      }
    }

    // Sort processing queue to ensure temporal order
    this.processingQueue.sort((a, b) => a - b);

    if (this.processingQueue.length > 0) {
      console.log(`[Mute.ly AOT] Seek → queuing chunks [${this.processingQueue.join(', ')}]`);
    }

    this.startDrain();
  };

  /** Aborts the current drain loop and any in-flight transcription. */
  private abortDrain() {
    if (this.drainController) {
      this.drainController.abort();
      this.drainController = null;
    }
    this.isProcessing = false;
  }

  /** Creates a fresh AbortController and starts draining the queue. */
  private startDrain() {
    if (this.isProcessing) return;
    this.drainController = new AbortController();
    this.drainQueue(this.drainController.signal);
  }

  private renderCaptions() {
    if (!this.videoElement) return;
    const currentTime = this.videoElement.currentTime;

    // Keep captions sorted by start time for correct seek alignment
    if (!this.captionsSorted && this.captionTimestamps.length > 0) {
      this.captionTimestamps.sort((a, b) => a.start - b.start);
      this.captionsSorted = true;
    }

    // Binary-search style: find the last caption whose start <= currentTime
    let match: CaptionTimestamp | null = null;
    let lo = 0, hi = this.captionTimestamps.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.captionTimestamps[mid].start <= currentTime) {
        match = this.captionTimestamps[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Verify the match actually covers currentTime
    if (match && currentTime <= match.end) {
      if (match.text !== this.lastText) {
        this.onCaption(match.text, false);
        this.lastText = match.text;
      }
    } else if (this.lastText) {
      this.onCaption('', false);
      this.lastText = '';
    }
  }

  private async drainQueue(signal: AbortSignal) {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.processingQueue.length > 0 && this.isStarted && !signal.aborted) {
      const chunkIndex = this.processingQueue.shift()!;
      this.inFlightChunk = chunkIndex;
      await this.requestChunk(chunkIndex, signal);

      if (!signal.aborted) {
        this.inFlightChunk = null;
        this.completedChunks.add(chunkIndex);
        this.captionsSorted = false;
      }
    }

    if (this.drainController?.signal === signal || !this.drainController) {
      this.isProcessing = false;
    }
  }

  private async requestChunk(chunkIndex: number, signal: AbortSignal) {
    const startTime = chunkIndex * CHUNK_STRIDE;
    const endTime = Math.min(startTime + CHUNK_DURATION, this.audioDuration);

    // Each chunk "owns" captions from its start to (start + STRIDE).
    // Captions in the trailing overlap are discarded — the next chunk covers
    // that region more accurately (Whisper is better at the start of a window).
    const isLastChunk = chunkIndex >= this.totalChunks - 1;
    const ownedEnd = isLastChunk ? endTime : startTime + CHUNK_STRIDE;

    const result: TranscriptionResult = await this.client.transcribeAOT(startTime, endTime, signal);

    // If aborted while waiting, discard the result
    if (signal.aborted) return;

    if (result) {
      if (result.chunks && Array.isArray(result.chunks)) {
        for (const chunk of result.chunks) {
          if (!chunk.text || !Array.isArray(chunk.timestamp)) continue;
          const text = chunk.text.trim();
          if (!text || isHallucination(text)) continue;

          const absStart = startTime + (chunk.timestamp[0] ?? 0);
          const absEnd = startTime + (chunk.timestamp[1] ?? CHUNK_DURATION);

          if (absStart < ownedEnd) {
            this.captionTimestamps.push({
              start: absStart,
              end: Math.min(absEnd, ownedEnd),
              text
            });
          }
        }
      } else if (result.text && !isHallucination(result.text.trim())) {
        this.captionTimestamps.push({
          start: startTime,
          end: ownedEnd,
          text: result.text.trim()
        });
      }
    }

    console.log(`[Mute.ly AOT] Chunk ${chunkIndex} done. ${this.captionTimestamps.length} total captions.`);
  }

  public destroy() {
    this.isStarted = false;
    this.abortDrain();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.renderTimer) clearInterval(this.renderTimer);
    if (this.videoElement) {
      this.videoElement.removeEventListener('seeking', this.handleSeek);
    }
    this.captionTimestamps = [];
    this.completedChunks.clear();
    this.inFlightChunk = null;
    this.processingQueue = [];
    this.lastText = '';
  }
}

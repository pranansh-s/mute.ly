import { isHallucination } from './hallucination-filter';
import type { OffscreenClient } from './offscreen-client';
import type { SpeechActivityWindow, TranscriptionResult } from '../types';

const CHUNK_DURATION_SECONDS = 30;
const CHUNK_STRIDE_SECONDS = 25;
const LOOKAHEAD_CHUNKS = 4;
const RENDER_INTERVAL_MS = 50;
const CACHE_LIMIT_CHUNKS = 500;
const CAPTION_END_GRACE_SECONDS = 0.45;
const CAPTION_START_SYNC_DELAY_SECONDS = 0.08;
const MIN_CAPTION_DURATION_SECONDS = 0.5;
const MAX_CAPTION_DURATION_SECONDS = 7;
const SPEECH_ACTIVITY_END_GRACE_SECONDS = 1.15;
const SPEECH_ACTIVITY_MATCH_GRACE_SECONDS = 0.6;
const DROPPED_CHUNK_RETRY_DELAY_MS = 1500;
const FINAL_CHUNK_BUFFER_TOLERANCE_SECONDS = 2.0;

interface CaptionTimestamp {
  start: number;
  end: number;
  text: string;
}

interface ActiveChunk {
  index: number;
  startTime: number;
  endTime: number;
  ownedEnd: number;
}

class CaptionCache {
  private chunks = new Map<number, CaptionTimestamp[]>();

  public has(chunkIndex: number) {
    return this.chunks.has(chunkIndex);
  }

  public set(chunkIndex: number, captions: CaptionTimestamp[]) {
    if (this.chunks.has(chunkIndex)) {
      this.chunks.delete(chunkIndex);
    }

    this.chunks.set(chunkIndex, captions);
    this.trim();
  }

  public find(currentTime: number): CaptionTimestamp | null {
    const currentChunk = Math.floor(currentTime / CHUNK_STRIDE_SECONDS);
    const visibleCaptions: CaptionTimestamp[] = [];

    for (let i = currentChunk - 1; i <= currentChunk + 1; i++) {
      const cached = this.get(i);
      if (cached) visibleCaptions.push(...cached);
    }

    if (visibleCaptions.length === 0) return null;

    visibleCaptions.sort((a, b) => a.start - b.start);

    let match: CaptionTimestamp | null = null;
    let lo = 0;
    let hi = visibleCaptions.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (visibleCaptions[mid].start <= currentTime) {
        match = visibleCaptions[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (match && currentTime <= match.end + CAPTION_END_GRACE_SECONDS) {
      return match;
    }

    return null;
  }

  public clear() {
    this.chunks.clear();
  }

  public get size() {
    return this.chunks.size;
  }

  private get(chunkIndex: number) {
    const captions = this.chunks.get(chunkIndex);
    if (!captions) return null;

    this.chunks.delete(chunkIndex);
    this.chunks.set(chunkIndex, captions);
    return captions;
  }

  private trim() {
    while (this.chunks.size > CACHE_LIMIT_CHUNKS) {
      const oldestChunk = this.chunks.keys().next().value;
      if (oldestChunk === undefined) return;
      this.chunks.delete(oldestChunk);
    }
  }
}

export class AotPipeline {
  private readonly cache = new CaptionCache();
  private pendingQueue: number[] = [];
  private activeChunk: ActiveChunk | null = null;
  private isProcessing = false;
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimerAt = Infinity;
  private retryAfterByChunk = new Map<number, number>();
  private videoElement: HTMLVideoElement | null = null;
  private lastText = '';
  private lastPlaybackTime = 0;
  private isStarted = false;
  private sessionId = 0;

  private audioDuration = Infinity;
  private bufferedDuration = 0;
  private totalChunks = Infinity;

  constructor(
    private readonly client: OffscreenClient,
    private readonly onCaption: (text: string, isPartial: boolean) => void
  ) {}

  public start(videoElement: HTMLVideoElement) {
    if (this.isStarted && this.videoElement === videoElement) return;
    if (this.isStarted) {
      this.client.stopAOT();
      this.detachVideoListeners();
    }

    this.videoElement = videoElement;
    this.isStarted = true;
    this.sessionId++;
    this.pendingQueue = [];
    this.activeChunk = null;
    this.isProcessing = false;
    this.retryAfterByChunk.clear();
    this.clearRetryTimer();
    this.lastText = '';
    this.audioDuration = Infinity;
    this.bufferedDuration = 0;
    this.totalChunks = Infinity;

    this.rebuildQueue('start');
    this.restartRenderTimer();

    videoElement.addEventListener('seeking', this.handleSeek);
    videoElement.addEventListener('timeupdate', this.handleTimeUpdate);
    videoElement.addEventListener('ended', this.handleEnded);
    videoElement.addEventListener('ratechange', this.handlePlaybackRateChange);
  }

  public updateBufferedDuration(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.bufferedDuration = seconds;
    this.rebuildQueue('buffer-progress');
  }

  public finalize(totalDuration: number) {
    this.audioDuration = Math.max(0, totalDuration);
    this.bufferedDuration = this.audioDuration;
    this.totalChunks = Math.ceil(this.audioDuration / CHUNK_STRIDE_SECONDS);
    this.rebuildQueue('stream-finalized');
  }

  public destroy() {
    this.isStarted = false;
    this.sessionId++;
    this.client.stopAOT();

    if (this.renderTimer) clearInterval(this.renderTimer);
    this.renderTimer = null;
    this.clearRetryTimer();
    this.detachVideoListeners();

    this.pendingQueue = [];
    this.activeChunk = null;
    this.isProcessing = false;
    this.retryAfterByChunk.clear();
    this.cache.clear();
    this.lastText = '';
  }

  private handleSeek = () => {
    if (!this.videoElement || !this.isStarted) return;

    const seekDelta = this.videoElement.currentTime - this.lastPlaybackTime;
    console.debug('[Mute.ly AOT] Seek detected', {
      from: this.lastPlaybackTime,
      to: this.videoElement.currentTime,
      delta: seekDelta,
    });
    this.retryAfterByChunk.clear();
    this.clearRetryTimer();
    this.rebuildQueue('seek');
    this.renderCaptions();
  };

  private handleTimeUpdate = () => {
    if (this.videoElement) this.lastPlaybackTime = this.videoElement.currentTime;
    this.rebuildQueue('timeupdate');
  };

  private handleEnded = () => {
    this.clearRenderedCaption();
  };

  private handlePlaybackRateChange = () => {
    this.rebuildQueue('ratechange');
    this.renderCaptions();
  };

  private restartRenderTimer() {
    if (this.renderTimer) clearInterval(this.renderTimer);
    this.renderTimer = setInterval(() => this.renderCaptions(), RENDER_INTERVAL_MS);
  }

  private rebuildQueue(reason: string) {
    if (!this.videoElement || !this.isStarted) return;

    const neededChunks = this.getNeededChunks();
    const now = Date.now();
    const pending: number[] = [];
    const cachedChunks: number[] = [];
    const deferredChunks: number[] = [];
    let nextRetryAt = Infinity;

    for (const chunkIndex of neededChunks) {
      if (this.cache.has(chunkIndex)) {
        cachedChunks.push(chunkIndex);
        continue;
      }

      if (chunkIndex === this.activeChunk?.index) continue;

      const retryAt = this.retryAfterByChunk.get(chunkIndex);
      if (retryAt && retryAt > now) {
        nextRetryAt = Math.min(nextRetryAt, retryAt);
        deferredChunks.push(chunkIndex);
        continue;
      }

      if (retryAt) this.retryAfterByChunk.delete(chunkIndex);
      pending.push(chunkIndex);
    }

    if (!arraysEqual(this.pendingQueue, pending)) {
      this.pendingQueue = pending;
      console.debug('[Mute.ly AOT] Queue rebuilt', {
        reason,
        currentTime: this.videoElement.currentTime,
        bufferedDuration: this.bufferedDuration,
        activeChunk: this.activeChunk?.index ?? null,
        cachedChunks,
        deferredChunks,
        pendingQueue: [...this.pendingQueue],
      });
    }

    this.scheduleRetryRebuild(nextRetryAt);
    this.processNextChunk();
  }

  private getNeededChunks() {
    if (!this.videoElement) return [];

    const currentChunk = this.getChunkIndex(this.videoElement.currentTime);
    const effectiveDuration = this.getEffectiveDuration();
    const totalChunks = Number.isFinite(effectiveDuration)
      ? Math.ceil(effectiveDuration / CHUNK_STRIDE_SECONDS)
      : this.totalChunks;
    const lastChunk = totalChunks === Infinity ? Infinity : totalChunks - 1;
    const playbackRate = this.videoElement.playbackRate || 1;
    const lookahead = playbackRate > 1.25 ? LOOKAHEAD_CHUNKS + 1 : LOOKAHEAD_CHUNKS;
    const maxChunk = Math.min(currentChunk + lookahead, lastChunk);
    const neededChunks: number[] = [];

    for (let chunkIndex = currentChunk; chunkIndex <= maxChunk; chunkIndex++) {
      if (chunkIndex < 0) continue;
      if (!this.isChunkBuffered(chunkIndex)) break;
      neededChunks.push(chunkIndex);
    }

    return neededChunks;
  }

  private getChunkIndex(timeSeconds: number) {
    return Math.max(0, Math.floor(timeSeconds / CHUNK_STRIDE_SECONDS));
  }

  private isChunkBuffered(chunkIndex: number) {
    const ownedEnd = this.getOwnedEnd(chunkIndex);
    const effectiveDuration = this.getEffectiveDuration();
    const isFinalChunk = Number.isFinite(effectiveDuration) && ownedEnd >= effectiveDuration;
    if (isFinalChunk && ownedEnd <= this.bufferedDuration + FINAL_CHUNK_BUFFER_TOLERANCE_SECONDS) {
      return true;
    }

    return ownedEnd <= this.bufferedDuration;
  }

  private getOwnedEnd(chunkIndex: number) {
    const strideEnd = (chunkIndex + 1) * CHUNK_STRIDE_SECONDS;
    return Math.min(strideEnd, this.getEffectiveDuration());
  }

  private getEffectiveDuration() {
    if (Number.isFinite(this.audioDuration)) return this.audioDuration;

    const videoDuration = this.videoElement?.duration;
    if (typeof videoDuration === 'number' && Number.isFinite(videoDuration) && videoDuration > 0) {
      return videoDuration;
    }

    return Infinity;
  }

  private async processNextChunk() {
    if (!this.isStarted || this.isProcessing) return;

    const chunkIndex = this.pendingQueue.shift();
    if (chunkIndex === undefined) return;

    if (this.cache.has(chunkIndex)) {
      queueMicrotask(() => this.processNextChunk());
      return;
    }

    const sessionId = this.sessionId;
    const startTime = chunkIndex * CHUNK_STRIDE_SECONDS;
    const endTime = Math.min(startTime + CHUNK_DURATION_SECONDS, this.audioDuration);
    const ownedEnd = this.getOwnedEnd(chunkIndex);

    this.isProcessing = true;
    this.activeChunk = { index: chunkIndex, startTime, endTime, ownedEnd };
    console.debug('[Mute.ly AOT] Processing chunk', {
      chunkIndex,
      startTime,
      endTime,
      ownedEnd,
      bufferedDuration: this.bufferedDuration,
    });

    try {
      const result = await this.client.transcribeAOT(startTime, endTime);

      if (!this.isStarted || sessionId !== this.sessionId) return;
      if (result.dropped) {
        const retryAt = Date.now() + DROPPED_CHUNK_RETRY_DELAY_MS;
        this.retryAfterByChunk.set(chunkIndex, retryAt);
        console.debug('[Mute.ly AOT] Chunk dropped; deferring retry', {
          chunkIndex,
          reason: result.dropReason ?? 'unknown',
          retryInMs: DROPPED_CHUNK_RETRY_DELAY_MS,
        });
        return;
      }

      const captions = this.parseCaptions(result, startTime, ownedEnd);
      this.retryAfterByChunk.delete(chunkIndex);
      this.cache.set(chunkIndex, captions);
      console.debug('[Mute.ly AOT] Chunk processed', {
        chunkIndex,
        captionCount: captions.length,
        dropped: false,
      });

      this.renderCaptions();
    } catch (error) {
      if (this.isStarted && sessionId === this.sessionId) {
        console.error(`[Mute.ly AOT] Chunk ${chunkIndex} failed:`, error);
      }
    } finally {
      if (sessionId === this.sessionId) {
        this.activeChunk = null;
        this.isProcessing = false;
        this.rebuildQueue('chunk-complete');
      }
    }
  }

  private parseCaptions(result: TranscriptionResult, startTime: number, ownedEnd: number) {
    const captions: CaptionTimestamp[] = [];
    const speechActivity = normalizeSpeechActivity(result.speechActivity, startTime, ownedEnd);

    if (result.chunks && Array.isArray(result.chunks)) {
      for (const chunk of result.chunks) {
        if (!chunk.text || !Array.isArray(chunk.timestamp)) continue;

        const text = chunk.text.trim();
        if (!text || isHallucination(text)) continue;

        const relativeStart = toFiniteNumber(chunk.timestamp[0], 0);
        const relativeEnd = toFiniteNumber(chunk.timestamp[1], relativeStart + MIN_CAPTION_DURATION_SECONDS);
        const caption = normalizeCaption(startTime + relativeStart, startTime + relativeEnd, text, startTime, ownedEnd);
        const alignedCaption = alignCaptionToSpeechActivity(caption, speechActivity);

        if (alignedCaption) captions.push(alignedCaption);
      }
    } else if (result.text) {
      const text = result.text.trim();
      if (text && !isHallucination(text)) {
        const caption = normalizeCaption(startTime, ownedEnd, text, startTime, ownedEnd);
        const alignedCaption = alignCaptionToSpeechActivity(caption, speechActivity);
        if (alignedCaption) captions.push(alignedCaption);
      }
    }

    captions.sort((a, b) => a.start - b.start);
    return mergeAdjacentDuplicates(captions);
  }

  private renderCaptions() {
    if (!this.videoElement || !this.isStarted) return;
    this.lastPlaybackTime = this.videoElement.currentTime;

    const match = this.cache.find(this.videoElement.currentTime);
    if (match) {
      if (match.text !== this.lastText) {
        this.onCaption(match.text, false);
        this.lastText = match.text;
      }
      return;
    }

    if (this.lastText) {
      this.clearRenderedCaption();
    }
  }

  private detachVideoListeners() {
    if (!this.videoElement) return;
    this.videoElement.removeEventListener('seeking', this.handleSeek);
    this.videoElement.removeEventListener('timeupdate', this.handleTimeUpdate);
    this.videoElement.removeEventListener('ended', this.handleEnded);
    this.videoElement.removeEventListener('ratechange', this.handlePlaybackRateChange);
    this.videoElement = null;
  }

  private clearRenderedCaption() {
    if (!this.lastText) return;
    console.debug('[Mute.ly AOT] Caption cleared', {
      currentTime: this.videoElement?.currentTime ?? null,
      reason: 'no-active-caption',
    });
    this.onCaption('', false);
    this.lastText = '';
  }

  private scheduleRetryRebuild(nextRetryAt: number) {
    if (!Number.isFinite(nextRetryAt)) {
      this.clearRetryTimer();
      return;
    }

    if (this.retryTimer && this.retryTimerAt === nextRetryAt) return;

    this.clearRetryTimer();
    this.retryTimerAt = nextRetryAt;

    const delayMs = Math.max(0, nextRetryAt - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryTimerAt = Infinity;
      this.rebuildQueue('retry-ready');
    }, delayMs);
  }

  private clearRetryTimer() {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryTimerAt = Infinity;
  }
}

function normalizeCaption(
  rawStart: number,
  rawEnd: number,
  text: string,
  chunkStart: number,
  ownedEnd: number
): CaptionTimestamp | null {
  const start = clamp(rawStart + CAPTION_START_SYNC_DELAY_SECONDS, chunkStart, ownedEnd);
  if (start >= ownedEnd) return null;

  const minimumEnd = Math.min(start + MIN_CAPTION_DURATION_SECONDS, ownedEnd);
  const maximumEnd = Math.min(start + MAX_CAPTION_DURATION_SECONDS, ownedEnd);
  const end = clamp(Math.max(rawEnd, minimumEnd), start, maximumEnd);
  if (end <= start) return null;

  return { start, end, text };
}

function normalizeSpeechActivity(
  activity: SpeechActivityWindow[] | undefined,
  chunkStart: number,
  ownedEnd: number
) {
  if (!activity || activity.length === 0) return [];

  return activity
    .map((window) => ({
      start: clamp(window.start, chunkStart, ownedEnd),
      end: clamp(window.end, chunkStart, ownedEnd),
    }))
    .filter((window) => window.end > window.start)
    .sort((a, b) => a.start - b.start);
}

function alignCaptionToSpeechActivity(
  caption: CaptionTimestamp | null,
  activity: SpeechActivityWindow[]
): CaptionTimestamp | null {
  if (!caption || activity.length === 0) return caption;

  const match = findBestSpeechActivity(caption, activity);
  if (!match) return caption;

  const start = Math.max(caption.start, match.start);
  const end = Math.min(caption.end, match.end + SPEECH_ACTIVITY_END_GRACE_SECONDS);
  if (end <= start) return null;

  return {
    ...caption,
    start,
    end,
  };
}

function findBestSpeechActivity(caption: CaptionTimestamp, activity: SpeechActivityWindow[]) {
  let bestMatch: SpeechActivityWindow | null = null;
  let bestOverlap = 0;

  for (const window of activity) {
    const overlap = Math.min(caption.end, window.end) - Math.max(caption.start, window.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestMatch = window;
    }
  }

  if (bestMatch) return bestMatch;

  return activity.find((window) => (
    window.start >= caption.start &&
    window.start <= caption.end + SPEECH_ACTIVITY_MATCH_GRACE_SECONDS
  )) ?? null;
}

function mergeAdjacentDuplicates(captions: CaptionTimestamp[]) {
  const merged: CaptionTimestamp[] = [];

  for (const caption of captions) {
    const previous = merged[merged.length - 1];
    if (previous && previous.text === caption.text && caption.start <= previous.end + CAPTION_END_GRACE_SECONDS) {
      previous.end = Math.max(previous.end, caption.end);
    } else {
      merged.push({ ...caption });
    }
  }

  return merged;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function toFiniteNumber(value: number | null | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function arraysEqual(left: number[], right: number[]) {
  if (left.length !== right.length) return false;

  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }

  return true;
}

import { isHallucination } from './hallucination-filter';
import type { OffscreenClient } from './offscreen-client';
import type { SpeechActivityWindow, TranscriptionResult } from '../types';

const CHUNK_DURATION_SECONDS = 30;
const CHUNK_STRIDE_SECONDS = 25;
const LOOKAHEAD_CHUNKS = 4;
const POLL_INTERVAL_MS = 500;
const RENDER_INTERVAL_MS = 50;
const CACHE_LIMIT_CHUNKS = 500;
const CAPTION_END_GRACE_SECONDS = 0.45;
const MIN_CAPTION_DURATION_SECONDS = 0.5;
const MAX_CAPTION_DURATION_SECONDS = 5;
const SPEECH_ACTIVITY_END_GRACE_SECONDS = 1.15;
const SPEECH_ACTIVITY_MATCH_GRACE_SECONDS = 0.6;
const DROPPED_CHUNK_RETRY_DELAY_MS = 1500;

const WHISPER_START_OFFSET_SECONDS = 0.12;
const WHISPER_END_OFFSET_SECONDS = 0.08;

interface CaptionTimestamp {
  start: number;
  end: number;
  text: string;
}

interface ActiveChunk {
  key: string;
  index: number;
  startTime: number;
  endTime: number;
  ownedEnd: number;
  seekGeneration: number;
}

interface ChunkRequest {
  key: string;
  index: number;
  startTime: number;
  endTime: number;
  ownedEnd: number;
}

class CaptionCache {
  private chunks = new Map<string, CaptionTimestamp[]>();
  private keyByIndex = new Map<number, string>();
  private captionTotal = 0;

  public has(key: string) {
    return this.chunks.has(key);
  }

  public set(chunk: ChunkRequest, captions: CaptionTimestamp[]) {
    const previousKey = this.keyByIndex.get(chunk.index);
    if (previousKey && previousKey !== chunk.key) {
      const previousCaptions = this.chunks.get(previousKey);
      if (previousCaptions) this.captionTotal -= previousCaptions.length;
      this.chunks.delete(previousKey);
    }

    const existingCaptions = this.chunks.get(chunk.key);
    if (existingCaptions) {
      this.captionTotal -= existingCaptions.length;
      this.chunks.delete(chunk.key);
    }

    this.keyByIndex.set(chunk.index, chunk.key);
    this.chunks.set(chunk.key, captions);
    this.captionTotal += captions.length;
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

    let lo = 0;
    let hi = visibleCaptions.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (visibleCaptions[mid].start <= currentTime) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    for (let i = lo - 1; i >= 0; i--) {
      const caption = visibleCaptions[i];
      if (caption.start <= currentTime && currentTime <= caption.end + CAPTION_END_GRACE_SECONDS) {
        return caption;
      }
    }

    return null;
  }

  public clear() {
    this.chunks.clear();
    this.keyByIndex.clear();
    this.captionTotal = 0;
  }

  public get size() {
    return this.chunks.size;
  }

  private get(chunkIndex: number) {
    const key = this.keyByIndex.get(chunkIndex);
    if (!key) return null;

    const captions = this.chunks.get(key);
    if (!captions) return null;

    this.chunks.delete(key);
    this.chunks.set(key, captions);
    return captions;
  }

  private trim() {
    while (this.chunks.size > CACHE_LIMIT_CHUNKS) {
      const oldestChunk = this.chunks.keys().next().value;
      if (oldestChunk === undefined) return;
      const captions = this.chunks.get(oldestChunk);
      if (captions) this.captionTotal -= captions.length;
      this.chunks.delete(oldestChunk);
      for (const [index, key] of this.keyByIndex) {
        if (key === oldestChunk) {
          this.keyByIndex.delete(index);
          break;
        }
      }
    }
  }
}

export class AotPipeline {
  private readonly cache = new CaptionCache();
  private pendingQueue: ChunkRequest[] = [];
  private activeChunk: ActiveChunk | null = null;
  private isProcessing = false;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimerAt = Infinity;
  private retryAfterByChunk = new Map<number, number>();
  private videoElement: HTMLVideoElement | null = null;
  private lastText = '';
  private lastPlaybackTime = 0;
  private isStarted = false;
  private sessionId = 0;
  private seekGeneration = 0;
  private lastRebuiltChunkIndex = -1;

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
    this.seekGeneration = 0;
    this.audioDuration = Infinity;
    this.bufferedDuration = 0;
    this.totalChunks = Infinity;

    this.lastRebuiltChunkIndex = -1;

    this.rebuildQueue('start');
    this.restartSchedulerTimer();
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
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
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

    const newTime = this.videoElement.currentTime;
    const neededChunks = this.getNeededChunks();
    const neededKeys = new Set(neededChunks.map(chunk => chunk.key));
    const activeChunkCoversPlayhead = this.activeChunk
      ? this.activeChunk.startTime <= newTime && newTime < this.activeChunk.ownedEnd
      : false;

    this.pendingQueue = this.pendingQueue.filter(chunk => neededKeys.has(chunk.key));

    if (this.isProcessing && this.activeChunk && !activeChunkCoversPlayhead) {
      this.seekGeneration++;
      this.client.abortActiveAOT();
    } else if (!this.activeChunk || !activeChunkCoversPlayhead) {
      this.seekGeneration++;
    }

    this.retryAfterByChunk.clear();
    this.clearRetryTimer();
    this.lastRebuiltChunkIndex = -1;
    this.rebuildQueue('seek');
    this.renderCaptions();
  };

  private handleTimeUpdate = () => {
    if (!this.videoElement) return;
    this.lastPlaybackTime = this.videoElement.currentTime;
    const currentChunk = this.getChunkIndex(this.videoElement.currentTime);
    if (currentChunk !== this.lastRebuiltChunkIndex) {
      this.lastRebuiltChunkIndex = currentChunk;
      this.rebuildQueue('timeupdate');
    }
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

  private restartSchedulerTimer() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = setInterval(() => this.pollScheduler(), POLL_INTERVAL_MS);
  }

  private pollScheduler() {
    if (!this.videoElement || !this.isStarted) return;
    this.rebuildQueue('poll');
  }

  private rebuildQueue(_reason: string) {
    if (!this.videoElement || !this.isStarted) return;

    const neededChunks = this.getNeededChunks();
    const now = Date.now();
    const pending: ChunkRequest[] = [];
    const pendingKeys = new Set<string>();
    let nextRetryAt = Infinity;

    for (const chunk of neededChunks) {
      if (pendingKeys.has(chunk.key)) continue;

      if (this.cache.has(chunk.key)) {
        continue;
      }

      if (chunk.key === this.activeChunk?.key) continue;

      if (!this.isChunkBuffered(chunk)) {
        continue;
      }

      const retryAt = this.retryAfterByChunk.get(chunk.index);
      if (retryAt && retryAt > now) {
        nextRetryAt = Math.min(nextRetryAt, retryAt);
        continue;
      }

      if (retryAt) this.retryAfterByChunk.delete(chunk.index);
      pending.push(chunk);
      pendingKeys.add(chunk.key);
    }

    if (!arraysEqual(this.pendingQueue, pending)) {
      this.pendingQueue = pending;
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
    const neededChunks: ChunkRequest[] = [];

    for (let chunkIndex = currentChunk; chunkIndex <= maxChunk; chunkIndex++) {
      if (chunkIndex < 0) continue;
      neededChunks.push(this.getChunkWindow(chunkIndex));
    }

    return neededChunks;
  }

  private getChunkIndex(timeSeconds: number) {
    return Math.max(0, Math.floor(timeSeconds / CHUNK_STRIDE_SECONDS));
  }

  private getChunkWindow(chunkIndex: number): ChunkRequest {
    const startTime = chunkIndex * CHUNK_STRIDE_SECONDS;
    const endTime = Math.min(startTime + CHUNK_DURATION_SECONDS, this.getEffectiveDuration());
    const ownedEnd = this.getOwnedEnd(chunkIndex);

    return {
      key: getChunkKey(startTime, endTime),
      index: chunkIndex,
      startTime,
      endTime,
      ownedEnd,
    };
  }

  private isChunkBuffered(chunk: ChunkRequest) {
    return chunk.endTime <= this.bufferedDuration;
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

    const chunk = this.pendingQueue.shift();
    if (chunk === undefined) return;

    if (this.cache.has(chunk.key)) {
      queueMicrotask(() => this.processNextChunk());
      return;
    }

    if (!this.isChunkBuffered(chunk)) {
      queueMicrotask(() => this.rebuildQueue('dispatch-buffer-wait'));
      return;
    }

    const sessionId = this.sessionId;
    const seekGeneration = this.seekGeneration;
    const { index: chunkIndex, startTime, endTime, ownedEnd } = chunk;

    this.isProcessing = true;
    this.activeChunk = { ...chunk, seekGeneration };

    try {
      const result = await this.client.transcribeAOT(startTime, endTime);

      if (!this.isStarted || sessionId !== this.sessionId || seekGeneration !== this.seekGeneration) {
        return;
      }

      if (result.dropped) {
        if (result.dropReason !== 'aborted') {
          const retryAt = Date.now() + DROPPED_CHUNK_RETRY_DELAY_MS;
          this.retryAfterByChunk.set(chunkIndex, retryAt);
        }
        return;
      }

      const captions = this.parseCaptions(result, startTime, ownedEnd);
      this.retryAfterByChunk.delete(chunkIndex);
      this.cache.set(chunk, captions);

      this.renderCaptions();
    } catch (error) {
      if (this.isStarted && sessionId === this.sessionId) {
        console.error(`[mutely:aot] Chunk ${chunk.key} failed:`, error);
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
        if (!text) continue;
        if (isHallucination(text)) continue;

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
    const merged = mergeAdjacentDuplicates(captions);
    return resolveTemporalOverlaps(merged);
  }

  private renderCaptions() {
    if (!this.videoElement || !this.isStarted) return;
    this.lastPlaybackTime = this.videoElement.currentTime;

    const currentTime = this.videoElement.currentTime;
    const match = this.cache.find(currentTime);
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
  const start = clamp(rawStart + WHISPER_START_OFFSET_SECONDS, chunkStart, ownedEnd);
  if (start >= ownedEnd) return null;

  const minimumEnd = Math.min(start + MIN_CAPTION_DURATION_SECONDS, ownedEnd);
  const maximumEnd = Math.min(start + MAX_CAPTION_DURATION_SECONDS, ownedEnd);
  const end = clamp(Math.max(rawEnd + WHISPER_END_OFFSET_SECONDS, minimumEnd), start, maximumEnd);
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

function resolveTemporalOverlaps(captions: CaptionTimestamp[]): CaptionTimestamp[] {
  if (captions.length <= 1) return captions;

  const resolved: CaptionTimestamp[] = [];
  const MIN_GAP_SECONDS = 0.08;

  for (let i = 0; i < captions.length; i++) {
    resolved.push({ ...captions[i] });
  }

  for (let i = 0; i < resolved.length - 1; i++) {
    const current = resolved[i];
    const next = resolved[i + 1];

    if (current.end > next.start - MIN_GAP_SECONDS) {
      const maxPossibleEnd = next.start - MIN_GAP_SECONDS;
      const minRequiredEnd = current.start + MIN_CAPTION_DURATION_SECONDS;

      if (maxPossibleEnd >= minRequiredEnd) {
        current.end = maxPossibleEnd;
      } else {
        current.end = minRequiredEnd;
        next.start = current.end + MIN_GAP_SECONDS;
      }
    }
  }

  return resolved.filter(c => c.end > c.start);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function toFiniteNumber(value: number | null | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getChunkKey(startTime: number, endTime: number) {
  return `${Math.round(startTime * 10)}_${Math.round(endTime * 10)}`;
}

function arraysEqual(left: ChunkRequest[], right: ChunkRequest[]) {
  if (left.length !== right.length) return false;

  for (let i = 0; i < left.length; i++) {
    if (left[i].key !== right[i].key) return false;
  }

  return true;
}

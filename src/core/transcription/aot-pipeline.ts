import { isHallucination } from './hallucination-filter';
import type { OffscreenClient } from './offscreen-client';
import type { TranscriptionResult } from '../types';
import {
  CHUNK_STRIDE_SECONDS,
  type ChunkRequest,
  computeNeededChunks,
  getChunkIndex,
  pickPending,
} from './aot-scheduler';
import { splitCaptionFromWords, splitCaptionFromText, type WordTimestamp } from './caption-splitter';

export { getChunkKey } from './aot-scheduler';

const RENDER_INTERVAL_MS = 50;
const SCHEDULER_POLL_MS = 500;
const CACHE_LIMIT_CHUNKS = 500;
const CAPTION_END_GRACE_SECONDS = 0.2;
const MIN_CAPTION_DURATION_SECONDS = 0.5;
const MIN_GAP_SECONDS = 0.08;
const WHISPER_START_OFFSET_SECONDS = 0.18;
const WHISPER_END_OFFSET_SECONDS = 0.08;

interface CaptionTimestamp {
  start: number;
  end: number;
  text: string;
}

class CaptionCache {
  private chunks = new Map<string, CaptionTimestamp[]>();
  private keyByIndex = new Map<number, string>();

  public has(key: string) {
    return this.chunks.has(key);
  }

  public set(chunk: ChunkRequest, captions: CaptionTimestamp[]) {
    const previousKey = this.keyByIndex.get(chunk.index);
    if (previousKey && previousKey !== chunk.key) this.chunks.delete(previousKey);
    if (this.chunks.has(chunk.key)) this.chunks.delete(chunk.key);

    this.keyByIndex.set(chunk.index, chunk.key);
    this.chunks.set(chunk.key, captions);
    this.trim();
  }

  public find(currentTime: number): CaptionTimestamp | null {
    const currentChunk = Math.floor(currentTime / CHUNK_STRIDE_SECONDS);
    const visible: CaptionTimestamp[] = [];

    for (let i = currentChunk - 1; i <= currentChunk + 1; i++) {
      const cached = this.get(i);
      if (cached) visible.push(...cached);
    }
    if (visible.length === 0) return null;

    visible.sort((a, b) => a.start - b.start);

    let lo = 0;
    let hi = visible.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (visible[mid].start <= currentTime) lo = mid + 1;
      else hi = mid;
    }

    for (let i = lo - 1; i >= 0; i--) {
      const caption = visible[i];
      if (caption.start <= currentTime && currentTime <= caption.end + CAPTION_END_GRACE_SECONDS) {
        return caption;
      }
    }
    return null;
  }

  public clear() {
    this.chunks.clear();
    this.keyByIndex.clear();
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
      const oldest = this.chunks.keys().next().value;
      if (oldest === undefined) return;
      this.chunks.delete(oldest);
      for (const [index, key] of this.keyByIndex) {
        if (key === oldest) {
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
  private activeChunkKey: string | null = null;
  private isProcessing = false;
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private lastText = '';
  private isStarted = false;
  private sessionId = 0;
  private seekEpoch = 0;
  private lastChunkIndex = -1;

  private audioDuration = Infinity;
  private bufferedDuration = 0;

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
    this.seekEpoch = 0;
    this.pendingQueue = [];
    this.activeChunkKey = null;
    this.isProcessing = false;
    this.lastText = '';
    this.audioDuration = Infinity;
    this.bufferedDuration = 0;
    this.lastChunkIndex = -1;

    this.rebuildQueue();
    this.restartRenderTimer();
    this.restartSchedulerTimer();

    videoElement.addEventListener('seeking', this.handleSeek);
    videoElement.addEventListener('timeupdate', this.handleTimeUpdate);
    videoElement.addEventListener('ended', this.handleEnded);
    videoElement.addEventListener('ratechange', this.handleRateChange);
  }

  public updateBufferedDuration(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.bufferedDuration = seconds;
    this.rebuildQueue();
  }

  public finalize(totalDuration: number) {
    this.audioDuration = Math.max(0, totalDuration);
    this.bufferedDuration = this.audioDuration;
    this.rebuildQueue();
  }

  public destroy() {
    this.isStarted = false;
    this.sessionId++;
    this.client.stopAOT();

    if (this.renderTimer) clearInterval(this.renderTimer);
    this.renderTimer = null;
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
    this.detachVideoListeners();

    this.pendingQueue = [];
    this.activeChunkKey = null;
    this.isProcessing = false;
    this.cache.clear();
    this.lastText = '';
  }

  private handleSeek = () => {
    if (!this.videoElement || !this.isStarted) return;

    const newTime = this.videoElement.currentTime;
    const activeCoversPlayhead = this.activeChunkCoversTime(newTime);

    if (!activeCoversPlayhead) {
      this.seekEpoch++;
      if (this.isProcessing) {
        this.client.abortActiveAOT();
        this.activeChunkKey = null;
        this.isProcessing = false;
      }
    }

    this.lastChunkIndex = -1;
    this.rebuildQueue();
    this.renderCaptions();
  };

  private handleTimeUpdate = () => {
    if (!this.videoElement) return;
    const currentChunk = getChunkIndex(this.videoElement.currentTime);
    if (currentChunk !== this.lastChunkIndex) {
      this.lastChunkIndex = currentChunk;
      this.rebuildQueue();
    }
  };

  private handleEnded = () => {
    this.clearRenderedCaption();
  };

  private handleRateChange = () => {
    this.rebuildQueue();
    this.renderCaptions();
  };

  private restartRenderTimer() {
    if (this.renderTimer) clearInterval(this.renderTimer);
    this.renderTimer = setInterval(() => this.renderCaptions(), RENDER_INTERVAL_MS);
  }

  private restartSchedulerTimer() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = setInterval(() => {
      if (!this.isStarted || this.isProcessing) return;
      this.rebuildQueue();
    }, SCHEDULER_POLL_MS);
  }

  private rebuildQueue() {
    if (!this.videoElement || !this.isStarted) return;

    const needed = computeNeededChunks(
      this.videoElement.currentTime,
      this.videoElement.playbackRate || 1,
      this.getEffectiveDuration()
    );
    this.pendingQueue = pickPending(needed, (k) => this.cache.has(k), this.activeChunkKey, this.bufferedDuration);
    this.processNextChunk();
  }

  private getEffectiveDuration() {
    if (Number.isFinite(this.audioDuration)) return this.audioDuration;
    const videoDuration = this.videoElement?.duration;
    if (typeof videoDuration === 'number' && Number.isFinite(videoDuration) && videoDuration > 0) {
      return videoDuration;
    }
    return Infinity;
  }

  private activeChunkCoversTime(time: number) {
    if (!this.activeChunkKey || !this.videoElement) return false;
    const [startTenths, endTenths] = this.activeChunkKey.split('_').map(Number);
    const start = startTenths / 10;
    const ownedEnd = Math.min(start + CHUNK_STRIDE_SECONDS, endTenths / 10);
    return start <= time && time < ownedEnd;
  }

  private async processNextChunk() {
    if (!this.isStarted || this.isProcessing) return;

    const chunk = this.pendingQueue.shift();
    if (chunk === undefined) return;

    if (this.cache.has(chunk.key)) {
      queueMicrotask(() => this.processNextChunk());
      return;
    }
    if (chunk.endTime > this.bufferedDuration) return;

    const sessionId = this.sessionId;
    const seekEpoch = this.seekEpoch;
    const { startTime, endTime, ownedEnd } = chunk;

    this.isProcessing = true;
    this.activeChunkKey = chunk.key;

    try {
      const result = await this.client.transcribeAOT(startTime, endTime);
      if (!this.isStarted || sessionId !== this.sessionId || seekEpoch !== this.seekEpoch) return;
      if (result.dropped) return;

      const captions = parseCaptions(result, startTime, ownedEnd);
      this.cache.set(chunk, captions);
      this.renderCaptions();
    } catch (error) {
      if (this.isStarted && sessionId === this.sessionId) {
        console.error(`[mutely:aot] Chunk ${chunk.key} failed:`, error);
      }
    } finally {
      if (sessionId === this.sessionId && seekEpoch === this.seekEpoch) {
        this.activeChunkKey = null;
        this.isProcessing = false;
        this.rebuildQueue();
      }
    }
  }

  private renderCaptions() {
    if (!this.videoElement || !this.isStarted) return;
    const match = this.cache.find(this.videoElement.currentTime);
    if (match) {
      if (match.text !== this.lastText) {
        this.onCaption(match.text, false);
        this.lastText = match.text;
      }
      return;
    }
    if (this.lastText) this.clearRenderedCaption();
  }

  private detachVideoListeners() {
    if (!this.videoElement) return;
    this.videoElement.removeEventListener('seeking', this.handleSeek);
    this.videoElement.removeEventListener('timeupdate', this.handleTimeUpdate);
    this.videoElement.removeEventListener('ended', this.handleEnded);
    this.videoElement.removeEventListener('ratechange', this.handleRateChange);
    this.videoElement = null;
  }

  private clearRenderedCaption() {
    if (!this.lastText) return;
    this.onCaption('', false);
    this.lastText = '';
  }
}

function parseCaptions(result: TranscriptionResult, startTime: number, ownedEnd: number): CaptionTimestamp[] {
  const words = collectWords(result, startTime, ownedEnd);
  let captions: CaptionTimestamp[] = [];

  if (words.length > 0) {
    captions = splitCaptionFromWords(words)
      .filter(c => !isHallucination(c.text))
      .map(c => clampCaption(c.start, c.end, c.text, startTime, ownedEnd))
      .filter((c): c is CaptionTimestamp => c !== null);
  } else if (result.chunks && Array.isArray(result.chunks)) {
    for (const chunk of result.chunks) {
      if (!chunk.text || !Array.isArray(chunk.timestamp)) continue;
      const text = chunk.text.trim();
      if (!text) continue;
      const relStart = toFinite(chunk.timestamp[0], 0);
      const relEnd = toFinite(chunk.timestamp[1], relStart + MIN_CAPTION_DURATION_SECONDS);
      const split = splitCaptionFromText(text, startTime + relStart, startTime + relEnd);
      for (const piece of split) {
        if (isHallucination(piece.text)) continue;
        const clamped = clampCaption(piece.start, piece.end, piece.text, startTime, ownedEnd);
        if (clamped) captions.push(clamped);
      }
    }
  } else if (result.text) {
    const text = result.text.trim();
    if (text && !isHallucination(text)) {
      for (const piece of splitCaptionFromText(text, startTime, ownedEnd)) {
        if (isHallucination(piece.text)) continue;
        const clamped = clampCaption(piece.start, piece.end, piece.text, startTime, ownedEnd);
        if (clamped) captions.push(clamped);
      }
    }
  }

  captions.sort((a, b) => a.start - b.start);
  return enforceMinGap(captions);
}

function collectWords(result: TranscriptionResult, startTime: number, ownedEnd: number): WordTimestamp[] {
  if (!result.chunks || !Array.isArray(result.chunks)) return [];
  const words: WordTimestamp[] = [];
  for (const chunk of result.chunks) {
    if (!chunk.text || !Array.isArray(chunk.timestamp)) continue;
    const text = chunk.text.trim();
    if (!text || text.includes(' ')) return [];
    const relStart = toFinite(chunk.timestamp[0], NaN);
    const relEnd = toFinite(chunk.timestamp[1], relStart);
    if (!Number.isFinite(relStart) || !Number.isFinite(relEnd)) return [];
    const absStart = startTime + relStart;
    const absEnd = startTime + relEnd;
    if (absStart >= ownedEnd) continue;
    words.push({ text, start: absStart, end: absEnd });
  }
  return words;
}

function clampCaption(
  rawStart: number,
  rawEnd: number,
  text: string,
  chunkStart: number,
  ownedEnd: number
): CaptionTimestamp | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const start = clamp(rawStart + WHISPER_START_OFFSET_SECONDS, chunkStart, ownedEnd);
  if (start >= ownedEnd) return null;
  const minEnd = Math.min(start + MIN_CAPTION_DURATION_SECONDS, ownedEnd);
  const end = clamp(Math.max(rawEnd + WHISPER_END_OFFSET_SECONDS, minEnd), start, ownedEnd);
  if (end <= start) return null;
  return { start, end, text: trimmed };
}

function enforceMinGap(captions: CaptionTimestamp[]): CaptionTimestamp[] {
  if (captions.length <= 1) return captions;

  for (let i = 0; i < captions.length - 1; i++) {
    const current = captions[i];
    const next = captions[i + 1];
    if (current.end > next.start - MIN_GAP_SECONDS) {
      current.end = Math.max(current.start + MIN_CAPTION_DURATION_SECONDS, next.start - MIN_GAP_SECONDS);
    }
  }
  return captions.filter(c => c.end > c.start);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function toFinite(value: number | null | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

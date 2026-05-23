import { isHallucination } from './hallucination-filter';
import type { OffscreenClient } from './offscreen-client';

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

  // Authoritative Queue State
  private pendingQueue: number[] = [];
  private activeChunk: { index: number, requestId: number } | null = null;

  // Processed Chunk Cache
  private chunkCache = new Map<number, CaptionTimestamp[]>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private renderTimer: ReturnType<typeof setInterval> | null = null;

  private lastText = '';
  private isStarted = false;

  private audioDuration = Infinity;
  private bufferedDuration = 0;
  private totalChunks = Infinity;

  constructor(client: OffscreenClient, onCaption: (text: string, isPartial: boolean) => void) {
    this.client = client;
    this.onCaption = onCaption;
  }

  public start(videoElement: HTMLVideoElement) {
    this.videoElement = videoElement;
    this.isStarted = true;

    this.totalChunks = Infinity;
    this.audioDuration = Infinity;

    this.rebuildQueue();

    this.pollTimer = setInterval(() => this.rebuildQueue(), 500);
    this.renderTimer = setInterval(() => this.renderCaptions(), 50);

    videoElement.addEventListener('seeking', this.handleSeek);
  }

  public updateBufferedDuration(seconds: number) {
    this.bufferedDuration = seconds;
    this.rebuildQueue();
  }

  public finalize(totalDuration: number) {
    this.audioDuration = totalDuration;
    this.bufferedDuration = totalDuration;
    this.totalChunks = Math.ceil(totalDuration / CHUNK_STRIDE);
    this.rebuildQueue();
  }

  private handleSeek = () => {
    if (!this.videoElement || !this.isStarted) return;
    this.rebuildQueue();
  };

  private rebuildQueue() {
    if (!this.videoElement || !this.isStarted) return;

    const currentChunk = Math.floor(this.videoElement.currentTime / CHUNK_STRIDE);
    const maxChunk = Math.min(currentChunk + LOOKAHEAD, this.totalChunks - 1);

    const neededChunks: number[] = [];
    for (let i = currentChunk; i <= maxChunk; i++) {
      if (i < 0) continue;
      const chunkEndTime = (i + 1) * CHUNK_STRIDE;
      if (chunkEndTime > this.bufferedDuration) break;
      neededChunks.push(i);
    }

    // Determine if active chunk should be aborted
    if (this.activeChunk) {
      const isNeeded = neededChunks.includes(this.activeChunk.index);
      
      // Check if there is a more urgent chunk (earlier in the timeline) that we are missing
      let hasMoreUrgent = false;
      for (const c of neededChunks) {
        if (c < this.activeChunk.index && !this.chunkCache.has(c)) {
          hasMoreUrgent = true;
          break;
        }
      }

      if (!isNeeded || hasMoreUrgent) {
        this.client.cancelRequests([this.activeChunk.requestId]);
        this.activeChunk = null; // Detach
      }
    }

    // Filter out chunks that are already cached or currently processing
    this.pendingQueue = neededChunks.filter(c => !this.chunkCache.has(c) && c !== this.activeChunk?.index);

    // Kick the processing loop
    this.processNextChunk();
  }

  private async processNextChunk() {
    if (!this.isStarted) return;
    
    // Only process one chunk at a time
    if (this.activeChunk !== null) return;
    
    // Nothing left to process
    if (this.pendingQueue.length === 0) return;

    const chunkIndex = this.pendingQueue.shift()!;

    const startTime = chunkIndex * CHUNK_STRIDE;
    const endTime = Math.min(startTime + CHUNK_DURATION, this.audioDuration);
    
    const isLastChunk = chunkIndex >= this.totalChunks - 1;
    const ownedEnd = isLastChunk ? endTime : startTime + CHUNK_STRIDE;

    console.log(`[Mute.ly AOT] Requesting chunk ${chunkIndex} (${startTime}s to ${endTime}s)...`);

    const { id, promise } = this.client.transcribeAOT(startTime, endTime);
    this.activeChunk = { index: chunkIndex, requestId: id };

    try {
      const result = await promise;

      // Ensure we are still the same seek session and still the owner
      if (!this.isStarted) return;
      if (this.activeChunk?.requestId !== id) return;

      if (result.dropped) return;

      const parsedCaptions: CaptionTimestamp[] = [];

      if (result.chunks && Array.isArray(result.chunks)) {
        for (const chunk of result.chunks) {
          if (!chunk.text || !Array.isArray(chunk.timestamp)) continue;
          const text = chunk.text.trim();
          if (!text || isHallucination(text)) continue;

          const absStart = startTime + (chunk.timestamp[0] ?? 0);
          const absEnd = startTime + (chunk.timestamp[1] ?? CHUNK_DURATION);

          if (absStart < ownedEnd) {
            parsedCaptions.push({
              start: absStart,
              end: Math.min(absEnd, ownedEnd),
              text,
            });
          }
        }
      } else if (result.text && !isHallucination(result.text.trim())) {
        parsedCaptions.push({
          start: startTime,
          end: ownedEnd,
          text: result.text.trim(),
        });
      }

      // Save to cache
      this.chunkCache.set(chunkIndex, parsedCaptions);
      console.log(`[Mute.ly AOT] Chunk ${chunkIndex} done. Cached ${parsedCaptions.length} captions.`);
    } catch (err) {
      console.error(`[Mute.ly AOT] Chunk ${chunkIndex} failed:`, err);
    } finally {
      // If we still own the active chunk, clear it and process the next one
      if (this.activeChunk?.requestId === id) {
        this.activeChunk = null;
        this.processNextChunk();
      }
    }
  }

  private renderCaptions() {
    if (!this.videoElement) return;
    const currentTime = this.videoElement.currentTime;

    // Prune the cache if it gets excessively large (> 500 chunks = > 3 hours of unique video)
    if (this.chunkCache.size > 500) {
      const oldestChunk = Math.min(...this.chunkCache.keys());
      this.chunkCache.delete(oldestChunk);
    }

    const currentChunk = Math.floor(currentTime / CHUNK_STRIDE);
    
    // Assemble nearby captions from cache
    const visibleCaptions: CaptionTimestamp[] = [];
    for (let i = currentChunk - 1; i <= currentChunk + 1; i++) {
      const cached = this.chunkCache.get(i);
      if (cached) {
        visibleCaptions.push(...cached);
      }
    }
    
    visibleCaptions.sort((a, b) => a.start - b.start);

    let match: CaptionTimestamp | null = null;
    let lo = 0, hi = visibleCaptions.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (visibleCaptions[mid].start <= currentTime) {
        match = visibleCaptions[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

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

  public destroy() {
    this.isStarted = false;

    if (this.activeChunk) {
      this.client.cancelRequests([this.activeChunk.requestId]);
      this.activeChunk = null;
    }
    
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.renderTimer) clearInterval(this.renderTimer);
    if (this.videoElement) {
      this.videoElement.removeEventListener('seeking', this.handleSeek);
    }
    
    this.pendingQueue = [];
    this.chunkCache.clear();
    this.lastText = '';
  }
}

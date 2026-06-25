import { OffscreenClient } from './offscreen-client';
import { AotPipeline } from './aot-pipeline';
import { isHallucination } from './hallucination-filter';
import { splitCaptionFromText } from './caption-splitter';
import type { AsrDevice, AsrMode, ModelStatus, TranscriptionResult } from '../types';

type CaptionCallback = (committed: string, tentative: string) => void;

const LIVE_CAPTION_CLEAR_DELAY_MS = 8000;

export class TranscriptionEngine {
  private onCaption: CaptionCallback;
  private client: OffscreenClient;
  private aotPipeline: AotPipeline;

  private isReady = false;
  private aotMode = false;
  private liveSessionId = 0;
  private pendingVideoElement: HTMLVideoElement | null = null;
  private liveClearTimer: ReturnType<typeof setTimeout> | null = null;
  private isDestroyed = false;

  public onStatusChange?: (status: ModelStatus) => void;
  public onLoadProgress?: (progress: number) => void;
  public onDeviceChange?: (device: AsrDevice) => void;

  constructor(onCaption: CaptionCallback) {
    this.onCaption = onCaption;
    this.client = new OffscreenClient();
    this.aotPipeline = new AotPipeline(this.client, (text) => onCaption(text, ''));

    this.client.onStatusChange = (s) => {
      if (s === 'ready') this.isReady = true;
      this.onStatusChange?.(s);
    };
    this.client.onLoadProgress = (p) => this.onLoadProgress?.(p);
    this.client.onDeviceChange = (d) => this.onDeviceChange?.(d);

    this.client.onAotBufferProgress = (seconds) => {
      if (this.isDestroyed) return;
      if (this.pendingVideoElement) {
        this.aotPipeline.start(this.pendingVideoElement);
        this.pendingVideoElement = null;
      }
      this.aotPipeline.updateBufferedDuration(seconds);
    };

    this.client.onAotReady = (duration) => {
      if (this.isDestroyed) return;
      if (this.pendingVideoElement) {
        this.aotPipeline.start(this.pendingVideoElement);
        this.pendingVideoElement = null;
      }
      this.aotPipeline.finalize(duration);
    };
  }

  public initialize(mode: AsrMode) {
    if (this.isDestroyed) return;
    this.client.initialize(mode);
  }

  public startAOT(videoId: string, videoElement: HTMLVideoElement) {
    if (this.isDestroyed) return;
    this.aotMode = true;
    this.pendingVideoElement = videoElement;
    this.client.startAOT(videoId);
  }

  public probeHost(): Promise<{ ok: boolean; reason?: string }> {
    return this.client.probeHost();
  }

  public transcribeLive(audio: Float32Array): void {
    if (this.isDestroyed || !this.isReady || this.aotMode) return;
    void this.runLive(audio);
  }

  public resetLiveSession() {
    if (this.isDestroyed || this.aotMode) return;
    this.clearLiveClearTimer();
    this.liveSessionId++;
    this.onCaption('', '');
  }

  public destroy() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.clearLiveClearTimer();
    this.aotPipeline.destroy();
    this.client.destroy();
    this.isReady = false;
    this.aotMode = false;
    this.pendingVideoElement = null;
  }

  private async runLive(audio: Float32Array) {
    const sessionId = ++this.liveSessionId;
    const result: TranscriptionResult = await this.client.transcribeLive(audio, sessionId);
    if (this.isDestroyed || sessionId !== this.liveSessionId) return;

    const text = result?.text?.trim() || '';
    if (!text || isHallucination(text)) return;

    const display = formatLiveCaption(text);
    if (!display) return;

    this.onCaption(display, '');
    this.scheduleLiveClear();
  }

  private scheduleLiveClear() {
    this.clearLiveClearTimer();
    this.liveClearTimer = setTimeout(() => {
      this.liveClearTimer = null;
      this.onCaption('', '');
    }, LIVE_CAPTION_CLEAR_DELAY_MS);
  }

  private clearLiveClearTimer() {
    if (!this.liveClearTimer) return;
    clearTimeout(this.liveClearTimer);
    this.liveClearTimer = null;
  }
}

function formatLiveCaption(text: string): string {
  const pieces = splitCaptionFromText(text, 0, 1);
  if (pieces.length === 0) return '';
  return pieces.map(p => p.text).join('\n');
}

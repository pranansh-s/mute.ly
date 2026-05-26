import { OffscreenClient } from './offscreen-client';
import { AotPipeline } from './aot-pipeline';
import { isHallucination } from './hallucination-filter';
import type { ModelStatus, TranscriptionResult, WhisperModelKind } from '../types';

type CaptionCallback = (text: string, isPartial: boolean) => void;

const LIVE_CAPTION_CLEAR_DELAY_MS = 1600;

export class TranscriptionEngine {
  private onCaption: CaptionCallback;
  private client: OffscreenClient;
  private aotPipeline: AotPipeline;

  private isReady = false;
  private aotMode = false;
  private isProcessing = false;
  private pendingLiveAudio: Float32Array | null = null;
  private lastText = '';
  private pendingVideoElement: HTMLVideoElement | null = null;
  private speechEndTimer: ReturnType<typeof setTimeout> | null = null;
  private isDestroyed = false;
  private isLiveSpeechActive = false;

  public onStatusChange?: (status: ModelStatus) => void;
  public onLoadProgress?: (progress: number) => void;

  constructor(onCaption: CaptionCallback) {
    this.onCaption = onCaption;
    this.client = new OffscreenClient();
    this.aotPipeline = new AotPipeline(this.client, onCaption);

    // Relay client events to our listeners
    this.client.onStatusChange = (s) => {
      if (s === 'ready') this.isReady = true;
      this.onStatusChange?.(s);
    };
    this.client.onLoadProgress = (p) => this.onLoadProgress?.(p);

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

  public initialize(modelKind: WhisperModelKind) {
    if (this.isDestroyed) return;
    this.client.initialize(modelKind);
  }

  public startAOT(url: string, videoElement: HTMLVideoElement) {
    if (this.isDestroyed) return;
    this.aotMode = true;
    this.pendingVideoElement = videoElement;
    this.client.startAOT(url);
  }

  public async transcribe(audio: Float32Array): Promise<void> {
    if (this.isDestroyed || !this.isReady || this.aotMode) return;
    if (this.isLiveSpeechActive) {
      this.clearSpeechEndTimer();
    }

    if (this.isProcessing) {
      this.pendingLiveAudio = audio;
      return;
    }

    this.isProcessing = true;

    try {
      const result: TranscriptionResult = await this.client.transcribeJIT(audio);
      if (this.isDestroyed) return;

      const text = result?.text?.trim() || '';
      if (text && !isHallucination(text)) {
        this.onCaption(text, this.isLiveSpeechActive);
        this.lastText = text;
        if (!this.isLiveSpeechActive) {
          this.scheduleLiveCaptionClear();
        }
      }
    } finally {
      this.isProcessing = false;

      const nextAudio = this.pendingLiveAudio;
      this.pendingLiveAudio = null;
      if (nextAudio && !this.isDestroyed && this.isReady && !this.aotMode) {
        void this.transcribe(nextAudio);
      }
    }
  }

  public onSpeechStart() {
    if (this.isDestroyed || this.aotMode) return;
    this.isLiveSpeechActive = true;
    this.clearSpeechEndTimer();
  }

  public onSpeechEnd() {
    if (this.isDestroyed || this.aotMode) return;
    this.isLiveSpeechActive = false;

    if (this.lastText) {
      this.onCaption(this.lastText, false);
      this.scheduleLiveCaptionClear();
      return;
    }

    this.onCaption('', false);
  }

  public destroy() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    if (this.speechEndTimer) {
      clearTimeout(this.speechEndTimer);
      this.speechEndTimer = null;
    }
    this.aotPipeline.destroy();
    this.client.destroy();
    this.isReady = false;
    this.isProcessing = false;
    this.pendingLiveAudio = null;
    this.aotMode = false;
    this.pendingVideoElement = null;
    this.lastText = '';
    this.isLiveSpeechActive = false;
  }

  private scheduleLiveCaptionClear() {
    this.clearSpeechEndTimer();
    this.speechEndTimer = setTimeout(() => {
      this.speechEndTimer = null;
      this.onCaption('', false);
      this.lastText = '';
    }, LIVE_CAPTION_CLEAR_DELAY_MS);
  }

  private clearSpeechEndTimer() {
    if (!this.speechEndTimer) return;
    clearTimeout(this.speechEndTimer);
    this.speechEndTimer = null;
  }
}

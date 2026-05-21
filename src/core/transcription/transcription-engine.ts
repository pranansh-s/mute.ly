import { OffscreenClient } from './offscreen-client';
import { AotPipeline } from './aot-pipeline';
import { isHallucination } from './hallucination-filter';
import type { ModelStatus, TranscriptionResult } from '../types';

type CaptionCallback = (text: string, isPartial: boolean) => void;

export class TranscriptionEngine {
  private onCaption: CaptionCallback;
  private client: OffscreenClient;
  private aotPipeline: AotPipeline;

  private isReady = false;
  private aotMode = false;
  private isProcessing = false;
  private lastText = '';
  private pendingVideoElement: HTMLVideoElement | null = null;
  private speechEndTimer: ReturnType<typeof setTimeout> | null = null;

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
      if (this.pendingVideoElement) {
        console.log(`[Mute.ly Engine] AOT stream started. Audio buffered: ${seconds.toFixed(1)}s.`);
        this.aotPipeline.start(this.pendingVideoElement);
        this.pendingVideoElement = null;
      }
      this.aotPipeline.updateBufferedDuration(seconds);
    };

    this.client.onAotReady = (duration) => {
      this.aotPipeline.finalize(duration);
    };
  }

  public initialize() {
    this.client.initialize();
  }

  public startAOT(url: string, videoElement: HTMLVideoElement) {
    this.aotMode = true;
    this.pendingVideoElement = videoElement;
    this.client.startAOT(url);
  }

  public async transcribe(audio: Float32Array): Promise<void> {
    if (!this.isReady || this.aotMode || this.isProcessing) return;
    this.isProcessing = true;

    const result: TranscriptionResult = await this.client.transcribeJIT(audio);

    const text = result?.text?.trim() || '';
    if (text && !isHallucination(text)) {
      this.onCaption(text, text === this.lastText);
      this.lastText = text;
    }

    this.isProcessing = false;
  }

  public onSpeechEnd() {
    if (this.aotMode) return;
    if (this.lastText) {
      this.onCaption(this.lastText, false);
      this.lastText = '';
    }
    this.speechEndTimer = setTimeout(() => {
      this.speechEndTimer = null;
      this.onCaption('', false);
    }, 2000);
  }

  public destroy() {
    if (this.speechEndTimer) {
      clearTimeout(this.speechEndTimer);
      this.speechEndTimer = null;
    }
    this.client.destroy();
    this.aotPipeline.destroy();
    this.isReady = false;
    this.isProcessing = false;
    this.aotMode = false;
    this.pendingVideoElement = null;
    this.lastText = '';
  }
}

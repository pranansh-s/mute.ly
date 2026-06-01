import { OffscreenClient } from './offscreen-client';
import { AotPipeline } from './aot-pipeline';
import { isHallucination } from './hallucination-filter';
import type { ModelStatus, TranscriptionResult, WhisperModelKind } from '../types';

type CaptionCallback = (text: string, isPartial: boolean) => void;

const LIVE_CAPTION_CLEAR_DELAY_MS = 1200;

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
        this.clearSpeechEndTimer();

        let mergedText = text;
        if (this.isLiveSpeechActive && this.lastText) {
          mergedText = mergeOverlap(this.lastText, text);
        }
        this.onCaption(mergedText, this.isLiveSpeechActive);
        this.lastText = mergedText;

        if (!this.isLiveSpeechActive) {
          this.scheduleLiveCaptionClear();
        }
      } else {
        if (!this.speechEndTimer) {
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
    this.lastText = '';
  }

  public onSpeechEnd() {
    if (this.isDestroyed || this.aotMode) return;
    this.isLiveSpeechActive = false;
    this.scheduleLiveCaptionClear();
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

function mergeOverlap(accumulated: string, incoming: string): string {
  if (!accumulated) return incoming;
  if (!incoming) return accumulated;

  const aWords = accumulated.trim().split(/\s+/);
  const nWords = incoming.trim().split(/\s+/);

  const clean = (w: string) => w.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "");

  let bestMatch = {
    accumIndex: -1,
    incomingIndex: -1,
    matchLen: 0
  };

  const maxAnchors = Math.min(4, nWords.length);

  for (let j = 0; j < maxAnchors; j++) {
    const anchor = clean(nWords[j]);
    if (!anchor) continue;

    const searchStart = Math.max(0, aWords.length - 8);
    for (let i = aWords.length - 1; i >= searchStart; i--) {
      if (clean(aWords[i]) === anchor) {
        let matchLen = 0;
        let scanA = i;
        let scanI = j;

        while (scanA < aWords.length && scanI < nWords.length) {
          if (clean(aWords[scanA]) === clean(nWords[scanI])) {
            matchLen++;
          } else {
            break;
          }
          scanA++;
          scanI++;
        }

        if (matchLen > bestMatch.matchLen) {
          bestMatch = {
            accumIndex: i,
            incomingIndex: j,
            matchLen: matchLen
          };
        }
      }
    }
  }

  if (bestMatch.matchLen > 0) {
    const prefix = aWords.slice(0, bestMatch.accumIndex).join(" ");
    const remainingIncoming = nWords.slice(bestMatch.incomingIndex).join(" ");
    return prefix ? `${prefix} ${remainingIncoming}` : remainingIncoming;
  }

  return incoming;
}

import { MicVAD } from '@ricky0123/vad-web';
import { TranscriptionEngine } from '../transcription/transcription-engine';

const PLAY_WAIT_TIMEOUT_MS = 10_000;
const AUDIO_TRACK_TIMEOUT_MS = 15_000;
const MID_UTTERANCE_FLUSH_MS = 3000;

const ASSET_BASE = chrome.runtime.getURL('assets/');

export class LiveStreamer {
  private isExtracting = false;
  private audioTrack: MediaStreamTrack | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private seekHandler: (() => void) | null = null;
  private vad: MicVAD | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  async start(engine: TranscriptionEngine, videoElement: HTMLVideoElement): Promise<void> {
    if (this.isExtracting) return;
    this.isExtracting = true;

    try {
      if (videoElement.paused) {
        await this.waitForVideoPlay(videoElement);
        if (!this.isExtracting) return;
      }

      const audioTrack = await this.waitForAudioTrack(videoElement);
      if (!this.isExtracting) return;
      if (!audioTrack) throw new Error('NO_AUDIO_TRACK');

      const stream = new MediaStream([audioTrack]);

      this.vad = await MicVAD.new({
        getStream: async () => stream,
        pauseStream: async () => {},
        resumeStream: async () => stream,
        model: 'v5',
        baseAssetPath: ASSET_BASE,
        onnxWASMBasePath: ASSET_BASE,
        startOnLoad: true,
        positiveSpeechThreshold: 0.35,
        negativeSpeechThreshold: 0.25,
        redemptionMs: 350,
        preSpeechPadMs: 250,
        minSpeechMs: 200,
        submitUserSpeechOnPause: true,
        onSpeechRealStart: () => {
          if (!this.isExtracting) return;
          this.scheduleMidUtteranceFlush();
        },
        onSpeechEnd: (audio: Float32Array) => {
          this.clearFlushTimer();
          if (!this.isExtracting) return;
          engine.transcribeLive(audio);
        },
      });

      if (!this.isExtracting) {
        await this.vad.destroy();
        this.vad = null;
        return;
      }

      this.videoElement = videoElement;
      this.seekHandler = () => {
        if (!this.isExtracting) return;
        this.clearFlushTimer();
        engine.resetLiveSession();
        void this.flushVadOnSeek();
      };
      videoElement.addEventListener('seeking', this.seekHandler);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.isExtracting = false;
    this.clearFlushTimer();

    if (this.videoElement && this.seekHandler) {
      this.videoElement.removeEventListener('seeking', this.seekHandler);
    }
    this.videoElement = null;
    this.seekHandler = null;

    if (this.vad) {
      try { await this.vad.destroy(); } catch {}
      this.vad = null;
    }
    if (this.audioTrack) {
      this.audioTrack.stop();
      this.audioTrack = null;
    }
  }

  private scheduleMidUtteranceFlush() {
    this.clearFlushTimer();
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      if (!this.isExtracting || !this.vad) return;
      try {
        await this.vad.pause();
        if (!this.isExtracting || !this.vad) return;
        await this.vad.start();
        if (!this.isExtracting) return;
        this.scheduleMidUtteranceFlush();
      } catch (err) {
        console.warn('[mutely:live] mid-utterance flush failed:', err);
      }
    }, MID_UTTERANCE_FLUSH_MS);
  }

  private clearFlushTimer() {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async flushVadOnSeek() {
    if (!this.vad) return;
    const vad = this.vad;
    try {
      await vad.pause();
      if (!this.isExtracting || this.vad !== vad) return;
      await vad.start();
    } catch {}
  }

  private async waitForAudioTrack(videoElement: HTMLVideoElement): Promise<MediaStreamTrack | null> {
    const deadline = Date.now() + AUDIO_TRACK_TIMEOUT_MS;
    while (this.isExtracting) {
      if (Date.now() > deadline) return null;
      const captureFn = (videoElement as any).captureStream || (videoElement as any).mozCaptureStream;
      if (captureFn) {
        try {
          const stream: MediaStream = captureFn.call(videoElement);
          const tracks = stream.getAudioTracks();
          if (tracks.length > 0) {
            this.audioTrack = tracks[0];
            return tracks[0];
          }
        } catch (err) {
          console.debug('[mutely:live] captureStream attempt failed, retrying:', err);
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  private waitForVideoPlay(videoElement: HTMLVideoElement): Promise<void> {
    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout>;
      const onPlay = () => {
        videoElement.removeEventListener('play', onPlay);
        clearTimeout(timeoutId);
        resolve();
      };
      videoElement.addEventListener('play', onPlay);
      timeoutId = setTimeout(() => {
        videoElement.removeEventListener('play', onPlay);
        resolve();
      }, PLAY_WAIT_TIMEOUT_MS);
    });
  }
}

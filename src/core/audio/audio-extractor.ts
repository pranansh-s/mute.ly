import { MicVAD, type RealTimeVADOptions } from '@ricky0123/vad-web';
import { TranscriptionEngine } from '../transcription/transcription-engine';

const TARGET_SAMPLE_RATE = 16000;
const PLAY_WAIT_TIMEOUT_MS = 10000;

const LIVE_WINDOW_S = 3.0;
const LIVE_STEP_S = 0.5;
const MIN_LIVE_SPEECH_S = 0.0;

const EXTENSION_ASSET_URL = chrome.runtime.getURL('assets/');

export class AudioExtractor {
  private isExtracting = false;
  private vad: MicVAD | null = null;
  private capturedStream: MediaStream | null = null;
  private windowBuffer: Float32Array | null = null;
  private samplesAccumulated = 0;
  private speechSamplesAccumulated = 0;
  private isSpeechActive = false;
  private stepSizeSamples = 0;
  private minSpeechSamples = 0;

  async startExtraction(engine: TranscriptionEngine, videoElement: HTMLVideoElement): Promise<void> {
    if (this.isExtracting) return;
    this.isExtracting = true;

    this.windowBuffer = new Float32Array(TARGET_SAMPLE_RATE * LIVE_WINDOW_S);
    this.stepSizeSamples = TARGET_SAMPLE_RATE * LIVE_STEP_S;
    this.minSpeechSamples = TARGET_SAMPLE_RATE * MIN_LIVE_SPEECH_S;

    try {
      if (videoElement.paused) {
        await this.waitForVideoPlay(videoElement);
        if (!this.isExtracting) return;
      }

      const audioTrack = await this.waitForAudioTrack(videoElement);
      if (!this.isExtracting || !audioTrack) return;

      const stream = new MediaStream([audioTrack]);

      const vadOptions: Partial<RealTimeVADOptions> = {
        model: 'v5',
        baseAssetPath: EXTENSION_ASSET_URL,
        onnxWASMBasePath: EXTENSION_ASSET_URL,
        getStream: async () => stream,
        onSpeechStart: () => {
          this.isSpeechActive = true;
          this.samplesAccumulated = 0;
          this.speechSamplesAccumulated = 0;
          engine.onSpeechStart();
        },
        onSpeechEnd: () => {
          this.isSpeechActive = false;
          if (this.isExtracting && this.windowBuffer && this.speechSamplesAccumulated >= this.minSpeechSamples) {
            engine.transcribe(new Float32Array(this.windowBuffer));
            engine.onSpeechEnd();
            this.samplesAccumulated = 0;
          }
          this.speechSamplesAccumulated = 0;
        },
        onFrameProcessed: ((_probs: any, frame: Float32Array) => {
          if (!this.isExtracting || !this.windowBuffer) return;

          this.windowBuffer.set(this.windowBuffer.subarray(frame.length));
          this.windowBuffer.set(frame, this.windowBuffer.length - frame.length);

          if (!this.isSpeechActive) return;

          this.samplesAccumulated += frame.length;
          this.speechSamplesAccumulated += frame.length;

          if (this.samplesAccumulated >= this.stepSizeSamples && this.speechSamplesAccumulated >= this.minSpeechSamples) {
            engine.transcribe(new Float32Array(this.windowBuffer));
            this.samplesAccumulated = 0;
          }
        }) as RealTimeVADOptions['onFrameProcessed'],
      };

      this.vad = await MicVAD.new(vadOptions as RealTimeVADOptions);
      this.vad.start();
    } catch (error) {
      this.stopExtraction();
      throw error;
    }
  }

  async stopExtraction(): Promise<void> {
    this.isExtracting = false;

    if (this.vad) {
      try { await this.vad.destroy(); } catch { }
      this.vad = null;
    }

    if (this.capturedStream) {
      this.capturedStream.getTracks().forEach(track => track.stop());
      this.capturedStream = null;
    }

    if (this.windowBuffer) {
      this.windowBuffer.fill(0);
    }
    this.samplesAccumulated = 0;
    this.speechSamplesAccumulated = 0;
    this.isSpeechActive = false;
  }

  private async waitForAudioTrack(videoElement: HTMLVideoElement): Promise<MediaStreamTrack | null> {
    while (this.isExtracting) {
      const captureFn = (videoElement as any).captureStream || (videoElement as any).mozCaptureStream;
      if (captureFn) {
        try {
          const stream: MediaStream = captureFn.call(videoElement);
          const tracks = stream.getAudioTracks();
          if (tracks.length > 0) {
            this.capturedStream = stream;
            return tracks[0];
          }
        } catch { }
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

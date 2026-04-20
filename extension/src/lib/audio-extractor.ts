import { MicVAD } from '@ricky0123/vad-web';
import { TransportClient } from './transport';
import { encodePCM } from './pcm-encoder';

const TARGET_SAMPLE_RATE = 16000;
const WINDOW_SIZE_S = 3;
const STEP_SIZE_S = 0.5;
const PLAY_WAIT_TIMEOUT_MS = 10000;

export class AudioExtractor {
  private isExtracting = false;
  private vad: MicVAD | null = null;
  private capturedStream: MediaStream | null = null;

  private windowBuffer: Float32Array = new Float32Array(TARGET_SAMPLE_RATE * WINDOW_SIZE_S);
  private samplesAccumulated = 0;
  private isSpeechActive = false;

  async startExtraction(transport: TransportClient): Promise<void> {
    if (this.isExtracting) return;
    this.isExtracting = true;

    try {
      const videoElement = this.getVideoElement();
      if (!videoElement) throw new Error('YouTube video element not found');

      if (videoElement.paused) await this.waitForVideoPlay(videoElement);

      const audioTrack = this.captureAudioTrack(videoElement);
      if (!audioTrack) throw new Error('Could not capture audio track');

      const stream = new MediaStream([audioTrack]);

      this.vad = await MicVAD.new({
        baseAssetPath: chrome.runtime.getURL('assets/'),
        onnxWASMBasePath: chrome.runtime.getURL('assets/'),
        getStream: async () => stream,
        onSpeechStart: () => {
          this.isSpeechActive = true;
          console.debug('[VAD] Speech started');
        },
        onSpeechEnd: () => {
          this.isSpeechActive = false;
          console.debug('[VAD] Speech ended');
        },
        onFrameProcessed: (probs, frame) => {
          if (!this.isExtracting) return;

          this.windowBuffer.set(this.windowBuffer.subarray(frame.length));
          this.windowBuffer.set(frame, this.windowBuffer.length - frame.length);

          this.samplesAccumulated += frame.length;

          if (this.samplesAccumulated >= TARGET_SAMPLE_RATE * STEP_SIZE_S) {
            if (this.isSpeechActive) {
              const pcmData = encodePCM(this.windowBuffer);
              const buffer = pcmData.buffer instanceof ArrayBuffer ? pcmData.buffer : pcmData.buffer.slice(0);
              transport.sendBinary(buffer as ArrayBuffer);
            }
            this.samplesAccumulated = 0;
          }
        }
      });

      this.vad.start();

    } catch (error) {
      this.stopExtraction();
      throw error;
    }
  }

  stopExtraction(): void {
    this.isExtracting = false;

    if (this.vad) {
      this.vad.pause();
      this.vad = null;
    }

    if (this.capturedStream) {
      this.capturedStream.getTracks().forEach(track => track.stop());
      this.capturedStream = null;
    }

    this.windowBuffer.fill(0);
    this.samplesAccumulated = 0;
    this.isSpeechActive = false;
  }

  private captureAudioTrack(videoElement: HTMLVideoElement): MediaStreamTrack | null {
    const captureStreamFn = (videoElement as any).captureStream || (videoElement as any).mozCaptureStream;
    if (!captureStreamFn) return null;

    try {
      const stream: MediaStream = captureStreamFn.call(videoElement);
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) return null;

      this.capturedStream = stream;
      return audioTracks[0];
    } catch (error) {
      console.error('captureStream failed:', error);
      return null;
    }
  }

  private waitForVideoPlay(videoElement: HTMLVideoElement): Promise<void> {
    return new Promise((resolve) => {
      const onPlay = () => {
        videoElement.removeEventListener('play', onPlay);
        resolve();
      };
      videoElement.addEventListener('play', onPlay);
      setTimeout(() => {
        videoElement.removeEventListener('play', onPlay);
        resolve();
      }, PLAY_WAIT_TIMEOUT_MS);
    });
  }

  private getVideoElement(): HTMLVideoElement | null {
    const player = document.querySelector('ytd-player');
    if (!player) return null;
    return player.querySelector('video') as HTMLVideoElement | null;
  }
}
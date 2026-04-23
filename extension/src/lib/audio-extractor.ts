import { MicVAD } from '@ricky0123/vad-web';
import { TransportClient } from './transport';
import { encodePCM } from './pcm-encoder';

const TARGET_SAMPLE_RATE = 16000;
const PLAY_WAIT_TIMEOUT_MS = 10000;

const EXTENSION_ASSET_URL = chrome.runtime.getURL('assets/');

export class AudioExtractor {
  private isExtracting = false;
  private vad: MicVAD | null = null;
  private capturedStream: MediaStream | null = null;

  private windowBuffer!: Float32Array;
  private samplesAccumulated = 0;
  private isSpeechActive = false;
  private stepSizeSamples = 0;
  private abortController: AbortController | null = null;

  async startExtraction(transport: TransportClient, isLive: boolean = true): Promise<void> {
    if (this.isExtracting) return;
    this.isExtracting = true;
    this.abortController = new AbortController();

    const effectiveWindowS = isLive ? 2.5 : 30.0;
    const effectiveStepS = isLive ? 0.5 : 1.0;

    this.windowBuffer = new Float32Array(TARGET_SAMPLE_RATE * effectiveWindowS);
    this.stepSizeSamples = TARGET_SAMPLE_RATE * effectiveStepS;

    try {
      const videoElement = await this.waitForVideoElement();
      if (!this.isExtracting) return;
      if (!videoElement) throw new Error('YouTube video element not found after waiting');

      if (!isLive) {
        console.log('[Mute.ly] Starting backend-driven transcription for VOD');
        const videoId = new URLSearchParams(window.location.search).get('v');
        if (videoId) {
          await this.startVODTranscription(transport, videoElement, videoId);
          return;
        }
      }

      console.log('[Mute.ly] Starting VAD-based extraction for Live');
      await this.startVADExtraction(transport, videoElement);
    } catch (error) {
      if (this.isExtracting) {
        console.error('[Mute.ly] Extraction failed:', error);
        this.stopExtraction();
      }
    }
  }

  private async startVADExtraction(transport: TransportClient, videoElement: HTMLVideoElement): Promise<void> {
    try {
      if (videoElement.paused) {
        await this.waitForVideoPlay(videoElement);
        if (!this.isExtracting) return;
      }

      let audioTrack = this.captureAudioTrack(videoElement);
      while (!audioTrack && this.isExtracting) {
        await new Promise(r => setTimeout(r, 500));
        audioTrack = this.captureAudioTrack(videoElement);
      }

      if (!this.isExtracting) return;
      if (!audioTrack) throw new Error('Could not capture audio track after waiting');

      const stream = new MediaStream([audioTrack]);

      this.vad = await MicVAD.new({
        model: 'v5',
        baseAssetPath: EXTENSION_ASSET_URL,
        onnxWASMBasePath: EXTENSION_ASSET_URL,
        getStream: async () => stream,
        onSpeechStart: () => {
          this.isSpeechActive = true;
          console.debug('[VAD] Speech started');
        },
        onSpeechEnd: () => {
          this.isSpeechActive = false;
          console.debug('[VAD] Speech ended');
          if (this.isExtracting) {
            const pcmData = encodePCM(this.windowBuffer);
            const buffer = pcmData.buffer instanceof ArrayBuffer ? pcmData.buffer : pcmData.buffer.slice(0);
            transport.sendBinary(buffer as ArrayBuffer);
            transport.sendControl('speech_end');
            this.samplesAccumulated = 0;
          }
        },
        onFrameProcessed: (probs, frame) => {
          if (!this.isExtracting) return;

          this.windowBuffer.set(this.windowBuffer.subarray(frame.length));
          this.windowBuffer.set(frame, this.windowBuffer.length - frame.length);

          this.samplesAccumulated += frame.length;

          if (this.samplesAccumulated >= this.stepSizeSamples) {
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

  private async startVODTranscription(transport: TransportClient, videoElement: HTMLVideoElement, videoId: string): Promise<void> {
    const transcripts: { startTimeSeconds: number; endTimeSeconds: number; text: string }[] = [];
    let isDone = false;

    try {
      const response = await fetch('http://localhost:3001/api/vod/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId }),
        signal: this.abortController?.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Backend responded with ${response.status}`);
      }

      console.log('[Mute.ly] SSE stream opened for VOD transcription');

      // Start the caption sync loop immediately — it will display captions
      // as they arrive from the stream
      const syncLoop = () => {
        if (!this.isExtracting) return;

        const currentTime = videoElement.currentTime;
        const entry = transcripts.find(
          (t) => currentTime >= t.startTimeSeconds && currentTime < t.endTimeSeconds
        );

        if (entry && entry.text) {
          transport.handleIncomingCaption(entry.text, false);
        } else {
          transport.handleIncomingCaption('', false);
        }

        if (this.isExtracting && !isDone) {
          setTimeout(syncLoop, 500);
        } else if (isDone) {
          // Keep syncing even after done — user may seek around
          setTimeout(syncLoop, 500);
        }
      };

      setTimeout(syncLoop, 500);

      // Read SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const parsed = JSON.parse(jsonStr);

              if (parsed.index !== undefined && parsed.text !== undefined) {
                transcripts.push({
                  startTimeSeconds: parsed.startTimeSeconds,
                  endTimeSeconds: parsed.endTimeSeconds,
                  text: parsed.text,
                });
                console.log(`[Mute.ly] Received transcript chunk ${parsed.index}: ${parsed.startTimeSeconds}s–${parsed.endTimeSeconds}s`);
              } else if (parsed.totalChunks !== undefined) {
                isDone = true;
                console.log(`[Mute.ly] VOD transcription complete: ${parsed.totalChunks} chunks`);
              } else if (parsed.error) {
                console.error('[Mute.ly] Backend error:', parsed.error);
              }
            } catch {
              // skip malformed JSON
            }
          }
        }
      }

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      console.error('[Mute.ly] VOD transcription error:', error);
      // Fallback to VAD if backend fails
      await this.startVADExtraction(transport, videoElement);
    }
  }

  async stopExtraction(): Promise<void> {
    this.isExtracting = false;
    this.abortController?.abort();
    this.abortController = null;

    if (this.vad) {
      try {
        await this.vad.destroy();
      } catch (e) {
        console.warn('Error destroying VAD:', e);
      }
      this.vad = null;
    }

    if (this.capturedStream) {
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

  private async waitForVideoElement(maxWaitMs = 5000): Promise<HTMLVideoElement | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const player = document.querySelector('ytd-player');
      if (player) {
        const video = player.querySelector('video') as HTMLVideoElement | null;
        if (video) return video;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return null;
  }
}
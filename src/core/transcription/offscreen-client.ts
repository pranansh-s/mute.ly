import type { ModelStatus, OffscreenEvent, TranscriptionResult } from '../types';

const AOT_CHUNK_TIMEOUT_MS = 300_000;
const JIT_TIMEOUT_MS = 60_000;

export class OffscreenClient {
  private messageId = 0;
  private pendingResults = new Map<number, (result: TranscriptionResult) => void>();

  public onStatusChange?: (status: ModelStatus) => void;
  public onLoadProgress?: (progress: number) => void;
  public onAotBufferProgress?: (seconds: number) => void;
  public onAotReady?: (duration: number) => void;

  constructor() {
    chrome.runtime.onMessage.addListener(this.handleMessage);
  }

  public initialize() {
    this.onStatusChange?.('loading');
    this.sendToOffscreen({ type: 'load' });
  }

  public startAOT(url: string) {
    console.log('[Mute.ly Engine] Sending load_aot to offscreen...');
    this.sendToOffscreen({ type: 'load_aot', url });
  }

  public async transcribeJIT(audio: Float32Array): Promise<TranscriptionResult> {
    const id = this.messageId++;
    return new Promise<TranscriptionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingResults.delete(id);
        resolve({ text: '' });
      }, JIT_TIMEOUT_MS);

      this.pendingResults.set(id, (result) => {
        clearTimeout(timer);
        this.pendingResults.delete(id);
        resolve(result);
      });
      this.sendToOffscreen({ type: 'transcribe', audio: Array.from(audio), id });
    });
  }

  public async transcribeAOT(startTime: number, endTime: number, signal?: AbortSignal): Promise<TranscriptionResult> {
    if (signal?.aborted) return { text: '' };

    const id = this.messageId++;

    try {
      return await new Promise<TranscriptionResult>((resolve, reject) => {
        let settled = false;
        const settle = (result: TranscriptionResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.pendingResults.delete(id);
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            this.pendingResults.delete(id);
            signal?.removeEventListener('abort', onAbort);
            reject(new Error('TIMEOUT'));
          }
        }, AOT_CHUNK_TIMEOUT_MS);

        const onAbort = () => settle({ text: '' });
        signal?.addEventListener('abort', onAbort);

        this.pendingResults.set(id, (result) => settle(result));

        this.sendToOffscreen({
          type: 'transcribe_aot', startTime, endTime, id, return_timestamps: true,
        });
      });
    } catch (err: unknown) {
      console.warn(`[Mute.ly Engine] Chunk failed or timed out permanently.`);
      return { text: '' };
    }
  }

  private handleMessage = (msg: OffscreenEvent & { _fromOffscreen?: boolean }) => {
    if (!msg._fromOffscreen) return;

    switch (msg.type) {
      case 'loading':
        console.log(`[Mute.ly Engine] Model loading: ${msg.progress}%`);
        this.onLoadProgress?.(msg.progress);
        break;
      case 'ready':
        console.log('[Mute.ly Engine] Whisper model ready.');
        this.onStatusChange?.('ready');
        break;
      case 'aot_buffer_progress':
        this.onAotBufferProgress?.(msg.bufferedSeconds);
        break;
      case 'aot_audio_ready':
        console.log(`[Mute.ly Engine] AOT stream complete (${msg.duration.toFixed(2)}s).`);
        this.onAotReady?.(msg.duration);
        break;
      case 'error':
        console.error('[Mute.ly Engine] Error from offscreen:', msg.message);
        this.onStatusChange?.('error');
        break;
      case 'result': {
        const resolve = this.pendingResults.get(msg.id);
        if (resolve) resolve(msg.result);
        break;
      }
    }
  };

  /** Wraps chrome.runtime.sendMessage with the target/data envelope expected by background.ts. */
  private sendToOffscreen(data: Record<string, unknown>) {
    chrome.runtime.sendMessage({ target: 'offscreen', data }).catch(() => { });
  }

  public destroy() {
    chrome.runtime.onMessage.removeListener(this.handleMessage);
    this.pendingResults.clear();
  }
}

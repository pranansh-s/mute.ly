import type { ModelStatus, OffscreenEvent, TranscriptionResult, WhisperModelKind } from '../types';

const AOT_CHUNK_TIMEOUT_MS = 300_000;
const JIT_TIMEOUT_MS = 15_000;

interface PendingJitResult {
  resolve: (result: TranscriptionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveAotResult {
  id: number;
  resolve: (result: TranscriptionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OffscreenClient {
  private messageId = 0;
  private readonly clientId = createClientId();
  private isDestroyed = false;
  private aotStarted = false;
  private requestedModelKind: WhisperModelKind = 'base';
  private activeAot: ActiveAotResult | null = null;
  private pendingJitResults = new Map<number, PendingJitResult>();

  public onStatusChange?: (status: ModelStatus) => void;
  public onLoadProgress?: (progress: number) => void;
  public onAotBufferProgress?: (seconds: number) => void;
  public onAotReady?: (duration: number) => void;

  constructor() {
    chrome.runtime.onMessage.addListener(this.handleMessage);
  }

  public initialize(modelKind: WhisperModelKind) {
    if (this.isDestroyed) return;
    this.requestedModelKind = modelKind;
    this.onStatusChange?.('loading');
    this.sendToOffscreen({ type: 'load', clientId: this.clientId, modelKind }).catch((error) => {
      console.error('[Mute.ly Engine] Failed to initialize offscreen model:', error);
      this.onStatusChange?.('error');
    });
  }

  public startAOT(url: string) {
    if (this.isDestroyed) return;
    this.aotStarted = true;
    this.sendToOffscreen({ type: 'load_aot', url, clientId: this.clientId }).catch((error) => {
      console.error('[Mute.ly Engine] Failed to start AOT stream:', error);
      this.onStatusChange?.('error');
    });
  }

  public stopAOT() {
    if (this.isDestroyed) return;
    if (!this.aotStarted && !this.activeAot) return;
    this.aotStarted = false;
    this.sendToOffscreen({ type: 'stop_aot', clientId: this.clientId }, true).catch(() => {});
    this.settleActiveAot({ dropped: true });
  }

  public async transcribeJIT(audio: Float32Array): Promise<TranscriptionResult> {
    if (this.isDestroyed) return { text: '' };

    const id = this.messageId++;
    return new Promise<TranscriptionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingJitResults.delete(id);
        this.sendToOffscreen({ type: 'abort_job', id, clientId: this.clientId }, true).catch(() => {});
        resolve({ text: '' });
      }, JIT_TIMEOUT_MS);

      this.pendingJitResults.set(id, {
        timer,
        resolve: (result) => {
          clearTimeout(timer);
          this.pendingJitResults.delete(id);
          resolve(result);
        },
      });

      this.sendToOffscreen({
        type: 'transcribe',
        audio: Array.from(audio),
        id,
        clientId: this.clientId,
        modelKind: 'tiny',
      }).catch((error) => {
        console.error('[Mute.ly Engine] Failed to send live transcription request:', error);
        const pending = this.pendingJitResults.get(id);
        if (pending) pending.resolve({ text: '' });
      });
    });
  }

  public transcribeAOT(startTime: number, endTime: number): Promise<TranscriptionResult> {
    if (this.isDestroyed) return Promise.resolve({ dropped: true });

    if (this.activeAot) {
      return Promise.resolve({ dropped: true });
    }

    const id = this.messageId++;

    return new Promise<TranscriptionResult>((resolve) => {
      const finish = (result: TranscriptionResult) => {
        if (this.activeAot?.id !== id) return;
        clearTimeout(this.activeAot.timer);
        this.activeAot = null;
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ dropped: true, dropReason: 'timeout' });
      }, AOT_CHUNK_TIMEOUT_MS);

      this.activeAot = { id, resolve: finish, timer };

      this.sendToOffscreen({
        type: 'transcribe_aot',
        startTime,
        endTime,
        id,
        return_timestamps: true,
        clientId: this.clientId,
        modelKind: 'base',
      }).catch((error) => {
        console.error('[Mute.ly Engine] Failed to send AOT transcription request:', error);
        finish({ dropped: true, dropReason: 'send-failed' });
      });
    });
  }

  public destroy() {
    this.stopAOT();
    this.isDestroyed = true;
    chrome.runtime.onMessage.removeListener(this.handleMessage);

    for (const pending of this.pendingJitResults.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ text: '' });
    }
    this.pendingJitResults.clear();
    this.settleActiveAot({ dropped: true });
  }

  private handleMessage = (msg: OffscreenEvent & { _fromOffscreen?: boolean }) => {
    if (!msg._fromOffscreen) return;
    const routedClientId = 'clientId' in msg ? msg.clientId : undefined;
    if (routedClientId && routedClientId !== this.clientId) return;

    switch (msg.type) {
      case 'loading':
        if (msg.modelKind && msg.modelKind !== this.requestedModelKind) return;
        this.onLoadProgress?.(msg.progress);
        break;
      case 'ready':
        if (msg.modelKind && msg.modelKind !== this.requestedModelKind) return;
        this.onStatusChange?.('ready');
        break;
      case 'aot_buffer_progress':
        this.onAotBufferProgress?.(msg.bufferedSeconds);
        break;
      case 'aot_audio_ready':
        this.onAotReady?.(msg.duration);
        break;
      case 'error':
        console.error('[Mute.ly Engine] Error from offscreen:', msg.message);
        this.onStatusChange?.('error');
        break;
      case 'result':
        this.handleResult(msg.id, msg.result);
        break;
    }
  };

  private handleResult(id: number, result: TranscriptionResult) {
    const pendingJit = this.pendingJitResults.get(id);
    if (pendingJit) {
      pendingJit.resolve(result);
      return;
    }

    if (this.activeAot?.id === id) {
      this.activeAot.resolve(result);
      return;
    }
  }

  private settleActiveAot(result: TranscriptionResult) {
    if (!this.activeAot) return;

    const active = this.activeAot;
    clearTimeout(active.timer);
    this.activeAot = null;
    active.resolve(result);
  }

  /** Wraps chrome.runtime.sendMessage with the target/data envelope expected by background.ts. */
  private async sendToOffscreen(data: Record<string, unknown>, allowAfterDestroy = false) {
    if (this.isDestroyed && !allowAfterDestroy) return;
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', data });
    if (response?.ok === false) {
      throw new Error(response.error || 'Offscreen message failed');
    }
  }
}

function createClientId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

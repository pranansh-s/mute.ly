import type { AsrDevice, AsrMode, ModelStatus, OffscreenEvent, TranscriptionResult } from '../types';

const AOT_CHUNK_TIMEOUT_MS = 340_000;
const LIVE_TIMEOUT_MS = 25_000;

interface PendingLiveResult {
  sessionId: number;
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
  private readonly clientId = crypto.randomUUID();
  private isDestroyed = false;
  private aotStarted = false;
  private requestedMode: AsrMode = 'vod';
  private activeAot: ActiveAotResult | null = null;
  private pendingLiveResults = new Map<number, PendingLiveResult>();

  public onStatusChange?: (status: ModelStatus) => void;
  public onLoadProgress?: (progress: number) => void;
  public onAotBufferProgress?: (seconds: number) => void;
  public onAotReady?: (duration: number) => void;
  public onDeviceChange?: (device: AsrDevice) => void;

  constructor() {
    chrome.runtime.onMessage.addListener(this.handleMessage);
  }

  public initialize(mode: AsrMode) {
    if (this.isDestroyed) return;
    this.requestedMode = mode;
    this.onStatusChange?.('loading');
    this.sendToOffscreen({ type: 'load', clientId: this.clientId, mode }).catch((error) => {
      console.error('[mutely:engine] Failed to initialize offscreen model:', error);
      this.onStatusChange?.('error');
    });
  }

  public startAOT(videoId: string) {
    if (this.isDestroyed) return;
    this.aotStarted = true;
    this.sendToOffscreen({ type: 'load_aot', videoId, clientId: this.clientId }).catch((error) => {
      console.error('[mutely:aot] Failed to start AOT stream:', error);
      this.onStatusChange?.('error');
    });
  }

  public probeHost(): Promise<{ ok: boolean; reason?: string }> {
    if (this.isDestroyed) return Promise.resolve({ ok: false, reason: 'client destroyed' });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { ok: boolean; reason?: string }) => {
        if (settled) return;
        settled = true;
        chrome.runtime.onMessage.removeListener(listener);
        resolve(result);
      };

      const listener = (msg: any) => {
        if (!msg?._fromOffscreen) return;
        if (msg.type !== 'host_status') return;
        if (msg.clientId && msg.clientId !== this.clientId) return;
        finish({ ok: !!msg.ok, reason: msg.reason });
      };
      chrome.runtime.onMessage.addListener(listener);

      setTimeout(() => finish({ ok: false, reason: 'probe timeout' }), 5000);

      this.sendToOffscreen({ type: 'host_probe', clientId: this.clientId }).catch((error) => {
        finish({ ok: false, reason: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  public stopAOT() {
    if (this.isDestroyed) return;
    if (!this.aotStarted && !this.activeAot) return;
    this.aotStarted = false;
    this.sendToOffscreen({ type: 'stop_aot', clientId: this.clientId }, true).catch(() => {});
    this.settleActiveAot({ dropped: true });
  }

  public abortActiveAOT() {
    if (this.isDestroyed) return;
    if (!this.activeAot) return;

    const id = this.activeAot.id;
    this.sendToOffscreen({ type: 'abort_job', id, clientId: this.clientId }).catch((error) => {
      console.error('[mutely:aot] Failed to send abort_job request:', error);
    });
    this.settleActiveAot({ dropped: true, dropReason: 'aborted' });
  }

  public abortPendingLive() {
    if (this.isDestroyed) return;
    if (this.pendingLiveResults.size === 0) return;
    for (const [id] of this.pendingLiveResults) {
      this.sendToOffscreen({ type: 'abort_job', id, clientId: this.clientId }).catch(() => {});
    }
    for (const pending of this.pendingLiveResults.values()) {
      pending.resolve({ text: '' });
    }
    this.pendingLiveResults.clear();
  }

  public transcribeLive(audio: Float32Array, sessionId: number): Promise<TranscriptionResult> {
    if (this.isDestroyed) return Promise.resolve({ text: '' });

    const id = this.messageId++;
    return new Promise<TranscriptionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingLiveResults.delete(id);
        resolve({ text: '' });
      }, LIVE_TIMEOUT_MS);

      this.pendingLiveResults.set(id, {
        sessionId,
        timer,
        resolve: (result) => {
          clearTimeout(timer);
          this.pendingLiveResults.delete(id);
          resolve(result);
        },
      });

      this.sendToOffscreen({
        type: 'transcribe_live',
        audio: Array.from(audio),
        id,
        sessionId,
        clientId: this.clientId,
        mode: 'live',
      }).catch((error) => {
        console.error('[mutely:engine] Failed to send live transcription request:', error);
        const pending = this.pendingLiveResults.get(id);
        if (pending) pending.resolve({ text: '' });
      });
    });
  }

  public transcribeAOT(startTime: number, endTime: number): Promise<TranscriptionResult> {
    if (this.isDestroyed) return Promise.resolve({ dropped: true });

    if (this.activeAot) {
      console.warn('[mutely:aot] transcribeAOT rejected because another AOT job is active', {
        activeId: this.activeAot.id,
      });
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
        clientId: this.clientId,
        mode: 'vod',
      }).catch((error) => {
        console.error('[mutely:aot] Failed to send AOT transcription request:', error);
        finish({ dropped: true, dropReason: 'send-failed' });
      });
    });
  }

  public destroy() {
    this.stopAOT();
    this.isDestroyed = true;
    chrome.runtime.onMessage.removeListener(this.handleMessage);

    for (const pending of this.pendingLiveResults.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ text: '' });
    }
    this.pendingLiveResults.clear();
    this.settleActiveAot({ dropped: true });
  }

  private handleMessage = (msg: OffscreenEvent & { _fromOffscreen?: boolean }) => {
    if (!msg._fromOffscreen) return;
    const routedClientId = 'clientId' in msg ? msg.clientId : undefined;
    if (routedClientId && routedClientId !== this.clientId) return;

    switch (msg.type) {
      case 'loading':
        if (msg.mode && msg.mode !== this.requestedMode) return;
        this.onLoadProgress?.(msg.progress);
        break;
      case 'ready':
        if (msg.mode && msg.mode !== this.requestedMode) return;
        if (msg.device) this.onDeviceChange?.(msg.device);
        this.onStatusChange?.('ready');
        break;
      case 'device':
        this.onDeviceChange?.(msg.device);
        break;
      case 'aot_buffer_progress':
        this.onAotBufferProgress?.(msg.bufferedSeconds);
        break;
      case 'aot_audio_ready':
        this.onAotReady?.(msg.duration);
        break;
      case 'error':
        if (msg.mode && msg.mode !== this.requestedMode) return;
        console.error('[mutely:engine] Error from offscreen:', msg.message);
        this.onStatusChange?.('error');
        break;
      case 'result':
        this.handleResult(msg.id, msg.result);
        break;
    }
  };

  private handleResult(id: number, result: TranscriptionResult) {
    const pendingLive = this.pendingLiveResults.get(id);
    if (pendingLive) {
      pendingLive.resolve(result);
      return;
    }

    if (this.activeAot?.id === id) {
      this.activeAot.resolve(result);
    }
  }

  private settleActiveAot(result: TranscriptionResult) {
    if (!this.activeAot) return;
    this.activeAot.resolve(result);
  }

  private async sendToOffscreen(data: Record<string, unknown>, allowAfterDestroy = false) {
    if (this.isDestroyed && !allowAfterDestroy) return;
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', data });
    if (response?.ok === false) {
      throw new Error(response.error || 'Offscreen message failed');
    }
  }
}

import type { ServerMessage, InitMessage } from './types';

const MAX_RETRY_COUNT = 5;
const BASE_RETRY_DELAY_MS = 2000;

export class TransportClient {
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private retryTimeoutId?: ReturnType<typeof setTimeout>;
  private intentionalClose = false;

  private wsUrl = '';
  private videoId = '';
  private isLive = false;
  private onCaptionMessage?: (text: string, isPartial: boolean) => void;
  public onStatusChange?: (connected: boolean) => void;

  public get isReady(): boolean {
    return this.wsConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  public connect(
    wsUrl: string,
    videoId: string,
    isLive: boolean,
    onCaptionMessage?: (text: string, isPartial: boolean) => void
  ) {
    this.wsUrl = wsUrl;
    this.videoId = videoId;
    this.isLive = isLive;
    this.onCaptionMessage = onCaptionMessage || this.onCaptionMessage;
    this.intentionalClose = false;

    if (isLive) {
      this.openSocket(0);
    } else {
      this.onStatusChange?.(true);
    }
  }

  private openSocket(retry: number) {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (e) {
      console.error('[WS] Initialization failed:', e);
      this.scheduleRetry(retry);
      return;
    }

    this.ws.onopen = () => {
      this.wsConnected = true;
      this.onStatusChange?.(true);
      console.debug('[WS] Connected');
      this.ws!.send(JSON.stringify({ type: 'init', videoId: this.videoId, isLive: this.isLive } as InitMessage));
    };

    this.ws.onclose = () => {
      const wasConnected = this.wsConnected;
      this.wsConnected = false;

      if (wasConnected) {
        this.onStatusChange?.(false);
      }

      if (!this.intentionalClose) {
        this.scheduleRetry(retry);
      }
    };

    this.ws.onerror = (ev) => {
      console.warn('[WS] Socket error, will retry via onclose');
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if ((data.type === 'partial' || data.type === 'final') && this.onCaptionMessage) {
          this.handleIncomingCaption(data.text, data.type === 'partial');
        } else if (data.type === 'clear' && this.onCaptionMessage) {
          this.handleIncomingCaption('', false);
        }
      } catch (e) {
        console.debug('[WS] Non-JSON message received');
      }
    };
  }

  public handleIncomingCaption(text: string, isPartial: boolean) {
    if (this.onCaptionMessage) {
      this.onCaptionMessage(text, isPartial);
    }
  }

  private scheduleRetry(currentRetry: number) {
    if (this.intentionalClose || currentRetry >= MAX_RETRY_COUNT) return;

    const delay = BASE_RETRY_DELAY_MS * Math.pow(2, currentRetry);
    console.debug(`[WS] Reconnecting in ${delay}ms (attempt ${currentRetry + 1}/${MAX_RETRY_COUNT})`);
    this.retryTimeoutId = setTimeout(() => this.openSocket(currentRetry + 1), delay);
  }

  public disconnect() {
    this.intentionalClose = true;

    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = undefined;
    }

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      if (this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
        this.ws.close();
      }
      this.ws = null;
      this.wsConnected = false;
    }
  }

  public sendBinary(data: ArrayBuffer) {
    if (this.isReady) {
      this.ws!.send(data);
    }
  }

  public sendControl(type: string) {
    if (this.isReady) {
      this.ws!.send(JSON.stringify({ type }));
    }
  }
}

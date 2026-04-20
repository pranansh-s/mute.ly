import type { ServerMessage, InitMessage } from './types';

const MAX_RETRY_COUNT = 5;
const BASE_RETRY_DELAY_MS = 2000;

export class TransportClient {
  private ws: WebSocket | null = null;
  private wsConnected = false;

  public get isReady(): boolean {
    return this.wsConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  private onCaptionMessage?: (text: string, isPartial: boolean) => void;

  public connect(wsUrl: string, videoId: string, retry: number, onCaptionMessage?: (text: string, isPartial: boolean) => void) {
    this.onCaptionMessage = onCaptionMessage || this.onCaptionMessage;
    
    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('[WS] Initialization failed:', e);
      return;
    }

    this.ws.onopen = () => {
      this.wsConnected = true;
      if (this.isReady) {
        this.ws!.send(JSON.stringify({ type: 'init', videoId } as InitMessage));
      }
    };

    this.ws.onclose = () => {
      this.wsConnected = false;
      if (retry < MAX_RETRY_COUNT) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, retry);
        setTimeout(() => this.connect(wsUrl, videoId, retry + 1, this.onCaptionMessage), delay);
      }
    };

    this.ws.onerror = () => this.disconnect();

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if ((data.type === 'partial' || data.type === 'final') && this.onCaptionMessage) {
          this.onCaptionMessage(data.text, data.type === 'partial');
        }
      } catch (e) {
        console.debug("[WS] Invalid JSON");
      }
    };
  }

  public disconnect() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      this.ws.close();
      this.ws = null;
      this.wsConnected = false;
    }
  }

  public sendBinary(data: ArrayBuffer) {
    if (this.isReady) {
      this.ws!.send(data);
    } else {
      console.warn('[Transport] WebSocket not ready; dropping audio chunk');
    }
  }
}

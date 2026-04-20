import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { STTService } from './services/stt.service.js';
import { TranscriptionSession } from './services/session.service.js';

export class SocketManager {
  private wss: WebSocketServer;
  private sessions = new Map<WebSocket, TranscriptionSession>();

  constructor(server: Server, private stt: STTService) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', this.handleConnection.bind(this));
  }

  public get activeSessionsCount(): number {
    return this.sessions.size;
  }

  private handleConnection(ws: WebSocket) {
    console.log('[WS] New extension connection');

    ws.on('message', async (data, isBinary) => {
      try {
        if (isBinary) {
          let buffer: Buffer;
          if (Buffer.isBuffer(data)) {
            buffer = data;
          } else if (Array.isArray(data)) {
            buffer = Buffer.concat(data);
          } else {
            buffer = Buffer.from(data as ArrayBuffer);
          }

          const session = this.sessions.get(ws);
          if (session) {
            // Processing queue handles strictly sequential logic natively. No await.
            session.processChunk(buffer);
          }
          return;
        }

        const msg = JSON.parse(data.toString());
        if (msg.type === 'init') {
          const session = new TranscriptionSession(msg.videoId, ws, this.stt);
          this.sessions.set(ws, session);
          console.log('[WS] Session started for:', msg.videoId);
          ws.send(JSON.stringify({ type: 'connected', videoId: msg.videoId }));
        }
      } catch (error) {
        console.error('[WS] Message error:', error);
      }
    });

    ws.on('close', () => {
      this.sessions.delete(ws);
      console.log('[WS] Connection closed');
    });
  }
}

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
          const buffer = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data as ArrayBuffer);

          const session = this.sessions.get(ws);
          if (session) {
            await session.processChunk(buffer);
          }
          return;
        }

        const { type, videoId, isLive } = JSON.parse(data.toString());
        if (type === 'init') {
          const session = new TranscriptionSession(videoId, ws, this.stt, isLive);
          this.sessions.set(ws, session);
          console.log(`[WS] Session started for: ${videoId} (Live: ${isLive})`);
          ws.send(JSON.stringify({ type: 'connected', videoId }));
        } else if (type === 'speech_end') {
          const session = this.sessions.get(ws);
          if (session) session.onSpeechEnd();
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

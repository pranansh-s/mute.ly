import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { STTService } from './services/stt.service.js';
import { createVodRouter } from './routes/vod.routes.js';
import { SocketManager } from './socket.js';

const app = new Hono();
app.use('*', cors());

const sttService = new STTService();

app.route('/api/vod', createVodRouter(sttService));
app.get('/api/health', (c) => c.json({ status: 'ok' }));

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT) || 3001
}, (info) => {
  console.log(`[HTTP] Backend listening on http://localhost:${info.port}`);
});

const socketManager = new SocketManager(server as any, sttService);

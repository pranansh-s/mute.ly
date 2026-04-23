import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { execSync } from 'child_process';
import { STTService } from './services/stt.service.js';
import { createVodRouter } from './routes/vod.routes.js';
import { SocketManager } from './socket.js';

const app = new Hono();
app.use('*', cors());

const sttService = new STTService();

app.route('/api/vod', createVodRouter(sttService));

app.get('/api/health', (c) => {
  const check = (cmd: string) => {
    try {
      const version = execSync(`${cmd} --version`, { timeout: 5000 }).toString().split('\n')[0].trim();
      return { available: true, version };
    } catch {
      return { available: false, version: null };
    }
  };

  return c.json({
    status: 'ok',
    tools: {
      'yt-dlp': check('yt-dlp'),
      ffmpeg: check('ffmpeg'),
    },
  });
});

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT) || 3001
}, (info) => {
  console.log(`[HTTP] Backend listening on http://localhost:${info.port}`);
});

const socketManager = new SocketManager(server as any, sttService);

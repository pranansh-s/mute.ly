import { Hono } from 'hono';
import { STTService } from '../services/stt.service.js';

export function createVodRouter(stt: STTService) {
  const router = new Hono();

  router.post('/transcribe', async (c) => {
    try {
      const { videoId, chunks } = await c.req.json();

      if (!videoId || !Array.isArray(chunks)) {
        return c.json({ error: 'Invalid payload: expected videoId and chunks array' }, 400);
      }

      const promises = chunks.map(async (chunk) => {
        const audioBuffer = Buffer.from(chunk.audio, 'base64');
        const result = await stt.transcribe(audioBuffer);

        return {
          index: chunk.index,
          startTimeSeconds: chunk.index * 30,
          endTimeSeconds: (chunk.index + 1) * 30,
          text: result.text
        };
      });

      const transcriptions = await Promise.all(promises);
      transcriptions.sort((a, b) => a.index - b.index);

      return c.json({
        transcripts: transcriptions
      }, 200);

    } catch (error) {
      console.error('[VOD] Transcription error:', error);
      return c.json({ error: 'Failed to transcribe VOD audio' }, 500);
    }
  });

  return router;
}

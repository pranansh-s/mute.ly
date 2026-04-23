import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { spawn } from 'child_process';
import { STTService } from '../services/stt.service.js';

const CHUNK_DURATION_S = 30;
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const CHUNK_SIZE = CHUNK_DURATION_S * SAMPLE_RATE * BYTES_PER_SAMPLE;

export function createVodRouter(stt: STTService) {
  const router = new Hono();

  router.post('/transcribe', async (c) => {
    const { videoId } = await c.req.json();

    if (!videoId || typeof videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return c.json({ error: 'Invalid payload: expected a valid YouTube videoId' }, 400);
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    return streamSSE(c, async (stream) => {
      let chunkIndex = 0;
      let pcmBuffer = Buffer.alloc(0);
      let ytdlp: any = null;
      let ffmpegProc: any = null;
      const transcriptionPromises: Promise<void>[] = [];

      const killProcesses = () => {
        try {
          if (ytdlp && !ytdlp.killed) ytdlp.kill('SIGKILL');
          if (ffmpegProc && !ffmpegProc.killed) ffmpegProc.kill('SIGKILL');
        } catch (e) {
          // ignore kill errors
        }
      };

      try {
        ytdlp = spawn('yt-dlp', [
          '--cookies-from-browser', 'chrome',
          '-f', 'bestaudio',
          '-o', '-',
          '--no-playlist',
          '--no-warnings',
          videoUrl,
        ]);

        ffmpegProc = spawn('ffmpeg', [
          '-i', 'pipe:0',
          '-f', 's16le',
          '-acodec', 'pcm_s16le',
          '-ar', String(SAMPLE_RATE),
          '-ac', '1',
          '-loglevel', 'error',
          'pipe:1',
        ]);

        // Increase listeners limit for complex piping
        ytdlp.setMaxListeners(20);
        ffmpegProc.setMaxListeners(20);

        let ytdlpError = '';
        let ffmpegError = '';

        ytdlp.stdout.pipe(ffmpegProc.stdin);

        ytdlp.stderr.on('data', (d: Buffer) => {
          ytdlpError += d.toString();
          if (ytdlpError.length > 10000) ytdlpError = ytdlpError.slice(-10000);
        });

        ffmpegProc.stderr.on('data', (d: Buffer) => {
          ffmpegError += d.toString();
          if (ffmpegError.length > 10000) ffmpegError = ffmpegError.slice(-10000);
        });

        ytdlp.once('error', (err: any) => {
          console.error(`[VOD] [${videoId}] yt-dlp spawn error:`, err.message);
        });

        ffmpegProc.once('error', (err: any) => {
          console.error(`[VOD] [${videoId}] ffmpeg spawn error:`, err.message);
        });

        const transcribeChunk = async (chunk: Buffer, index: number) => {
          const startTime = index * CHUNK_DURATION_S;
          const endTime = (index + 1) * CHUNK_DURATION_S;

          try {
            console.log(`[VOD] [${videoId}] Transcribing chunk ${index} (${startTime}s–${endTime}s)...`);
            const result = await stt.transcribe(chunk, true);

            const segments = result.segments?.map(s => ({
              start: startTime + s.start,
              end: startTime + s.end,
              text: s.text
            })) || [
                {
                  start: startTime,
                  end: endTime,
                  text: result.text
                }
              ];

            await stream.writeSSE({
              event: 'transcript',
              data: JSON.stringify({
                index,
                segments,
              }),
            });
          } catch (err) {
            console.error(`[VOD] [${videoId}] Failed to transcribe chunk ${index}:`, err);
          }
        };

        const processStream = async () => {
          for await (const data of ffmpegProc.stdout) {
            pcmBuffer = Buffer.concat([pcmBuffer, data]);
            while (pcmBuffer.length >= CHUNK_SIZE) {
              const chunk = pcmBuffer.subarray(0, CHUNK_SIZE);
              pcmBuffer = pcmBuffer.subarray(CHUNK_SIZE);
              // Start transcription in background while reading next data
              const promise = transcribeChunk(chunk, chunkIndex++);
              transcriptionPromises.push(promise);
            }
          }
        };

        const processPromise = processStream();

        await new Promise<void>((resolve, reject) => {
          ytdlp.once('close', (code: number) => {
            if (code !== 0 && code !== null) {
              console.error(`[VOD] yt-dlp exited with code ${code}: ${ytdlpError}`);
            }
            if (ffmpegProc.stdin.writable) {
              ffmpegProc.stdin.end();
            }
          });

          ffmpegProc.once('close', async (code: number) => {
            if (code !== 0 && code !== null) {
              console.error(`[VOD] ffmpeg exited with code ${code}: ${ffmpegError}`);
            }

            try {
              await processPromise;
              await Promise.all(transcriptionPromises);

              if (pcmBuffer.length > SAMPLE_RATE * BYTES_PER_SAMPLE) {
                const startTime = chunkIndex * CHUNK_DURATION_S;
                const durationS = pcmBuffer.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);

                console.log(`[VOD] Transcribing final chunk ${chunkIndex} (${startTime}s–${(startTime + durationS).toFixed(1)}s)...`);
                const result = await stt.transcribe(pcmBuffer, true);

                const segments = result.segments?.map(s => ({
                  start: startTime + s.start,
                  end: startTime + s.end,
                  text: s.text
                })) || [
                    {
                      start: startTime,
                      end: startTime + durationS,
                      text: result.text
                    }
                  ];

                await stream.writeSSE({
                  event: 'transcript',
                  data: JSON.stringify({
                    index: chunkIndex,
                    segments,
                  }),
                });
                chunkIndex++;
              }

              await stream.writeSSE({
                event: 'done',
                data: JSON.stringify({ totalChunks: chunkIndex }),
              });

              resolve();
            } catch (err) {
              reject(err);
            }
          });

          stream.onAbort(() => {
            killProcesses();
            resolve();
          });
        });

      } catch (error) {
        console.error('[VOD] Transcription pipeline error:', error);
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'Transcription pipeline failed' }),
        });
      } finally {
        killProcesses();
      }

      console.log(`[VOD] Finished transcription for ${videoId} (${chunkIndex} chunks)`);
    });
  });

  return router;
}

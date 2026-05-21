const { spawn } = require('child_process');

function handleAudioProxy(req, res) {
  const { videoId } = req.query;
  if (!videoId) {
    return res.status(400).json({ error: true, message: 'Missing videoId parameter' });
  }

  console.log(`[Server] Streaming audio for: ${videoId}`);

  // yt-dlp downloads the best audio and streams to stdout
  const ytDlp = spawn('yt-dlp', [
    '--no-warnings',
    '--no-playlist',
    '-f', 'bestaudio',
    '-o', '-',
    `https://www.youtube.com/watch?v=${videoId}`
  ]);

  // ffmpeg reads from yt-dlp stdout and converts to raw PCM (f32le, 16000Hz, mono)
  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',      // Read from stdin
    '-f', 'f32le',       // Output format: 32-bit float little-endian
    '-ac', '1',          // 1 channel (mono)
    '-ar', '16000',      // 16000 Hz sample rate
    'pipe:1'             // Write to stdout
  ]);

  // Pipe yt-dlp stdout to ffmpeg stdin
  ytDlp.stdout.pipe(ffmpeg.stdin);

  // Set appropriate headers for raw binary stream
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Transfer-Encoding', 'chunked');

  // Pipe ffmpeg stdout directly to HTTP response
  ffmpeg.stdout.pipe(res);

  let ytDlpClosed = false;
  let ffmpegClosed = false;

  const cleanup = () => {
    if (!ytDlpClosed) ytDlp.kill();
    if (!ffmpegClosed) ffmpeg.kill();
  };

  req.on('close', () => {
    console.log(`[Server] Client disconnected for ${videoId}, cleaning up processes...`);
    cleanup();
  });

  ytDlp.on('close', (code) => {
    ytDlpClosed = true;
    if (code !== 0 && code !== null) {
      console.error(`[Server] yt-dlp exited with code ${code}`);
      if (!res.headersSent) {
        res.status(500).json({ error: true, message: 'yt-dlp failed to start' });
      } else {
        // Stream already started, force a network error on the client
        req.destroy(new Error(`yt-dlp crashed with code ${code}`));
      }
      cleanup();
    }
  });

  ytDlp.on('error', (err) => {
    console.error(`[Server] yt-dlp error:`, err);
    if (!res.headersSent) res.status(500).json({ error: true, message: 'yt-dlp process error' });
    else req.destroy(err);
    cleanup();
  });

  ffmpeg.on('close', (code) => {
    ffmpegClosed = true;
    if (code !== 0 && code !== null) {
      console.error(`[Server] ffmpeg exited with code ${code}`);
      if (!res.headersSent) {
        res.status(500).json({ error: true, message: 'ffmpeg failed to start' });
      } else {
        // Stream already started, force a network error on the client
        req.destroy(new Error(`ffmpeg crashed with code ${code}`));
      }
    } else {
      res.end(); // Normal successful completion
    }
  });

  ffmpeg.on('error', (err) => {
    console.error(`[Server] ffmpeg error:`, err);
    if (!res.headersSent) res.status(500).json({ error: true, message: 'ffmpeg process error' });
    else req.destroy(err);
    cleanup();
  });
}

function handleHealth(req, res) {
  res.send('ok');
}

module.exports = {
  handleAudioProxy,
  handleHealth
};

const express = require('express');
const cors = require('cors');

const { handleAudioProxy, handleHealth } = require('./routes.cjs');

const PORT = 3000;
const app = express();

app.use(cors());

const { spawnSync } = require('child_process');

function checkDependency(command, args) {
  try {
    const result = spawnSync(command, args, { stdio: 'ignore' });
    if (result.error) return false;
    return result.status === 0;
  } catch {
    return false;
  }
}

console.log('[Server] Checking dependencies...');
if (!checkDependency('yt-dlp', ['--version'])) {
  console.error('[Server] ERROR: yt-dlp is not installed or not in PATH.');
  process.exit(1);
}
if (!checkDependency('ffmpeg', ['-version'])) {
  console.error('[Server] ERROR: ffmpeg is not installed or not in PATH.');
  process.exit(1);
}
console.log('[Server] Dependencies OK.');

app.get('/api/audio-proxy', handleAudioProxy);
app.get('/api/health', handleHealth);

const server = app.listen(PORT, () => console.log(`Mute.ly Server on port ${PORT}`));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${PORT} is already in use. Kill the old process: lsof -ti:${PORT} | xargs kill -9`);
  } else {
    console.error('[Server] Failed to start:', err);
  }
  process.exit(1);
});

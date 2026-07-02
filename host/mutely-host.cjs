#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

process.on('uncaughtException', (err) => { console.error('[mutely-host] uncaughtException', err); });
process.on('unhandledRejection', (err) => { console.error('[mutely-host] unhandledRejection', err); });

if (process.platform === 'darwin') {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
  process.env.PATH = [...extra, process.env.PATH || ''].filter(Boolean).join(path.delimiter);
} else if (process.platform === 'linux') {
  const extra = ['/usr/local/bin', '/snap/bin', `${process.env.HOME || ''}/.local/bin`];
  process.env.PATH = [...extra, process.env.PATH || ''].filter(Boolean).join(path.delimiter);
}

const PCM_FRAME_BYTES = 512 * 1024;
const MAX_INCOMING_FRAME = 1024 * 1024;

let stdinBuffer = Buffer.alloc(0);
let activeYtDlp = null;
let activeFfmpeg = null;
let pcmBuffered = Buffer.alloc(0);
let totalBytes = 0;
let pcmSeq = 0;

process.stdin.on('data', (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  drainIncoming();
});

process.stdin.on('end', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

process.stdin.resume();

function drainIncoming() {
  while (stdinBuffer.length >= 4) {
    const len = stdinBuffer.readUInt32LE(0);
    if (len > MAX_INCOMING_FRAME) {
      sendError(`Incoming frame too large: ${len}`);
      shutdown(1);
      return;
    }
    if (stdinBuffer.length < 4 + len) return;

    const body = stdinBuffer.slice(4, 4 + len);
    stdinBuffer = stdinBuffer.slice(4 + len);

    let msg;
    try { msg = JSON.parse(body.toString('utf8')); }
    catch (err) { sendError(`Bad JSON: ${err.message}`); continue; }

    handleMessage(msg);
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'start') {
    if (typeof msg.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(msg.videoId)) {
      sendError('Invalid videoId');
      return;
    }
    startStream(msg.videoId);
    return;
  }

  if (msg.type === 'stop') {
    killStream();
    return;
  }

  if (msg.type === 'ping') {
    send({ type: 'pong' });
    return;
  }
}

function startStream(videoId) {
  killStream();
  pcmBuffered = Buffer.alloc(0);
  totalBytes = 0;
  pcmSeq = 0;

  let ytDlp;
  try {
    ytDlp = spawn('yt-dlp', [
      '--no-warnings',
      '--no-playlist',
      '--extractor-args', 'youtube:player_client=default,web_safari,mweb,ios,tv',
      '-f', 'bestaudio',
      '-o', '-',
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
  } catch (err) {
    sendError(`yt-dlp spawn failed: ${err.message}`, 'NO_FFMPEG_OR_YTDLP');
    return;
  }

  let ffmpeg;
  try {
    ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 'f32le',
      '-ac', '1',
      '-ar', '16000',
      'pipe:1',
    ]);
  } catch (err) {
    try { ytDlp.kill('SIGKILL'); } catch {}
    sendError(`ffmpeg spawn failed: ${err.message}`, 'NO_FFMPEG_OR_YTDLP');
    return;
  }

  activeYtDlp = ytDlp;
  activeFfmpeg = ffmpeg;

  const STDERR_TAIL_BYTES = 2048;
  let ytDlpStderr = '';
  let ffmpegStderr = '';
  const appendStderr = (current, chunk) => {
    const next = current + chunk.toString('utf8');
    return next.length > STDERR_TAIL_BYTES ? next.slice(-STDERR_TAIL_BYTES) : next;
  };

  ytDlp.on('error', (err) => sendError(`yt-dlp error: ${err.message}`, 'NO_FFMPEG_OR_YTDLP'));
  ffmpeg.on('error', (err) => sendError(`ffmpeg error: ${err.message}`, 'NO_FFMPEG_OR_YTDLP'));

  ytDlp.stderr.on('data', (chunk) => { ytDlpStderr = appendStderr(ytDlpStderr, chunk); });
  ffmpeg.stderr.on('data', (chunk) => { ffmpegStderr = appendStderr(ffmpegStderr, chunk); });

  ytDlp.stdout.pipe(ffmpeg.stdin);
  ytDlp.stdout.on('error', () => {});
  ffmpeg.stdin.on('error', () => {});

  ffmpeg.stdout.on('data', (chunk) => {
    if (ffmpeg !== activeFfmpeg) return;
    pcmBuffered = pcmBuffered.length === 0 ? chunk : Buffer.concat([pcmBuffered, chunk]);
    while (pcmBuffered.length >= PCM_FRAME_BYTES) {
      const out = pcmBuffered.slice(0, PCM_FRAME_BYTES);
      pcmBuffered = pcmBuffered.slice(PCM_FRAME_BYTES);
      emitPcm(out);
    }
  });

  ytDlp.on('close', (code) => {
    if (ytDlp !== activeYtDlp) return;
    if (code !== 0 && code !== null && !ffmpeg.killed) {
      sendError(`yt-dlp exited code ${code}: ${ytDlpStderr.trim() || '<no stderr>'}`);
      killStream();
    }
  });

  ffmpeg.on('close', (code) => {
    if (ffmpeg !== activeFfmpeg) return;
    if (pcmBuffered.length > 0) {
      const tail = pcmBuffered;
      pcmBuffered = Buffer.alloc(0);
      emitPcm(tail);
    }
    if (code === 0 || code === null) {
      send({ type: 'end', durationSeconds: totalBytes / 4 / 16000 });
    } else {
      sendError(`ffmpeg exited code ${code}: ${ffmpegStderr.trim() || '<no stderr>'}`);
    }
    activeYtDlp = null;
    activeFfmpeg = null;
  });
}

function emitPcm(buffer) {
  totalBytes += buffer.length;
  send({ type: 'pcm', seq: pcmSeq++, chunk: buffer.toString('base64') });
}

function killStream() {
  if (activeYtDlp) {
    try { activeYtDlp.kill('SIGKILL'); } catch {}
    activeYtDlp = null;
  }
  if (activeFfmpeg) {
    try { activeFfmpeg.kill('SIGKILL'); } catch {}
    activeFfmpeg = null;
  }
  pcmBuffered = Buffer.alloc(0);
}

const writeQueue = [];
let draining = false;

function flushWriteQueue() {
  while (writeQueue.length > 0) {
    const buf = writeQueue.shift();
    const ok = process.stdout.write(buf);
    if (!ok) {
      draining = true;
      process.stdout.once('drain', () => {
        draining = false;
        flushWriteQueue();
      });
      return;
    }
  }
}

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  writeQueue.push(Buffer.concat([header, body]));
  if (!draining) flushWriteQueue();
}

function sendError(message, code) {
  send({ type: 'error', message, code });
}

function shutdown(exitCode) {
  killStream();
  process.exit(exitCode);
}

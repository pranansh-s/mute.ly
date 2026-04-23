# Mute.ly - Robust YouTube Transcription Pipeline

Mute.ly is a high-performance, real-time transcription system for YouTube, designed to provide accurate, low-latency captions for both VOD (Video on Demand) and Live streams. It bypasses common bot detection issues and handles long-duration content with high memory efficiency.

## 🚀 Features

- **Robust VOD Transcription**: Uses `yt-dlp` and `ffmpeg` subprocesses to reliably extract audio from YouTube.
- **Bypass Bot Detection**: Leverages `--cookies-from-browser` to use your active Chrome session for authenticated requests.
- **Progressive Streaming (SSE)**: Captions are streamed to the browser in real-time as chunks are processed, eliminating the wait for full video transcription.
- **Parallel Processing**: Employs non-blocking background transcription to maximize throughput.
- **Live Support**: WebSocket-based real-time transcription for live streams using Voice Activity Detection (VAD).
- **Smooth UX**: Stability-focused caption synchronization that eliminates subtitle flickering and jitter.
- **Memory Efficient**: Processes raw PCM audio via async iterators to maintain a flat memory profile regardless of video length.

## 🏗️ Architecture

- **Extension**: A Vite-powered Chrome extension that captures audio from the YouTube player and manages the transcription lifecycle.
- **Backend**: A Hono (Node.js) server that orchestrates subprocesses (`yt-dlp`, `ffmpeg`) and communicates with the STT engine.
- **STT Engine**: Powered by `faster-whisper-server` (running in Docker) for high-speed, accurate speech-to-text.

## 🛠️ Prerequisites

1.  **Node.js**: v18+ recommended.
2.  **Docker**: To run the STT server.
3.  **yt-dlp**: System-wide installation required (`brew install yt-dlp` or similar).
4.  **ffmpeg**: System-wide installation required (`brew install ffmpeg`).
5.  **Google Chrome**: Active session for YouTube cookie extraction.

## 🚦 Getting Started

### 1. Start the STT Server
Run the Faster-Whisper server using Docker:
```bash
docker run -p 8080:8000 fedirz/faster-whisper-server:latest-cuda
```
*(If you don't have a CUDA-capable GPU, use the CPU version as per the container documentation.)*

### 2. Setup the Backend
Navigate to the `backend` directory and install dependencies:
```bash
cd backend
npm install
npm run dev
```
The backend will start listening on `http://localhost:3001`.

### 3. Setup the Extension
Navigate to the `extension` directory and build the project:
```bash
cd extension
npm install
npm run build
```
Load the `dist` folder into Chrome as an unpacked extension via `chrome://extensions`.

## 📖 How It Works

1.  **Extraction**: When you start Mute.ly on a YouTube video, the extension detects if it's a VOD or Live stream.
2.  **Piping**: For VODs, the backend spawns `yt-dlp` which pipes raw audio directly into `ffmpeg`.
3.  **Chunking**: Audio is buffered into 30-second PCM chunks.
4.  **Transcription**: Each chunk is sent to the STT server. While one chunk is transcribing, the next one is already being read.
5.  **Streaming**: Granular segments with timestamps are pushed back to the extension via Server-Sent Events (SSE).
6.  **Rendering**: The extension's sync loop monitors the video `currentTime` and displays the matching subtitle segment with high stability logic.

## 🛠️ Development

- **Backend Health Check**: Verify your dependencies are correctly installed by visiting `http://localhost:3001/api/health`.
- **Logs**: Monitor the terminal for real-time transcription progress and subprocess status.

---
Built with ❤️ for a more accessible YouTube experience.

# Mute.ly

Free, private YouTube captions powered by local AI — runs entirely on your machine. No API keys, no cloud servers, and your data never leaves your network.

## What It Does

Mute.ly is a Chrome extension that transcribes YouTube audio using a Whisper model running locally. It supports both live streams and pre-recorded VODs (Video on Demand) using a dual-mode architecture.

- **Fully Local**: All AI inference happens directly in your browser. The VOD backend runs entirely on your local machine.
- **Zero Setup APIs**: No accounts or API keys required.
- **Dual-Mode Processing**:
  - **Live Streams**: Uses real-time Voice Activity Detection (VAD) driven sliding window transcription for low-latency captions directly via browser tab audio capture.
  - **VODs**: Uses a high-performance, seek-aware Ahead-of-Time (AOT) transcription pipeline. A local Node server securely downloads the audio track via `yt-dlp` and proxies it to the extension for offline decoding and fast chunked processing.
- **WASM Optimized**: Runs securely within a single-threaded WebAssembly environment to comply with strict Chrome Manifest V3 Content Security Policies.

## Architecture & Event Flow

The system is split into the **Chrome Extension** (UI + AI inference) and a **Local Node.js Proxy Server** (VOD audio extraction). All communication between the Content Script and the Offscreen Document is relayed through the Background Service Worker — Chrome MV3 does not allow direct messaging between them.

### Live Stream Pipeline

In live mode, the Content Script captures tab audio via `captureStream()`, runs Voice Activity Detection locally (Silero VAD v5), and sends 2.5-second sliding windows of audio to the Offscreen Document for transcription.

```mermaid
sequenceDiagram
    participant YT as YouTube DOM
    participant CS as Content Script
    participant BG as Background Worker
    participant OD as Offscreen Document
    participant WW as Whisper Worker

    CS->>YT: Inject UI (Button & Overlay)
    CS->>BG: {type: load}
    BG->>OD: Relay (ensureOffscreen)
    OD->>WW: Load whisper-base.en model
    WW-->>OD: Model ready
    OD-->>BG: {type: ready}
    BG-->>CS: Relay ready

    CS->>YT: captureStream() → VAD
    loop On Speech (2.5s sliding window, 0.5s step)
        CS->>BG: {type: transcribe, audio: Float32[]}
        BG->>OD: Relay
        OD->>WW: Transcribe chunk
        WW-->>OD: {type: result, text}
        OD-->>BG: Relay result
        BG-->>CS: Relay result
        CS->>YT: Render caption
    end
```

### VOD Pipeline (Streaming Ahead-of-Time)

In VOD mode, audio is processed ahead of playback. The Content Script sends only the proxy **URL** — the Offscreen Document performs the actual HTTP fetch from the local server and progressively reads raw PCM chunks into memory. Captions are rendered on a decoupled 20fps timer using binary search against stored timestamps, enabling instant seek.

```mermaid
sequenceDiagram
    participant YT as YouTube DOM
    participant CS as Content Script
    participant Srv as Local Server :3000
    participant BG as Background Worker
    participant OD as Offscreen Document
    participant WW as Whisper Worker

    CS->>Srv: GET /api/health
    Srv-->>CS: 200 OK

    CS->>BG: {type: load}
    BG->>OD: Relay
    OD->>WW: Load model
    WW-->>OD: Model ready
    OD-->>BG: {type: ready}
    BG-->>CS: Relay ready

    CS->>BG: {type: load_aot, url}
    BG->>OD: Relay load_aot
    OD->>Srv: fetch(/api/audio-proxy?videoId=...)
    Note over Srv: yt-dlp | ffmpeg raw f32le PCM
    Srv-->>OD: Streaming raw PCM response
    Note over OD: Read ReadableStream chunks → Float32 buffer
    OD-->>BG: {type: aot_buffer_progress, bufferedSeconds}
    BG-->>CS: Relay aot_buffer_progress
    
    loop Chunks queued around playback (poll every 500ms)
        CS->>BG: {type: transcribe_aot, start, end, id}
        BG->>OD: Relay
        Note over OD: Slice buffer, RMS silence check
        OD->>WW: Transcribe (if not silent)
        WW-->>OD: {type: result, timestamps + text}
        OD-->>BG: Relay result
        BG-->>CS: Store timestamped captions
    end

    Note over CS: Render loop (20fps): binary search captions by video.currentTime
    CS->>YT: Display matching caption
    Note over CS: On seek: abort in-flight chunks, re-queue around new position
```

### Component Breakdown

1. **Content Script (`src/content.ts`)**: Monitors the YouTube player, injects UI, and orchestrates the pipeline based on the video type (live vs VOD).
2. **Local Express Server (`server/`)**: Bypasses browser CORS limitations by using `yt-dlp` to download and serve the highest quality audio track. Only used for VODs.
3. **Background Service Worker (`src/background.ts`)**: Stateless message relay between Content Script and Offscreen Document. Also manages the Offscreen Document lifecycle.
4. **Offscreen Document (`src/offscreen.ts`)**: A hidden DOM environment that fetches and decodes VOD audio into a PCM buffer, and forwards audio chunks to the Whisper Worker. This is the only component that can use `OfflineAudioContext` (not available in service workers or content scripts).
5. **Whisper Web Worker (`src/whisper-worker.ts`)**: Runs `Transformers.js` (Whisper-base.en, ONNX q8) in a background thread for non-blocking WASM inference.

## Getting Started

### Prerequisites

- **Google Chrome** 113+ (for WebGPU / modern WASM support)
- **Node.js** 18+ (for building and running the local proxy)
- **yt-dlp**: Must be installed on your system and available in your PATH. 
  - macOS: `brew install yt-dlp`
  - Linux: `sudo apt install yt-dlp`
  - Windows: `winget install yt-dlp`

### Installation

1. Install dependencies and build the extension:
```bash
npm install
npm run build
```

2. Start the local VOD audio proxy server:
```bash
npm run server
```

3. Load the extension in Chrome:
   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** → select the `dist` folder
   - Navigate to any YouTube video and click the speaker icon in the player controls!

On first activation, the model will download (~75MB). A pulsing orange indicator shows progress. After that, it loads from cache instantly.

### Development

For hot-reloading the extension during development:
```bash
npm run dev
```
*(Remember to manually reload the extension in `chrome://extensions` after file changes)*

To clean stale build artifacts before a fresh build:
```bash
npm run clean && npm run build
```

## Project Structure

```
.
├── server/
│   ├── index.cjs               # Express server entry point
│   ├── routes.cjs              # Handles audio proxying and yt-dlp spawning
│   └── temp/                   # Cached .webm audio files (gitignored)
├── src/
│   ├── background.ts           # Service worker: offscreen lifecycle + message routing
│   ├── content.ts              # Content script: YouTube monitor, UI orchestration
│   ├── offscreen.ts            # Offscreen document: AOT audio decoding & slicing
│   ├── whisper-worker.ts       # Web Worker: Transformers.js inference
│   ├── core/
│   │   ├── types.ts            # Shared types: MonitorStatus, message protocol unions
│   │   ├── audio/
│   │   │   └── audio-extractor.ts    # Live audio capture via VAD + captureStream
│   │   ├── transcription/
│   │   │   ├── transcription-engine.ts  # Orchestrator: routes to JIT or AOT pipeline
│   │   │   ├── offscreen-client.ts      # Chrome messaging client for offscreen document
│   │   │   ├── aot-pipeline.ts          # Seek-aware chunked VOD transcription
│   │   │   └── hallucination-filter.ts  # Filters Whisper phantom outputs
│   │   └── youtube/
│   │       └── youtube-dom.ts           # YouTube DOM queries (video element, controls)
│   └── ui/
│       ├── player-button.ts    # YouTube player button (states: idle/loading/active/error)
│       └── subtitle-overlay.ts # Caption rendering overlay with loading/error states
```

## Technical Details

| Component | Detail |
|---|---|
| **Model** | `onnx-community/whisper-base.en` (ONNX, quantized q8) |
| **Inference** | Transformers.js v4, single-threaded WASM |
| **Live Audio** | VAD (Silero v5) → 2.5s sliding window, 0.5s step |
| **VOD Audio** | AOT decoding via local proxy → seek-aware 30s chunk slicing (25s stride) |
| **Sample Rate** | 16kHz mono Float32 |
| **Permissions** | `offscreen` |

---

Built with ❤️ for a more accessible YouTube.

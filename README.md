<div align="center">
   
# Mute.ly

<img src="assets/banner.gif" alt="Mute.ly Banner" width="100%" />

<br/>
<br/>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Chrome Web Store](https://img.shields.io/badge/Chrome_Extension-v3.0.0-green.svg)](https://chrome.google.com/webstore)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-darkgreen.svg)](https://nodejs.org/)
[![WebGPU + WASM](https://img.shields.io/badge/WebGPU%20%2B%20WASM-Optimized-blueviolet.svg)](https://webassembly.org/)

**Free, private YouTube captions powered by local AI — running entirely on your machine.**<br>
*No API keys, no cloud servers, and your data never leaves your local network.*

---

[Key Features](#key-features) • [Architecture](#architecture) • [Getting Started](#getting-started) • [Project Structure](#project-structure)

</div>

---

## What It Does

Mute.ly is a Chrome extension that transcribes YouTube audio locally with on-device ASR models — Moonshine for live streams, Whisper for VODs.

- **Private by design** — inference runs in-browser via WebAssembly/WebGPU; VOD audio is pulled by a local native process, never a remote server.
- **Zero setup** — no accounts, no API keys, no subscription.
- **Dual-mode** — live audio is captioned just-in-time off voice-activity detection; VODs are transcribed ahead-of-time in chunks as you watch, so seeking never waits on live inference.

---

## Key Features

**Local audio DSP** — every slice is cleaned before it reaches the model: a 150Hz Butterworth high-pass biquad strips rumble and hum, and a 20ms-frame noise gate silences background noise that would otherwise get hallucinated into text. A chunk-level RMS gate also short-circuits fully silent 30-second VOD windows before they hit inference.

**Dual transcription pipeline** — live audio is segmented by Silero VAD v5, with each finished utterance (plus a 3s flush for long ones) sent off as it completes. VOD audio is fetched ahead of playback in 30-second chunks on a 25-second stride, keyed by time range so re-seeking never re-transcribes finished work.

**Cinema-style captions** — model output is split on sentence boundaries into ≤42-character, two-line captions with a minimum on-screen duration, so text never flashes faster than it can be read. A dedicated filter also strips known ASR phantom-text patterns.

**MV3-safe lifecycle** — a sub-audible 1Hz oscillator keeps the offscreen document alive, and the background worker pings the native host every 20s while streaming, working around Manifest V3's aggressive context suspension. Every message carries a tab/client ID so a stale tab can never write into an active session.

**Seek-aware VOD scheduling** — seeking prunes queued work outside the new playhead, keeps in-flight chunks that are still useful, and aborts/restarts the ASR worker if the active job no longer matches where playback jumped to.

---

## Architecture

Four isolated MV3 contexts talk only via message passing; a Chrome **native messaging host** (auto-spawned on demand, torn down on disconnect) is the sole source of VOD audio — no local HTTP server involved.

```
[YouTube Tab] <== (Service Worker Relay) ==> [Offscreen Page] <==> [ASR Worker (WebGPU/WASM)]
     ||                                             ||
     || (Live: captureStream + VAD)                 || (VOD: connectNative stdio port)
     \/                                             \/
[Local Audio Output]                        [Native Host: mutely-host.cjs]
                                                    || (yt-dlp | ffmpeg → base64 PCM, seq-numbered frames)
                                                    \/
                                            [YouTube CDN Stream]
```

**Live** — the content script captures tab audio, runs Silero VAD locally, and forwards each finished utterance through the background relay to the offscreen worker for transcription.

**VOD** — the background worker opens a native-messaging port to `mutely-host.cjs`, which pipes `yt-dlp | ffmpeg` back as sequence-numbered, base64 PCM frames; the offscreen document buffers these into an Int16 PCM store and dispatches Whisper jobs for whatever range the playhead needs next, aborting stale jobs on seek.

---

## Getting Started

**Prerequisites:** Chrome 116+, Node.js 18+, and `yt-dlp` + `ffmpeg` on PATH.
- macOS: `brew install yt-dlp ffmpeg`
- Linux: `sudo apt install yt-dlp ffmpeg`
- Windows: `winget install yt-dlp` and `winget install ffmpeg`

1. **Build:**
   ```bash
   npm install
   npm run build
   ```
2. **Load the extension:** open `chrome://extensions`, enable Developer mode, "Load unpacked" → select `dist`, copy the extension ID shown on the card.
3. **Install the native host (one-time):**
   ```bash
   npm run install-host -- --extension-id=<YOUR_EXTENSION_ID>
   ```
   Registers `com.mutely.host.json` for your OS's browsers and refuses to install if `yt-dlp`/`ffmpeg` aren't on PATH.
4. **Use it:** open any YouTube video and click the speaker icon in the player controls. Chrome spawns the host process on demand — no terminal, no server to run.

*First run downloads the model (~60MB live / ~80MB VOD) and caches it in the browser for instant startup after.*

## Project Structure

```
.
├── public/
│   ├── manifest.json            # MV3 manifest
│   └── index.html                # Offscreen document shell
├── host/
│   ├── mutely-host.cjs          # Native messaging host: spawns yt-dlp | ffmpeg, streams base64 PCM over stdio
│   ├── install.cjs              # One-time installer; writes Chrome native-messaging manifest, checks PATH
│   ├── uninstall.cjs            # Removes the manifest from all supported browser dirs
│   └── manifest/com.mutely.host.json  # Template patched at install time
├── src/
│   ├── background.ts            # Service worker: offscreen lifecycle + message relay + native port
│   ├── content.ts               # Content script: YouTube monitor, UI overlay, mode select
│   ├── offscreen.ts             # Hidden DOM: worker queue, AOT decoder, keep-alive oscillator
│   ├── asr-worker.ts            # Web Worker: ONNX ASR inference — Moonshine live / Whisper VOD (WebGPU/WASM)
│   ├── core/
│   │   ├── types.ts                       # OffscreenCommand / OffscreenEvent / WorkerCommand unions
│   │   ├── audio/
│   │   │   ├── live-streamer.ts           # Silero VAD v5 lifecycle (live mode)
│   │   │   ├── audio-preprocessor.ts      # 150Hz HPF biquad + 20ms noise gate
│   │   │   └── aot-stream-decoder.ts      # Progressive AOT PCM store + range slicer + silence check
│   │   ├── transcription/
│   │   │   ├── transcription-engine.ts    # Live vs VOD orchestrator (single facade for content.ts)
│   │   │   ├── offscreen-client.ts        # Cross-context messaging wrapper, per-tab clientId
│   │   │   ├── aot-pipeline.ts            # Render loop + caption cache (LRU 500)
│   │   │   ├── caption-splitter.ts        # Cinema-style caption layout + reading-rate enforcement
│   │   │   ├── aot-scheduler.ts           # Pure chunk-window math (30s window / 25s stride)
│   │   │   └── hallucination-filter.ts    # Filters ASR phantom-text patterns
│   │   ├── errors/
│   │   │   └── error-mapper.ts            # Runtime errors → user-facing title/advice
│   │   └── youtube/
│   │       └── youtube-dom.ts             # DOM scraping (video ID, live badge, controls)
│   └── ui/
│       ├── player-button.ts     # Custom control-bar toggle (idle / loading / active)
│       ├── subtitle-overlay.ts  # Caption rendering
│       ├── error-overlay.ts     # Error modal with title/advice/retry
│       └── overlay-styles.ts    # Shared CSS-in-JS style objects
```

---

## Technical Specifications

| Parameter | Specification |
|:---|:---|
| **ASR Model** | `moonshine-base` (~60MB) for live — encodes actual clip length, no 30s padding — `whisper-base.en` (~80MB) for VOD |
| **Inference Backend** | WebGPU when `navigator.gpu` is available, WASM fallback (with auto-retry on late WebGPU init failure) |
| **Quantization** | ONNX quantized q8 (8-bit integer weights) on both WebGPU and WASM |
| **Speech Highpass** | Second-order Butterworth Biquad (`150Hz`, Q ≈ 0.7071) |
| **Noise Gate** | 20ms frame RMS at `0.015` threshold (-36dBFS) |
| **Format** | 16kHz mono Float32 Linear PCM, end-to-end |
| **CPU Threading** | Multi-threaded WASM inference (`numThreads` capped at 4, scales with `navigator.hardwareConcurrency`) |

---

## License

This project is open-source and available under the [MIT License](LICENSE).

*Built with ❤️ for a more private, accessible, and fast YouTube viewing experience.*

# YouTube Caption Extractor

Chrome extension that extracts YouTube captions or audio in real-time via WebSocket or HTTP.

## How it works

1. **Caption extraction** (primary) - Reads active captions from YouTube's video player text tracks
2. **Audio extraction** (fallback) - Captures audio stream using `captureStream()` API

## Install

```bash
npm install
npm run build
```

## Load in Chrome

1. Open `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `dist` folder

## Usage

1. Navigate to any YouTube video
2. Click extension icon to open popup
3. Configure URLs:
   - HTTP: `http://localhost:3001/api/transcribe` (vod-playback)
   - WebSocket: `ws://localhost:3001/ws` (real-time)

## Debug

Popup shows real-time logs:
- Caption text extracted
- Audio chunks sent
- WebSocket connection status
- Errors

## Backend format

### Caption (WebSocket/HTTP)
```json
{ "type": "caption", "videoId": "abc123", "text": "Hello world", "timestamp": 123 }
```

### Audio (WebSocket/HTTP)
```json
{ "type": "audio", "videoId": "abc123", "audio": "base64-wav", "chunkId": 0, "timestamp": 123 }
```

## Development

```bash
npm run dev    # Watch mode
npm run build  # Production build
```

## Structure

```
extension/
├── src/
│   ├── content.ts              # YouTube page injection + monitor
│   ├── background.ts           # Service worker
│   ├── popup.tsx               # Popup entry
│   ├── popup/Popup.tsx         # Popup UI with debug logs
│   └── lib/
│       ├── caption-extractor.ts # Text track extraction + WebSocket
│       └── audio-extractor.ts   # Audio capture + WebSocket
├── dist/                       # Load this in Chrome
└── manifest.json
```

## Troubleshooting

**No audio track:**
- Video must be playing (not paused)
- Some videos have no audio track
- Try different video

**Captions not detected:**
- Enable captions on YouTube (CC button)
- Video must have caption track available

**WebSocket not connecting:**
- Check backend is running
- Default: `ws://localhost:3001/ws`

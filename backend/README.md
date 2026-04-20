# Backend Server

Hono + WebSocket server for real-time YouTube caption/audio processing.

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

Server starts on:
- HTTP: `http://localhost:3001`
- WebSocket: `ws://localhost:3001/ws`

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ws` | WebSocket | Real-time caption/audio stream |
| `/api/transcribe` | POST | HTTP fallback |
| `/api/health` | GET | Health + connection count |


## WebSocket messages

### Init (client → server)
```json
{ "type": "init", "videoId": "abc123", "mode": "audio" }
```

### Audio (client → server)
```json
{ "type": "audio", "videoId": "abc123", "audio": "base64", "chunkId": 0 }
```

### Ack (server → client)
```json
{ "type": "ack", "processed": true }
```

## Add transcription

Integrate with:
- OpenAI Whisper API
- AWS Transcribe Streaming
- Google Speech-to-Text
- AssemblyAI

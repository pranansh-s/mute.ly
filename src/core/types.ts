export type MonitorStatus = 'idle' | 'loading' | 'audio' | 'error';

/** Status reported by the Whisper model lifecycle. */
export type ModelStatus = 'loading' | 'ready' | 'error';

// ── Messages: Content → Background → Offscreen ─────────────────────

export type OffscreenCommand =
  | { type: 'load' }
  | { type: 'load_aot'; url: string }
  | { type: 'cancel_requests'; ids: number[] }
  | { type: 'abort_chunk'; id: number }
  | { type: 'transcribe'; audio: number[]; id: number }
  | { type: 'transcribe_aot'; startTime: number; endTime: number; id: number; return_timestamps: boolean };

// ── Messages: Offscreen → Background → Content ─────────────────────

export type OffscreenEvent =
  | { type: 'loading'; progress: number }
  | { type: 'ready' }
  | { type: 'aot_buffer_progress'; bufferedSeconds: number }
  | { type: 'aot_audio_ready'; duration: number }
  | { type: 'error'; message: string }
  | { type: 'result'; id: number; tabId?: number; result: TranscriptionResult };

// ── Transcription result from the Whisper worker ────────────────────

export interface TranscriptionResult {
  text?: string;
  chunks?: TranscriptionChunk[];
  dropped?: boolean;
}

export interface TranscriptionChunk {
  text: string;
  timestamp: [number, number] | [number, null];
}

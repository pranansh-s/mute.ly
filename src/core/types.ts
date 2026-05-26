export type MonitorStatus = 'idle' | 'loading' | 'audio' | 'error';

/** Status reported by the Whisper model lifecycle. */
export type ModelStatus = 'loading' | 'ready' | 'error';
export type WhisperModelKind = 'tiny' | 'base';

// ── Messages: Content → Background → Offscreen ─────────────────────

export type OffscreenCommand =
  | { type: 'load'; clientId?: string; modelKind: WhisperModelKind }
  | { type: 'load_aot'; url: string; clientId: string }
  | { type: 'stop_aot'; clientId: string }
  | { type: 'abort_job'; id: number; clientId: string }
  | { type: 'transcribe'; audio: number[]; id: number; clientId: string; modelKind: WhisperModelKind }
  | {
      type: 'transcribe_aot';
      startTime: number;
      endTime: number;
      id: number;
      return_timestamps: boolean;
      clientId: string;
      modelKind: WhisperModelKind;
    };

// ── Messages: Offscreen → Background → Content ─────────────────────

export type OffscreenEvent =
  | { type: 'loading'; progress: number; modelKind?: WhisperModelKind }
  | { type: 'ready'; modelKind?: WhisperModelKind }
  | { type: 'aot_buffer_progress'; bufferedSeconds: number; tabId?: number; clientId?: string }
  | { type: 'aot_audio_ready'; duration: number; tabId?: number; clientId?: string }
  | { type: 'error'; message: string; tabId?: number; clientId?: string }
  | {
      type: 'result';
      id: number;
      tabId?: number;
      clientId?: string;
      result: TranscriptionResult;
    };

// ── Transcription result from the Whisper worker ────────────────────

export interface TranscriptionResult {
  text?: string;
  chunks?: TranscriptionChunk[];
  speechActivity?: SpeechActivityWindow[];
  dropped?: boolean;
  dropReason?: string;
}

export interface TranscriptionChunk {
  text: string;
  timestamp: [number, number] | [number, null];
}

export interface SpeechActivityWindow {
  start: number;
  end: number;
}

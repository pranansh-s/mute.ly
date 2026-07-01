export type MonitorStatus = 'idle' | 'loading' | 'audio' | 'error';

export type ModelStatus = 'loading' | 'ready' | 'error';

export type AsrMode = 'live' | 'vod';
export type AsrDevice = 'webgpu' | 'wasm';

export type OffscreenCommand =
  | { type: 'load'; clientId?: string; mode: AsrMode }
  | { type: 'load_aot'; videoId: string; clientId: string }
  | { type: 'stop_aot'; clientId: string }
  | { type: 'abort_job'; id: number; clientId: string }
  | { type: 'host_probe'; clientId: string }
  | { type: 'aot_pcm'; chunk: string; clientId?: string }
  | { type: 'aot_pcm_end'; durationSeconds?: number; clientId?: string }
  | { type: 'aot_pcm_error'; reason: string; clientId?: string }
  | {
      type: 'transcribe_live';
      audio: number[];
      id: number;
      sessionId: number;
      clientId: string;
      mode: AsrMode;
    }
  | {
      type: 'transcribe_aot';
      startTime: number;
      endTime: number;
      id: number;
      clientId: string;
      mode: AsrMode;
    };

export type OffscreenEvent =
  | { type: 'loading'; progress: number; mode?: AsrMode }
  | { type: 'ready'; mode?: AsrMode; device?: AsrDevice }
  | { type: 'device'; device: AsrDevice }
  | { type: 'aot_buffer_progress'; bufferedSeconds: number; tabId?: number; clientId?: string }
  | { type: 'aot_audio_ready'; duration: number; tabId?: number; clientId?: string }
  | { type: 'host_status'; ok: boolean; reason?: string; tabId?: number; clientId?: string }
  | { type: 'error'; message: string; mode?: AsrMode; tabId?: number; clientId?: string }
  | {
      type: 'result';
      id: number;
      sessionId?: number;
      tabId?: number;
      clientId?: string;
      result: TranscriptionResult;
    };

export type WorkerCommand =
  | { type: 'load'; mode: AsrMode }
  | { type: 'abort_chunk'; id: number }
  | {
      type: 'transcribe_live' | 'transcribe_aot';
      audio: number[];
      id: number;
      sessionId?: number;
      tabId?: number;
      clientId?: string;
      mode: AsrMode;
    };

export interface TranscriptionResult {
  text?: string;
  chunks?: TranscriptionChunk[];
  dropped?: boolean;
  dropReason?: string;
}

export interface TranscriptionChunk {
  text: string;
  timestamp: [number, number] | [number, null];
}

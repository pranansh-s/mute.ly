import { WebSocket } from 'ws';
import { STTService } from './stt.service.js';

const MAX_DISPLAY_WORDS = 15;

type Task = { type: 'audio', buffer: Buffer } | { type: 'speech_end' };

export class TranscriptionSession {
  private lastWords: string[] = [];
  private confirmedWords: string[] = [];
  private taskQueue: Task[] = [];
  private isProcessing = false;
  private emptyCount = 0;

  constructor(
    public readonly videoId: string,
    private ws: WebSocket,
    private stt: STTService,
    private isLive: boolean = true
  ) { }

  private clearTimer: NodeJS.Timeout | null = null;

  async processChunk(audioBuffer: Buffer) {
    if (this.taskQueue.length > 0 && this.taskQueue[this.taskQueue.length - 1].type === 'audio') {
      this.taskQueue[this.taskQueue.length - 1] = { type: 'audio', buffer: audioBuffer };
    } else {
      this.taskQueue.push({ type: 'audio', buffer: audioBuffer });
    }
    this.pump();
  }

  onSpeechEnd() {
    this.taskQueue.push({ type: 'speech_end' });
    this.pump();
  }

  private async pump() {
    if (this.isProcessing) return;

    this.isProcessing = true;
    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift()!;
      if (task.type === 'audio') {
        await this.runSTT(task.buffer);
      } else if (task.type === 'speech_end') {
        this.handleSpeechEnd();
      }
    }
    this.isProcessing = false;
  }

  destroy() {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
    this.taskQueue = [];
  }

  private async runSTT(audioBuffer: Buffer) {
    try {
      const result = await this.stt.transcribe(audioBuffer, !this.isLive);
      const text = result.text.trim();

      if (this.clearTimer) {
        clearTimeout(this.clearTimer);
        this.clearTimer = null;
      }

      if (!text) {
        this.emptyCount++;
        if (this.emptyCount >= 3 && this.confirmedWords.length > 0) {
          this.emit('clear', '');
          this.confirmedWords = [];
          this.lastWords = [];
        }
        return;
      }
      this.emptyCount = 0;

      const currentWords = text.split(/\s+/);

      if (this.lastWords.length === 0) {
        this.emit('partial', text);
        this.lastWords = currentWords;
        return;
      }

      const commonPrefix: string[] = [];
      const minLen = Math.min(currentWords.length, this.lastWords.length);
      for (let i = 0; i < minLen; i++) {
        if (currentWords[i].toLowerCase() === this.lastWords[i].toLowerCase()) {
          commonPrefix.push(currentWords[i]);
        } else {
          break;
        }
      }

      const newConfirmed = commonPrefix.slice(this.confirmedWords.length);
      if (newConfirmed.length > 0) {
        this.confirmedWords.push(...newConfirmed);
      }

      if (this.confirmedWords.length > MAX_DISPLAY_WORDS) {
        this.confirmedWords = this.confirmedWords.slice(-MAX_DISPLAY_WORDS);
      }

      const partialTail = currentWords.slice(this.confirmedWords.length).join(' ');
      const displayText = partialTail
        ? this.confirmedWords.join(' ') + ' ' + partialTail
        : this.confirmedWords.join(' ');

      this.emit(newConfirmed.length > 0 ? 'final' : 'partial', displayText);

      this.lastWords = currentWords;

      if (commonPrefix.length === 0 && this.confirmedWords.length > 0) {
        this.confirmedWords = [];
        this.lastWords = currentWords;
      }

    } catch (error) {
      console.error(`[Session ${this.videoId}] STT Error:`, error);
    }
  }

  private handleSpeechEnd() {
    const displayText = this.lastWords.length > 0
      ? this.lastWords.join(' ')
      : this.confirmedWords.join(' ');

    if (displayText.trim()) {
      this.emit('final', displayText);
    }

    this.confirmedWords = [];
    this.lastWords = [];
    this.emptyCount = 0;

    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => {
      this.emit('clear', '');
      this.clearTimer = null;
    }, 2000);
  }

  private emit(type: 'final' | 'partial' | 'clear', text: string) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, text, videoId: this.videoId }));
    }
  }
}

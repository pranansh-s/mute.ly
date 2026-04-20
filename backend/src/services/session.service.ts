import { WebSocket } from 'ws';
import { STTService } from './stt.service.js';

export class TranscriptionSession {
  private history: string[] = [];
  private confirmedText: string[] = [];
  private processingQueue: Buffer[] = [];
  private isProcessing = false;

  constructor(
    public readonly videoId: string, 
    private ws: WebSocket,
    private stt: STTService
  ) { }

  /**
   * Enqueues a chunk to guarantee strictly sequential STT execution.
   */
  async processChunk(audioBuffer: Buffer) {
    this.processingQueue.push(audioBuffer);
    if (!this.isProcessing) {
      this.isProcessing = true;
      while (this.processingQueue.length > 0) {
        const buffer = this.processingQueue.shift()!;
        await this.runSTT(buffer);
      }
      this.isProcessing = false;
    }
  }

  /**
   * Processes a 3s audio window and implements LocalAgreement-2.
   * Compares the current transcript with the previous one to find stable words.
   */
  private async runSTT(audioBuffer: Buffer) {
    try {
      const result = await this.stt.transcribe(audioBuffer);
      const currentWords = result.text.trim().split(/\s+/).filter(w => w.length > 0);

      if (this.history.length > 0) {
        const lastWords = this.history[this.history.length - 1].split(/\s+/);

        const commonPrefix: string[] = [];
        const minLength = Math.min(currentWords.length, lastWords.length);

        for (let i = 0; i < minLength; i++) {
          if (currentWords[i].toLowerCase() === lastWords[i].toLowerCase()) {
            commonPrefix.push(currentWords[i]);
          } else {
            break;
          }
        }

        const newConfirmed = commonPrefix.slice(this.confirmedText.length);
        if (newConfirmed.length > 0) {
          this.confirmedText.push(...newConfirmed);
          this.emit('final', newConfirmed.join(' '));
        }

        const partial = currentWords.slice(this.confirmedText.length).join(' ');
        this.emit('partial', partial);
      } else {
        this.emit('partial', result.text);
      }

      this.history.push(currentWords.join(' '));
      if (this.history.length > 5) this.history.shift();

    } catch (error) {
      console.error(`[Session ${this.videoId}] STT Error:`, error);
    }
  }

  private emit(type: 'final' | 'partial', text: string) {
    if (this.ws.readyState === WebSocket.OPEN && text.trim().length > 0) {
      this.ws.send(JSON.stringify({ type, text, videoId: this.videoId }));
    }
  }
}

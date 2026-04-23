import OpenAI, { toFile } from 'openai';

export interface TranscriptionResult {
  text: string;
  language?: string;
}

export class STTService {
  private openai: OpenAI;

  constructor(baseURL: string = 'http://localhost:8080/v1') {
    this.openai = new OpenAI({
      apiKey: 'not-needed-for-local',
      baseURL,
    });
  }

  async transcribe(audioBuffer: Buffer, useBetterModel = false): Promise<TranscriptionResult> {
    try {
      const rms = this.calculateRMS(audioBuffer);
      if (rms < 100) {
        return { text: '' };
      }

      const wavBuffer = this.addWavHeader(audioBuffer, 16000, 1, 16);
      const file = await toFile(wavBuffer, 'audio.wav', { type: 'audio/wav' });

      // Scale model up for VOD since we relax real-time constraint
      const modelIdentifier = useBetterModel ? 'Systran/faster-whisper-base.en' : 'Systran/faster-whisper-tiny.en';

      const result = await this.openai.audio.transcriptions.create({
        file,
        model: modelIdentifier,
        language: 'en',
        temperature: 0,
      });

      const text = result.text?.trim() || '';

      if (this.isHallucination(text)) {
        return { text: '' };
      }

      return { text };
    } catch (error) {
      console.error('[STTService] Transcription failed:', error);
      return { text: '' };
    }
  }

  private calculateRMS(pcmBuffer: Buffer): number {
    let sumSquares = 0;
    const sampleCount = pcmBuffer.length / 2;
    for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
      const sample = pcmBuffer.readInt16LE(i);
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / sampleCount);
  }

  private isHallucination(text: string): boolean {
    const lower = text.toLowerCase().trim();

    if ((lower.startsWith('[') && lower.endsWith(']')) ||
      (lower.startsWith('(') && lower.endsWith(')')) ||
      (lower.startsWith('*') && lower.endsWith('*'))) {
      return true;
    }

    const phantoms = [
      'thank you.', 'thanks for watching.', 'subscribe.',
      'thank you', 'thanks for watching', 'subscribe',
      'like and subscribe', 'see you next time', 'bye',
      'you', 'the end', 'so', 'um', 'uh',
      'thank you for watching', 'please subscribe',
      'music', '♪', 'applause', 'laughter',
    ];
    if (phantoms.includes(lower)) return true;

    const phantomPhrases = ['thanks for watching', 'please subscribe', 'subscribe to the channel'];
    if (lower.split(/\s+/).length < 8 && phantomPhrases.some(p => lower.includes(p))) {
      return true;
    }

    const alphaNumChars = lower.replace(/[^a-z0-9]/g, '').length;
    if (lower.length > 3 && alphaNumChars < lower.length * 0.5) return true;

    const words = lower.split(/\s+/);
    if (words.length >= 4) {
      const unique = new Set(words);
      if (unique.size <= Math.ceil(words.length * 0.3)) return true;
    }

    if (words.length >= 4 && words.length % 2 === 0) {
      const half = words.length / 2;
      const firstHalf = words.slice(0, half).join(' ');
      const secondHalf = words.slice(half).join(' ');
      if (firstHalf === secondHalf) return true;
    }

    return false;
  }

  private addWavHeader(pcmData: Buffer, sampleRate: number, numChannels: number, bitsPerSample: number): Buffer {
    const headerLength = 44;
    const dataSize = pcmData.length;
    const buffer = Buffer.alloc(headerLength + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
    buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    pcmData.copy(buffer, headerLength);
    return buffer;
  }
}

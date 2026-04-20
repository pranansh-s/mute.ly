export interface TranscriptionResult {
  text: string;
  language?: string;
}

export class STTService {
  private apiUrl: string;

  constructor(apiUrl: string = 'http://localhost:8080/v1/audio/transcriptions') {
    this.apiUrl = apiUrl;
  }

  async transcribe(audioBuffer: Buffer): Promise<TranscriptionResult> {
    try {
      const wavBuffer = this.addWavHeader(audioBuffer, 16000, 1, 16);
      
      const form = new FormData();
      const blob = new Blob([wavBuffer], { type: 'audio/wav' });
      form.append('file', blob, 'audio.wav');
      form.append('model', 'whisper-1'); 
      form.append('response_format', 'json');

      const response = await fetch(this.apiUrl, { 
        method: 'POST', 
        body: form
      });
      
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Whisper API error: ${response.status} ${response.statusText} - ${errText}`);
      }

      const data = await response.json() as any;
      return { text: data.text || "" };
    } catch (error) {
      console.error('[STTService] Transcription failed:', error);
      // Return empty text to gracefully avoid crashing the session pipeline
      return { text: "" };
    }
  }

  /**
   * Helper to wrap raw 16-bit PCM in a valid WAV header 
   * so it can be accepted by standard transcription APIs.
   */
  private addWavHeader(pcmData: Buffer, sampleRate: number, numChannels: number, bitsPerSample: number): Buffer {
    const headerLength = 44;
    const dataSize = pcmData.length;
    const buffer = Buffer.alloc(headerLength + dataSize);
    
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // fmt chunk size
    buffer.writeUInt16LE(1, 20); // format = PCM
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

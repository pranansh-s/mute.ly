export interface TranscribeAOTRequest {
  id: number;
  startTime: number;
  endTime: number;
  return_timestamps: boolean;
  tabId?: number;
}

export class AotStreamDecoder {
  private aotAudioBuffer: Float32Array | null = null;
  private bufferedSamples = 0;
  private streamAbort: AbortController | null = null;
  private readonly SAMPLE_RATE = 16000;

  constructor(
    private readonly onProgress: (bufferedSeconds: number) => void,
    private readonly onReady: (duration: number) => void,
    private readonly onError: (message: string) => void,
    private readonly onTranscribe: (audio: Float32Array, request: TranscribeAOTRequest) => void,
    private readonly onEmptyResult: (id: number) => void
  ) {}

  /** Cancel any in-progress stream fetch and reset buffer state. */
  public cancelStream() {
    if (this.streamAbort) {
      this.streamAbort.abort();
      this.streamAbort = null;
    }
    this.aotAudioBuffer = null;
    this.bufferedSamples = 0;
  }

  public async loadStream(url: string) {
    // Cancel any previous stream before starting a new one
    this.cancelStream();

    const abort = new AbortController();
    this.streamAbort = abort;

    try {
      console.log('[Offscreen] Starting AOT stream fetch:', url);
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      
      // Pre-allocate buffer for ~10 minutes of 16kHz audio (10 * 60 * 16000 = 9.6M samples)
      let capacity = 16000 * 60 * 10;
      this.aotAudioBuffer = new Float32Array(capacity);
      this.bufferedSamples = 0;
      
      let lastProgressTime = 0;
      let leftoverBuffer = new Uint8Array(0);

      while (true) {
        // Check abort before each read
        if (abort.signal.aborted) return;

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Stream hung (15s timeout)')), 15000);
        });
        
        let readResult;
        try {
          readResult = await Promise.race([reader.read(), timeoutPromise]);
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }

        // Check abort after read completes
        if (abort.signal.aborted) {
          reader.cancel().catch(() => {});
          return;
        }
        
        const { done, value } = readResult;
        
        if (done) break;

        let chunk = value;
        if (leftoverBuffer.length > 0) {
          chunk = new Uint8Array(leftoverBuffer.length + value.length);
          chunk.set(leftoverBuffer);
          chunk.set(value, leftoverBuffer.length);
        }

        const remainder = chunk.length % 4;
        if (remainder > 0) {
          leftoverBuffer = chunk.slice(chunk.length - remainder);
          chunk = chunk.subarray(0, chunk.length - remainder);
        } else {
          leftoverBuffer = new Uint8Array(0);
        }

        if (chunk.length === 0) continue;

        // Always copy into an aligned buffer to avoid DataView alignment issues
        const alignedChunk = new Uint8Array(chunk);
        const floatView = new Float32Array(alignedChunk.buffer, alignedChunk.byteOffset, alignedChunk.length / 4);
        
        if (this.bufferedSamples + floatView.length > capacity) {
          capacity = capacity * 2;
          const newBuffer = new Float32Array(capacity);
          newBuffer.set(this.aotAudioBuffer!);
          this.aotAudioBuffer = newBuffer;
        }
        
        this.aotAudioBuffer!.set(floatView, this.bufferedSamples);
        this.bufferedSamples += floatView.length;

        const bufferedSeconds = this.bufferedSamples / this.SAMPLE_RATE;
        
        if (bufferedSeconds - lastProgressTime >= 2.0) {
          this.onProgress(bufferedSeconds);
          lastProgressTime = bufferedSeconds;
        }
      }

      // Stream completed naturally — only finalize if not aborted
      if (abort.signal.aborted) return;

      this.aotAudioBuffer = this.aotAudioBuffer!.slice(0, this.bufferedSamples);
      const totalDuration = this.bufferedSamples / this.SAMPLE_RATE;
      
      console.log(`[Offscreen] Stream complete: ${totalDuration.toFixed(2)}s`);
      this.onReady(totalDuration);
      
    } catch (err: unknown) {
      // Aborted streams are not errors
      if (abort.signal.aborted) return;

      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[Offscreen] AOT Stream Error:', err);
      this.aotAudioBuffer = null;
      this.bufferedSamples = 0;
      this.onError(`Audio stream failed: ${message}`);
    }
  }

  public transcribeSlice(data: TranscribeAOTRequest) {
    if (!this.aotAudioBuffer || this.bufferedSamples === 0) {
      this.onEmptyResult(data.id);
      return;
    }

    const startSample = Math.floor(data.startTime * this.SAMPLE_RATE);
    const endSample = Math.floor(data.endTime * this.SAMPLE_RATE);

    if (startSample >= this.bufferedSamples) {
      this.onEmptyResult(data.id);
      return;
    }

    const slice = this.aotAudioBuffer.slice(startSample, Math.min(endSample, this.bufferedSamples));
    
    let sumSquares = 0;
    for (let i = 0; i < slice.length; i++) {
      sumSquares += slice[i] * slice[i];
    }
    const rms = Math.sqrt(sumSquares / slice.length);

    if (rms < 0.005) {
      this.onEmptyResult(data.id);
      return;
    }

    this.onTranscribe(slice, data);
  }
}

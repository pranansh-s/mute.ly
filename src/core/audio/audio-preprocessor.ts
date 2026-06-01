class BiquadFilter {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number
  ) {}

  public process(audio: Float32Array): void {
    for (let i = 0; i < audio.length; i++) {
      const x = audio[i];
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      
      audio[i] = y;
    }
  }
}

function createHighPassBiquad(cutoffHz: number, sampleRate = 16000): BiquadFilter {
  const w0 = (2.0 * Math.PI * cutoffHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const q = 0.7071;
  const alpha = sinW0 / (2.0 * q);

  const a0 = 1.0 + alpha;
  const b0 = (1.0 + cosW0) / 2.0 / a0;
  const b1 = -(1.0 + cosW0) / a0;
  const b2 = (1.0 + cosW0) / 2.0 / a0;
  const a1 = -2.0 * cosW0 / a0;
  const a2 = (1.0 - alpha) / a0;

  return new BiquadFilter(b0, b1, b2, a1, a2);
}

function createLowPassBiquad(cutoffHz: number, sampleRate = 16000): BiquadFilter {
  const w0 = (2.0 * Math.PI * cutoffHz) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const q = 0.7071;
  const alpha = sinW0 / (2.0 * q);

  const a0 = 1.0 + alpha;
  const b0 = (1.0 - cosW0) / 2.0 / a0;
  const b1 = (1.0 - cosW0) / a0;
  const b2 = (1.0 - cosW0) / 2.0 / a0;
  const a1 = -2.0 * cosW0 / a0;
  const a2 = (1.0 - alpha) / a0;

  return new BiquadFilter(b0, b1, b2, a1, a2);
}

function normalizeGain(audio: Float32Array, targetMax = 0.8): void {
  let maxVal = 0;
  for (let i = 0; i < audio.length; i++) {
    const absVal = Math.abs(audio[i]);
    if (absVal > maxVal) {
      maxVal = absVal;
    }
  }

  if (maxVal > 0.06 && Math.abs(maxVal - targetMax) > 0.05) {
    const scale = targetMax / maxVal;
    for (let i = 0; i < audio.length; i++) {
      audio[i] *= scale;
    }
  }
}

function applyNoiseGate(audio: Float32Array, sampleRate = 16000, gateThreshold = 0.015): void {
  const frameSize = Math.floor(sampleRate * 0.02);
  if (frameSize <= 0) return;

  for (let offset = 0; offset < audio.length; offset += frameSize) {
    const end = Math.min(offset + frameSize, audio.length);
    let sumSquares = 0;

    for (let i = offset; i < end; i++) {
      sumSquares += audio[i] * audio[i];
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, end - offset));

    if (rms < gateThreshold) {
      for (let i = offset; i < end; i++) {
        audio[i] = 0.0;
      }
    }
  }
}

export function preprocessAudio(audio: Float32Array, sampleRate = 16000): void {
  if (audio.length === 0) return;

  const hpf = createHighPassBiquad(150, sampleRate);
  hpf.process(audio);
  const lpf = createLowPassBiquad(3500, sampleRate);
  lpf.process(audio);

  normalizeGain(audio, 0.8);
  applyNoiseGate(audio, sampleRate, 0.015);
}

export interface LoopRegion {
  start: number;
  end: number;
}

export interface PcmVoiceOptions {
  position?: number;
  rate?: number;
  gain?: number;
  loop?: LoopRegion | null;
}

const MIN_RATE = -16;
const MAX_RATE = 16;

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.max(MIN_RATE, Math.min(MAX_RATE, rate));
}

export class PcmVoice {
  readonly channels: Float32Array[];
  readonly frames: number;
  position: number;
  rate: number;
  gain: number;
  loop: LoopRegion | null;
  ended = false;

  constructor(channels: Float32Array[], options: PcmVoiceOptions = {}) {
    if (!channels.length) throw new Error("PcmVoice needs at least one channel");
    const frames = channels[0].length;
    for (const channel of channels) {
      if (channel.length !== frames) throw new Error("PcmVoice channels must be equal length");
    }
    this.channels = channels;
    this.frames = frames;
    this.position = options.position ?? 0;
    this.rate = clampRate(options.rate ?? 1);
    this.gain = options.gain ?? 1;
    this.loop = options.loop ?? null;
    this.validateLoop();
  }

  private validateLoop(): void {
    const loop = this.loop;
    if (!loop) return;
    if (!Number.isFinite(loop.start) || !Number.isFinite(loop.end)) {
      throw new Error("Loop bounds must be finite");
    }
    if (loop.end <= loop.start) throw new Error("Loop end must be after loop start");
    if (loop.start < 0 || loop.end > this.frames) throw new Error("Loop is outside the track");
  }

  seek(frame: number): void {
    const max = Math.max(0, this.frames - 1);
    this.position = Math.max(0, Math.min(max, frame));
    this.ended = false;
  }

  setRate(rate: number): void {
    this.rate = clampRate(rate);
  }

  setLoop(loop: LoopRegion | null): void {
    this.loop = loop;
    this.validateLoop();
  }

  private wrap(): void {
    const loop = this.loop;
    if (!loop) return;
    const length = loop.end - loop.start;
    if (this.rate >= 0) {
      if (this.position >= loop.end) {
        this.position = loop.start + ((this.position - loop.start) % length);
      }
    } else if (this.position < loop.start) {
      this.position = loop.end - ((loop.end - this.position) % length);
    }
  }

  renderAdd(left: Float32Array, right: Float32Array, frames: number): void {
    if (this.ended) return;
    const channels = this.channels;
    const mono = channels.length === 1 ? channels[0] : null;
    const srcLeft = channels[0];
    const srcRight = mono ?? channels[1] ?? srcLeft;
    const last = this.frames - 1;
    const gain = this.gain;
    let position = this.position;
    let rate = this.rate;
    const count = Math.min(frames, left.length, right.length);

    for (let i = 0; i < count; i += 1) {
      if (position < 0 || position > last) {
        if (!this.loop) {
          this.ended = true;
          break;
        }
        this.wrap();
        if (position < 0 || position > last) {
          this.ended = true;
          break;
        }
      }
      const index = position | 0;
      const frac = position - index;
      let leftSample: number;
      let rightSample: number;
      if (index >= last) {
        leftSample = srcLeft[last];
        rightSample = srcRight[last];
      } else {
        leftSample = srcLeft[index] + (srcLeft[index + 1] - srcLeft[index]) * frac;
        rightSample = srcRight[index] + (srcRight[index + 1] - srcRight[index]) * frac;
      }
      left[i] += leftSample * gain;
      right[i] += rightSample * gain;
      position += rate;
      if (this.loop) {
        const loop = this.loop;
        if (rate >= 0) {
          if (position >= loop.end) {
            position = loop.start + ((position - loop.start) % (loop.end - loop.start));
          }
        } else if (position < loop.start) {
          position = loop.end - ((loop.end - position) % (loop.end - loop.start));
        }
      }
      rate = this.rate;
    }

    this.position = position;
    if (!this.loop && (position < 0 || position > last)) this.ended = true;
  }
}

export interface OfflineRender {
  left: Float32Array;
  right: Float32Array;
}

export class PcmTransport {
  readonly voices: PcmVoice[] = [];

  addVoice(channels: Float32Array[], options: PcmVoiceOptions = {}): PcmVoice {
    const voice = new PcmVoice(channels, options);
    this.voices.push(voice);
    return voice;
  }

  removeVoice(voice: PcmVoice): void {
    const index = this.voices.indexOf(voice);
    if (index >= 0) this.voices.splice(index, 1);
  }

  renderBlock(left: Float32Array, right: Float32Array, frames: number): void {
    const count = Math.min(frames, left.length, right.length);
    left.fill(0, 0, count);
    right.fill(0, 0, count);
    for (const voice of this.voices) voice.renderAdd(left, right, count);
  }

  renderOffline(frames: number, blockSize = 128): OfflineRender {
    if (!Number.isInteger(frames) || frames < 0) throw new Error("Frame count must be a non-negative integer");
    if (!Number.isInteger(blockSize) || blockSize < 1) throw new Error("Block size must be a positive integer");
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const blockLeft = new Float32Array(blockSize);
    const blockRight = new Float32Array(blockSize);
    let offset = 0;
    while (offset < frames) {
      const count = Math.min(blockSize, frames - offset);
      this.renderBlock(blockLeft, blockRight, count);
      left.set(blockLeft.subarray(0, count), offset);
      right.set(blockRight.subarray(0, count), offset);
      offset += count;
    }
    return { left, right };
  }
}

export function makeSine(frames: number, frequency: number, sampleRate: number, amplitude = 1): Float32Array {
  const channel = new Float32Array(frames);
  const step = (2 * Math.PI * frequency) / sampleRate;
  for (let i = 0; i < frames; i += 1) channel[i] = Math.sin(i * step) * amplitude;
  return channel;
}

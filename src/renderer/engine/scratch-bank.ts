import { ScratchVoice } from "./scratch-voice.ts";

export class ScratchBank {
  private readonly voices: ScratchVoice[] = [];
  private readonly buffers: (AudioBuffer | null)[] = new Array(8).fill(null);
  private active: number | null = null;

  constructor(ctx: AudioContext, destination: AudioNode) {
    for (let index = 0; index < 8; index += 1) {
      this.voices.push(new ScratchVoice(ctx, destination));
    }
  }

  load(index: number, buffer: AudioBuffer): void {
    if (!Number.isInteger(index) || index < 0 || index > 7) return;
    this.buffers[index] = buffer;
    this.voices[index]!.setBuffer(buffer);
  }

  has(index: number): boolean {
    return Boolean(this.buffers[index]);
  }

  duration(index: number): number {
    return this.buffers[index]?.duration ?? 0;
  }

  start(index: number, position = 0, rate = 1): boolean {
    const voice = this.voices[index];
    if (!voice || !this.buffers[index]) return false;
    this.stop();
    this.active = index;
    voice.setRate(rate);
    void voice.start(Math.max(0, Math.min(position, this.duration(index) - 0.01)));
    return true;
  }

  setRate(rate: number): void {
    if (this.active === null) return;
    this.voices[this.active]!.setRate(rate);
  }

  stop(): void {
    if (this.active === null) return;
    this.voices[this.active]!.stop();
    this.active = null;
  }

  clear(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > 7) return;
    this.voices[index]!.clear();
    this.buffers[index] = null;
    if (this.active === index) this.active = null;
  }
}

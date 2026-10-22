declare module "signalsmith-stretch" {
  export interface StretchSchedule {
    output?: number;
    active?: boolean;
    input?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    loopStart?: number;
    loopEnd?: number;
  }

  export interface StretchNode extends AudioWorkletNode {
    inputTime: number;
    setUpdateInterval(seconds: number, callback?: (time: number) => void): Promise<void>;
    schedule(options: StretchSchedule): Promise<StretchSchedule>;
    start(when?: number | StretchSchedule, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<void>;
    stop(when?: number): Promise<void>;
    addBuffers(buffers: Float32Array[], transfer?: Transferable[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number } | number>;
    latency(): Promise<number>;
    configure(options: { blockMs?: number | null; intervalMs?: number; splitComputation?: boolean; preset?: "default" | "cheaper" }): Promise<void>;
  }

  export default function SignalsmithStretch(
    context: AudioContext,
    options?: AudioWorkletNodeOptions,
  ): Promise<StretchNode>;
}

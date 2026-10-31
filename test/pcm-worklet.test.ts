import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { WORKLET_SOURCE } from "../src/renderer/engine/pcm-source.ts";

interface PositionMessage {
  type: string;
  position?: number;
}

class FakePort {
  messages: PositionMessage[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;

  postMessage(message: PositionMessage): void {
    this.messages.push(message);
  }
}

class FakeProcessor {
  port = new FakePort();
}

function loadProcessor(): new () => FakeProcessor & {
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
} {
  let registered: { name: string; ctor: new () => FakeProcessor } | null = null;
  const context = vm.createContext({
    AudioWorkletProcessor: FakeProcessor,
    registerProcessor(name: string, ctor: new () => FakeProcessor): void {
      registered = { name, ctor };
    },
    sampleRate: 48000,
  });
  new vm.Script(WORKLET_SOURCE).runInContext(context);
  assert.ok(registered, "worklet should register a processor");
  assert.equal(registered.name, "opendeck-pcm");
  return registered.ctor;
}

function send(
  processor: FakeProcessor & { process(inputs: unknown[], outputs: Float32Array[][]): boolean },
  data: unknown,
): void {
  processor.port.onmessage?.({ data });
}

function render(
  processor: FakeProcessor & { process(inputs: unknown[], outputs: Float32Array[][]): boolean },
  frames: number,
): Float32Array[] {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  processor.process([], [[left, right]]);
  return [left, right];
}

test("pcm worklet plays a buffer at unity rate and reports the end", () => {
  const Processor = loadProcessor();
  const processor = new Processor();
  const left = Float32Array.from([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  send(processor, { type: "buffer", left, right: left.slice() });
  send(processor, { type: "play" });

  const [first] = render(processor, 4);
  assert.deepEqual(Array.from(first), [0, 0.1, 0.2, 0.3].map((value) => Math.fround(value)));

  const [second] = render(processor, 4);
  assert.deepEqual(Array.from(second), [0.4, 0.5, 0.6, 0.7].map((value) => Math.fround(value)));
  assert.ok(processor.port.messages.some((message) => message.type === "ended"));
});

test("pcm worklet wraps a loop sample-accurately", () => {
  const Processor = loadProcessor();
  const processor = new Processor();
  const samples = Float32Array.from([1, 2, 3, 4]);
  send(processor, { type: "buffer", left: samples, right: samples.slice() });
  send(processor, { type: "loop", start: 0, end: 3 });
  send(processor, { type: "play" });

  const [left] = render(processor, 6);
  assert.deepEqual(Array.from(left), [1, 2, 3, 1, 2, 3]);
  assert.ok(!processor.port.messages.some((message) => message.type === "ended"));
});

test("pcm worklet seeks and pauses with position updates", () => {
  const Processor = loadProcessor();
  const processor = new Processor();
  const samples = Float32Array.from([1, 2, 3, 4]);
  send(processor, { type: "buffer", left: samples, right: samples.slice() });
  send(processor, { type: "play" });
  send(processor, { type: "seek", position: 2 });
  const seek = processor.port.messages.filter((message) => message.type === "position").at(-1);
  assert.equal(seek?.position, 2);

  const [left] = render(processor, 4);
  assert.deepEqual(Array.from(left), [3, 4, 0, 0]);

  send(processor, { type: "play", position: 0 });
  send(processor, { type: "pause" });
  const pause = processor.port.messages.filter((message) => message.type === "position").at(-1);
  assert.equal(pause?.position, 0);
  const [silence] = render(processor, 2);
  assert.deepEqual(Array.from(silence), [0, 0]);
});

test("pcm worklet patches a region in place while playing (progressive stems)", () => {
  const Processor = loadProcessor();
  const processor = new Processor();
  const left = new Float32Array(1024).fill(0.25);
  const right = new Float32Array(1024).fill(0.25);
  send(processor, { type: "buffer", left, right, position: 0 });
  send(processor, { type: "play", position: 0 });
  const [before] = render(processor, 128);
  assert.equal(before[127], 0.25);
  send(processor, { type: "patch", start: 128, left: new Float32Array(256).fill(1), right: new Float32Array(256).fill(-1) });
  const [l, r] = render(processor, 128);
  assert.equal(l[0], 1, "patched region plays at once, no reload");
  assert.equal(r[0], -1);
  // A patch that runs past the end is clipped, not thrown.
  send(processor, { type: "patch", start: 1000, left: new Float32Array(100).fill(0.5), right: new Float32Array(100).fill(0.5) });
  const [after] = render(processor, 128);
  assert.equal(after[0], 1, "position kept");
});

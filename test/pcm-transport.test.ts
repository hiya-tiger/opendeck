import assert from "node:assert/strict";
import test from "node:test";
import { makeSine, PcmTransport, PcmVoice } from "../src/renderer/engine/pcm-transport.ts";

function ramp(frames: number, offset = 0): Float32Array {
  const channel = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) channel[i] = offset + i;
  return channel;
}

function renderWith(options: { frames: number; blockSize: number; rate?: number; loop?: { start: number; end: number } | null; position?: number }) {
  const transport = new PcmTransport();
  transport.addVoice([ramp(options.frames)], {
    rate: options.rate ?? 1,
    position: options.position ?? 0,
    loop: options.loop ?? null,
  });
  return transport.renderOffline(options.frames, options.blockSize).left;
}

test("pcm voice reproduces the buffer at unity rate", () => {
  const output = renderWith({ frames: 16, blockSize: 16 });
  assert.deepEqual(Array.from(output), Array.from({ length: 16 }, (_, i) => i));
});

test("pcm voice resamples at double rate", () => {
  const transport = new PcmTransport();
  transport.addVoice([ramp(16)], { rate: 2 });
  const output = transport.renderOffline(8, 8).left;
  assert.deepEqual(Array.from(output), [0, 2, 4, 6, 8, 10, 12, 14]);
});

test("pcm voice plays in reverse", () => {
  const output = renderWith({ frames: 8, blockSize: 8, rate: -1, position: 7 });
  assert.deepEqual(Array.from(output), [7, 6, 5, 4, 3, 2, 1, 0]);
});

test("pcm loop wraps on the exact sample boundary", () => {
  const output = renderWith({ frames: 10, blockSize: 10, loop: { start: 2, end: 6 }, position: 2 });
  assert.deepEqual(Array.from(output), [2, 3, 4, 5, 2, 3, 4, 5, 2, 3]);
});

test("pcm reverse loop wraps backwards", () => {
  const output = renderWith({ frames: 8, blockSize: 8, rate: -1, position: 5, loop: { start: 2, end: 6 } });
  assert.deepEqual(Array.from(output), [5, 4, 3, 2, 5, 4, 3, 2]);
});

test("pcm output is identical for any block size", () => {
  const sizes = [1, 2, 3, 7, 16, 64, 128];
  const reference = renderWith({ frames: 200, blockSize: 200, rate: 0.7, loop: { start: 13, end: 97 }, position: 13 });
  for (const blockSize of sizes) {
    const output = renderWith({ frames: 200, blockSize, rate: 0.7, loop: { start: 13, end: 97 }, position: 13 });
    assert.deepEqual(Array.from(output), Array.from(reference), `block size ${blockSize}`);
  }
});

test("pcm reverse loop output is block-size invariant", () => {
  const reference = renderWith({ frames: 150, blockSize: 150, rate: -0.83, loop: { start: 11, end: 83 }, position: 40 });
  for (const blockSize of [1, 5, 32, 128]) {
    const output = renderWith({ frames: 150, blockSize, rate: -0.83, loop: { start: 11, end: 83 }, position: 40 });
    assert.deepEqual(Array.from(output), Array.from(reference), `block size ${blockSize}`);
  }
});

test("pcm voice stops at the end and reports ended", () => {
  const transport = new PcmTransport();
  const voice = transport.addVoice([ramp(4)], {});
  const output = transport.renderOffline(8, 2).left;
  assert.deepEqual(Array.from(output), [0, 1, 2, 3, 0, 0, 0, 0]);
  assert.equal(voice.ended, true);
});

test("pcm transport mixes voices with gain and stereo channels", () => {
  const transport = new PcmTransport();
  transport.addVoice([ramp(4), ramp(4, 10)], { gain: 0.5 });
  transport.addVoice([ramp(4)], { gain: 0.25, position: 1 });
  const rendered = transport.renderOffline(4, 4);
  assert.deepEqual(Array.from(rendered.left), [0.25, 1, 1.75, 1.5]);
  assert.deepEqual(Array.from(rendered.right), [5.25, 6, 6.75, 6.5]);
});

test("pcm voice can seek and change rate", () => {
  const voice = new PcmVoice([ramp(16)]);
  voice.seek(4);
  voice.setRate(0.5);
  const transport = new PcmTransport();
  transport.voices.push(voice);
  const output = transport.renderOffline(6, 3).left;
  assert.deepEqual(Array.from(output), [4, 4.5, 5, 5.5, 6, 6.5]);
});

test("pcm accepts a mono sine without clicks at the loop point", () => {
  const sine = makeSine(512, 11, 48000);
  const transport = new PcmTransport();
  transport.addVoice([sine], { loop: { start: 64, end: 448 } });
  const output = transport.renderOffline(2048, 128).left;
  for (const sample of output) assert.ok(Number.isFinite(sample));
  const peak = output.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  assert.ok(peak <= 1.0001);
});

test("pcm rejects an invalid loop", () => {
  assert.throws(() => new PcmVoice([ramp(8)], { loop: { start: 6, end: 2 } }), /Loop end/);
  assert.throws(() => new PcmVoice([ramp(8)], { loop: { start: 0, end: 9 } }), /outside/);
});

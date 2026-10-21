import test from "node:test";
import assert from "node:assert/strict";
import { TIMECODES, findTimecode } from "../src/timecode/defs.ts";
import { encodeTimecode } from "../src/timecode/encoder.ts";
import { TimecodeDecoder } from "../src/timecode/decoder.ts";
import { forward, reverse, bitOf, buildPositionTable } from "../src/timecode/lfsr.ts";

const BLOCK = 512;

const run = (id: string, options: Parameters<typeof encodeTimecode>[1], sampleRate = 48000) => {
  const def = findTimecode(id);
  assert.ok(def, `unknown timecode ${id}`);
  const signal = encodeTimecode(def, { sampleRate, ...options });
  const decoder = new TimecodeDecoder(def, sampleRate);
  const states = [];
  for (let offset = 0; offset < signal.left.length; offset += BLOCK) {
    const l = signal.left.subarray(offset, Math.min(offset + BLOCK, signal.left.length));
    const r = signal.right.subarray(offset, Math.min(offset + BLOCK, signal.right.length));
    decoder.push(l, r);
    states.push({ ...decoder.state, at: offset / sampleRate });
  }
  return { def, signal, states, final: decoder.state };
};

test("lfsr is symmetric and never repeats the seed", () => {
  for (const def of TIMECODES.slice(0, 3)) {
    let state = def.seed;
    for (let n = 0; n < 20000; n += 1) {
      const next = forward(state, def);
      assert.equal(reverse(next, def), state);
      assert.notEqual(next, def.seed);
      state = next;
    }
  }
});

test("position table maps states back to their index", () => {
  const def = findTimecode("serato-2a")!;
  const table = buildPositionTable(def);
  let state = def.seed;
  for (let n = 0; n < 5000; n += 1) {
    assert.equal(table[state], n);
    state = forward(state, def);
  }
});

test("serato cv02 decodes speed, lock and position at 1.0x", () => {
  const { states, final } = run("serato-2a", { seconds: 3, startBit: 5000 });
  const settled = states.filter((s) => s.locked);
  assert.ok(settled.length > 0, "decoder never locked");
  assert.ok(Math.abs(final.speed - 1) < 0.02, `speed ${final.speed}`);
  assert.equal(final.direction, 1);
  const expected = 5000 + 3 * 1000;
  assert.ok(Math.abs(final.position - expected) < 60, `position ${final.position} vs ${expected}`);
  assert.ok(final.positionSeconds > 7.9 && final.positionSeconds < 8.1);
});

test("serato cv02 follows pitch at 1.08x", () => {
  const { final } = run("serato-2a", { seconds: 3, startBit: 20000, speed: 1.08 });
  assert.ok(final.locked, "not locked at +8%");
  assert.ok(Math.abs(final.speed - 1.08) < 0.02, `speed ${final.speed}`);
});

test("serato cv02 tracks reverse playback", () => {
  const forwardRun = run("serato-2a", { seconds: 3, startBit: 40000 });
  const reversed = {
    left: forwardRun.signal.left.slice().reverse(),
    right: forwardRun.signal.right.slice().reverse(),
  };
  const def = findTimecode("serato-2a")!;
  const decoder = new TimecodeDecoder(def, 48000);
  const samples = [];
  for (let offset = 0; offset < reversed.left.length; offset += BLOCK) {
    decoder.push(
      reversed.left.subarray(offset, Math.min(offset + BLOCK, reversed.left.length)),
      reversed.right.subarray(offset, Math.min(offset + BLOCK, reversed.right.length)),
    );
    samples.push({ ...decoder.state, at: offset / 48000 });
  }
  const final = decoder.state;
  const locked = samples.filter((s) => s.locked);
  assert.ok(final.locked, "reverse not locked");
  assert.equal(final.direction, -1);
  assert.ok(Math.abs(final.speed + 1) < 0.02, `speed ${final.speed}`);
  assert.ok(locked.length > 0);
  const first = locked[0].position;
  assert.ok(final.position < first, `position ${final.position} did not fall from ${first}`);
  assert.ok(Math.abs(final.position - 40000) < 200, `position ${final.position}`);
});

test("traktor mk2 2 kHz timecode locks", () => {
  const { final } = run("traktor-a", { seconds: 3, startBit: 25000 });
  assert.ok(final.locked, "traktor not locked");
  assert.ok(Math.abs(final.speed - 1) < 0.02, `speed ${final.speed}`);
  assert.ok(Math.abs(final.position - 25000 - 3 * 2000) < 80, `position ${final.position}`);
});

test("pioneer and mixvibes definitions decode", () => {
  for (const id of ["pioneer-a", "mixvibes-v2"]) {
    const { final } = run(id, { seconds: 3, startBit: 12000 });
    assert.ok(final.locked, `${id} not locked`);
    assert.ok(Math.abs(final.speed - 1) < 0.03, `${id} speed ${final.speed}`);
  }
});

test("silence never locks", () => {
  const def = findTimecode("serato-2a")!;
  const decoder = new TimecodeDecoder(def, 48000);
  const silence = new Float32Array(BLOCK);
  for (let i = 0; i < 400; i += 1) decoder.push(silence, silence);
  assert.equal(decoder.state.locked, false);
  assert.equal(decoder.state.position, -1);
});

test("decoder reports bit linearity for every serato side", () => {
  const def = findTimecode("serato-2a")!;
  const table = buildPositionTable(def);
  const positions = [];
  let state = def.seed;
  for (let n = 0; n < 200; n += 1) {
    positions.push(table[state]);
    state = forward(state, def);
  }
  for (let n = 1; n < positions.length; n += 1) assert.equal(positions[n] - positions[n - 1], 1);
  assert.equal(positions[0], 0);
  assert.equal(bitOf(def.seed, def), (def.seed >>> 19) & 1);
});

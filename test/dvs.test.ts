import test from "node:test";
import assert from "node:assert/strict";
import { findTimecode } from "../src/timecode/defs.ts";
import { DvsTransport } from "../src/dvs/transport.ts";
import { drive, renderSignal } from "../src/dvs/simulate.ts";

const RATE = 48000;

test("transport reports locked, positive rate and position", () => {
  const def = findTimecode("serato-2a")!;
  const signal = renderSignal(def, { seconds: 3, startBit: 8000 }, RATE);
  const readings = drive(def, signal, RATE, { block: 480 });
  const final = readings.at(-1)!;
  assert.equal(final.status, "locked");
  assert.ok(Math.abs(final.rate - 1) < 0.02, `rate ${final.rate}`);
  assert.ok(Math.abs(final.speedPercent - 100) < 2);
  assert.ok(final.positionSeconds > 10.6 && final.positionSeconds < 11.1);
  assert.ok(final.jump === null);
});

test("transport survives noise and low gain", () => {
  const def = findTimecode("serato-2a")!;
  for (const spec of [
    { noise: 0.15, gain: 1 },
    { noise: 0.01, gain: 0.08 },
  ]) {
    const signal = renderSignal(def, { seconds: 3, startBit: 30000, ...spec }, RATE);
    const final = drive(def, signal, RATE, { block: 480 }).at(-1)!;
    assert.equal(final.status, "locked", `noise ${spec.noise} gain ${spec.gain}`);
    assert.ok(Math.abs(final.rate - 1) < 0.05, `rate ${final.rate}`);
  }
});

test("silence reports no-signal and zero rate", () => {
  const def = findTimecode("serato-2a")!;
  const zero = new Float32Array(RATE);
  const transport = new DvsTransport(def, RATE);
  const reading = transport.push(zero, zero);
  assert.equal(reading.status, "no-signal");
  assert.equal(reading.rate, 0);
});

test("needle lift stops the deck and reports stalled", () => {
  const def = findTimecode("serato-2a")!;
  const signal = renderSignal(def, { seconds: 2, startBit: 5000 }, RATE);
  const transport = new DvsTransport(def, RATE, { stallMs: 100 });
  for (let o = 0; o < signal.left.length; o += 480) {
    transport.push(signal.left.subarray(o, o + 480), signal.right.subarray(o, o + 480));
  }
  const silence = new Float32Array(480);
  let reading = transport.push(silence, silence);
  for (let i = 0; i < 20; i += 1) reading = transport.push(silence, silence);
  assert.ok(reading.status === "stalled" || reading.status === "no-signal");
  assert.equal(reading.rate, 0);
});

test("needle drop produces a jump event once", () => {
  const def = findTimecode("serato-2a")!;
  const first = renderSignal(def, { seconds: 2, startBit: 2000 }, RATE);
  const second = renderSignal(def, { seconds: 2, startBit: 300000 }, RATE);
  const transport = new DvsTransport(def, RATE);
  for (let o = 0; o < first.left.length; o += 480) {
    transport.push(first.left.subarray(o, o + 480), first.right.subarray(o, o + 480));
  }
  const jumps: number[] = [];
  for (let o = 0; o < second.left.length; o += 480) {
    const reading = transport.push(second.left.subarray(o, o + 480), second.right.subarray(o, o + 480));
    if (reading.jump !== null) jumps.push(reading.jump);
  }
  assert.equal(jumps.length, 1, `jump events ${jumps.length}`);
  assert.ok(Math.abs(jumps[0] - 300) < 6, `jump at ${jumps[0]}`);
});

test("reverse option flips the reported rate", () => {
  const def = findTimecode("serato-2a")!;
  const signal = renderSignal(def, { seconds: 2, startBit: 9000 }, RATE);
  const transport = new DvsTransport(def, RATE, { reverse: true });
  let reading = transport.push(new Float32Array(480), new Float32Array(480));
  for (let o = 0; o < signal.left.length; o += 480) {
    reading = transport.push(signal.left.subarray(o, o + 480), signal.right.subarray(o, o + 480));
  }
  assert.ok(reading.rate < -0.9 && reading.rate > -1.1, `rate ${reading.rate}`);
});

test("offset shifts reported position", () => {
  const def = findTimecode("serato-2a")!;
  const signal = renderSignal(def, { seconds: 2, startBit: 10000 }, RATE);
  const transport = new DvsTransport(def, RATE, { offsetSeconds: 2 });
  let reading = transport.push(new Float32Array(480), new Float32Array(480));
  for (let o = 0; o < signal.left.length; o += 480) {
    reading = transport.push(signal.left.subarray(o, o + 480), signal.right.subarray(o, o + 480));
  }
  assert.ok(Math.abs(reading.positionSeconds - 14) < 0.4, `position ${reading.positionSeconds}`);
});

test("DvsTransport calibrates RMS gain and phase balance from stereo signal", () => {
  const def = findTimecode("serato-2a")!;
  const signal = renderSignal(def, { seconds: 1, startBit: 4000, gain: 0.175 }, RATE);
  const transport = new DvsTransport(def, RATE);
  const cal = transport.calibrate(signal.left, signal.right);
  assert.ok(cal.rms > 0.05 && cal.rms < 0.35, `rms ${cal.rms}`);
  assert.ok(cal.calibratedGain > 1.2 && cal.calibratedGain <= 8, `gain ${cal.calibratedGain}`);
  assert.ok(cal.phaseBalance > 0.5 && cal.phaseBalance <= 1.0, `phaseBalance ${cal.phaseBalance}`);
});

test("DvsTransport supports internal, relative, and absolute modes and continuous drift correction", () => {
  const def = findTimecode("serato-2a")!;
  const first = renderSignal(def, { seconds: 1.5, startBit: 4000 }, RATE);
  const second = renderSignal(def, { seconds: 1.5, startBit: 200000 }, RATE);
  const transport = new DvsTransport(def, RATE, { mode: "relative" });
  assert.equal(transport.mode, "relative");

  let reading = transport.push(new Float32Array(480), new Float32Array(480));
  for (let o = 0; o < first.left.length; o += 480) {
    reading = transport.push(first.left.subarray(o, o + 480), first.right.subarray(o, o + 480));
  }
  const posBeforeDrop = reading.positionSeconds;
  assert.equal(reading.status, "locked");

  // In relative mode, a needle drop adjusts relativeAnchor instead of emitting a jump
  for (let o = 0; o < second.left.length; o += 480) {
    reading = transport.push(second.left.subarray(o, o + 480), second.right.subarray(o, o + 480));
    assert.equal(reading.jump, null);
  }
  assert.ok(reading.positionSeconds > posBeforeDrop, `relative pos advanced smoothly: ${reading.positionSeconds}`);

  // Drift correction returns bounded proportional rate adjustment when slightly behind/ahead
  const corr = transport.computeDriftCorrection(reading.positionSeconds - 0.05);
  assert.ok(corr > 0 && corr <= 0.08, `drift correction ${corr}`);

  // Internal mode ignores timecode lock and reports 0 drift correction
  transport.setMode("internal");
  assert.equal(transport.getMode(), "internal");
  assert.equal(transport.computeDriftCorrection(0), 0);
  const internalReading = transport.push(second.left.subarray(0, 480), second.right.subarray(0, 480));
  assert.equal(internalReading.status, "idle");
});

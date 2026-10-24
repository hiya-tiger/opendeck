import test from "node:test";
import assert from "node:assert/strict";
import {
  BEAT_JUMP_STEPS,
  LOOP_ROLL_BEATS,
  PAD_MODE_IDS,
  PART_FX_PADS,
  PITCH_PLAY_SEMITONES,
  SequenceRecorder,
  beatJumpStep,
  cueLoopRange,
  isPadMode,
  loopRollBeats,
  pitchPlayRate,
  pitchPlaySemitones,
  rollingReleasePosition,
  sliceRange,
} from "../src/renderer/engine/pad-modes.ts";
import { SAMPLER_BANKS, SAMPLER_PADS, SAMPLER_SLOTS } from "../src/renderer/engine/sampler.ts";

test("ten pad modes are defined and validated", () => {
  assert.equal(PAD_MODE_IDS.length, 10);
  assert.equal(new Set(PAD_MODE_IDS).size, 10);
  assert.equal(isPadMode("slicer"), true);
  assert.equal(isPadMode("video"), false);
});

test("pad mode value tables clamp invalid indexes", () => {
  assert.equal(loopRollBeats(-2), LOOP_ROLL_BEATS[0]);
  assert.equal(loopRollBeats(99), LOOP_ROLL_BEATS[7]);
  assert.equal(beatJumpStep(99), BEAT_JUMP_STEPS[7]);
  assert.equal(pitchPlaySemitones(99), PITCH_PLAY_SEMITONES[7]);
  assert.ok(Math.abs(pitchPlayRate(0) - 2 ** (-7 / 12)) < 1e-12);
});

test("slicer divides the track into eight equal ranges", () => {
  assert.deepEqual(sliceRange(0, 64), { start: 0, end: 8 });
  assert.deepEqual(sliceRange(7, 64), { start: 56, end: 64 });
  assert.deepEqual(sliceRange(99, 64), { start: 56, end: 64 });
  assert.deepEqual(sliceRange(0, Number.NaN), { start: 0, end: 0 });
});

test("cue loop lasts four beats by default", () => {
  assert.deepEqual(cueLoopRange(10, 120), { start: 10, end: 12 });
  assert.deepEqual(cueLoopRange(-5, 120, 8), { start: 0, end: 4 });
});

test("rolling loop release advances by elapsed time at the playback rate", () => {
  assert.equal(rollingReleasePosition(10, 1000, 2500, 1, 100), 11.5);
  assert.equal(rollingReleasePosition(10, 1000, 2500, 0.5, 100), 10.75);
  assert.equal(rollingReleasePosition(99, 0, 1000, 1, 100), 99.98);
});

test("sequence recorder timestamps cue events and caps its length", () => {
  const recorder = new SequenceRecorder(3);
  assert.equal(recorder.record(0, 50), false);
  recorder.start(1000);
  assert.equal(recorder.recording, true);
  assert.equal(recorder.record(0, 1250), true);
  assert.equal(recorder.record(3, 2000), true);
  assert.equal(recorder.record(5, 2600), true);
  assert.equal(recorder.record(6, 2700), false);
  assert.deepEqual(recorder.stop(), [
    { atMs: 250, cue: 0 },
    { atMs: 1000, cue: 3 },
    { atMs: 1600, cue: 5 },
  ]);
  assert.equal(recorder.recording, false);
  assert.equal(recorder.length, 3);
  recorder.clear();
  assert.equal(recorder.length, 0);
});

test("sequence recorder stores pad actions, phases and loop duration", () => {
  const recorder = new SequenceRecorder(8);
  recorder.start(500);
  assert.equal(recorder.recordAction("loop-roll", 2, 650, "press"), true);
  assert.equal(recorder.recordAction("loop-roll", 2, 1150, "release"), true);
  assert.equal(recorder.recordAction("pitch-play", 4, 1400, "press", 4), true);
  assert.equal(recorder.recordAction("hot-cue", 9, 1500, "tap", 9), false);
  assert.deepEqual(recorder.list(), [
    { atMs: 150, mode: "loop-roll", index: 2, phase: "press" },
    { atMs: 650, mode: "loop-roll", index: 2, phase: "release" },
    { atMs: 900, mode: "pitch-play", index: 4, phase: "press", cue: 4 },
  ]);
  assert.equal(recorder.durationMs(), 900);
  assert.equal(recorder.stop().length, 3);
});

test("part FX exposes four filters and four mutes", () => {
  assert.equal(PART_FX_PADS.length, 8);
  assert.equal(PART_FX_PADS.filter((action) => action.startsWith("filter-")).length, 4);
  assert.equal(PART_FX_PADS.filter((action) => action.startsWith("mute-")).length, 4);
});

test("sampler exposes 32 slots across four banks", () => {
  assert.equal(SAMPLER_BANKS.length, 4);
  assert.equal(SAMPLER_PADS.length, 8);
  assert.equal(SAMPLER_SLOTS.length, 32);
  assert.equal(SAMPLER_SLOTS[0]!.slot, 0);
  assert.equal(SAMPLER_SLOTS[31]!.slot, 31);
  assert.equal(SAMPLER_SLOTS[8]!.bank, "B");
  assert.equal(SAMPLER_SLOTS[8]!.label, "B1 Kick");
});

import { censorReleasePosition, slipReleasePosition } from "../src/renderer/engine/pad-modes.ts";

test("slipReleasePosition and censorReleasePosition advance virtual timeline accurately", () => {
  // Slip (return-mode): 2 seconds elapsed at 1.25x rate from 10s -> 12.5s
  assert.ok(Math.abs(slipReleasePosition(10, 1000, 3000, 1.25, 180) - 12.5) < 1e-9);
  // Censor (reverse-on-hold): even when rate is passed negative, forward timeline advances by |rate| * elapsed
  assert.ok(Math.abs(censorReleasePosition(20, 500, 2000, -1.0, 180) - 21.5) < 1e-9);
  // Clamps to duration - 0.02
  assert.ok(Math.abs(censorReleasePosition(59, 0, 5000, 1.0, 60) - 59.98) < 1e-9);
});

import test from "node:test";
import assert from "node:assert/strict";
import { detectBpm, detectKey, peaks, analyzeBuffer, formatTime } from "../src/renderer/engine/analyze.ts";
import { beatIndexAt, beatJumpTarget, loopSeconds, wrapBeatPhase, formatBeatPosition } from "../src/renderer/engine/beatgrid.ts";
import { syncDeck, syncRate, tempoPercentLabel } from "../src/renderer/engine/sync.ts";
import { delaySeconds, divisionBeats, filterFrequency, crushCurve, fxDefault } from "../src/renderer/engine/fx.ts";
import { applyStemSolo, centerFocus, defaultStemGains, STEMS } from "../src/renderer/engine/stems.ts";
import { normaliseDegrees, pointerAngle, scratchPosition, scratchRate } from "../src/renderer/engine/scratch.ts";

const SR = 44100;

function clickTrack(bpm: number, seconds = 12, rate = SR): { sampleRate: number; length: number; numberOfChannels: number; duration: number; getChannelData: (c: number) => Float32Array } {
  const length = Math.floor(seconds * rate);
  const data = new Float32Array(length);
  const beat = 60 / bpm;
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  for (let t = 0; t < seconds; t += beat) {
    const start = Math.floor(t * rate);
    for (let i = 0; i < rate * 0.08 && start + i < length; i += 1) {
      const env = Math.exp(-i / (rate * 0.018));
      data[start + i] += Math.sin((2 * Math.PI * 65 * i) / rate) * env * 0.9 + rand() * env * 0.15;
    }
  }
  for (let i = 0; i < length; i += 1) data[i] += rand() * 0.002;
  return {
    sampleRate: rate,
    length,
    numberOfChannels: 1,
    duration: seconds,
    getChannelData: () => data,
  };
}

function chord(freqs: number[], seconds = 6): { sampleRate: number; length: number; numberOfChannels: number; duration: number; getChannelData: () => Float32Array } {
  const length = Math.floor(seconds * SR);
  const data = new Float32Array(length);
  for (const hz of freqs) {
    for (let i = 0; i < length; i += 1) data[i] += Math.sin((2 * Math.PI * hz * i) / SR) * 0.2;
  }
  return { sampleRate: SR, length, numberOfChannels: 1, duration: seconds, getChannelData: () => data };
}

test("BPM detection is within half a BPM on house, techno and drum & bass", () => {
  for (const bpm of [90, 120, 128, 140, 174]) {
    const result = detectBpm(clickTrack(bpm));
    assert.ok(Math.abs(result.bpm - bpm) < 0.6, `wanted ${bpm}, got ${result.bpm}`);
    assert.ok(result.confidence > 0.1, `confidence ${result.confidence} at ${bpm}`);
    assert.ok(result.beatPhase >= 0 && result.beatPhase < 60 / bpm + 0.01);
  }
});

test("BPM of silence is zero", () => {
  const silence = {
    sampleRate: SR,
    length: SR * 4,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(SR * 4),
  };
  assert.equal(detectBpm(silence).bpm, 0);
});

test("key detection finds C major and its camelot code", () => {
  const result = detectKey(chord([261.63, 329.63, 392.0]));
  assert.equal(result.key, "C maj");
  assert.equal(result.camelot, "8B");
  assert.equal(result.mode, "major");
});

test("peaks and analysis metadata", () => {
  const buffer = clickTrack(128, 4);
  const result = analyzeBuffer(buffer, 400);
  assert.equal(result.peaks.length, 400);
  assert.ok(result.peaks.some((value) => value > 0.1));
  assert.ok(Math.abs(result.duration - 4) < 0.01);
  assert.equal(formatTime(75.4), "1:15");
});

test("beat grid math", () => {
  assert.ok(Math.abs(beatIndexAt(2, 120) - 4) < 1e-9);
  assert.ok(Math.abs(loopSeconds(120, 4) - 2) < 1e-9);
  assert.ok(Math.abs(loopSeconds(174, 1 / 8) - 60 / 174 / 8) < 1e-9);
  assert.equal(beatJumpTarget(10, 120, 8, 30), 14);
  assert.equal(beatJumpTarget(1, 120, -8, 30), 0);
  assert.equal(beatJumpTarget(29, 120, 32, 30), 29.99);
  const phase = wrapBeatPhase(0.3, 120);
  assert.ok(Math.abs(phase - -0.2) < 1e-9);
  assert.match(formatBeatPosition(2, 120), /^2\.1\.1$/);
});

test("sync matches tempo and phase", () => {
  assert.ok(Math.abs(syncRate(128, 128) - 1) < 1e-9);
  assert.ok(Math.abs(syncRate(140, 128) - 1.09375) < 1e-9);
  assert.equal(syncRate(300, 100), 1.5);
  const result = syncDeck({
    masterBpm: 128,
    targetBpm: 124,
    masterPosition: 10,
    targetPosition: 10.31,
  });
  assert.ok(Math.abs(result.rate - 128 / 124) < 1e-9);
  assert.ok(result.phaseErrorSeconds < 0.24 && result.phaseErrorSeconds > -0.24);
  assert.ok(Math.abs(result.seekTo + result.phaseErrorSeconds - 10.31) < 1e-9);
  assert.equal(tempoPercentLabel(3.2), "+3.2%");
  assert.equal(tempoPercentLabel(-1.5), "-1.5%");
});

test("FX maths: beat divisions, filter sweep, crusher", () => {
  assert.equal(divisionBeats("1/4"), 1);
  assert.equal(divisionBeats("3/8"), 1.5);
  assert.ok(Math.abs(delaySeconds("1/4", 120) - 0.5) < 1e-9);
  assert.ok(Math.abs(delaySeconds("1/8", 174) - 60 / 174 / 2) < 1e-9);
  assert.ok(filterFrequency(1) > 15000);
  assert.ok(filterFrequency(-1) < 200);
  assert.ok(filterFrequency(0) > 500 && filterFrequency(0) < 2500);
  const curve = crushCurve(0.5);
  assert.equal(curve.length, 1024);
  assert.ok(curve[0] >= -1 && curve[curve.length - 1] <= 1);
  assert.equal(fxDefault("echo").division, "1/4");
});

test("stem splits and solo logic", () => {
  assert.equal(STEMS.length, 4);
  assert.deepEqual(centerFocus(0), { mid: 1, side: 1 });
  assert.deepEqual(centerFocus(1), { mid: 1, side: 0 });
  const gains = defaultStemGains();
  const soloed = applyStemSolo(gains, { low: false, lowmid: false, highmid: false, high: false }, "highmid");
  assert.equal(soloed.highmid, 1);
  assert.equal(soloed.low, 0);
  const muted = applyStemSolo(gains, { low: true, lowmid: false, highmid: false, high: false }, null);
  assert.equal(muted.low, 0);
  assert.equal(muted.high, 1);
});

test("scratch math wraps angles and clamps seeks", () => {
  assert.equal(normaliseDegrees(370), 10);
  assert.equal(normaliseDegrees(-190), 170);
  assert.ok(Math.abs(pointerAngle(1, 0, 0, 0)) < 1e-9);
  assert.ok(Math.abs(pointerAngle(0, 1, 0, 0) - 90) < 1e-9);
  assert.equal(scratchPosition(10, 90, 60), 10.45);
  assert.equal(scratchPosition(10, -3600, 60), 0);
  assert.equal(scratchPosition(59.99, 360, 60), 59.95);
  assert.equal(scratchPosition(10, 90, 0), 0);
});

test("scratch rate follows hand speed and direction", () => {
  assert.equal(scratchRate(0, 0.016), 0);
  assert.equal(scratchRate(360, 1), 1.8);
  assert.equal(scratchRate(180, 0.5), 1.8);
  assert.equal(scratchRate(-180, 0.5), -1.8);
  assert.ok(scratchRate(3600, 1 / 500) > 1);
  assert.equal(scratchRate(90, 0), 0);
  assert.equal(scratchRate(Number.NaN, 0.1), 0);
});

import {
  addWarpMarker,
  adjustBeatGridBpm,
  beatGridToMarkers,
  clearWarpMarkers,
  createBeatGrid,
  markersToBeatGrid,
  scaleBeatGridBpm,
  setBeatGridBpm,
  setBeatGridLock,
  setGridDownbeat,
  shiftBeatGrid,
  tapBeatGridBpm,
  toggleBeatGridLock,
} from "../src/renderer/engine/beatgrid.ts";
import {
  CustomFxStore,
  DEFAULT_CUSTOM_FX_PRESETS,
  FX_DEFS,
  tapeStopRate,
  tremoloRateHz,
} from "../src/renderer/engine/fx.ts";
import { channelFaderGain, crossfaderGains } from "../src/renderer/engine/mixer.ts";

test("BeatGrid editor operations mutate unlocked grids and are blocked when locked", () => {
  let grid = createBeatGrid(120, 0.1, false);
  assert.equal(grid.bpm, 120);
  assert.equal(grid.firstBeatSeconds, 0.1);
  assert.equal(grid.locked, false);

  grid = setGridDownbeat(grid, 0.25);
  assert.equal(grid.firstBeatSeconds, 0.25);
  grid = shiftBeatGrid(grid, 0.05);
  assert.ok(Math.abs(grid.firstBeatSeconds - 0.3) < 1e-6);
  grid = adjustBeatGridBpm(grid, 4);
  assert.equal(grid.bpm, 124);
  grid = scaleBeatGridBpm(grid, 0.5);
  assert.equal(grid.bpm, 62);
  grid = scaleBeatGridBpm(grid, 2);
  assert.equal(grid.bpm, 124);
  grid = addWarpMarker(grid, 2.5, 8);
  assert.equal(grid.markers.length, 2);

  // Lock prevents all mutations
  const locked = setBeatGridLock(grid, true);
  assert.equal(locked.locked, true);
  assert.equal(setGridDownbeat(locked, 1.0).firstBeatSeconds, locked.firstBeatSeconds);
  assert.equal(shiftBeatGrid(locked, 0.5).firstBeatSeconds, locked.firstBeatSeconds);
  assert.equal(setBeatGridBpm(locked, 140).bpm, 124);
  assert.equal(adjustBeatGridBpm(locked, 5).bpm, 124);
  assert.equal(scaleBeatGridBpm(locked, 2).bpm, 124);
  assert.equal(addWarpMarker(locked, 5.0).markers.length, 2);
  assert.equal(clearWarpMarkers(locked).markers.length, 2);

  const unlocked = toggleBeatGridLock(locked);
  assert.equal(unlocked.locked, false);
  const cleared = clearWarpMarkers(unlocked);
  assert.equal(cleared.markers.length, 1);
  const roundTrip = markersToBeatGrid(beatGridToMarkers(cleared), 120, 0, true);
  assert.equal(roundTrip.bpm, 124);
  assert.equal(roundTrip.locked, true);
  assert.equal(tapBeatGridBpm([0, 500, 1000, 1500]), 120);
});

test("Expanded FX definitions and CustomFxStore save, update, remove, and serialize multi-slot chains", () => {
  assert.ok(FX_DEFS.length >= 14);
  assert.ok(FX_DEFS.some((f) => f.id === "tremolo"));
  assert.ok(FX_DEFS.some((f) => f.id === "gate"));
  assert.ok(FX_DEFS.some((f) => f.id === "tape-stop"));
  assert.ok(FX_DEFS.some((f) => f.id === "combo-filter-echo"));
  assert.equal(tremoloRateHz("1/4", 120), 2);
  assert.ok(tapeStopRate(0) > tapeStopRate(0.8));

  const store = new CustomFxStore();
  assert.equal(store.list().length, DEFAULT_CUSTOM_FX_PRESETS.length);
  const saved = store.save("My Riser Chain", [
    { type: "filter", division: "1/4", amount: 0.7, wet: 0.9, enabled: true },
    { type: "echo", division: "1/8", amount: 0.5, wet: 0.6, enabled: true },
  ]);
  assert.equal(saved.id, "my-riser-chain");
  assert.equal(store.get("my-riser-chain")?.slots.length, 2);

  const clone = CustomFxStore.fromJSON(store.toJSON());
  assert.equal(clone.get("my-riser-chain")?.name, "My Riser Chain");
  assert.equal(store.remove("my-riser-chain"), true);
  assert.equal(store.get("my-riser-chain"), undefined);
});

test("4-deck crossfader gains, crossfader reverse (hamster), and channel fader curves", () => {
  const normalLeft = crossfaderGains(0, "smooth", false);
  assert.ok(normalLeft.a > 0.99 && normalLeft.c > 0.99);
  assert.ok(normalLeft.b < 0.01 && normalLeft.d < 0.01);

  const reversedLeft = crossfaderGains(0, "smooth", true);
  assert.ok(reversedLeft.a < 0.01 && reversedLeft.c < 0.01);
  assert.ok(reversedLeft.b > 0.99 && reversedLeft.d > 0.99);

  assert.equal(channelFaderGain(0.5, "linear"), 0.5);
  assert.ok(channelFaderGain(0.5, "log") < 0.5);
  assert.ok(channelFaderGain(0.5, "sharp") > 0.5);
});

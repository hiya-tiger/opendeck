import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_FRAME_COUNT,
  MODEL_OVERLAP,
  MODEL_SAMPLE_RATE,
  MODEL_STRIDE,
  PARTS,
  STEM_MODEL,
  cacheDirName,
  defaultPartMix,
  fromInt16,
  partGains,
  partLabel,
  planChunks,
  toInt16,
  transitionWindow,
  vocalsOnly,
} from "../src/renderer/engine/parts.ts";

test("PARTS lists the four true parts in model row order", () => {
  assert.deepEqual(PARTS.map((part) => part.id), ["drums", "bass", "other", "vocals"]);
  for (const part of PARTS) {
    assert.ok(part.label.length > 0);
    assert.ok(part.short.length > 0);
    assert.ok(part.color.length > 0);
    assert.match(part.color, /^#[0-9A-F]{6}$/i);
  }
});

test("partLabel returns labels and rejects unknown ids", () => {
  assert.equal(partLabel("drums"), PARTS[0].label);
  assert.equal(partLabel("vocals"), "Vocals");
  assert.throws(() => partLabel("karaoke" as never));
});

test("defaultPartMix is a fresh full mix each call", () => {
  const mix = defaultPartMix();
  for (const part of PARTS) {
    assert.equal(mix.gain[part.id], 1);
    assert.equal(mix.muted[part.id], false);
  }
  assert.equal(mix.solo, null);
  const copy = defaultPartMix();
  copy.gain.drums = 0.5;
  copy.muted.vocals = true;
  assert.equal(mix.gain.drums, 1);
});

test("partGains applies mute", () => {
  const mix = defaultPartMix();
  mix.muted.bass = true;
  mix.gain.drums = 0.25;
  const gains = partGains(mix);
  assert.deepEqual(gains, { drums: 0.25, bass: 0, other: 1, vocals: 1 });
});

test("partGains solo wins and silences other parts", () => {
  const mix = defaultPartMix();
  mix.solo = "vocals";
  mix.muted.bass = true;
  const gains = partGains(mix);
  assert.deepEqual(gains, { drums: 0, bass: 0, other: 0, vocals: 1 });
  const mutedSolo = defaultPartMix();
  mutedSolo.solo = "drums";
  mutedSolo.muted.drums = true;
  assert.deepEqual(partGains(mutedSolo), { drums: 0, bass: 0, other: 0, vocals: 0 });
  const scaled = defaultPartMix();
  scaled.solo = "bass";
  scaled.gain.bass = 0.5;
  assert.deepEqual(partGains(scaled), { drums: 0, bass: 0.5, other: 0, vocals: 0 });
});

test("vocalsOnly toggles isolation mixing", () => {
  const on = vocalsOnly(true);
  assert.deepEqual(partGains(on), { drums: 0, bass: 0, other: 0, vocals: 1 });
  assert.deepEqual(on.muted, { drums: true, bass: true, other: true, vocals: false });
  const off = vocalsOnly(false);
  assert.deepEqual(partGains(off), { drums: 1, bass: 1, other: 1, vocals: 1 });
  assert.deepEqual(off.muted, { drums: false, bass: false, other: false, vocals: false });
});

test("STEM_MODEL and frame constants are wired correctly", () => {
  assert.equal(STEM_MODEL.id, "htdemucs-fp16weights");
  assert.equal(STEM_MODEL.version, "1");
  assert.equal(STEM_MODEL.filename, "htdemucs_fp16weights.onnx");
  assert.equal(STEM_MODEL.bytes, 165612636);
  assert.match(STEM_MODEL.sha256, /^[0-9a-f]{64}$/);
  assert.equal(MODEL_SAMPLE_RATE, 44100);
  assert.equal(MODEL_FRAME_COUNT, 343980);
  assert.equal(MODEL_OVERLAP, Math.floor(343980 / 4));
  assert.equal(MODEL_STRIDE, MODEL_FRAME_COUNT - MODEL_OVERLAP);
});

test("planChunks covers the whole input exactly", () => {
  assert.deepEqual(planChunks(0), []);
  assert.deepEqual(planChunks(-5), []);
  const single = planChunks(MODEL_FRAME_COUNT);
  assert.deepEqual(single, [
    { index: 0, start: 0, length: MODEL_FRAME_COUNT },
    { index: 1, start: MODEL_STRIDE, length: MODEL_FRAME_COUNT - MODEL_STRIDE },
  ]);
  assert.equal(MODEL_FRAME_COUNT - MODEL_STRIDE, MODEL_OVERLAP);
  const short = planChunks(1000);
  assert.deepEqual(short, [{ index: 0, start: 0, length: 1000 }]);
  const exact = planChunks(MODEL_STRIDE + MODEL_FRAME_COUNT);
  assert.equal(exact.length, 3);
  assert.deepEqual(exact[0], { index: 0, start: 0, length: MODEL_FRAME_COUNT });
  assert.deepEqual(exact[1], { index: 1, start: MODEL_STRIDE, length: MODEL_FRAME_COUNT });
  assert.deepEqual(exact[2], { index: 2, start: MODEL_STRIDE * 2, length: MODEL_STRIDE + MODEL_FRAME_COUNT - MODEL_STRIDE * 2 });
  const remainder = planChunks(MODEL_STRIDE * 3 + 77);
  assert.equal(remainder.length, 4);
  assert.deepEqual(remainder[3], { index: 3, start: MODEL_STRIDE * 3, length: 77 });
  for (const total of [1, MODEL_OVERLAP + 1, MODEL_STRIDE, MODEL_STRIDE * 2 + MODEL_OVERLAP]) {
    const chunks = planChunks(total);
    assert.ok(chunks.length >= 1);
    let previousEnd = 0;
    for (const [position, chunk] of chunks.entries()) {
      assert.equal(chunk.start, position * MODEL_STRIDE);
      assert.equal(chunk.length, Math.min(MODEL_FRAME_COUNT, total - chunk.start));
      previousEnd = chunk.start + chunk.length;
      assert.equal(chunk.index, position);
    }
    assert.equal(previousEnd, total, "the last chunk reaches the end of the input");
  }
});

test("transitionWindow has linear ramps and a full middle", () => {
  const window = transitionWindow(10, 2);
  assert.equal(window.length, 10);
  assert.equal(window[0], 0);
  assert.ok(Math.abs(window[1] - 0.5) < 1e-6);
  assert.equal(window[6], 1);
  assert.equal(window[7], 1);
  assert.ok(Math.abs(window[8] - 0.5) < 1e-6);
  assert.equal(window[9], 0);
  const odd = transitionWindow(7, 3);
  assert.equal(odd[0], 0);
  assert.ok(Math.abs(odd[1] - 1 / 3) < 1e-6);
  assert.ok(Math.abs(odd[2] - 2 / 3) < 1e-6);
  assert.ok(Math.abs(odd[3] - 1) < 1e-6);
  assert.ok(Math.abs(odd[4] - 2 / 3) < 1e-6);
  assert.ok(Math.abs(odd[5] - 1 / 3) < 1e-6);
  assert.equal(odd[6], 0);
  const minimal = transitionWindow(4, 2);
  assert.deepEqual([...minimal], [0, 0.5, 0.5, 0]);
  const flat = transitionWindow(5, 0);
  assert.deepEqual([...flat], [1, 1, 1, 1, 1]);
  const big = transitionWindow(MODEL_FRAME_COUNT, MODEL_OVERLAP);
  assert.equal(big.length, MODEL_FRAME_COUNT);
  assert.equal(big[Math.floor(MODEL_FRAME_COUNT / 2)], 1);
  assert.throws(() => transitionWindow(3, 2), /overlap/);
  assert.throws(() => transitionWindow(0, 0), /length/);
});

test("toInt16 clamps and scales; fromInt16 divides; round trip is close", () => {
  const data = new Float32Array([-1.5, -1, -0.5, 0, 0.5, 1, 1.5]);
  const quantized = toInt16(data);
  assert.deepEqual([...quantized], [-32767, -32767, -16383, 0, 16384, 32767, 32767]);
  const restored = fromInt16(quantized);
  assert.equal(restored[0], -32767 / 32768);
  assert.equal(restored[3], 0);
  assert.equal(restored[5], 32767 / 32768);
  const roundtrip = fromInt16(toInt16(new Float32Array([0.1234, -0.9876])));
  assert.ok(Math.abs(roundtrip[0] - 0.1234) < 2 / 32768 + 1e-9);
  assert.ok(Math.abs(roundtrip[1] + 0.9876) < 2 / 32768 + 1e-9);
  assert.equal(fromInt16(new Int16Array([-32768]))[0], -1);
  assert.equal(fromInt16(new Int16Array([32767]))[0], 32767 / 32768);
});

test("cacheDirName sanitises unsafe characters deterministically", () => {
  const name = cacheDirName("d05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a", "1");
  assert.equal(name, "d05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a-1");
  assert.equal(cacheDirName("ABCdef123", "v2.0"), "ABCdef123-v2.0");
  const slashed = cacheDirName("hash with/slash:and*stars", "1");
  assert.match(slashed, /^hash-with-slash-and-stars-1$/);
  assert.equal(cacheDirName("dup", "1"), cacheDirName("dup", "1"));
  assert.doesNotMatch(slashed, /[^\w.\-]/);
  assert.throws(() => cacheDirName("///", "1"));
  assert.throws(() => cacheDirName("ok", "***"));
  const long = cacheDirName("a".repeat(500), "1");
  assert.ok(long.length <= 257);
});

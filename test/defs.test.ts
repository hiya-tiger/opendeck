import test from "node:test";
import assert from "node:assert/strict";
import { TIMECODES, detectTimecode } from "../src/timecode/defs.ts";

test("carrier frequencies are distinct and sane", () => {
  const carriers = new Set(TIMECODES.map((t) => t.carrierHz));
  assert.ok(carriers.size >= 3);
  for (const t of TIMECODES) {
    assert.ok(t.carrierHz >= 500 && t.carrierHz <= 4000, t.id);
    assert.ok(t.length / t.carrierHz > 500, t.id);
    assert.equal(t.seconds, t.length / t.carrierHz);
    assert.ok(t.safeLength < t.length);
  }
});

test("detectTimecode narrows by carrier", () => {
  const kHz1 = detectTimecode(1000).map((t) => t.carrierHz);
  assert.ok(kHz1.every((hz) => hz === 1000));
  assert.ok(detectTimecode(2000).some((t) => t.id === "traktor-a"));
});

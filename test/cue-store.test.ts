import test from "node:test";
import assert from "node:assert/strict";
import {
  addSavedLoop,
  cycleCueColor,
  normaliseCues,
  normaliseLoops,
  removeSavedLoop,
  type SavedLoop,
} from "../src/renderer/media/cue-store.ts";
import { CUE_PALETTE, LOOP_COLOR } from "../src/renderer/media/serato-tags.ts";

const defaults = CUE_PALETTE.slice(0, 8);

function loop(id: string, start: number, end: number): SavedLoop {
  return { id, start, end, name: id, color: LOOP_COLOR, locked: false };
}

test("normaliseCues accepts legacy numeric entries", () => {
  const cues = normaliseCues([1.5, null, 3], defaults);
  assert.equal(cues.length, 8);
  assert.deepEqual(cues[0], { time: 1.5, color: defaults[0], name: "" });
  assert.equal(cues[1], null);
  assert.equal(cues[2]?.time, 3);
  assert.equal(cues[7], null);
});

test("normaliseCues keeps names, colours and replaces invalid colours", () => {
  const cues = normaliseCues(
    [{ time: 2, color: "#cc0000", name: "  Intro  " }, { time: 4, color: "#123456", name: 7 }],
    defaults,
  );
  assert.deepEqual(cues[0], { time: 2, color: "#CC0000", name: "Intro" });
  assert.deepEqual(cues[1], { time: 4, color: defaults[1], name: "" });
});

test("normaliseCues rejects malformed entries", () => {
  const cues = normaliseCues([{ time: Number.NaN }, { time: "2" }, -1, 0], defaults);
  assert.equal(cues[0], null);
  assert.equal(cues[1], null);
  assert.equal(cues[2]?.time, 0);
  assert.equal(cues[3]?.time, 0);
});

test("cycleCueColor wraps through the eighteen-colour palette", () => {
  assert.equal(cycleCueColor(CUE_PALETTE[0]), CUE_PALETTE[1]);
  assert.equal(cycleCueColor(CUE_PALETTE[CUE_PALETTE.length - 1]), CUE_PALETTE[0]);
  assert.equal(cycleCueColor("#ffffff"), CUE_PALETTE[0]);
});

test("normaliseLoops filters invalid ranges and caps at eight", () => {
  const raw = Array.from({ length: 12 }, (_, index) => ({
    id: `l${index}`,
    start: index,
    end: index + 1,
    name: `Loop ${index}`,
    color: LOOP_COLOR,
    locked: index % 2 === 0,
  }));
  raw.push({ id: "bad", start: 5, end: 5 });
  const loops = normaliseLoops(raw);
  assert.equal(loops.length, 8);
  assert.equal(loops[0].id, "l0");
  assert.equal(loops[7].id, "l7");
  assert.equal(loops[0].locked, true);
});

test("addSavedLoop ignores duplicate ranges and keeps the newest eight", () => {
  let loops: SavedLoop[] = [];
  for (let index = 0; index < 9; index += 1) loops = addSavedLoop(loops, loop(`l${index}`, index, index + 1));
  assert.equal(loops.length, 8);
  assert.equal(loops[0].id, "l1");
  assert.equal(addSavedLoop(loops, loop("copy", 5, 6)).length, 8);
});

test("removeSavedLoop removes only the requested entry", () => {
  const loops = [loop("a", 1, 2), loop("b", 2, 3)];
  assert.deepEqual(removeSavedLoop(loops, "a").map((item) => item.id), ["b"]);
  assert.equal(removeSavedLoop(loops, "missing").length, 2);
});

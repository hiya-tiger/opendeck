import test from "node:test";
import assert from "node:assert/strict";
import {
  bindingFor,
  defaultPadIndex,
  describeMidiEvent,
  loadBindings,
  mapControlValue,
  matchesBinding,
  parseMidiMessage,
  saveBindings,
} from "../src/renderer/midi/midi.ts";
import { SAMPLER_PADS } from "../src/renderer/engine/sampler.ts";

test("midi messages parse status, channel and normalised values", () => {
  assert.deepEqual(parseMidiMessage([0x90, 36, 100]), {
    type: "noteon",
    channel: 1,
    note: 36,
    velocity: 100,
    normalized: 100 / 127,
  });
  assert.deepEqual(parseMidiMessage([0x91, 38, 0]), {
    type: "noteoff",
    channel: 2,
    note: 38,
    velocity: 0,
    normalized: 0,
  });
  assert.deepEqual(parseMidiMessage([0x82, 36, 64]), {
    type: "noteoff",
    channel: 3,
    note: 36,
    velocity: 64,
    normalized: 0,
  });
  const cc = parseMidiMessage([0xb5, 74, 127]);
  assert.equal(cc?.type, "cc");
  assert.ok(cc && cc.type === "cc");
  assert.equal(cc.controller, 74);
  assert.equal(cc.channel, 6);
  assert.equal(cc.normalized, 1);
  assert.equal(parseMidiMessage([0xf8]), null);
  assert.equal(parseMidiMessage([0x90]), null);
  assert.equal(parseMidiMessage([]), null);
});

test("bindings match the same message and channel only", () => {
  const cc = bindingFor({ type: "cc", channel: 1, controller: 7, value: 50, normalized: 0.4 });
  assert.deepEqual(cc, { message: "cc", number: 7, channel: 1 });
  assert.equal(
    matchesBinding(cc, { type: "cc", channel: 1, controller: 7, value: 0, normalized: 0 }),
    true,
  );
  assert.equal(
    matchesBinding(cc, { type: "cc", channel: 2, controller: 7, value: 0, normalized: 0 }),
    false,
  );
  assert.equal(
    matchesBinding(cc, { type: "noteon", channel: 1, note: 7, velocity: 1, normalized: 1 }),
    false,
  );
  const note = bindingFor({ type: "noteon", channel: 4, note: 40, velocity: 90, normalized: 0.7 });
  assert.equal(
    matchesBinding(note, { type: "noteon", channel: 4, note: 40, velocity: 1, normalized: 1 }),
    true,
  );
});

test("control values map into the element range and notes latch", () => {
  const cc = { message: "cc" as const, number: 7, channel: null };
  assert.equal(mapControlValue(cc, 0, 0, 1), 0);
  assert.equal(mapControlValue(cc, 0.5, 0, 1), 0.5);
  assert.equal(mapControlValue(cc, 1, -50, 50), 50);
  assert.equal(mapControlValue(cc, 0.25, -50, 50), -25);
  const note = { message: "note" as const, number: 36, channel: null };
  assert.equal(mapControlValue(note, 0.2, 0, 1), 0);
  assert.equal(mapControlValue(note, 0.9, 0, 1), 1);
});

test("bindings persist and malformed entries are dropped", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  } as unknown as Storage;

  assert.deepEqual(loadBindings(storage), {});
  saveBindings(storage, {
    "mix.crossfader": { message: "cc", number: 1, channel: 1 },
    "A.pad1": { message: "note", number: 36, channel: null },
  });
  assert.deepEqual(loadBindings(storage), {
    "mix.crossfader": { message: "cc", number: 1, channel: 1 },
    "A.pad1": { message: "note", number: 36, channel: null },
  });

  store.set("opendeck.midi.map.v1", "{bad json");
  assert.deepEqual(loadBindings(storage), {});
  store.set(
    "opendeck.midi.map.v1",
    JSON.stringify({ good: { message: "cc", number: 4, channel: 2 }, bad: { message: "x", number: 4 } }),
  );
  assert.deepEqual(loadBindings(storage), {
    good: { message: "cc", number: 4, channel: 2 },
  });
});

test("generic drum notes map to sampler pads and events describe themselves", () => {
  assert.equal(defaultPadIndex(36), 0);
  assert.equal(defaultPadIndex(43), 7);
  assert.equal(defaultPadIndex(35), null);
  assert.equal(defaultPadIndex(44), null);
  assert.equal(
    describeMidiEvent({ type: "noteon", channel: 2, note: 38, velocity: 99, normalized: 99 / 127 }),
    "ch2 note 38 vel 99",
  );
  assert.equal(
    describeMidiEvent({ type: "cc", channel: 1, controller: 74, value: 64, normalized: 0.5 }),
    "ch1 CC74 64",
  );
});

test("sampler bank has eight labelled pads", () => {
  assert.equal(SAMPLER_PADS.length, 8);
  assert.deepEqual(
    SAMPLER_PADS.map((pad) => pad.label),
    ["Kick", "Snare", "Clap", "Hat", "Open", "Tom", "Rim", "Crash"],
  );
});

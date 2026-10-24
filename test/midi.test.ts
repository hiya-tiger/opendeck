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
  type MidiBindings,
} from "../src/renderer/midi/midi.ts";
import { applyProfile, DEVICE_PROFILES, profileForDevice } from "../src/renderer/midi/profiles.ts";
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

test("controller presets match device names", () => {
  assert.equal(profileForDevice("Hercules DJControl T10")?.id, "hercules-djcontrol-t10");
  assert.equal(profileForDevice("DJControl T10 MIDI")?.id, "hercules-djcontrol-t10");
  assert.equal(profileForDevice("Numark Party Mix III")?.id, "numark-party-mix-iii");
  assert.equal(profileForDevice("Numark Party Mix 3")?.id, "numark-party-mix-iii");
  assert.equal(profileForDevice("Numark Party Mix")?.id, "numark-party-mix-iii");
  assert.equal(profileForDevice("Akai MPK Mini"), null);
  assert.equal(profileForDevice(null), null);
});

test("DJControl T10 preset uses the documented channels and notes", () => {
  const profile = DEVICE_PROFILES.find((item) => item.id === "hercules-djcontrol-t10");
  assert.ok(profile);
  assert.deepEqual(profile.bindings["A.play"], { message: "note", number: 7, channel: 2 });
  assert.deepEqual(profile.bindings["A.cue"], { message: "note", number: 6, channel: 2 });
  assert.deepEqual(profile.bindings["B.play"], { message: "note", number: 7, channel: 3 });
  assert.deepEqual(profile.bindings["A.pad1"], { message: "note", number: 0, channel: 7 });
  assert.deepEqual(profile.bindings["B.pad8"], { message: "note", number: 7, channel: 8 });
  assert.deepEqual(profile.bindings["A.loop"], { message: "note", number: 11, channel: 2 });
  assert.deepEqual(profile.bindings["mix.crossfader"], { message: "cc", number: 0, channel: 1 });
  assert.deepEqual(profile.bindings["mix.chA"], { message: "cc", number: 0, channel: 2 });
  assert.deepEqual(profile.bindings["smp.1"], { message: "note", number: 48, channel: 7 });
  assert.deepEqual(profile.bindings["A.eqMid"], { message: "cc", number: 3, channel: 2 });
});

test("Party Mix III preset uses channel 16 for the mixer and separate pad channels", () => {
  const profile = DEVICE_PROFILES.find((item) => item.id === "numark-party-mix-iii");
  assert.ok(profile);
  assert.deepEqual(profile.bindings["A.play"], { message: "note", number: 0, channel: 1 });
  assert.deepEqual(profile.bindings["B.cue"], { message: "note", number: 1, channel: 2 });
  assert.deepEqual(profile.bindings["A.pad1"], { message: "note", number: 20, channel: 5 });
  assert.deepEqual(profile.bindings["B.pad4"], { message: "note", number: 23, channel: 6 });
  assert.deepEqual(profile.bindings["mix.crossfader"], { message: "cc", number: 8, channel: 16 });
  assert.deepEqual(profile.bindings["mix.master"], { message: "cc", number: 10, channel: 16 });
  assert.deepEqual(profile.bindings["mix.chA"], { message: "cc", number: 22, channel: 1 });
  assert.equal(profile.bindings["A.loop"], undefined);
});

test("preset merge keeps learned bindings and only fills empty targets", () => {
  const profile = DEVICE_PROFILES.find((item) => item.id === "hercules-djcontrol-t10");
  assert.ok(profile);
  const learned = { message: "note" as const, number: 99, channel: 4 };
  const bindings: MidiBindings = { "A.play": learned };
  const applied = applyProfile(bindings, profile);
  assert.deepEqual(bindings["A.play"], learned);
  assert.ok(applied.includes("A.cue"));
  assert.ok(!applied.includes("A.play"));
  assert.equal(applied.length, Object.keys(profile.bindings).length - 1);
  assert.deepEqual(applyProfile(bindings, profile), []);
});

test("sampler bank has eight labelled pads", () => {
  assert.equal(SAMPLER_PADS.length, 8);
  assert.deepEqual(
    SAMPLER_PADS.map((pad) => pad.label),
    ["Kick", "Snare", "Clap", "Hat", "Open", "Tom", "Rim", "Crash"],
  );
});

import { describe } from "node:test";
import {
  HARDWARE_CATALOGUE,
  lookupHardwareDevice,
  normalizeHardwareName,
  SUPPORTED_HARDWARE_RAW,
} from "../src/renderer/midi/profiles.ts";

describe("195-device hardware catalogue & profile matching", () => {
  test("catalogue contains all 195 supported hardware models and matches every raw and stripped line", () => {
    assert.equal(SUPPORTED_HARDWARE_RAW.length, 195);
    assert.equal(HARDWARE_CATALOGUE.length, 195);

    for (const rawLine of SUPPORTED_HARDWARE_RAW) {
      const stripped = normalizeHardwareName(rawLine);
      const byRaw = profileForDevice(rawLine);
      const byStripped = profileForDevice(stripped);
      const catalogueEntry = lookupHardwareDevice(rawLine);

      assert.ok(byRaw, `Expected profileForDevice to match raw line: "${rawLine}"`);
      assert.ok(byStripped, `Expected profileForDevice to match stripped line: "${stripped}"`);
      assert.equal(byRaw.id, byStripped.id, `Expected raw and stripped to match same profile for "${rawLine}"`);
      assert.ok(catalogueEntry, `Expected lookupHardwareDevice to find "${rawLine}"`);
    }
  });

  test("short USB descriptors and hyphen/space variations resolve to expected profiles", () => {
    const cases: [string, string][] = [
      ["DDJ-FLX10", "pioneer-dj-ddj-flx10"],
      ["DJM-S11", "pioneer-dj-djm-s11"],
      ["CDJ-3000X", "alphatheta-cdj-3000x"],
      ["CDJ-3000", "pioneer-dj-cdj-3000"],
      ["XDJ-AZ", "alphatheta-xdj-az"],
      ["SC6000 PRIME", "denon-dj-sc6000-prime"],
      ["SC6000M PRIME", "denon-dj-sc6000m-prime"],
      ["Kontrol S3", "native-instruments-traktor-kontrol-s3"],
      ["Kontrol Z2", "native-instruments-traktor-kontrol-z2"],
      ["Xone:DB4", "allen-and-heath-xone-db4"],
      ["Xone:43C", "allen-and-heath-xone-43c"],
      ["Flux Go", "reloop-flux-go"],
      ["Reloop Flux", "reloop-flux"],
      ["SL4", "rane-sl4"],
      ["SP-404MKII", "roland-sp-404mkii"],
      ["DJControl Inpulse 500", "hercules-djcontrol-inpulse-500"],
      ["DDJ SB3", "pioneer-dj-ddj-sb3"],
      ["DDJ-SB3", "pioneer-dj-ddj-sb3"],
      ["DDJ-SB", "pioneer-dj-ddj-sb"],
      ["RP8000 MK2", "reloop-rp8000-mk2"],
      ["RP-8000 MK2", "reloop-rp8000-mk2"],
      ["RP-8000", "reloop-rp-8000"],
      ["Numark Party Mix II", "numark-party-mix-ii"],
      ["Numark Party Mix Live", "numark-party-mix-live"],
      ["Numark Party Mix Pro", "numark-party-mix-pro"],
      ["Numark Party Mix", "numark-party-mix-iii"],
    ];

    for (const [descriptor, expectedId] of cases) {
      const profile = profileForDevice(descriptor);
      assert.equal(profile?.id, expectedId, `Descriptor "${descriptor}" should resolve to "${expectedId}"`);
    }
    assert.equal(profileForDevice("Akai MPK Mini"), null);
  });

  test("all 15 trailing-dot club mixers are flagged with dvsReady and dvsUpgrade", () => {
    const upgradeLines = SUPPORTED_HARDWARE_RAW.filter((line) => /\.\s*$/.test(line));
    assert.equal(upgradeLines.length, 15);
    for (const rawLine of upgradeLines) {
      const profile = profileForDevice(rawLine);
      assert.ok(profile, `Expected profile for "${rawLine}"`);
      assert.equal(profile.category, "mixer-dvs");
      assert.equal(profile.dvsReady, true, `Expected dvsReady=true for "${rawLine}"`);
      assert.equal(profile.dvsUpgrade, true, `Expected dvsUpgrade=true for "${rawLine}"`);
    }
  });

  test("all 6 DVS audio interfaces have category dvs-interface and dvsReady true", () => {
    const interfaces = [
      "Reloop Flux",
      "Reloop Flux Go",
      "Denon DJ DS1",
      "Rane SL2",
      "Rane SL3",
      "Rane SL4",
    ];
    for (const name of interfaces) {
      const profile = profileForDevice(name);
      assert.ok(profile, `Expected profile for DVS interface "${name}"`);
      assert.equal(profile.category, "dvs-interface", `Expected category="dvs-interface" for "${name}"`);
      assert.equal(profile.dvsReady, true, `Expected dvsReady=true for "${name}"`);
    }
  });

  test("4-deck controllers have decks=4 and include Deck C/D and mix.chC/chD bindings", () => {
    const fourDeckControllers = [
      "Pioneer DJ DDJ-FLX10",
      "RANE FOUR",
      "AlphaTheta XDJ-AZ",
      "Denon DJ PRIME 4+",
      "Reloop Mixon 8 Pro",
      "Native Instruments Traktor Kontrol S3",
    ];
    for (const name of fourDeckControllers) {
      const profile = profileForDevice(name);
      assert.ok(profile, `Expected profile for 4-deck controller "${name}"`);
      assert.equal(profile.decks, 4, `Expected decks=4 for "${name}"`);
      assert.ok(profile.bindings["C.play"], `Expected C.play binding on "${name}"`);
      assert.ok(profile.bindings["D.play"], `Expected D.play binding on "${name}"`);
      assert.ok(profile.bindings["mix.chC"], `Expected mix.chC binding on "${name}"`);
      assert.ok(profile.bindings["mix.chD"], `Expected mix.chD binding on "${name}"`);
    }
  });
});

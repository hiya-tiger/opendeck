import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SLAB_ENCODER_ASSIGN,
  SLAB_PAD_PAGE1_NOTES,
  SlabController,
  SlabDecoder,
  isSlabPort,
  provisionalColorNumber,
  slabFilterAmount,
  slabPadFromNote,
  slabPadNote,
  slabRelative,
  type SlabDeck,
  type SlabHost,
} from "../src/renderer/midi/slab.ts";
import { HARDWARE_CATALOGUE, profileForDevice } from "../src/renderer/midi/profiles.ts";

/**
 * Messages copied from AlphaTheta's "SLAB List of MIDI Messages" (status, data1).
 * Each entry: [figure id, bytes, expected decoded event (partial)].
 */
const OFFICIAL: [string, number[], Record<string, unknown>][] = [
  ["Tr1 UNDO", [0x90, 0x51, 0x7f], { kind: "button", name: "undo", shift: false }],
  ["Tr1 UNDO+SHIFT", [0x90, 0x50, 0x7f], { kind: "button", name: "undo", shift: true }],
  ["Tr3 <-", [0x90, 0x64, 0x7f], { kind: "button", name: "left", shift: false }],
  ["Tr4 -> +SHIFT", [0x90, 0x61, 0x7f], { kind: "button", name: "right", shift: true }],
  ["Tr5 dial CW", [0xb0, 0x3c, 0x01], { kind: "dial", delta: 1, shift: false }],
  ["Tr5 dial CCW", [0xb0, 0x3c, 0x41], { kind: "dial", delta: -1, shift: false }],
  ["Tr5 dial +SHIFT", [0xb0, 0x3d, 0x01], { kind: "dial", delta: 1, shift: true }],
  ["Tr5 dial press", [0x90, 0x62, 0x7f], { kind: "dial-press", pressed: true, shift: false }],
  ["Tr5 dial press+SHIFT", [0x90, 0x63, 0x7f], { kind: "dial-press", pressed: true, shift: true }],
  ["Tr8 SHIFT", [0x90, 0x46, 0x7f], { kind: "button", name: "shift" }],
  ["Tr9 REC", [0x90, 0x5f, 0x7f], { kind: "button", name: "rec", shift: false }],
  ["Tr9 REC+SHIFT", [0x90, 0x5b, 0x7f], { kind: "button", name: "rec", shift: true }],
  ["Tr10 PLAY", [0x90, 0x5e, 0x7f], { kind: "button", name: "play", shift: false }],
  ["Tr10 PLAY+SHIFT", [0x90, 0x5c, 0x7f], { kind: "button", name: "play", shift: true }],
  ["E1 ENCODER MODE (status 96)", [0x96, 0x10, 0x7f], { kind: "button", name: "encoder-mode", shift: false }],
  ["E1 ENCODER MODE (channel 1)", [0x90, 0x10, 0x7f], { kind: "button", name: "encoder-mode", shift: false }],
  ["E2 encoder 1 CW", [0xb0, 0x10, 0x01], { kind: "encoder", index: 0, delta: 1, shift: false }],
  ["E5 encoder 4 CCW+SHIFT", [0xb0, 0x17, 0x41], { kind: "encoder", index: 3, delta: -1, shift: true }],
  ["E3 encoder 2 touch", [0x90, 0x19, 0x7f], { kind: "encoder-touch", index: 1, touched: true }],
  ["E4 encoder 3 press", [0x90, 0x22, 0x7f], { kind: "encoder-press", index: 2, pressed: true, shift: false }],
  ["E4 encoder 3 press+SHIFT", [0x90, 0x26, 0x7f], { kind: "encoder-press", index: 2, pressed: true, shift: true }],
  ["To1 STRIP MODE", [0x96, 0x40, 0x7f], { kind: "button", name: "strip-mode" }],
  ["To2 mode 1 touch", [0x96, 0x48, 0x7f], { kind: "strip-touch", mode: 1, shift: false, touched: true }],
  ["To2 mode 2 touch+SHIFT", [0x96, 0x4b, 0x7f], { kind: "strip-touch", mode: 2, shift: true, touched: true }],
  ["A1 AUTOSET", [0x96, 0x50, 0x7f], { kind: "button", name: "autoset" }],
  ["A3 OCTAVE-", [0x96, 0x54, 0x7f], { kind: "button", name: "octave-down" }],
  ["A4 OCTAVE+", [0x96, 0x56, 0x7f], { kind: "button", name: "octave-up" }],
  ["A5 SCENE SIZE-", [0x96, 0x58, 0x7f], { kind: "button", name: "scene-size-down" }],
  ["A7 LIBRARY", [0x96, 0x5c, 0x7f], { kind: "button", name: "library" }],
  ["A8 DELETE", [0x96, 0x5e, 0x7f], { kind: "button", name: "delete" }],
  ["A10 NOTE REPEAT", [0x96, 0x62, 0x7f], { kind: "button", name: "note-repeat" }],
  ["P1 TRIGGER MODE", [0x96, 0x70, 0x7f], { kind: "button", name: "trigger-mode", shift: false }],
  ["P2 PIANO MODE", [0x96, 0x72, 0x7f], { kind: "button", name: "piano-mode" }],
  ["P3 DECK SELECT", [0x96, 0x75, 0x7f], { kind: "button", name: "deck-select", shift: false }],
  ["P3 DECK SELECT+SHIFT", [0x96, 0x76, 0x7f], { kind: "button", name: "deck-select", shift: true }],
  ["P4 SCENE SELECT", [0x96, 0x77, 0x7f], { kind: "button", name: "scene-select" }],
  ["P5 Pad 1 page 1", [0x97, 0x0c, 0x64], { kind: "pad", pad: 0, page: 0, velocity: 100, pressed: true, shift: false }],
  ["P5 Pad 1 page 2", [0x97, 0x1c, 0x40], { kind: "pad", pad: 0, page: 1, velocity: 64 }],
  ["P8 Pad 4 page 8", [0x97, 0x7c + 3, 0x7f], { kind: "pad", pad: 3, page: 7 }],
  ["P9 Pad 5 page 1", [0x97, 0x08, 0x10], { kind: "pad", pad: 4, page: 0 }],
  ["P17 Pad 13 page 1", [0x97, 0x00, 0x7f], { kind: "pad", pad: 12, page: 0 }],
  ["P20 Pad 16 page 4", [0x97, 0x33, 0x7f], { kind: "pad", pad: 15, page: 3 }],
  ["P20 Pad 16 +SHIFT", [0x98, 0x03, 0x7f], { kind: "pad", pad: 15, shift: true }],
  ["Pad release (vel 0)", [0x97, 0x0c, 0x00], { kind: "pad", pad: 0, pressed: false }],
  ["Pad release (note off)", [0x87, 0x0c, 0x40], { kind: "pad", pad: 0, pressed: false }],
  ["Pad 1 aftertouch", [0xa7, 0x0c, 0x7f], { kind: "pad-pressure", pad: 0, pressure: 1 }],
];

describe("SLAB: decoding the official MIDI message list", () => {
  for (const [figure, bytes, expected] of OFFICIAL) {
    test(figure, () => {
      const event = new SlabDecoder().decode(bytes);
      assert.ok(event, `${figure} decodes`);
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual((event as Record<string, unknown>)[key], value, `${figure}.${key}`);
      }
    });
  }

  test("pad layout follows the list (Pad 1 = note 12 top-left, Pad 13 = note 0 bottom-left, +16 per page)", () => {
    assert.deepEqual(SLAB_PAD_PAGE1_NOTES.slice(0, 4), [12, 13, 14, 15]);
    assert.deepEqual(SLAB_PAD_PAGE1_NOTES.slice(12), [0, 1, 2, 3]);
    for (let page = 0; page < 8; page += 1) {
      for (let pad = 0; pad < 16; pad += 1) assert.deepEqual(slabPadFromNote(slabPadNote(pad, page)), { pad, page });
    }
    assert.equal(slabPadNote(15, 7), 115); // P20 page 8 = 0x73
  });

  test("relative encoder values: 0x01.. CW, 0x41.. CCW", () => {
    assert.equal(slabRelative(0x01), 1);
    assert.equal(slabRelative(0x03), 3);
    assert.equal(slabRelative(0x41), -1);
    assert.equal(slabRelative(0x44), -4);
    assert.equal(slabRelative(0x40), 0);
  });

  test("touch strip 14-bit position from MSB then LSB (To2)", () => {
    const decoder = new SlabDecoder();
    const msb = decoder.decode([0xb6, 0x0e, 0x40]);
    assert.equal(msb?.kind, "strip");
    const lsb = decoder.decode([0xb6, 0x2e, 0x00]);
    assert.ok(lsb && lsb.kind === "strip");
    assert.equal(lsb.mode, 1);
    assert.ok(Math.abs(lsb.value - 8192 / 16383) < 1e-9);
    const top = decoder.decode([0xb6, 0x10, 0x7f]);
    const topLsb = decoder.decode([0xb6, 0x30, 0x7f]);
    assert.ok(top && topLsb && topLsb.kind === "strip");
    assert.equal(topLsb.mode, 2);
    assert.equal(topLsb.value, 1);
  });

  test("unknown messages are ignored", () => {
    const decoder = new SlabDecoder();
    assert.equal(decoder.decode([0x90, 0x01, 0x7f]), null);
    assert.equal(decoder.decode([0xb6, 0x01, 0x10]), null);
    assert.equal(decoder.decode([0xf8]), null);
  });
});

describe("SLAB: detection and catalogue", () => {
  test("port names", () => {
    for (const name of ["SLAB", "AlphaTheta SLAB", "SLAB MIDI 1", "slab"]) assert.ok(isSlabPort(name), name);
    for (const name of ["Slabber", "DDJ-FLX4", "Unslab Pro", ""]) assert.ok(!isSlabPort(name), name);
    assert.ok(isSlabPort("MIDI 1", "AlphaTheta SLAB"));
  });

  test("catalogue routes SLAB to the dedicated driver with no colliding generic bindings", () => {
    const profile = profileForDevice("AlphaTheta SLAB");
    assert.ok(profile);
    assert.equal(profile.driver, "slab");
    assert.equal(profile.testedOnHardware, false);
    assert.deepEqual(profile.bindings, {});
    const entry = HARDWARE_CATALOGUE.find((item) => item.id === "alphatheta-slab");
    assert.equal(entry?.driver, "slab");
    assert.equal(entry?.category, "accessory");
  });
});

function fakeHost() {
  const calls: unknown[][] = [];
  const state = { playing: { A: false, B: false, C: false, D: false } as Record<SlabDeck, boolean>, recording: false, padMode: { A: "hot-cue", B: "hot-cue", C: "hot-cue", D: "hot-cue" } as Record<SlabDeck, string> };
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
  };
  const host: SlabHost = {
    selectDeck: record("selectDeck"),
    deckPad: record("deckPad"),
    cycleDeckPadMode: (deck, dir) => {
      calls.push(["cycleDeckPadMode", deck, dir]);
      return "Cue Loop";
    },
    setDeckPadMode: (deck, mode) => {
      state.padMode[deck] = mode;
      calls.push(["setDeckPadMode", deck, mode]);
    },
    padFeedback: (_deck, index, mode) => (mode ? { color: null, active: false } : { color: index === 0 ? "#ff0000" : null, active: index === 0 }),
    sampler: record("sampler"),
    samplerLoaded: (slot) => slot < 8,
    padFx: record("padFx"),
    padFxAmount: record("padFxAmount"),
    encoder: (deck, assign, delta, fine) => {
      calls.push(["encoder", deck, assign, delta, fine]);
      return `${deck} ${assign}`;
    },
    encoderPress: (deck, assign) => {
      calls.push(["encoderPress", deck, assign]);
      return `${deck} ${assign} reset`;
    },
    readout: (deck, assign) => `${deck} ${assign} now`,
    showHud: record("showHud"),
    browse: record("browse"),
    loadBrowsed: record("loadBrowsed"),
    scrub: record("scrub"),
    filter: record("filter"),
    pitchBend: record("pitchBend"),
    needle: record("needle"),
    transport: record("transport"),
    focusLibrary: record("focusLibrary"),
    isPlaying: (deck) => state.playing[deck],
    isRecording: () => state.recording,
  };
  const named = (name: string) => calls.filter((call) => call[0] === name);
  return { host, calls, state, named };
}

describe("SLAB: controls driven by simulated MIDI", () => {
  test("hot cue page: pads 1-8 are the deck's pads, 9-16 loop rolls; SHIFT+pad deletes", () => {
    const { host, named } = fakeHost();
    const slab = new SlabController(host);
    slab.handle([0x97, 0x0c, 0x50]); // Pad 1 down
    slab.handle([0x97, 0x0c, 0x00]); // Pad 1 up
    slab.handle([0x97, 0x04, 0x7f]); // Pad 9 (note 4) down
    slab.handle([0x98, 0x0d, 0x7f]); // SHIFT + Pad 2
    assert.deepEqual(named("deckPad"), [
      ["deckPad", "A", 0, true, { shift: false }],
      ["deckPad", "A", 0, false, { shift: false }],
      ["deckPad", "A", 0, true, { shift: false, mode: "loop-roll" }],
      ["deckPad", "A", 1, true, { shift: true }],
    ]);
  });

  test("pads read on any SLAB page (OCTAVE -/+ only moves the note range)", () => {
    const { host, named } = fakeHost();
    const slab = new SlabController(host);
    slab.handle([0x97, 0x0c + 16 * 5, 0x50]); // Pad 1 on page 6
    assert.deepEqual(named("deckPad")[0], ["deckPad", "A", 0, true, { shift: false }]);
    assert.equal(slab.devicePage, 5);
  });

  test("PIANO page: 16 sampler pads with velocity, SHIFT+PIANO swaps bank pair", () => {
    const { host, named } = fakeHost();
    const slab = new SlabController(host);
    slab.handle([0x96, 0x72, 0x7f]);
    assert.equal(slab.page, "sampler");
    slab.handle([0x97, 0x0c, 127]); // Pad 1 hard
    slab.handle([0x97, 0x03, 32]); // Pad 16 soft
    slab.handle([0x96, 0x73, 0x7f]); // SHIFT+PIANO
    slab.handle([0x97, 0x0c, 64]);
    const hits = named("sampler");
    assert.deepEqual(hits[0], ["sampler", 0, 1]);
    assert.equal(hits[1]![1], 15);
    assert.ok(Math.abs((hits[1]![2] as number) - 32 / 127) < 1e-9);
    assert.equal(hits[2]![1], 16, "second bank pair starts at slot 16");
  });

  test("SCENE SELECT page: stem mutes/filters and held pad FX with aftertouch", () => {
    const { host, named } = fakeHost();
    const slab = new SlabController(host);
    slab.handle([0x96, 0x77, 0x7f]);
    assert.equal(slab.page, "stems");
    slab.handle([0x97, 0x08, 0x7f]); // Pad 5 -> part-fx index 4 (mute drums)
    assert.deepEqual(named("deckPad")[0], ["deckPad", "A", 4, true, { shift: false, mode: "part-fx" }]);
    slab.handle([0x97, 0x04, 0x60]); // Pad 9 -> echo
    slab.handle([0xa7, 0x04, 0x20]); // pressure on Pad 9
    slab.handle([0x97, 0x04, 0x00]); // release
    const fx = named("padFx");
    assert.equal(fx[0]![2], "echo");
    assert.deepEqual(fx[1], ["padFx", "A", null, 0]);
    assert.ok(Math.abs((named("padFxAmount")[0]![2] as number) - 0x20 / 127) < 1e-9);
  });

  test("DECK SELECT: pads 1-4 pick A-D and return to the previous page; SHIFT cycles", () => {
    const { host, named } = fakeHost();
    const slab = new SlabController(host);
    slab.handle([0x96, 0x77, 0x7f]); // stems page
    slab.handle([0x96, 0x75, 0x7f]); // deck select
    assert.equal(slab.page, "deck-select");
    slab.handle([0x97, 0x0e, 0x7f]); // Pad 3 -> C
    assert.equal(slab.deck, "C");
    assert.equal(slab.page, "stems");
    slab.handle([0x96, 0x76, 0x7f]); // SHIFT+DECK SELECT -> D
    slab.handle([0x96, 0x76, 0x7f]); // -> A
    assert.deepEqual(named("selectDeck").map((call) => call[1]), ["C", "D", "A"]);
    slab.handle([0x90, 0x5e, 0x7f]);
    assert.deepEqual(named("transport").at(-1), ["transport", "A", "play"]);
  });

  test("encoders: EQ / FX / Stems / Param modes, touch-to-show, press resets", () => {
    const { host, named } = fakeHost();
    const slab = new SlabController(host);
    slab.handle([0x90, 0x18, 0x7f]); // touch encoder 1
    assert.deepEqual(named("showHud").at(-1), ["showHud", "A eq-high now"]);
    slab.handle([0xb0, 0x10, 0x41]); // CCW
    slab.handle([0xb0, 0x14, 0x02]); // SHIFT (fine) CW x2
    slab.handle([0x90, 0x18, 0x00]); // release touch
    assert.deepEqual(named("showHud").at(-1), ["showHud", null]);
    slab.handle([0x96, 0x10, 0x7f]); // ENCODER MODE -> fx
    slab.handle([0xb0, 0x11, 0x01]);
    slab.handle([0x96, 0x10, 0x7f]); // -> stems
    slab.handle([0xb0, 0x13, 0x01]);
    slab.handle([0x96, 0x10, 0x7f]); // -> param
    slab.handle([0x90, 0x20, 0x7f]); // press encoder 1
    slab.handle([0x90, 0x11, 0x7f]); // SHIFT+ENCODER MODE -> back to stems
    assert.equal(slab.encoderMode, "stems");
    assert.deepEqual(named("encoder"), [
      ["encoder", "A", "eq-high", -1, false],
      ["encoder", "A", "eq-high", 2, true],
      ["encoder", "A", SLAB_ENCODER_ASSIGN.fx[1], 1, false],
      ["encoder", "A", "part-vocals", 1, false],
    ]);
    assert.deepEqual(named("encoderPress"), [["encoderPress", "A", "tempo"]]);
  });

  test("dial browses, SHIFT scrubs, press loads to the selected deck", () => {
    const { host, named } = fakeHost();
    const slab = new SlabController(host);
    slab.handle([0xb0, 0x3c, 0x03]);
    slab.handle([0xb0, 0x3c, 0x41]);
    slab.handle([0xb0, 0x3d, 0x42]);
    slab.handle([0x96, 0x76, 0x7f]); // -> deck B
    slab.handle([0x90, 0x62, 0x7f]);
    slab.handle([0x90, 0x63, 0x7f]);
    assert.deepEqual(named("browse"), [["browse", 3], ["browse", -1]]);
    assert.deepEqual(named("scrub"), [["scrub", "A", -2]]);
    assert.deepEqual(named("loadBrowsed"), [["loadBrowsed", "B", false], ["loadBrowsed", "B", true]]);
  });

  test("touch strip: mode 1 filter with a centre dead zone, mode 2 pitch bend springs back, SHIFT mode 2 needle search", () => {
    const { host, named } = fakeHost();
    const slab = new SlabController(host);
    slab.handle([0xb6, 0x0e, 0x40]); // centre
    slab.handle([0xb6, 0x2e, 0x00]);
    slab.handle([0xb6, 0x0e, 0x10]); // left
    assert.equal(named("filter")[0]![2], null);
    assert.ok((named("filter").at(-1)![2] as number) < 0.2);
    slab.handle([0x96, 0x4a, 0x7f]); // touch mode 2
    slab.handle([0xb6, 0x10, 0x40]); // origin
    slab.handle([0xb6, 0x10, 0x60]); // move right
    slab.handle([0x96, 0x4a, 0x00]); // release
    const bends = named("pitchBend").map((call) => call[2] as number);
    assert.equal(bends[0], 0);
    assert.ok(bends[1]! > 0 && bends[1]! <= 0.04);
    assert.equal(bends.at(-1), 0, "springs back on release");
    slab.handle([0xb6, 0x11, 0x20]);
    assert.equal(named("needle")[0]![1], "A");
  });

  test("transport and app buttons", () => {
    const { host, named } = fakeHost();
    const slab = new SlabController(host);
    for (const bytes of [[0x90, 0x5e, 0x7f], [0x90, 0x5c, 0x7f], [0x90, 0x5f, 0x7f], [0x90, 0x5b, 0x7f], [0x90, 0x64, 0x7f], [0x90, 0x61, 0x7f], [0x96, 0x58, 0x7f], [0x96, 0x5a, 0x7f], [0x96, 0x62, 0x7f], [0x96, 0x5e, 0x7f], [0x96, 0x50, 0x7f]]) {
      slab.handle(bytes);
      slab.handle([bytes[0]!, bytes[1]!, 0]); // releases do nothing
    }
    assert.deepEqual(named("transport").map((call) => call[2]), ["play", "cue", "rec", "sync", "jump-back", "jump-forward-fine", "loop-half", "loop-double", "loop", "eject", "sync"]);
  });

  test("LED feedback: pad colours, page buttons, play/rec, encoder rings, only changes are sent", () => {
    const { host, state } = fakeHost();
    const slab = new SlabController(host);
    const sent: number[][] = [];
    slab.attachOutput((bytes) => sent.push(bytes));
    const pad1 = sent.find((m) => m[0] === 0x97 && m[1] === 0x0c);
    assert.ok(pad1 && pad1[2]! > 0, "a set hot cue lights in its colour");
    const pad2 = sent.find((m) => m[0] === 0x97 && m[1] === 0x0d);
    assert.equal(pad2?.[2], 0, "empty hot cue is dark");
    assert.deepEqual(sent.find((m) => m[0] === 0x96 && m[1] === 0x70), [0x96, 0x70, 0x7f], "TRIGGER lit");
    assert.deepEqual(sent.find((m) => m[0] === 0x96 && m[1] === 0x72), [0x96, 0x72, 0x00]);
    assert.ok(sent.some((m) => m[0] === 0x90 && m[1] === 0x20 && m[2]! > 0), "encoder 1 indicator lit");
    sent.length = 0;
    assert.equal(slab.syncLeds(), 0, "nothing changed, nothing sent");
    state.playing.A = true;
    slab.syncLeds();
    assert.deepEqual(sent, [[0x90, 0x5e, 0x7f]]);
    sent.length = 0;
    slab.handle([0x96, 0x75, 0x7f]); // deck select page lights A-D
    const deckPads = [0, 1, 2, 3].map((pad) => sent.find((m) => m[0] === 0x97 && m[1] === slabPadNote(pad))?.[2]);
    assert.ok(deckPads.every((value) => typeof value === "number" && value > 0));
    slab.blackout();
    assert.ok(sent.slice(-5).every((m) => m[2] === 0));
  });

  test("LEDs follow the unit's pad page", () => {
    const { host } = fakeHost();
    const slab = new SlabController(host);
    const sent: number[][] = [];
    slab.attachOutput((bytes) => sent.push(bytes));
    sent.length = 0;
    slab.handle([0x96, 0x56, 0x7f]); // OCTAVE+ -> page 2
    assert.ok(sent.some((m) => m[0] === 0x97 && m[1] === 0x1c), "Pad 1 LED now on page-2 note 0x1C");
  });
});

describe("SLAB: provisional colours and filter curve", () => {
  test("colour numbers stay inside the documented 0x01-0x7F range, 0 for none", () => {
    assert.equal(provisionalColorNumber(null), 0);
    assert.equal(provisionalColorNumber("#000000"), 0);
    for (const color of ["#ff0000", "#00ff00", "#0000ff", "#f0a726", "rgb(64, 214, 128)", "#fff"]) {
      const value = provisionalColorNumber(color);
      assert.ok(value >= 1 && value <= 0x7f, `${color} -> ${value}`);
    }
    assert.notEqual(provisionalColorNumber("#ff0000"), provisionalColorNumber("#0000ff"));
  });

  test("filter strip: left closes a low-pass, right raises a high-pass", () => {
    assert.equal(slabFilterAmount(0), 0.5);
    assert.ok(slabFilterAmount(0.45) > 0.9);
    assert.ok(slabFilterAmount(0.55) < 0.1);
    assert.equal(slabFilterAmount(1), 0.5);
  });
});

// Exports the TypeScript tables the Linux build reads (keymap, MIDI device
// profiles) and test vectors the Rust ports must reproduce exactly.
//   node linux/tools/export-ts.mjs      (from the repo root; Node >= 22.18)
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const data = path.join(root, "linux/crates/od-core/data");
const vec = path.join(root, "linux/crates/od-core/tests/vectors");
mkdirSync(data, { recursive: true });
mkdirSync(vec, { recursive: true });
const imp = (p) => import(path.join(root, p));
const km = await imp("src/renderer/keyboard/serato-keymap.ts");
const prof = await imp("src/renderer/midi/profiles.ts");
const midi = await imp("src/renderer/midi/midi.ts");
const slab = await imp("src/renderer/midi/slab.ts");
const bg = await imp("src/renderer/engine/beatgrid.ts");
const sync = await imp("src/renderer/engine/sync.ts");
const fx = await imp("src/renderer/engine/fx.ts");
const mix = await imp("src/renderer/engine/mixer.ts");
const pads = await imp("src/renderer/engine/pad-modes.ts");
const w = (dir, name, obj) => writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 1) + "\n");

// ---- tables
w(data, "keymap.json", { bindings: km.SERATO_KEYMAP, moved: km.MOVED_BINDINGS, waveSpans: km.WAVE_SPANS });
w(data, "midi-profiles.json", prof.DEVICE_PROFILES.map((p) => ({ ...p, pattern: { source: p.pattern.source, flags: p.pattern.flags } })));
w(data, "hardware-catalogue.json", prof.HARDWARE_CATALOGUE);

// ---- vectors
const times = [0, 0.01, 0.25, 0.5, 1, 1.37, 2, 3.999, 7.5, 31.25, 60, 123.456, -0.3];
const bpms = [0, 60, 87.5, 120, 124, 128, 140, 174, 200];
const beatgrid = [];
for (const t of times) for (const b of bpms) {
  beatgrid.push({ t, b, snap: bg.snapToBeat(t, b), wrap: bg.wrapBeatPhase(t, b), nearest: bg.nearestBeat(t, b, 0.12), fmt: bg.formatBeatPosition(t, b, 0.12), jump: bg.beatJumpTarget(t, b, 4, 100), jumpBack: bg.beatJumpTarget(t, b, -8, 100), loop: bg.loopSeconds(b, 0.25) });
}
const syncs = [];
for (const m of bpms) for (const tb of bpms) for (const [mp, tp] of [[0, 0], [1.2, 3.7], [10.01, 9.5]]) {
  const r = sync.syncDeck({ masterBpm: m, targetBpm: tb, masterPosition: mp, targetPosition: tp, targetPhase: 0.05, masterPhase: 0.02 });
  syncs.push({ m, tb, mp, tp, ...r, nudge: sync.nudgeTowardPhase(m, mp, tp), label: sync.tempoPercentLabel(r.tempoPercent) });
}
const amounts = [-1.5, -1, -0.5, -0.1, 0, 0.1, 0.33, 0.5, 0.9, 1, 1.4];
const fxv = { filter: amounts.map((a) => [a, fx.filterFrequency(a), fx.filterType(a) === "lowpass"]), tape: amounts.map((a) => [a, fx.tapeStopRate(a)]), tremolo: [], delay: [], defaults: fx.FX_DEFS.map((d) => ({ id: d.id, ...fx.fxDefault(d.id) })), crush: [0, 0.35, 1].map((a) => [a, Array.from(fx.crushCurve(a))]) };
for (const d of fx.DIVISIONS) for (const b of bpms) { fxv.tremolo.push([d, b, fx.tremoloRateHz(d, b)]); fxv.delay.push([d, b, fx.delaySeconds(d, b)]); }
const mixv = { cross: [], chan: [] };
for (const x of [-0.2, 0, 0.05, 0.08, 0.3, 0.5, 0.51, 0.7, 0.92, 0.95, 1, 1.2]) for (const c of ["smooth", "fast", "cut"]) for (const r of [false, true]) { const g = mix.crossfaderGains(x, c, r); mixv.cross.push([x, c, r, g.a, g.b]); }
for (const x of [-1, 0, 0.01, 0.05, 0.2, 0.5, 0.85, 1, 2]) for (const c of ["linear", "log", "sharp"]) mixv.chan.push([x, c, mix.channelFaderGain(x, c)]);
const padv = { ids: pads.PAD_MODE_IDS, rows: [] };
for (const i of [-1, 0, 1.5, 3, 7, 9]) padv.rows.push([i, pads.loopRollBeats(i), pads.beatJumpStep(i), pads.pitchPlayRate(i), pads.sliceRange(i, 245.3).start, pads.sliceRange(i, 245.3).end]);
padv.release = [[10, 1000, 3500, 1.06, 300], [10, 1000, 900, 1, 300], [299, 0, 5000, 1, 300]].map((a) => [...a, pads.rollingReleasePosition(...a)]);
w(vec, "timing.json", { beatgrid, sync: syncs, fx: fxv, mixer: mixv, pads: padv });

// keyboard matching
const codes = ["KeyW", "KeyS", "KeyQ", "KeyA", "KeyE", "KeyR", "KeyF", "KeyI", "KeyK", "KeyU", "KeyJ", "KeyT", "KeyG", "KeyL", "KeyZ", "KeyN", "KeyP", "KeyO",
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`), "F1", "F5", "F6", "F10", "Space", "Tab", "Escape", "Equal", "Minus", "Backquote", "Slash", "Backslash", "Delete", "Backspace",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "NumpadAdd", "NumpadSubtract", "Enter", "KeyX", "KeyC", "KeyV", "KeyB", "KeyM", "KeyH", "KeyY", "Comma", "Period", "BracketLeft", "BracketRight", "Semicolon", "Quote"];
const keyv = [];
for (const code of codes) for (let m = 0; m < 16; m++) for (const rep of [false, true]) for (const ctx of [{ inTextInput: false }, { inTextInput: true }, { inTextInput: true, inBpmEditor: true }]) {
  const ev = { code, ctrlKey: !!(m & 1), shiftKey: !!(m & 2), altKey: !!(m & 4), metaKey: !!(m & 8), repeat: rep };
  const r = km.matchEvent(ev, "other", ctx);
  keyv.push([code, m, rep, ctx.inTextInput, !!ctx.inBpmEditor, r ? r.binding.id : null, r ? r.side : null, r?.index ?? null]);
}
const spans = []; for (const s of [1, 2, 5, 8, 32, 40]) for (const z of [true, false]) spans.push([s, z, km.nextSpan(s, z)]);
const tscale = []; for (const s of [0.7, 1, 1.25, 1.8]) for (const z of [true, false]) tscale.push([s, z, km.nextTextScale(s, z)]);
w(vec, "keymap.json", { matches: keyv, spans, textScale: tscale });

// MIDI
const names = ["Numark Party Mix III", "PartyMix 3 MIDI 1", "Party Mix", "Numark Party Mix", "Hercules DJControl T10", "DJControl T10 MIDI", "RANE ONE", "Rane One MK2", "Mixars DUO", "Omnis Duo", "SLAB", "AlphaTheta SLAB", "Pioneer DDJ-FLX4", "DDJ-FLX4 MIDI 1", "DDJ-1000", "Traktor Kontrol S4 MK3", "Kontrol S2", "Reloop RP8000 MK2", "Reloop RP-8000", "Denon DJ SC6000", "Unknown Thing", "Roland DJ-202", "Pioneer DJM-900NXS2", "Serato Control Vinyl"];
w(vec, "midi.json", {
  names: names.map((n) => [n, prof.profileForDevice(n)?.id ?? null, prof.lookupHardwareDevice(n)?.id ?? null]),
  slabPorts: ["SLAB", "AlphaTheta SLAB MIDI 1", "Slabs", "my-slab-2", "Kontrol"].map((n) => [n, slab.isSlabPort(n)]),
  parse: [[0x90, 36, 100], [0x90, 36, 0], [0x80, 40, 64], [0xb3, 7, 127], [0xb0, 1, 0], [0xe0, 0, 64], [0x40, 1, 1], [0x9f, 127, 127]].map((d) => [d, midi.parseMidiMessage(d)]),
});
// SLAB decoder: every status of interest x every data1, a few data2, one decoder (stateful strip)
const dec = new slab.SlabDecoder();
const slabv = [];
for (const st of [0x80, 0x86, 0x87, 0x88, 0x90, 0x96, 0x97, 0x98, 0xa7, 0xb0, 0xb6, 0xb1]) for (let d1 = 0; d1 < 128; d1++) for (const d2 of [0, 1, 0x3f, 0x41, 0x7f]) {
  slabv.push([[st, d1, d2], dec.decode([st, d1, d2])]);
}
w(vec, "slab.json", { decode: slabv, filter: [0, 1, 32, 63, 64, 65, 100, 127].map((v) => [v, slab.slabFilterAmount(v)]), colors: ["#ff0000", "#00ff00", "#0000ff", "#ffffff", "#000000", "#e8a33d", null, "nope"].map((c) => [c, slab.provisionalColorNumber(c)]) });
console.log("exported");

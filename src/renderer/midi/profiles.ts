import type { MidiBinding, MidiBindings } from "./midi.ts";

export interface MidiDeviceProfile {
  id: string;
  label: string;
  pattern: RegExp;
  bindings: MidiBindings;
}

const cc = (number: number, channel: number): MidiBinding => ({ message: "cc", number, channel });
const note = (number: number, channel: number): MidiBinding => ({ message: "note", number, channel });

function deckProfile(deck: "A" | "B", buttonChannel: number, padChannel: number): MidiBindings {
  const bindings: MidiBindings = {
    [`${deck}.play`]: note(0x07, buttonChannel),
    [`${deck}.cue`]: note(0x06, buttonChannel),
    [`${deck}.sync`]: note(0x05, buttonChannel),
    [`${deck}.loop`]: note(0x0b, buttonChannel),
    [`${deck}.pitch`]: cc(0x08, buttonChannel),
    [`${deck}.eqHigh`]: cc(0x04, buttonChannel),
    [`${deck}.eqMid`]: cc(0x03, buttonChannel),
    [`${deck}.eqLow`]: cc(0x02, buttonChannel),
    [`${deck}.trim`]: cc(0x05, buttonChannel),
  };
  for (let index = 0; index < 8; index += 1) {
    bindings[`${deck}.pad${index + 1}`] = note(index, padChannel);
  }
  return bindings;
}

function partyMixDeck(deck: "A" | "B", controlChannel: number, padChannel: number): MidiBindings {
  const bindings: MidiBindings = {
    [`${deck}.play`]: note(0x00, controlChannel),
    [`${deck}.cue`]: note(0x01, controlChannel),
    [`${deck}.sync`]: note(0x02, controlChannel),
    [`${deck}.pitch`]: cc(0x00, controlChannel),
  };
  for (let index = 0; index < 4; index += 1) {
    bindings[`${deck}.pad${index + 1}`] = note(0x14 + index, padChannel);
  }
  return bindings;
}

export const DEVICE_PROFILES: MidiDeviceProfile[] = [
  {
    id: "hercules-djcontrol-t10",
    label: "Hercules DJControl T10",
    pattern: /djcontrol[\s_-]*t10/i,
    bindings: {
      "mix.crossfader": cc(0x00, 1),
      "mix.chA": cc(0x00, 2),
      "mix.chB": cc(0x00, 3),
      ...deckProfile("A", 2, 7),
      ...deckProfile("B", 3, 8),
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [`smp.${index + 1}`, note(0x30 + index, 7)]),
      ),
    },
  },
  {
    id: "numark-party-mix-iii",
    label: "Numark Party Mix III",
    pattern: /party[\s_-]*mix[\s_-]*(iii|3)\b|party[\s_-]*mix$/i,
    bindings: {
      "mix.crossfader": cc(0x08, 16),
      "mix.master": cc(0x0a, 16),
      "mix.chA": cc(0x16, 1),
      "mix.chB": cc(0x16, 2),
      ...partyMixDeck("A", 1, 5),
      ...partyMixDeck("B", 2, 6),
    },
  },
];

export function profileForDevice(name: string | null | undefined): MidiDeviceProfile | null {
  if (!name) return null;
  return DEVICE_PROFILES.find((profile) => profile.pattern.test(name)) ?? null;
}

export function applyProfile(bindings: MidiBindings, profile: MidiDeviceProfile): string[] {
  const applied: string[] = [];
  for (const [target, binding] of Object.entries(profile.bindings)) {
    if (bindings[target]) continue;
    bindings[target] = { ...binding };
    applied.push(target);
  }
  return applied;
}

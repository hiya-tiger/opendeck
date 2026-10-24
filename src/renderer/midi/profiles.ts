import type { MidiBinding, MidiBindings } from "./midi.ts";

export type HardwareCategory =
  | "controller-2deck"
  | "controller-4deck"
  | "mixer-dvs"
  | "dvs-interface"
  | "media-player"
  | "accessory";

export interface MidiDeviceProfile {
  id: string;
  label: string;
  pattern: RegExp;
  bindings: MidiBindings;
  category?: HardwareCategory;
  vendor?: string;
  decks?: 1 | 2 | 4;
  dvsReady?: boolean;
  dvsUpgrade?: boolean;
  aliases?: string[];
}

export interface HardwareCatalogueEntry {
  rawLabel: string;
  label: string;
  id: string;
  vendor: string;
  model: string;
  category: HardwareCategory;
  decks: 1 | 2 | 4;
  dvsReady: boolean;
  dvsUpgrade: boolean;
}

const cc = (number: number, channel: number): MidiBinding => ({ message: "cc", number, channel });
const note = (number: number, channel: number): MidiBinding => ({ message: "note", number, channel });

function deckProfile(deck: "A" | "B" | "C" | "D", buttonChannel: number, padChannel: number): MidiBindings {
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
    [`${deck}.fxWet`]: cc(0x09, buttonChannel),
  };
  for (let index = 0; index < 8; index += 1) {
    bindings[`${deck}.pad${index + 1}`] = note(index, padChannel);
  }
  return bindings;
}

function herculesT10DeckProfile(deck: "A" | "B", buttonChannel: number, padChannel: number): MidiBindings {
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

function buildTwoDeckControllerBindings(): MidiBindings {
  return {
    "mix.crossfader": cc(0x1f, 1),
    "mix.master": cc(0x0e, 1),
    "mix.chA": cc(0x13, 1),
    "mix.chB": cc(0x13, 2),
    ...deckProfile("A", 1, 8),
    ...deckProfile("B", 2, 9),
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`smp.${index + 1}`, note(0x24 + index, 10)]),
    ),
  };
}

function buildFourDeckControllerBindings(): MidiBindings {
  return {
    "mix.crossfader": cc(0x1f, 1),
    "mix.master": cc(0x0e, 1),
    "mix.chA": cc(0x13, 1),
    "mix.chB": cc(0x13, 2),
    "mix.chC": cc(0x13, 3),
    "mix.chD": cc(0x13, 4),
    ...deckProfile("A", 1, 8),
    ...deckProfile("B", 2, 9),
    ...deckProfile("C", 3, 10),
    ...deckProfile("D", 4, 11),
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`smp.${index + 1}`, note(0x24 + index, 12)]),
    ),
  };
}

function buildMixerBindings(decks: 2 | 4): MidiBindings {
  const base: MidiBindings = {
    "mix.crossfader": cc(0x08, 1),
    "mix.master": cc(0x07, 1),
    "mix.chA": cc(0x13, 1),
    "mix.chB": cc(0x13, 2),
    ...deckProfile("A", 1, 5),
    ...deckProfile("B", 2, 6),
  };
  if (decks === 4) {
    Object.assign(base, {
      "mix.chC": cc(0x13, 3),
      "mix.chD": cc(0x13, 4),
      ...deckProfile("C", 3, 7),
      ...deckProfile("D", 4, 8),
    });
  }
  return base;
}

function buildDvsInterfaceBindings(decks: 2 | 4): MidiBindings {
  const base: MidiBindings = {
    "A.play": note(0x07, 1),
    "A.cue": note(0x06, 1),
    "A.sync": note(0x05, 1),
    "B.play": note(0x07, 2),
    "B.cue": note(0x06, 2),
    "B.sync": note(0x05, 2),
  };
  if (decks === 4) {
    Object.assign(base, {
      "C.play": note(0x07, 3),
      "C.cue": note(0x06, 3),
      "D.play": note(0x07, 4),
      "D.cue": note(0x06, 4),
    });
  }
  return base;
}

function buildMediaPlayerBindings(): MidiBindings {
  return {
    ...deckProfile("A", 1, 5),
  };
}

function buildAccessoryBindings(): MidiBindings {
  const bindings: MidiBindings = {
    "A.play": note(0x07, 1),
    "A.cue": note(0x06, 1),
    "A.loop": note(0x0b, 1),
    "A.fxWet": cc(0x09, 1),
    "B.play": note(0x07, 2),
    "B.cue": note(0x06, 2),
    "B.loop": note(0x0b, 2),
    "B.fxWet": cc(0x09, 2),
  };
  for (let index = 0; index < 8; index += 1) {
    bindings[`A.pad${index + 1}`] = note(0x14 + index, 1);
    bindings[`B.pad${index + 1}`] = note(0x14 + index, 2);
    bindings[`smp.${index + 1}`] = note(0x24 + index, 10);
  }
  return bindings;
}

/**
 * Exact 195-device list from the hardware specification (preserving trailing ` .`
 * on the 15 club/DVS-upgrade mixers).
 */
export const SUPPORTED_HARDWARE_RAW: readonly string[] = [
  "Hercules DJControl T10",
  "AlphaTheta XDJ-AN",
  "Numark Party Mix III",
  "Numark MixTrack Go",
  "AlphaTheta CDJ-1500X",
  "Hercules DJControl Inpulse 200 MK3",
  "Pioneer DJ DJM-750MK2",
  "Pioneer DJ DJM-450",
  "Pioneer DJ DJM-250MK2",
  "RANE SYSTEM ONE",
  "AlphaTheta DJM-V5 .",
  "Reloop Flux Go",
  "AlphaTheta SLAB",
  "AlphaTheta CDJ-3000X",
  "RANE ONE MKII",
  "Native Instruments Traktor Kontrol Z2 .",
  "Pioneer DJ DDJ-RB",
  "Roland SP-404MKII",
  "AlphaTheta XDJ-AZ",
  "AlphaTheta DDJ-FLX2",
  "AlphaTheta DDJ-GRV6",
  "Native Instruments Traktor Kontrol S3",
  "Native Instruments Traktor Kontrol S2 MK3",
  "Pioneer DJ DDJ-400",
  "Pioneer DJ DDJ-200",
  "RANE PERFORMER",
  "AlphaTheta Euphonia .",
  "AlphaTheta OMNIS-DUO",
  "Denon DJ PRIME 4+",
  "Pioneer DJ DDJ-REV5",
  "Pioneer DJ PLX-CRSS12",
  "Hercules DJControl Inpulse T7",
  "Pioneer DJ OPUS-QUAD",
  "Numark Mixstream Pro Go",
  "Hercules DJControl Inpulse 200 MK2",
  "Reloop Mixon 8 Pro",
  "Reloop Flux",
  "Pioneer DJ DDJ-FLX10",
  "RANE FOUR",
  "Pioneer DJ DJM-A9 .",
  "Numark Mixstream Pro +",
  "Numark Mixstream Pro",
  "Hercules DJControl Inpulse 300 MK2",
  "Pioneer DJ DDJ-FLX4",
  "Denon DJ SC Live 4",
  "Denon DJ SC Live 2",
  "Pioneer DJ DJM-S5",
  "Numark NS4FX",
  "Pioneer DJ XDJ-RX3",
  "Pioneer DJ DDJ-REV1",
  "Pioneer DJ DDJ-REV7",
  "Pioneer DJ CDJ-3000",
  "RANE SEVENTY A-Trak Edition",
  "Numark Party Mix Live",
  "Numark Party Mix II",
  "Denon DJ LC6000 PRIME",
  "Phase",
  "Reloop Ready",
  "Denon DJ SC6000 PRIME",
  "Denon DJ SC6000M PRIME",
  "Pioneer DJ DJM-S7",
  "RANE ONE",
  "Pioneer DJ DDJ-FLX6",
  "Pioneer DJ DJM-S11",
  "RANE TWELVE MKII",
  "RANE SEVENTY-TWO MKII",
  "Pioneer DJ DJM-V10-LF .",
  "Pioneer DJ DJM-V10 .",
  "Hercules DJControl Inpulse 500",
  "Numark Mixtrack Platinum FX",
  "Numark Mixtrack Pro FX",
  "Denon DJ X1850 PRIME .",
  "Rane SEVENTY",
  "Pioneer DJ XDJ-XZ",
  "Numark DJ2GO2 Touch",
  "Denon DJ PRIME 4",
  "Denon DJ SC5000M Prime",
  "Pioneer DJ DDJ-XP2",
  "Roland DJ-707M",
  "Pioneer DJ DDJ-1000SRT",
  "Numark Scratch",
  "Reloop ELITE",
  "Mixars PRIMO",
  "Reloop RP8000 MK2",
  "Roland TR-8S",
  "Hercules DJControl Inpulse 300",
  "Hercules DJControl Inpulse 200",
  "Hercules DJControl Starlight",
  "Numark Party Mix",
  "Pioneer DJ DDJ SB3",
  "Rane SEVENTY-TWO",
  "Pioneer DJ DDJ-SX3",
  "Denon DJ X1800 Prime .",
  "Roland DJ-505",
  "Rane TWELVE",
  "Mixars QUATTRO",
  "Pioneer DJ DJM-S3",
  "Roland DJ-202",
  "Pioneer DJ DDJ-SR2",
  "Roland DJ-808",
  "Numark NS6II",
  "Reloop RMX-90 DVS",
  "Pioneer DJ DDJ-SZ2",
  "Roland TR-8",
  "Denon DJ MC7000",
  "Numark Mixtrack Platinum",
  "Pioneer DJ DJM-900NXS2 .",
  "Denon DJ SC5000 Prime",
  "Pioneer DJ CDJ-2000NXS2",
  "Roland TR-08",
  "Roland TR-09",
  "Pioneer DJ DDJ-SB2",
  "Pioneer DJ DJM-S9",
  "Pioneer DJ DDJ-SX2",
  "Numark Party Mix Pro",
  "Denon DJ DS1",
  "Reloop Mixon 4",
  "Denon DJ MCX8000",
  "Akai Pro AMX",
  "Mixars DUO",
  "Numark DJ2GO2",
  "Hercules DJControl Jogvision",
  "Denon DJ MC4000",
  "Numark NS7 III",
  "Pioneer DJ DDJ-SZ",
  "Allen & Heath Xone:43C .",
  "Pioneer DJ DJM-900SRT",
  "Numark Mixtrack Pro 3",
  "Pioneer DJ DDJ-SB",
  "Numark Mixtrack Pro II",
  "Numark NVII",
  "Numark NV",
  "Reloop Beatmix 4",
  "Pioneer DJ DDJ-SR",
  "Denon DJ MC6000MK2",
  "Rane MP2015 .",
  "Pioneer DJ DDJ-SX",
  "Gemini Slate 4",
  "Pioneer DJ DDJ-WeGO3",
  "Reloop Terminal Mix 4",
  "Numark MixDeck Express",
  "Numark Mixtrack Quad",
  "Denon DJ MC2000",
  "Pioneer DJ DDJ-WeGO",
  "Numark MixDeck Quad",
  "Reloop Terminal Mix 2",
  "Pioneer DJ DDJ-ERGO",
  "Numark Mixtrack Pro",
  "Vestax Typhoon",
  "Numark N4",
  "Reloop Terminal Mix 8",
  "Reloop Beatmix 2",
  "Pioneer DJ DJM-900NXS .",
  "Vestax VCI-400",
  "Pioneer DJ DJM-850 .",
  "Vestax VCI-100 mk II",
  "Numark Dashboard",
  "Pioneer DJ CDJ-850",
  "Pioneer DJ CDJ-900",
  "Vestax VCI-380",
  "Pioneer DJ CDJ-2000NXS",
  "Pioneer DJ CDJ-2000",
  "Vestax VFX-1",
  "Pioneer DJ CDJ-900NXS",
  "Vestax VCI-300",
  "Allen & Heath Xone:K1",
  "Pioneer DJ DDJ-SP1",
  "Gemini Slate",
  "Reloop RP-8000",
  "Novation Dicers",
  "Numark NSFX",
  "Reloop NEON",
  "Numark NDX500",
  "Akai Pro AFX",
  "Pioneer DJ DDJ-S1",
  "Pioneer DJ XDJ-1000",
  "Rane TTM57mkII",
  "Rane SL3",
  "Rane Sixty-Two",
  "Rane SL4",
  "Rane SL2",
  "Numark NS6",
  "Allen & Heath Xone:DB4 .",
  "Numark NS7 II",
  "Korg KAOSS DJ",
  "Rane Sixty-Four",
  "Allen & Heath Xone:DB2 .",
  "Numark MixDeck",
  "Numark V7",
  "Rane Sixty-One",
  "Rane Sixty-Eight",
  "Novation TWITCH",
  "Numark Mixtrack Edge",
  "Numark NS7",
  "Denon DJ DN-HC1000S",
];

const VENDOR_PREFIXES = [
  "Native Instruments",
  "Allen & Heath",
  "Pioneer DJ",
  "AlphaTheta",
  "Denon DJ",
  "Akai Pro",
  "Hercules",
  "Novation",
  "Numark",
  "Reloop",
  "Roland",
  "Mixars",
  "Vestax",
  "Gemini",
  "RANE",
  "Rane",
  "Korg",
] as const;

const FOUR_DECK_CONTROLLER_SET = new Set<string>([
  "AlphaTheta XDJ-AN",
  "RANE SYSTEM ONE",
  "AlphaTheta XDJ-AZ",
  "AlphaTheta DDJ-GRV6",
  "Native Instruments Traktor Kontrol S3",
  "Native Instruments Traktor Kontrol S2 MK3",
  "RANE PERFORMER",
  "Denon DJ PRIME 4+",
  "Pioneer DJ OPUS-QUAD",
  "Reloop Mixon 8 Pro",
  "Pioneer DJ DDJ-FLX10",
  "RANE FOUR",
  "Denon DJ SC Live 4",
  "Numark NS4FX",
  "Pioneer DJ XDJ-RX3",
  "Pioneer DJ DDJ-FLX6",
  "Pioneer DJ XDJ-XZ",
  "Denon DJ PRIME 4",
  "Roland DJ-707M",
  "Pioneer DJ DDJ-1000SRT",
  "Pioneer DJ DDJ-SX3",
  "Roland DJ-808",
  "Numark NS6II",
  "Pioneer DJ DDJ-SZ2",
  "Denon DJ MC7000",
  "Pioneer DJ DDJ-SX2",
  "Reloop Mixon 4",
  "Denon DJ MCX8000",
  "Numark NS7 III",
  "Pioneer DJ DDJ-SZ",
  "Numark NVII",
  "Numark NV",
  "Reloop Beatmix 4",
  "Denon DJ MC6000MK2",
  "Pioneer DJ DDJ-SX",
  "Gemini Slate 4",
  "Reloop Terminal Mix 4",
  "Numark Mixtrack Quad",
  "Numark MixDeck Quad",
  "Numark N4",
  "Reloop Terminal Mix 8",
  "Vestax VCI-400",
  "Numark NS6",
  "Numark NS7 II",
  "Numark NS7",
]);

const MIXER_DVS_SET = new Set<string>([
  "Pioneer DJ DJM-750MK2",
  "Pioneer DJ DJM-450",
  "Pioneer DJ DJM-250MK2",
  "AlphaTheta DJM-V5",
  "Native Instruments Traktor Kontrol Z2",
  "AlphaTheta Euphonia",
  "Pioneer DJ DJM-A9",
  "Pioneer DJ DJM-S5",
  "RANE SEVENTY A-Trak Edition",
  "Pioneer DJ DJM-S7",
  "Pioneer DJ DJM-S11",
  "RANE SEVENTY-TWO MKII",
  "Pioneer DJ DJM-V10-LF",
  "Pioneer DJ DJM-V10",
  "Denon DJ X1850 PRIME",
  "Rane SEVENTY",
  "Numark Scratch",
  "Reloop ELITE",
  "Rane SEVENTY-TWO",
  "Denon DJ X1800 Prime",
  "Mixars QUATTRO",
  "Pioneer DJ DJM-S3",
  "Reloop RMX-90 DVS",
  "Pioneer DJ DJM-900NXS2",
  "Pioneer DJ DJM-S9",
  "Akai Pro AMX",
  "Mixars DUO",
  "Allen & Heath Xone:43C",
  "Pioneer DJ DJM-900SRT",
  "Rane MP2015",
  "Pioneer DJ DJM-900NXS",
  "Pioneer DJ DJM-850",
  "Rane TTM57mkII",
  "Rane Sixty-Two",
  "Allen & Heath Xone:DB4",
  "Rane Sixty-Four",
  "Allen & Heath Xone:DB2",
  "Rane Sixty-One",
  "Rane Sixty-Eight",
]);

const FOUR_CHANNEL_MIXER_SET = new Set<string>([
  "Pioneer DJ DJM-750MK2",
  "AlphaTheta DJM-V5",
  "AlphaTheta Euphonia",
  "Pioneer DJ DJM-A9",
  "Pioneer DJ DJM-V10-LF",
  "Pioneer DJ DJM-V10",
  "Denon DJ X1850 PRIME",
  "Denon DJ X1800 Prime",
  "Mixars QUATTRO",
  "Reloop RMX-90 DVS",
  "Pioneer DJ DJM-900NXS2",
  "Allen & Heath Xone:43C",
  "Pioneer DJ DJM-900SRT",
  "Rane MP2015",
  "Pioneer DJ DJM-900NXS",
  "Pioneer DJ DJM-850",
  "Allen & Heath Xone:DB4",
  "Rane Sixty-Four",
  "Allen & Heath Xone:DB2",
  "Rane Sixty-Eight",
]);

const DVS_INTERFACE_SET = new Set<string>([
  "Reloop Flux Go",
  "Reloop Flux",
  "Denon DJ DS1",
  "Rane SL3",
  "Rane SL4",
  "Rane SL2",
]);

const FOUR_DECK_DVS_INTERFACE_SET = new Set<string>([
  "Reloop Flux",
  "Rane SL3",
  "Rane SL4",
]);

const MEDIA_PLAYER_SET = new Set<string>([
  "AlphaTheta CDJ-1500X",
  "AlphaTheta CDJ-3000X",
  "Pioneer DJ PLX-CRSS12",
  "Pioneer DJ CDJ-3000",
  "Denon DJ LC6000 PRIME",
  "Phase",
  "Denon DJ SC6000 PRIME",
  "Denon DJ SC6000M PRIME",
  "RANE TWELVE MKII",
  "Denon DJ SC5000M Prime",
  "Reloop RP8000 MK2",
  "Rane TWELVE",
  "Denon DJ SC5000 Prime",
  "Pioneer DJ CDJ-2000NXS2",
  "Pioneer DJ CDJ-850",
  "Pioneer DJ CDJ-900",
  "Pioneer DJ CDJ-2000NXS",
  "Pioneer DJ CDJ-2000",
  "Pioneer DJ CDJ-900NXS",
  "Reloop RP-8000",
  "Numark NDX500",
  "Pioneer DJ XDJ-1000",
  "Numark V7",
]);

const DVS_READY_MEDIA_PLAYER_SET = new Set<string>([
  "Pioneer DJ PLX-CRSS12",
  "Phase",
  "Denon DJ SC6000M PRIME",
  "RANE TWELVE MKII",
  "Denon DJ SC5000M Prime",
  "Reloop RP8000 MK2",
  "Rane TWELVE",
  "Reloop RP-8000",
  "Numark V7",
]);

const ACCESSORY_SET = new Set<string>([
  "AlphaTheta SLAB",
  "Roland SP-404MKII",
  "Pioneer DJ DDJ-XP2",
  "Roland TR-8S",
  "Roland TR-8",
  "Roland TR-08",
  "Roland TR-09",
  "Numark Dashboard",
  "Vestax VFX-1",
  "Allen & Heath Xone:K1",
  "Pioneer DJ DDJ-SP1",
  "Novation Dicers",
  "Numark NSFX",
  "Reloop NEON",
  "Akai Pro AFX",
  "Denon DJ DN-HC1000S",
]);

function slugifyId(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\+/g, "plus")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitVendorAndModel(cleanLabel: string): { vendor: string; model: string } {
  for (const prefix of VENDOR_PREFIXES) {
    if (cleanLabel.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
      return {
        vendor: prefix === "Rane" ? "RANE" : prefix,
        model: cleanLabel.slice(prefix.length + 1).trim(),
      };
    }
  }
  if (cleanLabel === "Phase") {
    return { vendor: "MWM", model: "Phase" };
  }
  return { vendor: "Generic", model: cleanLabel };
}

function escapeRegexToken(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFlexibleModelRegex(cleanLabel: string, model: string): RegExp {
  if (cleanLabel === "Hercules DJControl T10") {
    return /djcontrol[\s_-]*t10/i;
  }
  if (cleanLabel === "Numark Party Mix III" || cleanLabel === "Numark Party Mix") {
    return /party[\s_-]*mix[\s_-]*(iii|3)\b|party[\s_-]*mix$/i;
  }
  if (cleanLabel === "RANE ONE") {
    return /\brane[\s_-]+one\b(?!\s*mk)|^one$/i;
  }
  if (cleanLabel === "Mixars DUO") {
    return /\bmixars[\s_-]+duo\b|(?<!omnis[\s_-])\bduo\b/i;
  }
  if (cleanLabel === "Reloop RP8000 MK2") {
    return /\brp[\s_-]*8000[\s_-]*mk\s*2\b/i;
  }
  if (cleanLabel === "Reloop RP-8000") {
    return /\brp[\s_-]*8000\b(?!\s*mk)/i;
  }

  const candidates = new Set<string>([cleanLabel, model]);
  if (model.toLowerCase().startsWith("traktor ")) {
    candidates.add(model.slice("traktor ".length).trim());
  }
  if (model.toLowerCase().startsWith("djcontrol ")) {
    candidates.add(model.slice("djcontrol ".length).trim());
  }

  const branches = [...candidates].map((candidate) => {
    const tokens = candidate
      .trim()
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((tok) => {
        if (/^[a-z]+:[a-z0-9]+$/i.test(tok)) {
          const [left, right] = tok.split(":");
          return `${escapeRegexToken(left)}[:\\s_-]*${escapeRegexToken(right)}`;
        }
        if (/^(ddj|cdj|xdj|djm|plx|rmx|vci|vfx|ndx|mcx|mc|sc|lc|tr|sp|dn|hc)[0-9a-z]+$/i.test(tok)) {
          const m = /^([a-z]+)([0-9a-z]+)$/i.exec(tok);
          if (m) {
            return `${escapeRegexToken(m[1])}[\\s_-]*${escapeRegexToken(m[2])}`;
          }
        }
        return escapeRegexToken(tok);
      });
    const joined = tokens.join("[\\s_-]*");
    return `(?:^|[^a-z0-9])${joined}(?=$|[^a-z0-9+])`;
  });

  return new RegExp(branches.join("|"), "i");
}

function classifyDevice(rawLabel: string): {
  rawLabel: string;
  label: string;
  id: string;
  vendor: string;
  model: string;
  category: HardwareCategory;
  decks: 1 | 2 | 4;
  dvsReady: boolean;
  dvsUpgrade: boolean;
  bindings: MidiBindings;
  pattern: RegExp;
  aliases?: string[];
} {
  const dvsUpgrade = /\.\s*$/.test(rawLabel);
  const label = rawLabel.replace(/[\s.]+$/, "").trim();
  const { vendor, model } = splitVendorAndModel(label);

  let category: HardwareCategory = "controller-2deck";
  let decks: 1 | 2 | 4 = 2;
  let dvsReady = false;
  let bindings: MidiBindings;

  if (label === "Hercules DJControl T10") {
    category = "controller-2deck";
    decks = 2;
    bindings = {
      "mix.crossfader": cc(0x00, 1),
      "mix.chA": cc(0x00, 2),
      "mix.chB": cc(0x00, 3),
      ...herculesT10DeckProfile("A", 2, 7),
      ...herculesT10DeckProfile("B", 3, 8),
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [`smp.${index + 1}`, note(0x30 + index, 7)]),
      ),
    };
  } else if (label === "Numark Party Mix III" || label === "Numark Party Mix") {
    category = "controller-2deck";
    decks = 2;
    bindings = {
      "mix.crossfader": cc(0x08, 16),
      "mix.master": cc(0x0a, 16),
      "mix.chA": cc(0x16, 1),
      "mix.chB": cc(0x16, 2),
      ...partyMixDeck("A", 1, 5),
      ...partyMixDeck("B", 2, 6),
    };
  } else if (DVS_INTERFACE_SET.has(label)) {
    category = "dvs-interface";
    decks = FOUR_DECK_DVS_INTERFACE_SET.has(label) ? 4 : 2;
    dvsReady = true;
    bindings = buildDvsInterfaceBindings(decks);
  } else if (MIXER_DVS_SET.has(label)) {
    category = "mixer-dvs";
    decks = FOUR_CHANNEL_MIXER_SET.has(label) ? 4 : 2;
    dvsReady = true;
    bindings = buildMixerBindings(decks);
  } else if (MEDIA_PLAYER_SET.has(label)) {
    category = "media-player";
    decks = 1;
    dvsReady = DVS_READY_MEDIA_PLAYER_SET.has(label);
    bindings = buildMediaPlayerBindings();
  } else if (ACCESSORY_SET.has(label)) {
    category = "accessory";
    decks = 2;
    bindings = buildAccessoryBindings();
  } else if (FOUR_DECK_CONTROLLER_SET.has(label)) {
    category = "controller-4deck";
    decks = 4;
    bindings = buildFourDeckControllerBindings();
  } else {
    category = "controller-2deck";
    decks = 2;
    bindings = buildTwoDeckControllerBindings();
  }

  const id = label === "Numark Party Mix" ? "numark-party-mix-iii" : slugifyId(label);
  const pattern = buildFlexibleModelRegex(label, model);
  const aliases =
    label === "Numark Party Mix III"
      ? ["Numark Party Mix", "Numark Party Mix 3", "Party Mix III", "Party Mix"]
      : [rawLabel, label, model];

  return {
    rawLabel,
    label: label === "Numark Party Mix" ? "Numark Party Mix III" : label,
    id,
    vendor,
    model,
    category,
    decks,
    dvsReady,
    dvsUpgrade,
    bindings,
    pattern,
    aliases,
  };
}

const classifiedList = SUPPORTED_HARDWARE_RAW.map((raw) => classifyDevice(raw));

export const HARDWARE_CATALOGUE: HardwareCatalogueEntry[] = classifiedList.map((item) => ({
  rawLabel: item.rawLabel,
  label: item.rawLabel.replace(/[\s.]+$/, "").trim(),
  id: item.id,
  vendor: item.vendor,
  model: item.model,
  category: item.category,
  decks: item.decks,
  dvsReady: item.dvsReady,
  dvsUpgrade: item.dvsUpgrade,
}));

function specificityRank(item: ReturnType<typeof classifyDevice>): number {
  if (item.rawLabel === "Numark Party Mix" || item.rawLabel === "Numark Party Mix III") {
    return -100;
  }
  return item.model.length * 10 + item.label.length;
}

export const DEVICE_PROFILES: MidiDeviceProfile[] = classifiedList
  .filter((item) => item.rawLabel !== "Numark Party Mix")
  .sort((a, b) => specificityRank(b) - specificityRank(a))
  .map((item) => ({
    id: item.id,
    label: item.label,
    pattern: item.pattern,
    bindings: item.bindings,
    category: item.category,
    vendor: item.vendor,
    decks: item.decks,
    dvsReady: item.dvsReady,
    dvsUpgrade: item.dvsUpgrade,
    aliases: item.aliases,
  }));

export function normalizeHardwareName(name: string | null | undefined): string {
  if (!name) return "";
  return name.replace(/[\s.]+$/, "").trim();
}

export function profileForDevice(name: string | null | undefined): MidiDeviceProfile | null {
  if (!name) return null;
  const cleaned = normalizeHardwareName(name);
  if (!cleaned) return null;
  return DEVICE_PROFILES.find((profile) => profile.pattern.test(cleaned)) ?? null;
}

export function lookupHardwareDevice(name: string | null | undefined): HardwareCatalogueEntry | null {
  if (!name) return null;
  const cleaned = normalizeHardwareName(name).toLowerCase();
  if (!cleaned) return null;
  const exact = HARDWARE_CATALOGUE.find(
    (entry) =>
      entry.label.toLowerCase() === cleaned ||
      entry.rawLabel.toLowerCase() === name.trim().toLowerCase() ||
      entry.model.toLowerCase() === cleaned,
  );
  if (exact) return exact;
  const profile = profileForDevice(cleaned);
  if (!profile) return null;
  return HARDWARE_CATALOGUE.find((entry) => entry.id === profile.id) ?? null;
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

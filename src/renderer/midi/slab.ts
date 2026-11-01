/**
 * AlphaTheta SLAB in its general-purpose MIDI mode.
 *
 * Every MIDI number here comes from AlphaTheta's official "SLAB List of MIDI
 * Messages" (SLAB_MIDI_Message_List_en.pdf, (c) 2025 AlphaTheta, from
 * downloads.support.alphatheta.com/midi-mapping/music-production/SLAB/). Row
 * ids in the comments (Tr5, E2, To2, P5 ...) are the figure labels of that list.
 *
 * SLAB's native mode is Serato's proprietary protocol. OpenDecks never sends
 * anything to switch the unit into it or to pose as Serato software: it only
 * reads and lights the controls the public list documents.
 *
 * Not in the list, so not implemented: OLED text (the list has no display
 * message) and the colour table behind the pad/encoder "color number"
 * (0x01-0x7F). LED colours therefore go through PROVISIONAL_COLOR_NUMBER
 * below, which is a guess until it is checked on a real unit.
 *
 * Untested on hardware: built and tested against simulated MIDI only.
 */

export type SlabDeck = "A" | "B" | "C" | "D";
export const SLAB_DECKS: readonly SlabDeck[] = ["A", "B", "C", "D"];

/** USB / MIDI port names seen as SLAB ("SLAB", "AlphaTheta SLAB", "SLAB MIDI 1" ...). */
export const SLAB_PORT_PATTERN = /(^|[^a-z0-9])slab([^a-z0-9]|$)/i;

export function isSlabPort(name: string | null | undefined, manufacturer?: string | null): boolean {
  return SLAB_PORT_PATTERN.test(`${manufacturer ?? ""} ${name ?? ""}`);
}

/* ------------------------------------------------ status bytes (official) */

// "MIDI Channel (Dec)" n is status 0x9(n-1) / 0xB(n-1) / 0xA(n-1).
export const SLAB_STATUS = {
  noteCh1: 0x90, // transport, dial, encoders (channel 1)
  ccCh1: 0xb0, // dial + encoder rotation (channel 1)
  noteCh7: 0x96, // touch strip buttons, app control, pad-mode buttons (channel 7)
  ccCh7: 0xb6, // touch strip position (channel 7)
  notePads: 0x97, // pads (channel 8)
  notePadsShift: 0x98, // pads with SHIFT held (channel 9)
  aftertouchPads: 0xa7, // pad polyphonic aftertouch (channel 8)
} as const;

/** Buttons by their official note number. */
export const SLAB_CH1_BUTTONS: Record<number, { name: SlabButton; shift: boolean }> = {
  0x51: { name: "undo", shift: false }, // Tr1
  0x50: { name: "undo", shift: true },
  0x52: { name: "redo", shift: false }, // Tr2
  0x53: { name: "redo", shift: true },
  0x64: { name: "left", shift: false }, // Tr3
  0x60: { name: "left", shift: true },
  0x65: { name: "right", shift: false }, // Tr4
  0x61: { name: "right", shift: true },
  0x36: { name: "focus", shift: false }, // Tr6
  0x37: { name: "dial-mode", shift: false }, // Tr7
  0x46: { name: "shift", shift: false }, // Tr8
  0x5f: { name: "rec", shift: false }, // Tr9 (Mackie Control REC)
  0x5b: { name: "rec", shift: true },
  0x5e: { name: "play", shift: false }, // Tr10 (Mackie Control PLAY)
  0x5c: { name: "play", shift: true },
  // E1: the list gives channel 1 but status 0x96 for ENCODER MODE; both are accepted.
  0x10: { name: "encoder-mode", shift: false },
  0x11: { name: "encoder-mode", shift: true },
};

export const SLAB_CH7_BUTTONS: Record<number, { name: SlabButton; shift: boolean }> = {
  0x10: { name: "encoder-mode", shift: false }, // E1 (status 0x96 per the list)
  0x11: { name: "encoder-mode", shift: true },
  0x40: { name: "strip-mode", shift: false }, // To1
  0x41: { name: "strip-mode", shift: true },
  0x50: { name: "autoset", shift: false }, // A1
  0x51: { name: "autoset", shift: true },
  0x52: { name: "favorite", shift: false }, // A2
  0x53: { name: "favorite", shift: true },
  0x54: { name: "octave-down", shift: false }, // A3
  0x55: { name: "octave-down", shift: true },
  0x56: { name: "octave-up", shift: false }, // A4
  0x57: { name: "octave-up", shift: true },
  0x58: { name: "scene-size-down", shift: false }, // A5
  0x59: { name: "scene-size-down", shift: true },
  0x5a: { name: "scene-size-up", shift: false }, // A6
  0x5b: { name: "scene-size-up", shift: true },
  0x5c: { name: "library", shift: false }, // A7
  0x5d: { name: "library", shift: true },
  0x5e: { name: "delete", shift: false }, // A8
  0x5f: { name: "delete", shift: true },
  0x60: { name: "select-all", shift: false }, // A9
  0x61: { name: "select-all", shift: true },
  0x62: { name: "note-repeat", shift: false }, // A10
  0x63: { name: "note-repeat", shift: true },
  0x70: { name: "trigger-mode", shift: false }, // P1
  0x71: { name: "trigger-mode", shift: true },
  0x72: { name: "piano-mode", shift: false }, // P2
  0x73: { name: "piano-mode", shift: true },
  0x75: { name: "deck-select", shift: false }, // P3
  0x76: { name: "deck-select", shift: true },
  0x77: { name: "scene-select", shift: false }, // P4
  0x78: { name: "scene-select", shift: true },
};

export const SLAB_DIAL = { cc: 0x3c, ccShift: 0x3d, press: 0x62, pressShift: 0x63 } as const; // Tr5
export const SLAB_ENCODER = {
  cc: [0x10, 0x11, 0x12, 0x13], // E2-E5 rotate
  ccShift: [0x14, 0x15, 0x16, 0x17],
  touch: [0x18, 0x19, 0x1a, 0x1b],
  press: [0x20, 0x21, 0x22, 0x23],
  pressShift: [0x24, 0x25, 0x26, 0x27],
  indicator: [0x20, 0x21, 0x22, 0x23], // E6-E9 MIDI-OUT, note on channel 1, data2 = colour number
} as const;
export const SLAB_STRIP = {
  // To2: 14-bit position, [MSB CC, LSB CC] per mode / SHIFT.
  mode1: { msb: 0x0e, lsb: 0x2e, touch: 0x48 },
  mode1Shift: { msb: 0x0f, lsb: 0x2f, touch: 0x49 },
  mode2: { msb: 0x10, lsb: 0x30, touch: 0x4a },
  mode2Shift: { msb: 0x11, lsb: 0x31, touch: 0x4b },
} as const;

/**
 * Pads P5-P20 (Pad 1-16, read left to right from the top row). Page 1 note of
 * each pad; page n (1-8, switched by OCTAVE -/+ on the unit) adds 16 * (n-1).
 */
export const SLAB_PAD_PAGE1_NOTES: readonly number[] = [
  12, 13, 14, 15, // Pad 1-4 (top row)
  8, 9, 10, 11, // Pad 5-8
  4, 5, 6, 7, // Pad 9-12
  0, 1, 2, 3, // Pad 13-16 (bottom row)
];

export function slabPadNote(pad: number, page = 0): number {
  return SLAB_PAD_PAGE1_NOTES[pad]! + 16 * page;
}

/** Note number -> pad index (0 = top-left Pad 1) and page (0-7). */
export function slabPadFromNote(note: number): { pad: number; page: number } | null {
  if (note < 0 || note > 127) return null;
  const pad = SLAB_PAD_PAGE1_NOTES.indexOf(note % 16);
  return pad < 0 ? null : { pad, page: Math.floor(note / 16) };
}

/* ---------------------------------------------------------------- decode */

export type SlabButton =
  | "undo" | "redo" | "left" | "right" | "focus" | "dial-mode" | "shift" | "rec" | "play"
  | "encoder-mode" | "strip-mode" | "autoset" | "favorite" | "octave-down" | "octave-up"
  | "scene-size-down" | "scene-size-up" | "library" | "delete" | "select-all" | "note-repeat"
  | "trigger-mode" | "piano-mode" | "deck-select" | "scene-select";

export type SlabEvent =
  | { kind: "pad"; pad: number; page: number; velocity: number; pressed: boolean; shift: boolean }
  | { kind: "pad-pressure"; pad: number; page: number; pressure: number }
  | { kind: "encoder"; index: number; delta: number; shift: boolean }
  | { kind: "encoder-touch"; index: number; touched: boolean }
  | { kind: "encoder-press"; index: number; pressed: boolean; shift: boolean }
  | { kind: "dial"; delta: number; shift: boolean }
  | { kind: "dial-press"; pressed: boolean; shift: boolean }
  | { kind: "strip"; mode: 1 | 2; shift: boolean; value: number }
  | { kind: "strip-touch"; mode: 1 | 2; shift: boolean; touched: boolean }
  | { kind: "button"; name: SlabButton; shift: boolean; pressed: boolean };

/** Relative encoder value: CW 0x01.., CCW 0x41.. (sign + magnitude). */
export function slabRelative(value: number): number {
  if (value === 0 || value === 0x40) return 0;
  return value < 0x40 ? value : -(value - 0x40);
}

const STRIP_BY_CC = new Map<number, { mode: 1 | 2; shift: boolean; part: "msb" | "lsb" }>();
const STRIP_BY_TOUCH = new Map<number, { mode: 1 | 2; shift: boolean }>();
for (const [key, spec] of Object.entries(SLAB_STRIP)) {
  const mode = key.startsWith("mode1") ? 1 : 2;
  const shift = key.endsWith("Shift");
  STRIP_BY_CC.set(spec.msb, { mode, shift, part: "msb" });
  STRIP_BY_CC.set(spec.lsb, { mode, shift, part: "lsb" });
  STRIP_BY_TOUCH.set(spec.touch, { mode, shift });
}

/** Stateful decoder: the strip's 14-bit position needs the last MSB. */
export class SlabDecoder {
  private stripMsb = new Map<string, number>();

  decode(data: ArrayLike<number>): SlabEvent | null {
    if (!data || data.length < 3) return null;
    const status = data[0]!;
    const d1 = data[1]!;
    const d2 = data[2]!;
    const type = status & 0xf0;
    const channelStatus = status & 0x0f;
    const isNoteOff = type === 0x80;
    const noteStatus = isNoteOff ? 0x90 | channelStatus : status;
    const on = !isNoteOff && d2 > 0;

    if (noteStatus === SLAB_STATUS.notePads || noteStatus === SLAB_STATUS.notePadsShift) {
      const where = slabPadFromNote(d1);
      if (!where) return null;
      return { kind: "pad", ...where, velocity: on ? d2 : 0, pressed: on, shift: noteStatus === SLAB_STATUS.notePadsShift };
    }
    if (status === SLAB_STATUS.aftertouchPads) {
      const where = slabPadFromNote(d1);
      return where ? { kind: "pad-pressure", ...where, pressure: d2 / 127 } : null;
    }
    if (status === SLAB_STATUS.ccCh1) {
      if (d1 === SLAB_DIAL.cc || d1 === SLAB_DIAL.ccShift) {
        return { kind: "dial", delta: slabRelative(d2), shift: d1 === SLAB_DIAL.ccShift };
      }
      let index: number = SLAB_ENCODER.cc.indexOf(d1 as never);
      if (index >= 0) return { kind: "encoder", index, delta: slabRelative(d2), shift: false };
      index = SLAB_ENCODER.ccShift.indexOf(d1 as never);
      if (index >= 0) return { kind: "encoder", index, delta: slabRelative(d2), shift: true };
      return null;
    }
    if (status === SLAB_STATUS.ccCh7) {
      const strip = STRIP_BY_CC.get(d1);
      if (!strip) return null;
      const key = `${strip.mode}${strip.shift ? "s" : ""}`;
      let msb: number;
      let lsb: number;
      if (strip.part === "msb") {
        msb = d2;
        lsb = 0;
        this.stripMsb.set(key, d2);
      } else {
        msb = this.stripMsb.get(key) ?? 0;
        lsb = d2;
      }
      return { kind: "strip", mode: strip.mode, shift: strip.shift, value: ((msb << 7) | lsb) / 16383 };
    }
    if (noteStatus === SLAB_STATUS.noteCh1) {
      if (d1 === SLAB_DIAL.press || d1 === SLAB_DIAL.pressShift) {
        return { kind: "dial-press", pressed: on, shift: d1 === SLAB_DIAL.pressShift };
      }
      let index: number = SLAB_ENCODER.touch.indexOf(d1 as never);
      if (index >= 0) return { kind: "encoder-touch", index, touched: on };
      index = SLAB_ENCODER.press.indexOf(d1 as never);
      if (index >= 0) return { kind: "encoder-press", index, pressed: on, shift: false };
      index = SLAB_ENCODER.pressShift.indexOf(d1 as never);
      if (index >= 0) return { kind: "encoder-press", index, pressed: on, shift: true };
      const button = SLAB_CH1_BUTTONS[d1];
      return button ? { kind: "button", ...button, pressed: on } : null;
    }
    if (noteStatus === SLAB_STATUS.noteCh7) {
      const touch = STRIP_BY_TOUCH.get(d1);
      if (touch) return { kind: "strip-touch", ...touch, touched: on };
      const button = SLAB_CH7_BUTTONS[d1];
      return button ? { kind: "button", ...button, pressed: on } : null;
    }
    return null;
  }
}

/* --------------------------------------------------------------- colours */

/**
 * PROVISIONAL. The official list says pads and encoder rings light "in color
 * specified in color number (0x01-0x7F)" but does not publish the colour
 * table. This maps a colour's hue onto 0x01-0x7F as a stand-in; replace it
 * with the real table once a unit has been checked. 0x00 is treated as off.
 */
export function provisionalColorNumber(color: string | null | undefined): number {
  const rgb = parseColor(color);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  if (max - min < 0.08) return 0x7f; // grey / white
  let hue: number;
  if (max === r) hue = ((g - b) / (max - min)) % 6;
  else if (max === g) hue = (b - r) / (max - min) + 2;
  else hue = (r - g) / (max - min) + 4;
  hue = (hue * 60 + 360) % 360;
  return 1 + Math.round((hue / 360) * 125);
}

function parseColor(color: string | null | undefined): [number, number, number] | null {
  if (!color) return null;
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.split("").map((c) => c + c).join("") : hex[1]!;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

export const SLAB_DECK_COLORS: Record<SlabDeck, string> = {
  A: "#4d6bfe",
  B: "#f0a726",
  C: "#40d680",
  D: "#e8567a",
};

/* --------------------------------------------------------------- mapping */

export type SlabPadPage = "hot-cue" | "sampler" | "stems" | "deck-select";
export type SlabEncoderMode = "eq" | "fx" | "stems" | "param";
export const SLAB_ENCODER_MODES: readonly SlabEncoderMode[] = ["eq", "fx", "stems", "param"];

/** What the four encoders do in each mode (index 0-3, left to right). */
export const SLAB_ENCODER_ASSIGN: Record<SlabEncoderMode, readonly string[]> = {
  eq: ["eq-high", "eq-mid", "eq-low", "trim"],
  fx: ["fx-type", "fx-wet", "fx-amount", "fx-division"],
  stems: ["part-drums", "part-bass", "part-other", "part-vocals"],
  param: ["tempo", "key", "loop-size", "beat-jump"],
};

export const SLAB_ENCODER_MODE_COLORS: Record<SlabEncoderMode, string> = {
  eq: "#4d6bfe",
  fx: "#e8567a",
  stems: "#40d680",
  param: "#f0a726",
};

/** Pad FX held from the stems page, pads 9-16. */
export const SLAB_PAD_FX = ["echo", "delay", "reverb", "filter", "flanger", "phaser", "crush", "gate"] as const;
export type SlabPadFx = (typeof SLAB_PAD_FX)[number];

export interface SlabPadFeedback {
  color: string | null;
  active: boolean;
}

export type SlabTransport =
  | "play" | "cue" | "sync" | "rec" | "loop" | "loop-half" | "loop-double" | "eject"
  | "jump-back" | "jump-forward" | "jump-back-fine" | "jump-forward-fine";

/** What the app gives the SLAB driver. Everything acts on a deck A-D. */
export interface SlabHost {
  selectDeck(deck: SlabDeck): void;
  /** One of the deck's 8 on-screen pads, in the deck's own pad mode or a forced one. */
  deckPad(deck: SlabDeck, index: number, pressed: boolean, options: { shift: boolean; mode?: string }): void;
  cycleDeckPadMode(deck: SlabDeck, direction: 1 | -1): string;
  setDeckPadMode(deck: SlabDeck, mode: string): void;
  padFeedback(deck: SlabDeck, index: number, mode?: string): SlabPadFeedback;
  sampler(slot: number, velocity: number): void;
  samplerLoaded(slot: number): boolean;
  padFx(deck: SlabDeck, fx: SlabPadFx | null, wet: number): void;
  padFxAmount(deck: SlabDeck, amount: number): void;
  /** Turns one encoder; returns the readout to show ("A · EQ HIGH -3.0 dB"). */
  encoder(deck: SlabDeck, assign: string, delta: number, fine: boolean): string;
  encoderPress(deck: SlabDeck, assign: string): string;
  readout(deck: SlabDeck, assign: string): string;
  showHud(text: string | null): void;
  browse(delta: number): void;
  loadBrowsed(deck: SlabDeck, play: boolean): void;
  scrub(deck: SlabDeck, delta: number): void;
  filter(deck: SlabDeck, value: number | null): void;
  pitchBend(deck: SlabDeck, amount: number): void;
  needle(deck: SlabDeck, ratio: number): void;
  transport(deck: SlabDeck, action: SlabTransport): void;
  focusLibrary(): void;
  isPlaying(deck: SlabDeck): boolean;
  isRecording(): boolean;
}

export type SlabSend = (bytes: number[]) => void;

/** Centre dead zone of the filter strip: inside it the filter is off. */
const FILTER_CENTRE = 0.04;
/** Full strip travel bends the tempo by +/- 4 % while touched. */
export const SLAB_PITCH_BEND_RANGE = 0.04;

export class SlabController {
  deck: SlabDeck = "A";
  page: SlabPadPage = "hot-cue";
  encoderMode: SlabEncoderMode = "eq";
  samplerPair = 0;
  devicePage = 0;
  private previousPage: SlabPadPage = "hot-cue";
  private readonly decoder = new SlabDecoder();
  private send: SlabSend | null = null;
  private leds = new Map<string, number>();
  private stripTouch: { mode: 1 | 2; shift: boolean; origin: number | null } | null = null;
  private touchedEncoders = new Set<number>();
  private heldPadFx: number | null = null;

  private readonly host: SlabHost;

  constructor(host: SlabHost) {
    this.host = host;
  }

  attachOutput(send: SlabSend | null): void {
    this.send = send;
    this.leds.clear();
    if (send) this.syncLeds();
  }

  /** Feed raw MIDI bytes from the SLAB input. Returns the decoded event. */
  handle(data: ArrayLike<number>): SlabEvent | null {
    const event = this.decoder.decode(data);
    if (!event) return null;
    this.apply(event);
    this.syncLeds();
    return event;
  }

  private apply(event: SlabEvent): void {
    const host = this.host;
    const deck = this.deck;
    switch (event.kind) {
      case "pad":
        this.devicePage = event.page;
        this.pad(event.pad, event.pressed, event.velocity, event.shift);
        return;
      case "pad-pressure":
        this.devicePage = event.page;
        if (this.page === "stems" && event.pad >= 8 && this.heldPadFx === event.pad) host.padFxAmount(deck, event.pressure);
        return;
      case "encoder": {
        const assign = SLAB_ENCODER_ASSIGN[this.encoderMode][event.index]!;
        host.showHud(host.encoder(deck, assign, event.delta, event.shift));
        return;
      }
      case "encoder-touch": {
        const assign = SLAB_ENCODER_ASSIGN[this.encoderMode][event.index]!;
        if (event.touched) {
          this.touchedEncoders.add(event.index);
          host.showHud(host.readout(deck, assign));
        } else {
          this.touchedEncoders.delete(event.index);
          if (!this.touchedEncoders.size) host.showHud(null);
        }
        return;
      }
      case "encoder-press":
        if (!event.pressed) return;
        host.showHud(host.encoderPress(deck, SLAB_ENCODER_ASSIGN[this.encoderMode][event.index]!));
        return;
      case "dial":
        if (event.shift) host.scrub(deck, event.delta);
        else host.browse(event.delta);
        return;
      case "dial-press":
        if (event.pressed) host.loadBrowsed(deck, event.shift);
        return;
      case "strip-touch":
        if (event.touched) {
          this.stripTouch = { mode: event.mode, shift: event.shift, origin: null };
        } else {
          if (event.mode === 2 && !event.shift) host.pitchBend(deck, 0);
          if (event.mode === 1 && event.shift) host.filter(deck, null);
          this.stripTouch = null;
        }
        return;
      case "strip":
        this.strip(event.mode, event.shift, event.value);
        return;
      case "button":
        if (event.pressed) this.button(event.name, event.shift);
        return;
    }
  }

  private pad(index: number, pressed: boolean, velocity: number, shift: boolean): void {
    const host = this.host;
    const deck = this.deck;
    switch (this.page) {
      case "hot-cue":
        if (index < 8) host.deckPad(deck, index, pressed, { shift });
        else host.deckPad(deck, index - 8, pressed, { shift, mode: "loop-roll" });
        return;
      case "sampler":
        if (pressed) host.sampler(this.samplerPair * 16 + index, Math.max(1, velocity) / 127);
        return;
      case "stems":
        if (index < 8) {
          if (pressed) host.deckPad(deck, index, true, { shift, mode: "part-fx" });
          return;
        }
        if (pressed) {
          this.heldPadFx = index;
          host.padFx(deck, SLAB_PAD_FX[index - 8]!, Math.max(0.2, velocity / 127));
        } else if (this.heldPadFx === index) {
          this.heldPadFx = null;
          host.padFx(deck, null, 0);
        }
        return;
      case "deck-select":
        if (!pressed || index > 3) return;
        this.selectDeck(SLAB_DECKS[index]!);
        this.page = this.previousPage;
        return;
    }
  }

  private strip(mode: 1 | 2, shift: boolean, value: number): void {
    const host = this.host;
    const deck = this.deck;
    if (mode === 1) {
      // Filter: centre = off, left = high-pass, right = low-pass sweep.
      host.filter(deck, Math.abs(value - 0.5) < FILTER_CENTRE ? null : value);
      return;
    }
    if (shift) {
      host.needle(deck, value);
      return;
    }
    // Pitch bend: relative to where the finger landed, springs back on release.
    const touch = this.stripTouch ?? (this.stripTouch = { mode, shift, origin: null });
    if (touch.origin === null) touch.origin = value;
    host.pitchBend(deck, Math.max(-1, Math.min(1, (value - touch.origin) * 2)) * SLAB_PITCH_BEND_RANGE);
  }

  private button(name: SlabButton, shift: boolean): void {
    const host = this.host;
    const deck = this.deck;
    switch (name) {
      case "trigger-mode":
        if (shift) {
          const mode = host.cycleDeckPadMode(deck, 1);
          host.showHud(`${deck} · pads ${mode}`);
        } else {
          host.setDeckPadMode(deck, "hot-cue");
        }
        this.setPage("hot-cue");
        return;
      case "piano-mode":
        if (shift && this.page === "sampler") this.samplerPair = this.samplerPair ? 0 : 1;
        this.setPage("sampler");
        host.showHud(`Sampler banks ${this.samplerPair ? "C + D" : "A + B"}`);
        return;
      case "scene-select":
        this.setPage("stems");
        return;
      case "deck-select":
        if (shift) {
          this.selectDeck(SLAB_DECKS[(SLAB_DECKS.indexOf(deck) + 1) % SLAB_DECKS.length]!);
          return;
        }
        if (this.page === "deck-select") this.page = this.previousPage;
        else this.setPage("deck-select");
        return;
      case "encoder-mode": {
        const at = SLAB_ENCODER_MODES.indexOf(this.encoderMode);
        const step = shift ? -1 : 1;
        this.encoderMode = SLAB_ENCODER_MODES[(at + step + SLAB_ENCODER_MODES.length) % SLAB_ENCODER_MODES.length]!;
        host.showHud(`Encoders: ${this.encoderMode.toUpperCase()}`);
        return;
      }
      case "play":
        host.transport(deck, shift ? "cue" : "play");
        return;
      case "rec":
        host.transport(deck, shift ? "sync" : "rec");
        return;
      case "autoset":
        host.transport(deck, "sync");
        return;
      case "left":
        host.transport(deck, shift ? "jump-back-fine" : "jump-back");
        return;
      case "right":
        host.transport(deck, shift ? "jump-forward-fine" : "jump-forward");
        return;
      case "scene-size-down":
        host.transport(deck, "loop-half");
        return;
      case "scene-size-up":
        host.transport(deck, "loop-double");
        return;
      case "note-repeat":
        host.transport(deck, "loop");
        return;
      case "delete":
        host.transport(deck, "eject");
        return;
      case "library":
        host.focusLibrary();
        return;
      case "octave-down":
        // The unit switches its own pad page (1-8); track it for the LEDs.
        this.devicePage = Math.max(0, this.devicePage - 1);
        this.leds.clear();
        return;
      case "octave-up":
        this.devicePage = Math.min(7, this.devicePage + 1);
        this.leds.clear();
        return;
      default:
        // undo, redo, favorite, select-all, focus, dial-mode, shift: not used.
        return;
    }
  }

  private setPage(page: SlabPadPage): void {
    if (page === this.page) return;
    if (this.page !== "deck-select") this.previousPage = this.page;
    if (this.heldPadFx !== null) {
      this.heldPadFx = null;
      this.host.padFx(this.deck, null, 0);
    }
    this.page = page;
  }

  selectDeck(deck: SlabDeck): void {
    if (this.heldPadFx !== null) {
      this.host.padFx(this.deck, null, 0);
      this.heldPadFx = null;
    }
    this.deck = deck;
    this.host.selectDeck(deck);
    this.host.showHud(`SLAB → deck ${deck}`);
  }

  /** Colour numbers for the 16 pads on the current page (0 = off). */
  padColors(): number[] {
    const host = this.host;
    const out: number[] = [];
    for (let pad = 0; pad < 16; pad += 1) {
      let color: string | null = null;
      switch (this.page) {
        case "hot-cue": {
          const state = pad < 8 ? host.padFeedback(this.deck, pad) : host.padFeedback(this.deck, pad - 8, "loop-roll");
          color = state.color ?? (state.active ? "#ffffff" : pad >= 8 ? "#2f3b52" : null);
          break;
        }
        case "sampler":
          color = host.samplerLoaded(this.samplerPair * 16 + pad) ? (this.samplerPair ? "#40d680" : "#8aa2ff") : null;
          break;
        case "stems": {
          if (pad < 8) {
            const state = host.padFeedback(this.deck, pad, "part-fx");
            color = state.active ? "#ffffff" : state.color ?? "#40d680";
          } else {
            color = this.heldPadFx === pad ? "#ffffff" : "#e8567a";
          }
          break;
        }
        case "deck-select":
          if (pad < 4) color = SLAB_DECKS[pad] === this.deck ? "#ffffff" : SLAB_DECK_COLORS[SLAB_DECKS[pad]!];
          break;
      }
      out.push(provisionalColorNumber(color));
    }
    return out;
  }

  /** The LED messages for the current state (documented MIDI-OUT rows only). */
  ledMessages(): number[][] {
    const messages: number[][] = [];
    const colors = this.padColors();
    colors.forEach((value, pad) => messages.push([SLAB_STATUS.notePads, slabPadNote(pad, this.devicePage), value]));
    const on = (flag: boolean): number => (flag ? 0x7f : 0x00);
    messages.push([SLAB_STATUS.noteCh7, 0x70, on(this.page === "hot-cue")]);
    messages.push([SLAB_STATUS.noteCh7, 0x72, on(this.page === "sampler")]);
    messages.push([SLAB_STATUS.noteCh7, 0x75, on(this.page === "deck-select")]);
    messages.push([SLAB_STATUS.noteCh7, 0x77, on(this.page === "stems")]);
    messages.push([SLAB_STATUS.noteCh1, 0x5e, on(this.host.isPlaying(this.deck))]);
    messages.push([SLAB_STATUS.noteCh1, 0x5f, on(this.host.isRecording())]);
    const ring = provisionalColorNumber(SLAB_ENCODER_MODE_COLORS[this.encoderMode]);
    for (const note of SLAB_ENCODER.indicator) messages.push([SLAB_STATUS.noteCh1, note, ring]);
    return messages;
  }

  /** Sends only the LEDs that changed since the last call. */
  syncLeds(): number {
    if (!this.send) return 0;
    let sent = 0;
    for (const message of this.ledMessages()) {
      const key = `${message[0]}:${message[1]}`;
      if (this.leds.get(key) === message[2]) continue;
      this.leds.set(key, message[2]!);
      this.send(message);
      sent += 1;
    }
    return sent;
  }

  /** All LEDs off (on disconnect or app close). */
  blackout(): void {
    if (!this.send) return;
    for (const message of this.ledMessages()) this.send([message[0]!, message[1]!, 0]);
    this.leds.clear();
  }
}

/**
 * Touch strip position (0-1, centre = 0.5) -> the deck filter FX amount.
 * The deck's filter maps amount 0.5-1 to a low-pass opening from ~1.9 kHz to
 * fully open and 0-0.5 to a high-pass rising from ~180 Hz to ~1.9 kHz, so the
 * left half closes a low-pass towards the edge and the right half raises a
 * high-pass towards the edge. Centre (null) means filter off.
 */
export function slabFilterAmount(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  if (v <= 0.5) return 0.5 + v; // 0 -> 0.5 (LP ~1.9 kHz), 0.5 -> 1 (open)
  return v - 0.5; // 0.5 -> 0 (HP ~180 Hz), 1 -> 0.5 (HP ~1.9 kHz)
}

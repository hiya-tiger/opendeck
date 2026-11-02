/**
 * Serato DJ style keyboard shortcuts (D45), as one data table.
 *
 * Every row of Serato DJ's own "Playback Shortcuts" / "Library Shortcuts"
 * screen is here, plus the OpenDecks bindings that existed before (some moved
 * where Serato's map needed their key) and the 4-deck focus keys.
 *
 * Chords are written Windows/Linux style ("Ctrl+Shift+ArrowRight"). On macOS
 * Ctrl means Cmd (metaKey) and Alt means Option, the way Serato's Mac build
 * does it; the physical Control key on a Mac matches nothing.
 *
 * Keys are matched on `KeyboardEvent.code` (the physical key), because Option
 * on macOS changes `event.key` (Option+W is "∑") and Shift changes digits.
 *
 * This file has no DOM access so the whole table can be unit-tested in Node.
 */

export type Side = "left" | "right";
export type Platform = "mac" | "other";
export type Section = "playback" | "library" | "opendecks";

/**
 * implemented: does what Serato does.
 * partial: works, but an approximation of the Serato feature (see `note`).
 * noop: the key is reserved and shows a "not available yet" toast.
 */
export type Status = "implemented" | "partial" | "noop";

export interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  code: string;
}

export interface Binding {
  /** Stable action id; the app implements one handler per id. */
  id: string;
  section: Section;
  /** The label from Serato's screen (or ours for OpenDecks rows). */
  label: string;
  /** Chords for the left deck (or the only chords, for non-deck actions). */
  keys: string[];
  /** Chords for the right deck; present only on per-deck rows. */
  right?: string[];
  /** Serato-style text for the overlay, Windows wording; mac is derived. */
  display: string;
  rightDisplay?: string;
  /** Act on keydown and again on keyup (rewind, fast forward, censor). */
  hold?: boolean;
  /** Fire again on auto-repeat (tempo nudges, list movement, zoom). */
  repeat?: boolean;
  /** Ask before doing it (delete, trash, exit). */
  confirm?: boolean;
  /** Fires even while a text field has focus. "bpm" = only in the BPM editor. */
  inInput?: "always" | "bpm";
  /**
   * Fixed deck for OpenDecks rows that never followed the side focus
   * (Shift+1-8 was always deck B).
   */
  deck?: "A" | "B" | "C" | "D";
  /** 1-based pad/cue number this chord addresses (digit rows). */
  index?: number[];
  rightIndex?: number[];
  status: Status;
  note?: string;
}

const DIGIT = (n: number): string => `Digit${n % 10}`;
const digits = (from: number, to: number): string[] => {
  const out: string[] = [];
  for (let n = from; n <= to; n += 1) out.push(DIGIT(n));
  return out;
};

export const SERATO_KEYMAP: readonly Binding[] = [
  // ------------------------------------------------------------- playback
  { id: "load-selected", section: "playback", label: "Load selected track", keys: ["Shift+ArrowLeft"], right: ["Shift+ArrowRight"], display: "shift + left arrow", rightDisplay: "shift + right arrow", status: "implemented" },
  { id: "double-track", section: "playback", label: "Double loaded track", keys: ["Ctrl+Shift+ArrowRight"], right: ["Ctrl+Shift+ArrowLeft"], display: "control + shift + right arrow", rightDisplay: "control + shift + left arrow", status: "implemented", note: "Copies the other side's track and playhead onto this deck (Instant Double)." },
  { id: "eject", section: "playback", label: "Eject Virtual Deck", keys: ["Shift+Alt+ArrowLeft"], right: ["Shift+Alt+ArrowRight"], display: "shift + alt + left arrow", rightDisplay: "shift + alt + right arrow", status: "implemented" },
  { id: "play-pause", section: "playback", label: "Play/Pause", keys: ["KeyW"], right: ["KeyS"], display: "W", rightDisplay: "S", status: "implemented" },
  { id: "reverse", section: "playback", label: "Reverse play direction", keys: ["KeyQ"], right: ["KeyA"], display: "Q", rightDisplay: "A", status: "implemented", note: "Toggles reverse; press again to play forward." },
  { id: "set-cue", section: "playback", label: "Set Cue Point", keys: digits(1, 5).map((c) => `Ctrl+${c}`), right: digits(6, 10).map((c) => `Ctrl+${c}`), index: [1, 2, 3, 4, 5], rightIndex: [1, 2, 3, 4, 5], display: "control + 1 2 3 4 5", rightDisplay: "control + 6 7 8 9 0", status: "implemented" },
  { id: "cue", section: "playback", label: "Set/Jump to Cue Point", keys: digits(1, 5), right: digits(6, 10), index: [1, 2, 3, 4, 5], rightIndex: [1, 2, 3, 4, 5], display: "1 2 3 4 5", rightDisplay: "6 7 8 9 0", hold: true, status: "implemented", note: "Sets the cue when empty, jumps when set. With SLIP on, releasing the key returns to the timeline." },
  { id: "add-next-cue", section: "playback", label: "Add next Cue Point", keys: ["Alt+Backquote"], right: ["Alt+Minus"], display: "alt + `", rightDisplay: "alt + -", status: "implemented", note: "Sets the first free hot cue (of 8) at the playhead." },
  { id: "temp-cue", section: "playback", label: "Jump to temporary Cue Point", keys: ["KeyI"], right: ["KeyK"], display: "I", rightDisplay: "K", status: "implemented", note: "Jumps to the deck's main (CUE button) cue point." },
  { id: "load-next", section: "playback", label: "Load next track", keys: ["Alt+KeyW"], right: ["Alt+KeyS"], display: "alt + W", rightDisplay: "alt + S", status: "implemented", note: "Next track in the current library view after the one on the deck." },
  { id: "load-prev", section: "playback", label: "Load previous track", keys: ["Alt+KeyQ"], right: ["Alt+KeyA"], display: "alt + Q", rightDisplay: "alt + A", status: "implemented" },
  { id: "rewind", section: "playback", label: "Rewind", keys: ["Alt+KeyE"], right: ["Alt+KeyD"], display: "alt + E", rightDisplay: "alt + D", hold: true, status: "implemented", note: "Scans backwards while held." },
  { id: "fast-forward", section: "playback", label: "Fast forward", keys: ["Alt+KeyR"], right: ["Alt+KeyF"], display: "alt + R", rightDisplay: "alt + F", hold: true, status: "implemented", note: "Scans forwards while held." },
  { id: "tempo-down", section: "playback", label: "Tempo Adjust down", keys: ["KeyE"], right: ["KeyD"], display: "E", rightDisplay: "D", repeat: true, status: "implemented", note: "0.1% per press; holding repeats." },
  { id: "tempo-up", section: "playback", label: "Tempo Adjust up", keys: ["KeyR"], right: ["KeyF"], display: "R", rightDisplay: "F", repeat: true, status: "implemented" },
  { id: "censor", section: "playback", label: "Censor", keys: ["KeyU"], right: ["KeyJ"], display: "U", rightDisplay: "J", hold: true, status: "implemented", note: "Plays backwards while held, then continues where the track would have been." },
  { id: "keylock", section: "playback", label: "Keylock", keys: ["F5"], right: ["F10"], display: "F5", rightDisplay: "F10", status: "implemented" },
  { id: "flip-record", section: "playback", label: "Arm/Disarm/Stop Flip Record", keys: ["Backslash"], display: "\\", status: "noop", note: "OpenDecks has no Flip recorder yet." },

  // -------------------------------------------------------------- library
  { id: "library-move", section: "library", label: "Move up/down through tracks", keys: ["ArrowUp", "ArrowDown"], display: "up/down arrow", repeat: true, status: "implemented" },
  { id: "crate-move", section: "library", label: "Move up/down through crates", keys: ["Ctrl+Shift+ArrowUp", "Ctrl+Shift+ArrowDown"], display: "control + shift + up/down arrow", repeat: true, status: "implemented", note: "Steps through All tracks, playlists, Smart Crates and crates." },
  { id: "shift-focus", section: "library", label: "Shift highlight focus", keys: ["Tab"], display: "tab", status: "implemented", note: "Switches the highlight between the track list and the crate picker; up/down then move in the highlighted one." },
  { id: "search", section: "library", label: "Search", keys: ["Ctrl+KeyF"], display: "control + F", status: "implemented" },
  { id: "crate-search", section: "library", label: "Crate Search", keys: ["Ctrl+Shift+KeyF"], display: "control + shift + F", status: "partial", note: "Focuses the crate picker, where typing jumps to a crate by name." },
  { id: "reveal", section: "library", label: "Reveal track in Explorer (PC) or Finder (Mac)", keys: ["Ctrl+KeyR"], display: "control + R", status: "implemented", note: "Desktop app only; needs a track with a file on disk." },
  { id: "show-in-crates", section: "library", label: "Show track in Crates", keys: ["Ctrl+Shift+KeyR"], display: "control + shift + R", status: "implemented", note: "Lists the crates/playlists holding the track and opens the first." },
  { id: "locate-loaded", section: "library", label: "Locate last loaded track (Press again for other Deck)", keys: ["Ctrl+KeyL"], display: "control + L", status: "implemented" },
  { id: "select-all", section: "library", label: "Select all", keys: ["Ctrl+KeyA"], display: "control + A", status: "implemented" },
  { id: "undo-load", section: "library", label: "Undo track load", keys: ["Ctrl+KeyZ"], display: "control + Z", status: "implemented", note: "Puts back the track (and position) the last load replaced." },
  { id: "delete-track", section: "library", label: "Delete track/crate", keys: ["Ctrl+Delete", "Ctrl+Backspace"], display: "control + delete", confirm: true, status: "implemented", note: "A Mac's delete key (Backspace) works too. Removes from the library only, never from disk. With the crate picker highlighted it deletes that playlist or Smart Crate." },
  { id: "trash-file", section: "library", label: "Send file to trash", keys: ["Ctrl+Shift+Delete", "Ctrl+Shift+Backspace"], display: "control + shift + delete", confirm: true, status: "implemented", note: "Desktop app only; moves the file to the system trash and removes it from the library." },
  { id: "prepare", section: "library", label: "Add track(s) to prepare panel", keys: ["Ctrl+KeyP"], display: "control + P", status: "partial", note: "OpenDecks' Scratchpad is the prepare list: the tracks are starred there." },
  { id: "wave-zoom", section: "library", label: "Zoom main waveform display", keys: ["Equal", "Shift+Equal", "NumpadAdd", "Minus", "NumpadSubtract"], display: "+ or -", repeat: true, status: "implemented" },
  { id: "text-zoom", section: "library", label: "Zoom library text size", keys: ["Ctrl+Equal", "Ctrl+Shift+Equal", "Ctrl+NumpadAdd", "Ctrl+Minus", "Ctrl+NumpadSubtract"], display: "control and + or -", repeat: true, status: "implemented" },
  { id: "new-recording", section: "library", label: "Start new recording (mic, aux, or mix)", keys: ["Ctrl+KeyN"], display: "control + N", status: "implemented", note: "Starts recording the mix; when one is running it says so instead of cutting it." },
  { id: "open-default", section: "library", label: "Open track in default media player", keys: ["Ctrl+KeyO"], display: "control + O", status: "implemented", note: "Desktop app only." },
  { id: "bpm-scale", section: "library", label: "(While editing BPM) Double/Halve BPM", keys: ["Alt+ArrowUp", "Alt+ArrowDown"], display: "alt + up/down arrow", inInput: "bpm", status: "implemented", note: "Double-click a deck's BPM to edit it." },
  { id: "beatgrid-edit", section: "library", label: "Enter Beatgrid Edit Mode", keys: ["Alt+Space"], display: "alt + spacebar (repeat to toggle between decks)", status: "implemented", note: "Left/right arrows slide the grid while in the mode; Escape leaves it." },
  { id: "am-hide", section: "library", label: "Enter Hide Track/Artist ( AM Mode )", keys: ["Alt+Slash"], display: "alt + /", status: "implemented", note: "Masks titles in the library and on the decks." },
  { id: "escape", section: "library", label: "Exit current track search / Exit OpenDecks", keys: ["Escape"], display: "escape", inInput: "always", confirm: true, status: "implemented", note: "Closes what is open first (dialog, BPM edit, grid edit, search); with nothing left it asks before quitting." },

  // ------------------------------------------------------------ OpenDecks
  { id: "focus-left", section: "opendecks", label: "4-deck: left keys target A ↔ C", keys: ["F1"], display: "F1", status: "implemented" },
  { id: "focus-right", section: "opendecks", label: "4-deck: right keys target B ↔ D", keys: ["F6"], display: "F6", status: "implemented" },
  { id: "load-c", section: "opendecks", label: "Load selected track into deck C", keys: ["Ctrl+Shift+Alt+ArrowLeft"], display: "control + shift + alt + left arrow", deck: "C", status: "implemented" },
  { id: "load-d", section: "opendecks", label: "Load selected track into deck D", keys: ["Ctrl+Shift+Alt+ArrowRight"], display: "control + shift + alt + right arrow", deck: "D", status: "implemented" },
  { id: "shortcuts-help", section: "opendecks", label: "Show this screen", keys: ["Shift+Slash"], display: "?", status: "implemented" },
  { id: "play-a", section: "opendecks", label: "Play/Pause deck A", keys: ["Space"], display: "spacebar", deck: "A", status: "implemented" },
  { id: "play-b", section: "opendecks", label: "Play/Pause deck B", keys: ["KeyP"], display: "P", deck: "B", status: "implemented" },
  { id: "cue-b", section: "opendecks", label: "Jump to cue, deck B", keys: ["KeyL"], display: "L", deck: "B", status: "implemented" },
  { id: "sync", section: "opendecks", label: "Sync", keys: ["KeyT"], right: ["KeyG"], display: "T", rightDisplay: "G", status: "implemented", note: "Moved from S / D (Serato uses those)." },
  { id: "crossfader", section: "opendecks", label: "Crossfader nudge", keys: ["ArrowLeft", "ArrowRight"], display: "left/right arrow", repeat: true, status: "implemented" },
  { id: "crossfader-big", section: "opendecks", label: "Crossfader big step", keys: ["Alt+ArrowLeft", "Alt+ArrowRight"], display: "alt + left/right arrow", repeat: true, status: "implemented", note: "Moved from Shift+left/right (Serato's load keys)." },
  { id: "hot-cue-a", section: "opendecks", label: "Hot cues 1-8, deck A", keys: digits(1, 8).map((c) => `Alt+${c}`), index: [1, 2, 3, 4, 5, 6, 7, 8], display: "alt + 1 … 8", deck: "A", hold: true, status: "implemented", note: "Moved from plain 1-8 (Serato's cue keys)." },
  { id: "hot-cue-b", section: "opendecks", label: "Hot cues 1-8, deck B", keys: digits(1, 8).map((c) => `Shift+${c}`), index: [1, 2, 3, 4, 5, 6, 7, 8], display: "shift + 1 … 8", deck: "B", hold: true, status: "implemented" },
  { id: "sampler", section: "opendecks", label: "Sampler pads 1-8 (current bank)", keys: digits(1, 8).map((n) => n.replace("Digit", "Numpad")), index: [1, 2, 3, 4, 5, 6, 7, 8], display: "numpad 1 … 8", status: "implemented" },
  { id: "fullscreen", section: "opendecks", label: "Fullscreen", keys: ["F11"], display: "F11", status: "implemented" },
  { id: "page-zoom", section: "opendecks", label: "Window zoom in / out / reset", keys: ["Ctrl+Alt+Equal", "Ctrl+Alt+Minus", "Ctrl+Alt+Digit0"], display: "control + alt + = / - / 0", status: "implemented", note: "Moved from Ctrl+= / Ctrl+- / Ctrl+0 (library text size and cue 5 in Serato's map)." },
  { id: "reload", section: "opendecks", label: "Reload window (debug)", keys: ["Ctrl+Alt+KeyR"], display: "control + alt + R", status: "implemented", note: "Moved from Ctrl+R (Reveal in Explorer/Finder)." },
];

/** Bindings that existed before D45 and where they went. */
export const MOVED_BINDINGS: readonly { action: string; before: string; now: string }[] = [
  { action: "Play/pause deck A", before: "Q", now: "W (Serato; follows A/C focus), Space still plays deck A" },
  { action: "Jump to cue, deck A", before: "A", now: "I (Serato temporary cue; follows A/C focus)" },
  { action: "Sync deck A / deck B", before: "S / D", now: "T / G (follow the side focus)" },
  { action: "Crossfader big step", before: "Shift+Left / Shift+Right", now: "Alt+Left / Alt+Right" },
  { action: "Hot cues 1-8, deck A", before: "1-8", now: "Alt+1…8 (plain 1-5 / 6-0 are Serato's left/right cues)" },
  { action: "Electron menu: Reload", before: "Ctrl+R", now: "Ctrl+Alt+R" },
  { action: "Electron menu: Force reload", before: "Ctrl+Shift+R", now: "View menu only" },
  { action: "Electron menu: Zoom in / out / actual size", before: "Ctrl+= / Ctrl+- / Ctrl+0", now: "Ctrl+Alt+= / Ctrl+Alt+- / Ctrl+Alt+0" },
];

// ------------------------------------------------------------------ parsing

export function parseChord(text: string): Chord {
  const parts = text.split("+");
  const code = parts.pop()!;
  if (!code) throw new Error(`bad chord ${text}`);
  const mods = new Set(parts);
  for (const mod of mods) if (!["Ctrl", "Shift", "Alt"].includes(mod)) throw new Error(`bad modifier ${mod} in ${text}`);
  return { ctrl: mods.has("Ctrl"), shift: mods.has("Shift"), alt: mods.has("Alt"), code };
}

export function chordKey(chord: Chord): string {
  return `${chord.ctrl ? "Ctrl+" : ""}${chord.shift ? "Shift+" : ""}${chord.alt ? "Alt+" : ""}${chord.code}`;
}

/** The parts of a KeyboardEvent the matcher reads. */
export interface KeyEventLike {
  code: string;
  key?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}

/**
 * The chord a key event is, in table terms. On macOS Cmd is "Ctrl"; a Mac's
 * physical Control key makes the chord unmatched (returns null), and so does
 * Windows/Super on other systems.
 */
export function chordFromEvent(event: KeyEventLike, platform: Platform): Chord | null {
  const primary = platform === "mac" ? event.metaKey : event.ctrlKey;
  const foreign = platform === "mac" ? event.ctrlKey : event.metaKey;
  if (foreign) return null;
  return { ctrl: primary, shift: event.shiftKey, alt: event.altKey, code: event.code };
}

export interface Match {
  binding: Binding;
  /** Which deck side the chord addressed; "left" for non-deck rows. */
  side: Side;
  /** 1-based cue/pad index for digit rows. */
  index?: number;
  /** The table chord that matched, e.g. "Ctrl+Shift+ArrowUp". */
  chord: string;
}

let compiled: Map<string, Match> | null = null;

function compile(): Map<string, Match> {
  const map = new Map<string, Match>();
  const add = (chordText: string, match: Match): void => {
    const key = chordKey(parseChord(chordText));
    const existing = map.get(key);
    if (existing) throw new Error(`keymap conflict on ${key}: ${existing.binding.id} vs ${match.binding.id}`);
    map.set(key, match);
  };
  for (const binding of SERATO_KEYMAP) {
    binding.keys.forEach((chord, i) => add(chord, { binding, side: "left", index: binding.index?.[i], chord }));
    binding.right?.forEach((chord, i) => add(chord, { binding, side: "right", index: binding.rightIndex?.[i], chord }));
  }
  return map;
}

/** Every chord in the table, mapped to its binding; throws on a conflict. */
export function compiledKeymap(): Map<string, Match> {
  compiled ??= compile();
  return compiled;
}

export interface MatchContext {
  /** Focus is in a text field (search, BPM editor, any input/textarea/select). */
  inTextInput: boolean;
  /** Focus is in a deck's BPM editor. */
  inBpmEditor?: boolean;
}

export function matchEvent(event: KeyEventLike, platform: Platform, context: MatchContext): Match | null {
  const chord = chordFromEvent(event, platform);
  if (!chord) return null;
  const match = compiledKeymap().get(chordKey(chord));
  if (!match) return null;
  if (context.inTextInput) {
    const allowed = match.binding.inInput === "always" || (match.binding.inInput === "bpm" && context.inBpmEditor);
    if (!allowed) return null;
  }
  if (event.repeat && !match.binding.repeat) {
    // A held key auto-repeats; one-shot actions fire once, holds stay engaged.
    return null;
  }
  return match;
}

/** The element types where letters and arrows belong to the field, not us. */
export interface TargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image", "hidden"]);

export function isTextInputTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase());
  return false;
}

// ---------------------------------------------------------------- display

/** Serato-style wording for the platform (control → cmd, alt → option on Mac). */
export function displayFor(text: string, platform: Platform): string {
  if (platform !== "mac") return text;
  return text.replace(/\bcontrol\b/g, "cmd").replace(/\balt\b/g, "option");
}

export function platformFrom(value: string | undefined | null): Platform {
  return /darwin|mac/i.test(value ?? "") ? "mac" : "other";
}

// ------------------------------------------------------------ deck focus

export type DeckLetter = "A" | "B" | "C" | "D";

export interface DeckFocus {
  left: "A" | "C";
  right: "B" | "D";
}

export const DEFAULT_FOCUS: DeckFocus = { left: "A", right: "B" };

/** The deck a side's keys act on. In 2-deck mode it is always A or B. */
export function deckForSide(side: Side, focus: DeckFocus, fourDeck: boolean): DeckLetter {
  if (!fourDeck) return side === "left" ? "A" : "B";
  return side === "left" ? focus.left : focus.right;
}

/** F1 / F6: flip one side. Does nothing (returns the same focus) in 2-deck mode. */
export function toggleFocus(focus: DeckFocus, side: Side, fourDeck: boolean): DeckFocus {
  if (!fourDeck) return { ...DEFAULT_FOCUS };
  return side === "left"
    ? { ...focus, left: focus.left === "A" ? "C" : "A" }
    : { ...focus, right: focus.right === "B" ? "D" : "B" };
}

/** Leaving 4-deck mode resets the focus to A/B. */
export function focusForMode(focus: DeckFocus, fourDeck: boolean): DeckFocus {
  return fourDeck ? focus : { ...DEFAULT_FOCUS };
}

/** The other side's deck, for Double ("copy the other deck's track"). */
export function otherSide(side: Side): Side {
  return side === "left" ? "right" : "left";
}

// -------------------------------------------------------- library helpers

/** Next cursor position in a list of ids, clamped to the ends. */
export function moveCursor(ids: readonly string[], cursor: string | null, delta: number): string | null {
  if (!ids.length) return null;
  const at = cursor ? ids.indexOf(cursor) : -1;
  if (at < 0) return delta >= 0 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.max(0, Math.min(ids.length - 1, at + delta))]!;
}

/** The track after/before the deck's track in the view; wraps to the cursor when the deck's track is not in view. */
export function neighbourTrack(ids: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (!ids.length) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (at < 0) return delta > 0 ? ids[0]! : ids[ids.length - 1]!;
  const next = at + delta;
  return next >= 0 && next < ids.length ? ids[next]! : null;
}

/** First empty hot-cue slot (0-based), or -1 when all 8 are set. */
export function firstFreeCue(cues: readonly unknown[], slots = 8): number {
  for (let i = 0; i < slots; i += 1) if (!cues[i]) return i;
  return -1;
}

export const WAVE_SPANS = [2, 4, 6, 8, 12, 16, 24, 32] as const;

/** Zooming in shows fewer seconds. */
export function nextSpan(current: number, zoomIn: boolean): number {
  const spans = WAVE_SPANS as readonly number[];
  let at = spans.indexOf(current);
  if (at < 0) at = spans.findIndex((s) => s >= current);
  if (at < 0) at = spans.length - 1;
  return spans[Math.max(0, Math.min(spans.length - 1, at + (zoomIn ? -1 : 1)))]!;
}

export function nextTextScale(current: number, bigger: boolean): number {
  const next = Math.round((current + (bigger ? 0.1 : -0.1)) * 10) / 10;
  return Math.max(0.7, Math.min(1.8, next));
}

/** Whether a "+"/"-" chord zooms in (true) or out (false). */
export function isZoomIn(code: string): boolean {
  return code === "Equal" || code === "NumpadAdd";
}

/** Undo-load history: what a load replaced, newest last. */
export interface LoadRecord {
  deck: DeckLetter;
  previousTrackId: string | null;
  previousPosition: number;
}

export class LoadHistory {
  private stack: LoadRecord[] = [];
  private loaded: { deck: DeckLetter; trackId: string }[] = [];
  private locateIndex = 0;

  record(deck: DeckLetter, previousTrackId: string | null, previousPosition: number, newTrackId: string): void {
    this.stack.push({ deck, previousTrackId, previousPosition });
    if (this.stack.length > 32) this.stack.shift();
    this.loaded = this.loaded.filter((entry) => entry.deck !== deck);
    this.loaded.push({ deck, trackId: newTrackId });
    this.locateIndex = 0;
  }

  undo(): LoadRecord | null {
    return this.stack.pop() ?? null;
  }

  /** Ctrl+L: the last loaded track first, then each earlier deck's, wrapping. */
  locate(): { deck: DeckLetter; trackId: string } | null {
    if (!this.loaded.length) return null;
    const ordered = [...this.loaded].reverse();
    const entry = ordered[this.locateIndex % ordered.length]!;
    this.locateIndex += 1;
    return entry;
  }

  resetLocate(): void {
    this.locateIndex = 0;
  }
}

/**
 * Deck view helpers shared by the renderer and its tests. They hold the rules
 * that two Oct 31 2026 bugs broke:
 *
 * 1. The vertical waveform switch reached decks A and B only (the renderer
 *    looped over a hardcoded ["A", "B"] list). Orientation now goes to every
 *    deck through applyWaveOrientation, and a deck built later picks up the
 *    current setting.
 * 2. Eject cleared the title and platter art but left the scrolling waveform,
 *    the cue/beatgrid markers and the time readout on screen. resetDeckReadouts
 *    is the one list of what an empty deck shows.
 */

export type DeckLetter = "A" | "B" | "C" | "D";

export const DECK_LETTERS: readonly DeckLetter[] = ["A", "B", "C", "D"];

export interface OrientableWave {
  setVertical(value: boolean): void;
}

/** Applies the waveform orientation to every deck that has a scrolling view. */
export function applyWaveOrientation(
  zooms: Partial<Record<DeckLetter, OrientableWave>>,
  vertical: boolean,
  decks: readonly DeckLetter[] = DECK_LETTERS,
): DeckLetter[] {
  const applied: DeckLetter[] = [];
  for (const deckId of decks) {
    const zoom = zooms[deckId];
    if (!zoom) continue;
    zoom.setVertical(vertical);
    applied.push(deckId);
  }
  return applied;
}

/** The stored switch value ("1" = vertical), read the same way at start-up. */
export function storedWaveVertical(value: string | null | undefined): boolean {
  return value === "1";
}

/** What an empty deck shows. The deck template in index.html uses the same text. */
export const EMPTY_DECK_TEXT = {
  title: "No track",
  sub: "Drop audio or load from the library",
  bpm: "-- BPM",
  key: "--",
  time: "0:00 / 0:00",
  bar: "1.1.1",
  parts: "parts not ready",
} as const;

export interface TextSlot {
  textContent: string | null;
}

export interface ClassSlot {
  classList: { remove(...tokens: string[]): void };
}

export interface DeckReadouts {
  title?: TextSlot | null;
  sub?: TextSlot | null;
  bpm?: TextSlot | null;
  key?: TextSlot | null;
  time?: (TextSlot & Partial<ClassSlot>) | null;
  bar?: TextSlot | null;
  partsState?: TextSlot | null;
}

/** Puts every text readout of a deck back to its empty state. */
export function resetDeckReadouts(refs: DeckReadouts): void {
  if (refs.title) refs.title.textContent = EMPTY_DECK_TEXT.title;
  if (refs.sub) refs.sub.textContent = EMPTY_DECK_TEXT.sub;
  if (refs.bpm) refs.bpm.textContent = EMPTY_DECK_TEXT.bpm;
  if (refs.key) refs.key.textContent = EMPTY_DECK_TEXT.key;
  if (refs.time) {
    refs.time.textContent = EMPTY_DECK_TEXT.time;
    refs.time.classList?.remove("track-end-warn");
  }
  if (refs.bar) refs.bar.textContent = EMPTY_DECK_TEXT.bar;
  if (refs.partsState) refs.partsState.textContent = EMPTY_DECK_TEXT.parts;
}

export function formatDeckClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The elapsed / length readout. An empty deck always shows the empty text,
 * whatever late state (a stem voice, a media element) still reports.
 */
export function deckTimeText(hasTrack: boolean, current: number, duration: number): string {
  if (!hasTrack) return EMPTY_DECK_TEXT.time;
  return `${formatDeckClock(current)} / ${formatDeckClock(duration)}`;
}

/**
 * The saved "last session" (D45): what was on each deck and how the mixer and
 * library looked. Pure data + validation, no DOM, so it is unit-tested; the
 * capture/restore glue lives in app.ts.
 *
 * Tracks are remembered by absolute path and the SHA-256 of their bytes (the
 * same hash the deck, the analysis cache and the stem cache use), so a moved
 * file can be found again and cached analysis/stems are reused.
 */
import { normaliseCues, normaliseLoops, type CueRecord, type SavedLoop } from "../media/cue-store.ts";

export const SESSION_VERSION = 1;
export const DECK_IDS = ["A", "B", "C", "D"] as const;
export type SessionDeckId = (typeof DECK_IDS)[number];

export interface DeckSnapshot {
  deck: SessionDeckId;
  path: string;
  name: string;
  hash: string;
  /** Seconds. */
  position: number;
  cuePoint: number;
  hotCues: (CueRecord | null)[];
  loop: { start: number; end: number; active: boolean; beats: number };
  savedLoops: SavedLoop[];
  tempoPercent: number;
  pitchRange: number;
  keylock: boolean;
  keyShift: number;
  quantize: boolean;
  eq: { high: number; mid: number; low: number };
  trim: number;
  fx: { type: string; wet: number; division: string };
}

export interface MixerSnapshot {
  crossfader: number;
  curve: string;
  reverse: boolean;
  master: number;
  aux: number;
  channels: Partial<Record<SessionDeckId, number>>;
}

export interface LibrarySnapshot {
  view: string;
  filter: string;
  sortKey: string;
  sortDirection: "asc" | "desc";
  colorFilter: string;
}

export interface SessionSnapshot {
  version: typeof SESSION_VERSION;
  savedAt: string;
  fourDecks: boolean;
  decks: DeckSnapshot[];
  mixer: MixerSnapshot;
  library: LibrarySnapshot;
}

const num = (value: unknown, fallback: number, min = -Infinity, max = Infinity): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const str = (value: unknown, max = 2048): string => (typeof value === "string" ? value.slice(0, max) : "");

const DEFAULT_CUE_COLORS = ["#CC0000", "#CC8800", "#0000CC", "#CCCC00", "#00CC00", "#CC00CC", "#00CCCC", "#8800CC"];

export const normaliseDeck = (raw: unknown): DeckSnapshot | null => {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const deck = value.deck as SessionDeckId;
  if (!DECK_IDS.includes(deck)) return null;
  const path = str(value.path);
  const hash = str(value.hash, 128).toLowerCase();
  if (!path || !/^[a-f0-9]{16,128}$/.test(hash)) return null;
  const loop = (value.loop ?? {}) as Record<string, unknown>;
  const eq = (value.eq ?? {}) as Record<string, unknown>;
  const fx = (value.fx ?? {}) as Record<string, unknown>;
  const start = num(loop.start, 0, 0);
  const end = num(loop.end, 0, 0);
  return {
    deck,
    path,
    name: str(value.name, 400) || path.split(/[\\/]/).pop() || "track",
    hash,
    position: num(value.position, 0, 0, 24 * 3600),
    cuePoint: num(value.cuePoint, 0, 0, 24 * 3600),
    hotCues: normaliseCues(value.hotCues, DEFAULT_CUE_COLORS),
    loop: { start, end: end > start ? end : 0, active: end > start && value.loop !== undefined && loop.active === true, beats: num(loop.beats, 4, 1 / 32, 64) },
    savedLoops: normaliseLoops(value.savedLoops),
    tempoPercent: num(value.tempoPercent, 0, -100, 100),
    pitchRange: num(value.pitchRange, 8, 1, 100),
    keylock: value.keylock === true,
    keyShift: Math.round(num(value.keyShift, 0, -12, 12)),
    quantize: value.quantize === true,
    eq: { high: num(eq.high, 0, -60, 12), mid: num(eq.mid, 0, -60, 12), low: num(eq.low, 0, -60, 12) },
    trim: num(value.trim, 1, 0, 4),
    fx: { type: str(fx.type, 40) || "off", wet: num(fx.wet, 0, 0, 1), division: str(fx.division, 10) || "1/4" },
  };
};

/** Validates a saved session; anything unusable becomes `null` (no prompt). */
export const normaliseSession = (raw: unknown): SessionSnapshot | null => {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== SESSION_VERSION) return null;
  const seen = new Set<string>();
  const decks: DeckSnapshot[] = [];
  for (const item of Array.isArray(value.decks) ? value.decks : []) {
    const deck = normaliseDeck(item);
    if (deck && !seen.has(deck.deck)) {
      seen.add(deck.deck);
      decks.push(deck);
    }
  }
  const mixer = (value.mixer ?? {}) as Record<string, unknown>;
  const channelsRaw = (mixer.channels ?? {}) as Record<string, unknown>;
  const channels: Partial<Record<SessionDeckId, number>> = {};
  for (const id of DECK_IDS) if (channelsRaw[id] !== undefined) channels[id] = num(channelsRaw[id], 1, 0, 1.5);
  const library = (value.library ?? {}) as Record<string, unknown>;
  return {
    version: SESSION_VERSION,
    savedAt: str(value.savedAt, 40),
    fourDecks: value.fourDecks === true || decks.some((deck) => deck.deck === "C" || deck.deck === "D"),
    decks,
    mixer: {
      crossfader: num(mixer.crossfader, 0.5, 0, 1),
      curve: str(mixer.curve, 20) || "smooth",
      reverse: mixer.reverse === true,
      master: num(mixer.master, 0.85, 0, 1.5),
      aux: num(mixer.aux, 0, 0, 1.5),
      channels,
    },
    library: {
      view: str(library.view, 200) || "all",
      filter: str(library.filter, 200),
      sortKey: str(library.sortKey, 40) || "title",
      sortDirection: library.sortDirection === "desc" ? "desc" : "asc",
      colorFilter: str(library.colorFilter, 20),
    },
  };
};

/** Something worth offering to resume: at least one deck had a track. */
export const hasResumableDecks = (session: SessionSnapshot | null): session is SessionSnapshot => Boolean(session && session.decks.length);

/** On launch: nothing to resume, ask, or resume straight away. */
export const resumeDecision = (session: SessionSnapshot | null, settings: { alwaysResume: boolean } | null): "none" | "ask" | "auto" => {
  if (!hasResumableDecks(session)) return "none";
  return settings?.alwaysResume ? "auto" : "ask";
};

const fileName = (deck: DeckSnapshot): string => deck.name.replace(/\.[a-z0-9]{2,4}$/i, "");

/** "A: Track One · B: Track Two" for the resume banner. */
export const sessionSummary = (session: SessionSnapshot): string =>
  session.decks.map((deck) => `${deck.deck}: ${fileName(deck)}`).join(" · ");

/** Restore order: A, B, C, D (the decks the user looks at first). */
export const restoreOrder = (session: SessionSnapshot): DeckSnapshot[] =>
  [...session.decks].sort((a, b) => DECK_IDS.indexOf(a.deck) - DECK_IDS.indexOf(b.deck));

/** Where to put the playhead: the saved position, clamped into the (possibly changed) track. */
export const restorePosition = (deck: DeckSnapshot, duration: number): number => {
  if (!(duration > 0)) return 0;
  const target = deck.loop.active && deck.loop.end > deck.loop.start ? Math.min(Math.max(deck.position, deck.loop.start), deck.loop.end) : deck.position;
  return Math.max(0, Math.min(target, Math.max(0, duration - 0.05)));
};

/** Key-shift steps from the deck's current semitones to the saved ones. */
export const keyShiftDelta = (current: number, saved: number): number => Math.round(saved) - Math.round(current);

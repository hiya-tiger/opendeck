import { Mixer, type CrossfaderCurve } from "./engine/mixer.ts";
import { Deck, HOT_CUE_COLORS, type DeckState, type DeckId } from "./engine/deck.ts";
import { analyzeBuffer, formatTime, formatClock, type AnalysisResult } from "./engine/analyze.ts";
import { AnalysisScheduler, WorkerPool, defaultPoolSize, type AnalysisPriority } from "./engine/analysis-pool.ts";
import { beatSeconds, formatBeatPosition, LOOP_BEATS, beatGridToMarkers, markersToBeatGrid } from "./engine/beatgrid.ts";
import { syncDeck } from "./engine/sync.ts";
import { TempoAuthority, type LinkTempoStatus } from "./engine/tempo-authority.ts";
import { FX_DEFS, DIVISIONS, fxDefault, type Division, type FxType } from "./engine/fx.ts";
import { STEMS, type StemId } from "./engine/stems.ts";
import { PARTS, STEM_MODEL, type PartId } from "./engine/parts.ts";
import { Waveform, ZoomWaveform } from "./media/waveform.ts";
import { Library, isAudioFile, type Track } from "./media/library.ts";
import { parseCrate, isSerato } from "./media/serato.ts";
import { readMediaInfo, type Artwork } from "./media/artwork.ts";
import { readSeratoTagsFromFile } from "./media/serato-file.ts";
import { buildSeratoExport } from "./media/serato-export.ts";
import { beatgridTempo, firstSavedLoop } from "./media/serato-import.ts";
import { DEFAULT_SLOT_COLORS, NO_TRACK_COLOR, type BeatGridMarker, type SeratoMarkers } from "./media/serato-tags.ts";
import {
  addSavedLoop,
  cycleCueColor,
  normaliseCues,
  normaliseLoops,
  removeSavedLoop,
  type CueRecord,
  type SavedLoop,
} from "./media/cue-store.ts";
import type { PlayedEntry, TrackSortKey, LivePlaylistRule } from "./media/library-ux.ts";
import { zipSync } from "fflate";
import { artworkQuery, lookupCoverArt, type LookupResult } from "./media/artwork-lookup.ts";
import { PlayQueue, type QueueTrack } from "./streaming/queue.ts";
import { mediaCrates, promptView, tracksFromMedia } from "./media/cdj.ts";
import type { CdjFetchProgress, CdjMediaLibrary, LoadedCue, LoadedTrack, MediaPrompt, ProlinkSettings, ProlinkSnapshot } from "../main/prolink/types.ts";
import { probeKeySystems, widevineStatusText } from "./streaming/drm.ts";
import { createDefaultSources } from "./streaming/index.ts";
import {
  NEEDS_PARTNER_KEY,
  parseStreamTrackKey,
  streamTrackKey,
  type AuthStatus,
  type BrowseNode,
  type CredentialStatus,
  type PlaybackPlan,
  type StreamHttp,
  type StreamRequest,
  type StreamResponse,
  type StreamSource,
  type StreamTrack,
} from "./streaming/source.ts";
import { describeError, libraryFieldsFor, loadStreamTrack, type FetchedAudio } from "./streaming/loader.ts";
import { WhipBroadcaster, type BroadcastStatus } from "./broadcast/whip.ts";
import { normaliseDegrees, pointerAngle, scratchPosition } from "./engine/scratch.ts";
import { Sampler, SAMPLER_BANKS, SAMPLER_SLOTS, type SamplerBank } from "./engine/sampler.ts";
import { ScratchBank } from "./engine/scratch-bank.ts";
import {
  VideoMixer,
  computeAspectRect,
  formatVideoCssFilter,
  isVideoFile,
  shouldResyncVideoElement,
  type VideoBlendMode,
  type VideoScaleMode,
} from "./engine/video-mixer.ts";
import {
  PART_FX_PADS,
  PAD_MODE_DEFS,
  SequenceRecorder,
  beatJumpStep,
  cueLoopRange,
  isPadMode,
  loopRollBeats,
  pitchPlayRate,
  pitchPlaySemitones,
  rollingReleasePosition,
  sliceRange,
  type PadMode,
} from "./engine/pad-modes.ts";
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
  type MidiEvent,
} from "./midi/midi.ts";
import { applyProfile, profileForDevice } from "./midi/profiles.ts";
import { applyWaveOrientation, deckTimeText, resetDeckReadouts, storedWaveVertical } from "./ui/deck-view.ts";

interface NativeAnalysis {
  bpm: number;
  confidence: number;
  beatPhase: number;
  duration: number;
  peaks: number[];
  bands: { low: number[]; mid: number[]; high: number[] };
  key: string;
  camelot: string;
  keyConfidence: number;
}

interface StemManifest {
  version: number;
  model: string;
  modelVersion: string;
  hash: string;
  sampleRate: number;
  frames: number;
  dir?: string;
  parts: Record<PartId, { file: string; bytes: number }>;
}

interface SeparationProgress {
  stage: string;
  percent: number;
  detail: string;
  hash?: string;
  deck?: string;
  provider?: string;
}

interface SeparationRegion {
  deck: string;
  hash: string;
  start: number;
  sampleRate: number;
  totalFrames: number;
  chunksDone: number;
  chunksTotal: number;
  parts: Record<PartId, [Float32Array, Float32Array]>;
}

interface SeratoWritePayload {
  path: string;
  name: string;
  markers: SeratoMarkers;
  beatgrid: BeatGridMarker[] | null;
  meta?: { bpm?: number; key?: string; title?: string; artist?: string };
}

interface SeratoWriteResult {
  ok: boolean;
  written: number;
  skipped: number;
  undoId: string | null;
  detail: string;
}

interface LinkStatusPayload {
  enabled: boolean;
  peerCount: number;
  sessionBpm: number;
  localBpm: number;
  beat: number;
  phase: number;
  quantum: number;
  status: string;
  protocol: string;
  error: string | null;
}

interface DesktopApi {
  platform: string;
  analysis?: {
    fromFile: (path: string) => Promise<NativeAnalysis>;
    fromBytes: (bytes: Uint8Array) => Promise<NativeAnalysis>;
  };
  streaming?: {
    status: () => Promise<{ sources: CredentialStatus[]; widevineBuild: boolean; redirectUri: string }>;
    setKey: (source: string, clientId: string, clientSecret?: string) => Promise<{ ok: boolean; error?: string }>;
    clearKey: (source: string) => Promise<{ ok: boolean }>;
    signIn: (source: string) => Promise<{ ok: boolean; error?: string }>;
    signOut: (source: string) => Promise<{ ok: boolean }>;
    request: (source: string, req: StreamRequest) => Promise<StreamResponse>;
    audio: (source: string, plan: Extract<PlaybackPlan, { kind: "decodable" }>) => Promise<FetchedAudio>;
  };
  recording: { save: (name: string, bytes: Uint8Array) => Promise<{ ok: boolean; path?: string }> };
  rtmp: {
    available: () => Promise<boolean>;
    start: (endpoint: string, key: string) => Promise<{ ok: boolean; detail?: string }>;
    chunk: (chunk: Uint8Array) => Promise<{ ok: boolean }>;
    stop: () => Promise<{ ok: boolean }>;
    onLog: (handler: (payload: unknown) => void) => () => void;
    onExit: (handler: (payload: unknown) => void) => () => void;
  };
  media: {
    fetch: (url: string) => Promise<{ ok: boolean; bytes?: Uint8Array; type?: string; error?: string }>;
    pathForFile?: (file: File) => string;
  };
  separation?: {
    status: () => Promise<{ ready: boolean; path: string; bytes: number; env: boolean; model: typeof STEM_MODEL }>;
    install: () => Promise<{ ready: boolean; path: string; bytes: number }>;
    cache: (request: { hash: string; trackPath?: string | null }) => Promise<{ found: boolean; manifest?: StemManifest }>;
    run: (request: {
      hash: string;
      sampleRate: number;
      left: Float32Array;
      right: Float32Array;
      trackPath?: string | null;
      deck?: string;
      focusFrame?: number;
    }) => Promise<StemManifest & { cancelled?: boolean; provider?: string }>;
    read: (
      dir: string,
      targetRate?: number,
    ) => Promise<{ manifest: StemManifest; sampleRate?: number; frames?: number; parts: Record<PartId, { left: Float32Array; right: Float32Array }> }>;
    cancel?: (deck: string) => Promise<unknown>;
    focus?: (deck: string, hash: string, frame: number) => Promise<unknown>;
    onProgress: (handler: (payload: unknown) => void) => () => void;
    onRegion?: (handler: (payload: unknown) => void) => () => void;
  };
  video?: {
    openOutput: (opts?: { fullscreen?: boolean }) => Promise<{ open: boolean; fullscreen: boolean }>;
    closeOutput: () => Promise<{ open: boolean; fullscreen: boolean }>;
    fullscreenOutput: (fullscreen?: boolean) => Promise<{ open: boolean; fullscreen: boolean }>;
    statusOutput: () => Promise<{ open: boolean; fullscreen: boolean }>;
    syncOutput: (state: unknown) => Promise<{ ok: boolean }>;
    onOutputState: (handler: (payload: unknown) => void) => () => void;
    onOutputClosed: (handler: (payload: unknown) => void) => () => void;
  };
  djmedia?: {
    state: () => Promise<{ snapshot: ProlinkSnapshot; libraries: CdjMediaLibrary[] }>;
    settings: (patch: Partial<ProlinkSettings>) => Promise<ProlinkSnapshot>;
    forget: (mediaKey?: string) => Promise<ProlinkSnapshot>;
    respond: (sourceId: string, action: "add" | "ignore", always: boolean) => Promise<{ ok: boolean; error?: string }>;
    loadTrack: (sourceId: string, trackId: string) => Promise<LoadedTrack>;
    onStatus: (handler: (payload: unknown) => void) => () => void;
    onPrompt: (handler: (payload: unknown) => void) => () => void;
    onPromptCleared: (handler: (payload: unknown) => void) => () => void;
    onLibrary: (handler: (payload: unknown) => void) => () => void;
    onRemoved: (handler: (payload: unknown) => void) => () => void;
    onProgress: (handler: (payload: unknown) => void) => () => void;
  };
  link?: {
    status: () => Promise<LinkStatusPayload>;
    enable: () => Promise<LinkStatusPayload>;
    disable: () => Promise<LinkStatusPayload>;
    setLocalTempo: (bpm: number) => Promise<LinkStatusPayload>;
  };
  serato?: {
    running: () => Promise<boolean>;
    writeTags: (request: { root: string | null; tracks: SeratoWritePayload[] }) => Promise<SeratoWriteResult>;
    undo: () => Promise<SeratoWriteResult>;
    applyCrateColumns?: (request: { sqlitePath?: string; columns: { name: string; width: number }[] }) => Promise<{ ok: boolean; detail: string }>;
  };
  videoOpenOutput?: (fullscreen?: boolean) => Promise<{ open: boolean; fullscreen: boolean }>;
  videoCloseOutput?: () => Promise<{ open: boolean; fullscreen: boolean }>;
  videoFullscreenOutput?: (fullscreen?: boolean) => Promise<{ open: boolean; fullscreen: boolean }>;
  videoSyncOutput?: (state: unknown) => Promise<{ ok: boolean; open: boolean; fullscreen: boolean }>;
}

declare global {
  interface Window {
    opendeckDesktop?: DesktopApi;
    openDeck?: unknown;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const mixer = new Mixer();
const sampler = new Sampler(mixer.ctx, mixer.master);
const scratchBank = new ScratchBank(mixer.ctx, mixer.master);
const videoMixer = new VideoMixer();
const ALL_DECKS: readonly DeckId[] = ["A", "B", "C", "D"] as const;
const decks: Record<DeckId, Deck> = {
  A: mixer.deck("A"),
  B: mixer.deck("B"),
  C: mixer.deck("C"),
  D: mixer.deck("D"),
};
const waves: Partial<Record<DeckId, Waveform>> = {};
const zooms: Partial<Record<DeckId, ZoomWaveform>> = {};
const meta: Partial<Record<DeckId, Track>> = {};
const ui: Partial<Record<DeckId, Record<string, HTMLElement>>> = {};
const synced: Record<DeckId, boolean> = { A: false, B: false, C: false, D: false };
const states: Partial<Record<DeckId, DeckState>> = {};
const savedLoops: Record<DeckId, SavedLoop[]> = { A: [], B: [], C: [], D: [] };
const loopsOpen: Record<DeckId, boolean> = { A: false, B: false, C: false, D: false };
const wasPlaying: Record<DeckId, boolean> = { A: false, B: false, C: false, D: false };
let lastPadVersion: Partial<Record<DeckId, string>> = {};
let rafPending = false;

const padModes: Record<DeckId, PadMode> = { A: "hot-cue", B: "hot-cue", C: "hot-cue", D: "hot-cue" };
const padSequences: Record<DeckId, SequenceRecorder> = {
  A: new SequenceRecorder(),
  B: new SequenceRecorder(),
  C: new SequenceRecorder(),
  D: new SequenceRecorder(),
};
const padSequenceEvents: Record<DeckId, ReturnType<SequenceRecorder["list"]>> = { A: [], B: [], C: [], D: [] };
const sequencePlayback: Partial<
  Record<DeckId, { timer: number; startedAt: number; next: number; cycle: number; loopMs: number }>
> = {};
interface PadHold {
  index: number;
  kind: PadMode;
  startedAt: number;
  position: number;
  rate: number;
  previousRate: number;
  previousKeylock: boolean;
  fromSequence: boolean;
  scratchBank?: boolean;
}

const padHolds: Partial<Record<DeckId, PadHold>> = {};
const partFxMuted: Record<DeckId, Record<PartId, boolean>> = {
  A: { drums: false, bass: false, other: false, vocals: false },
  B: { drums: false, bass: false, other: false, vocals: false },
  C: { drums: false, bass: false, other: false, vocals: false },
  D: { drums: false, bass: false, other: false, vocals: false },
};
const partFxFiltered: Record<DeckId, Record<PartId, boolean>> = {
  A: { drums: false, bass: false, other: false, vocals: false },
  B: { drums: false, bass: false, other: false, vocals: false },
  C: { drums: false, bass: false, other: false, vocals: false },
  D: { drums: false, bass: false, other: false, vocals: false },
};
let samplerBank: SamplerBank = "A";

const desktop = window.opendeckDesktop;

// D35: the single owner of session BPM/beat/phase. Link is an input to it, never
// a second authority, and this object holds no transport handle at all.
const tempoAuthority = new TempoAuthority({
  onPushLink: (bpm) => void desktop?.link?.setLocalTempo(bpm),
});

function toast(message: string, ms = 3200): void {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  window.clearTimeout((toast as unknown as { timer?: number }).timer);
  (toast as unknown as { timer?: number }).timer = window.setTimeout(() => el.classList.add("hidden"), ms);
}

function setEngineState(text: string, live = false): void {
  $("engineState").textContent = text;
  $("engineDot").classList.toggle("live", live);
}

let lastDiagnosticsAt = 0;
function updateEngineDiagnostics(now: number): void {
  if (now - lastDiagnosticsAt < 500) return;
  lastDiagnosticsAt = now;
  const active = decks.A.hasTrack ? decks.A : decks.B.hasTrack ? decks.B : null;
  if (!active) {
    $("engineDiag").textContent = "";
    return;
  }
  const latency = Math.round(active.latencySeconds * 1000);
  $("engineDiag").textContent = `${active.engine} ${latency} ms | ${active.underruns} xruns | ${active.pitchPreserved ? "pitch hold" : "pitch follows tempo"}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/* ---------------------------------------------------------------- decks */

function closeStream(deckId: DeckId): void {
  const refs = ui[deckId];
  if (!refs) return;
  (refs.streamSlot as HTMLElement).replaceChildren();
  (refs.stream as HTMLElement).hidden = true;
  refs.root.classList.remove("streaming");
  (refs.streamTitle as HTMLElement).textContent = "";
}

/** Streamed tracks known to the library, by library id (stream:<source>:<id>). */
const streamTrackMeta = new Map<string, StreamTrack>();

function showMonitorPlayer(deckId: DeckId, title: string, embedUrl: string, label: string): void {
  const refs = ui[deckId];
  if (!refs) return;
  closeStream(deckId);
  decks[deckId].pause();
  const frame = document.createElement("iframe");
  frame.className = "deck-stream-frame";
  frame.src = embedUrl;
  frame.title = `${title}: official player (monitor only)`;
  frame.allow = "autoplay; encrypted-media";
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  (refs.streamSlot as HTMLElement).append(frame);
  (refs.streamTitle as HTMLElement).textContent = `Deck ${deckId} · MONITOR ONLY · ${title}`;
  (refs.streamNote as HTMLElement).textContent = label;
  (refs.stream as HTMLElement).hidden = false;
  refs.root.classList.add("streaming");
}

async function ensureStreamFile(track: Track, deckId: DeckId): Promise<boolean> {
  const key = parseStreamTrackKey(track.id);
  const source = key ? streamSources.get(key.source) : undefined;
  if (!key || !source) {
    toast(`${track.name}: unknown streaming source.`);
    return false;
  }
  const refs = ui[deckId];
  if (refs) {
    refs.title.textContent = track.name;
    refs.sub.textContent = `resolving on ${source.name}…`;
  }
  let meta = streamTrackMeta.get(track.id);
  if (!meta) {
    try {
      meta = await source.metadata(key.id);
      streamTrackMeta.set(track.id, meta);
    } catch (error) {
      toast(describeError(error), 6000);
      return false;
    }
  }
  const fetcher = async (sourceId: string, plan: Extract<PlaybackPlan, { kind: "decodable" }>): Promise<FetchedAudio> =>
    desktop?.streaming ? desktop.streaming.audio(sourceId, plan) : { ok: false, error: "streaming needs the desktop app" };
  const outcome = await loadStreamTrack(source, meta, fetcher, widevineAvailable);
  if (outcome.kind === "unavailable") {
    toast(outcome.reason, 6000);
    if (refs) refs.sub.textContent = outcome.reason;
    return false;
  }
  if (outcome.kind === "monitor") {
    showMonitorPlayer(deckId, `${meta.artist} - ${meta.title}`, outcome.embedUrl, outcome.label);
    toast(`Deck ${deckId}: ${meta.title} plays in ${source.name}'s own player (monitor only).`, 5000);
    return false;
  }
  track.file = outcome.file;
  track.missing = false;
  enqueueAnalysis(track);
  toast(`${outcome.preview ? "Preview clip" : "Full track"} from ${source.name}: ${meta.artist} - ${meta.title}`);
  return true;
}

/** Load a streamed track the way a local file loads: into the library, then onto the deck. */
async function playStreamOnDeck(track: StreamTrack, deckId: DeckId): Promise<void> {
  const source = streamSources.get(track.source);
  if (!source) return;
  if (!source.capabilities.decodable) {
    const outcome = await loadStreamTrack(source, track, async () => ({ ok: false, error: "not decodable" }), widevineAvailable);
    if (outcome.kind === "monitor") showMonitorPlayer(deckId, track.title, outcome.embedUrl, outcome.label);
    else if (outcome.kind === "unavailable") toast(outcome.reason, 6000);
    return;
  }
  const id = streamTrackKey(track);
  streamTrackMeta.set(id, track);
  let entry = library.find(id);
  if (!entry) {
    entry = library.addStreamTrack(libraryFieldsFor(track));
    entry.artwork = track.artworkUrl ?? null;
  }
  await loadTrack(entry, deckId);
  const refs = ui[deckId];
  if (refs && meta[deckId] === entry) {
    // Attribution: credit the artist/uploader and the service on the deck.
    refs.sub.textContent = `${track.artist} · via ${source.name}`;
    refs.sub.title = track.permalink ?? "";
  }
}

function setupScratch(deckId: DeckId): void {
  const refs = ui[deckId];
  if (!refs) return;
  const vinyl = refs.vinyl as HTMLElement;
  const disc = vinyl.querySelector(".vinyl-disc") as HTMLElement | null;
  if (!disc) return;
  vinyl.title = "Drag around the record to scratch";

  let active = false;
  let pointerId = -1;
  let lastAngle = 0;
  let turn = 0;
  let position = 0;
  let wasPlaying = false;
  let centerX = 0;
  let centerY = 0;
  let lastMoveAt = 0;
  let lastFrameAt = 0;
  let frame = 0;

  const deck = decks[deckId];

  const driveScratch = (): void => {
    if (!active) {
      frame = 0;
      return;
    }
    const now = performance.now();
    const dt = Math.min(Math.max((now - lastFrameAt) / 1000, 1 / 1000), 0.1);
    lastFrameAt = now;
    if (now - lastMoveAt > 35) deck.scratchCoast(dt);
    frame = requestAnimationFrame(driveScratch);
  };

  vinyl.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0 || !deck.hasTrack) return;
    const rect = vinyl.getBoundingClientRect();
    centerX = rect.left + rect.width / 2;
    centerY = rect.top + rect.height / 2;
    active = true;
    pointerId = event.pointerId;
    try {
      vinyl.setPointerCapture(pointerId);
    } catch {
      // synthetic pointer events have no capture target
    }
    vinyl.classList.add("scratching");
    lastAngle = pointerAngle(event.clientX, event.clientY, centerX, centerY);
    turn = 0;
    position = deck.currentTime;
    wasPlaying = deck.playing;
    deck.pause();
    deck.beginScratch();
    lastMoveAt = performance.now();
    lastFrameAt = lastMoveAt;
    if (!frame) frame = requestAnimationFrame(driveScratch);
    event.preventDefault();
  });

  vinyl.addEventListener("pointermove", (event: PointerEvent) => {
    if (!active || event.pointerId !== pointerId) return;
    const now = performance.now();
    const angle = pointerAngle(event.clientX, event.clientY, centerX, centerY);
    const delta = normaliseDegrees(angle - lastAngle);
    const dt = Math.min(Math.max((now - lastMoveAt) / 1000, 1 / 1000), 0.1);
    lastAngle = angle;
    lastMoveAt = now;
    turn += delta;
    deck.scratchDrive(delta, dt);
    position = scratchPosition(position, delta, deck.duration);
    deck.seek(position);
    disc.style.transform = `rotate(${turn.toFixed(1)}deg)`;
  });

  const finish = (event: PointerEvent): void => {
    if (!active || event.pointerId !== pointerId) return;
    active = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    deck.endScratch();
    deck.seek(position);
    vinyl.classList.remove("scratching");
    disc.style.transform = "";
    try {
      if (vinyl.hasPointerCapture(pointerId)) vinyl.releasePointerCapture(pointerId);
    } catch {
      // pointer already released
    }
    pointerId = -1;
    if (wasPlaying) void deck.play();
  };

  vinyl.addEventListener("pointerup", finish);
  vinyl.addEventListener("pointercancel", finish);
}

function buildDeck(deckId: DeckId): void {
  const template = $<HTMLTemplateElement>("deckTemplate");
  const node = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  node.dataset.deck = deckId;
  $("deckSlot" + deckId).append(node);

  const refs: Record<string, any> = {
    root: node,
    chip: node.querySelector(".deck-chip"),
    vinyl: node.querySelector(".vinyl"),
    vinylLabel: node.querySelector(".vinyl-label"),
    vinylInitial: node.querySelector(".vinyl-initial"),
    title: node.querySelector(".deck-title"),
    sub: node.querySelector(".deck-sub"),
    bpm: node.querySelector(".deck-bpm"),
    key: node.querySelector(".deck-key"),
    overview: node.querySelector(".wf-overview"),
    zoom: node.querySelector(".wf-zoom"),
    time: node.querySelector(".deck-time"),
    bar: node.querySelector(".deck-bar"),
    tempo: node.querySelector(".deck-tempo"),
    syncChip: node.querySelector(".deck-sync"),
    pads: node.querySelector(".pads"),
    padMode: node.querySelector(".pad-mode") as HTMLSelectElement,
    padModeState: node.querySelector(".pad-mode-state"),
    padSeqState: node.querySelector(".pad-seq-state"),
    play: node.querySelector(".play"),
    cue: node.querySelector(".cue"),
    sync: node.querySelector(".sync"),
    loop: node.querySelector(".loop"),
    loopBeats: node.querySelector(".loop-beats"),
    loopHalf: node.querySelector(".loop-half"),
    loopDouble: node.querySelector(".loop-double"),
    quantize: node.querySelector(".quantize"),
    saveLoop: node.querySelector(".save-loop"),
    savedLoopToggle: node.querySelector(".saved-loop-toggle"),
    savedLoopsPanel: node.querySelector(".saved-loops"),
    jumpBtns: node.querySelector(".jump-btns"),
    pitch: node.querySelector(".pitch") as HTMLInputElement,
    pitchVal: node.querySelector(".pitch-val"),
    pitchRange: node.querySelector(".pitch-range") as HTMLSelectElement,
    keylock: node.querySelector(".keylock"),
    eqHigh: node.querySelector(".eq-high") as HTMLInputElement,
    eqMid: node.querySelector(".eq-mid") as HTMLInputElement,
    eqLow: node.querySelector(".eq-low") as HTMLInputElement,
    trim: node.querySelector(".trim") as HTMLInputElement,
    stems: node.querySelector(".stems"),
    parts: node.querySelector(".parts"),
    partsState: node.querySelector(".parts-state"),
    vocalsOnly: node.querySelector(".vocals-only") as HTMLButtonElement,
    instrumental: node.querySelector(".instrumental") as HTMLButtonElement,
    separateBtn: node.querySelector(".separate-btn") as HTMLButtonElement,
    installModel: node.querySelector(".install-model") as HTMLButtonElement,
    fxType: node.querySelector(".fx-type") as HTMLSelectElement,
    fxWet: node.querySelector(".fx-wet") as HTMLInputElement,
    fxDiv: node.querySelector(".fx-div") as HTMLSelectElement,
    cloneBtn: node.querySelector(".clone-btn") as HTMLButtonElement | null,
    ejectBtn: node.querySelector(".eject-btn") as HTMLButtonElement | null,
    slipToggle: node.querySelector(".slip-toggle") as HTMLButtonElement | null,
    censorBtn: node.querySelector(".censor-btn") as HTMLButtonElement | null,
    keyDown: node.querySelector(".key-down") as HTMLButtonElement | null,
    keyVal: node.querySelector(".key-val") as HTMLButtonElement | null,
    keyUp: node.querySelector(".key-up") as HTMLButtonElement | null,
    gridShiftLeft: node.querySelector(".grid-shift-left") as HTMLButtonElement | null,
    gridDownbeat: node.querySelector(".grid-downbeat") as HTMLButtonElement | null,
    gridShiftRight: node.querySelector(".grid-shift-right") as HTMLButtonElement | null,
    gridHalf: node.querySelector(".grid-half") as HTMLButtonElement | null,
    gridDouble: node.querySelector(".grid-double") as HTMLButtonElement | null,
    gridTap: node.querySelector(".grid-tap") as HTMLButtonElement | null,
    gridLock: node.querySelector(".grid-lock") as HTMLButtonElement | null,
  };
  ui[deckId] = refs;

  const streamPanel = document.createElement("div");
  streamPanel.className = "deck-stream";
  streamPanel.hidden = true;
  streamPanel.innerHTML =
    '<div class="deck-stream-head"><span class="deck-stream-title"></span>' +
    '<button type="button" class="mini deck-stream-close" title="Close stream player">x</button></div>' +
    '<div class="deck-stream-slot"></div>' +
    '<span class="deck-stream-note"></span>';
  node.append(streamPanel);
  refs.stream = streamPanel;
  refs.streamTitle = streamPanel.querySelector(".deck-stream-title");
  refs.streamSlot = streamPanel.querySelector(".deck-stream-slot");
  refs.streamNote = streamPanel.querySelector(".deck-stream-note");
  (streamPanel.querySelector(".deck-stream-close") as HTMLElement).addEventListener("click", () =>
    closeStream(deckId),
  );

  refs.chip.textContent = deckId;
  const deck = decks[deckId];
  const wave = new Waveform(refs.overview as HTMLCanvasElement);
  const zoom = new ZoomWaveform(refs.zoom as HTMLCanvasElement, 8);
  waves[deckId] = wave;
  zooms[deckId] = zoom;
  zoom.setVertical(document.body.classList.contains("vertical-waves"));

  wave.onSeek((seconds) => {
    deck.seek(seconds);
    if (deck.playing) void deck.play();
  });

  setupScratch(deckId);

  for (const mode of PAD_MODE_DEFS) {
    const option = document.createElement("option");
    option.value = mode.id;
    option.textContent = mode.label;
    option.title = mode.hint;
    refs.padMode.append(option);
  }
  refs.padMode.value = padModes[deckId];
  refs.padMode.addEventListener("change", () => {
    const next = refs.padMode.value;
    if (!isPadMode(next)) return;
    padModes[deckId] = next;
    releasePadHold(deckId);
    updatePads(deckId, true);
  });

  for (let i = 0; i < 8; i += 1) {
    const pad = document.createElement("button");
    pad.type = "button";
    pad.className = "pad";
    pad.dataset.index = String(i);
    pad.title = "Click: perform the current pad mode action. Right-click: edit cue.";
    pad.append(String(i + 1));
    const sub = document.createElement("small");
    sub.textContent = "-";
    pad.append(sub);
    pad.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.shiftKey && padModes[deckId] === "scratch") return;
      startPadHold(deckId, i, event);
    });
    pad.addEventListener("pointerup", (event) => {
      if (event.button !== 0) return;
      releasePadHold(deckId);
      if (padModes[deckId] === "hot-cue") deck.releaseHotCue();
    });
    pad.addEventListener("pointercancel", () => releasePadHold(deckId));
    pad.addEventListener("pointerleave", () => releasePadHold(deckId));
    pad.addEventListener("click", (event) => {
      if (event.altKey) {
        const cue = deck.hotCues[i];
        if (cue) {
          deck.setHotCueStyle(i, { color: cycleCueColor(cue.color) });
          persistCues(deckId);
          updatePads(deckId, true);
        }
        return;
      }
      if (event.shiftKey && padModes[deckId] === "scratch") {
        loadScratchPad(deckId, i);
        return;
      }
      if (["loop-roll", "slicer", "pitch-play", "scratch"].includes(padModes[deckId])) return;
      handlePadAction(deckId, i);
    });
    pad.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const cue = deck.hotCues[i];
      if (!cue) return;
      if (event.shiftKey) {
        deck.clearHotCue(i);
      } else {
        const next = window.prompt("Cue name", cue.name ?? "");
        if (next === null) return;
        deck.setHotCueStyle(i, { name: next });
      }
      persistCues(deckId);
      updatePads(deckId, true);
    });
    refs.pads.append(pad);
  }

  for (const value of [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = value < 1 ? `1/${Math.round(1 / value)}` : String(value);
    button.addEventListener("click", () => {
      deck.setLoopBeats(value);
      if (!deck.loopActive) deck.setLoop(deck.currentTime, value, true);
      syncLoopButtons(deckId);
    });
    refs.loopBeats.append(button);
  }

  const pitchRange = refs.pitchRange;
  pitchRange.addEventListener("change", () => {
    const max = Number(pitchRange.value);
    deck.setPitchRange(max);
    refs.pitch.min = String(-max);
    refs.pitch.max = String(max);
    if (Math.abs(deck.tempo) > max) applyTempo(deckId, Math.sign(deck.tempo) * max);
  });


  const refreshGridUi = (): void => {
    const track = meta[deckId];
    if (track) {
      track.bpm = deck.info.bpm;
      track.beatPhase = deck.info.beatPhase;
      track.beatgridLocked = deck.beatgridLocked;
      library.setMeta(track, {});
    }
    refs.bpm.textContent = deck.info.bpm ? `${deck.info.bpm.toFixed(1)} BPM` : "-- BPM";
    zooms[deckId]?.setBpm(deck.info.bpm, deck.info.beatPhase);
    refs.gridLock?.setAttribute("aria-pressed", String(deck.beatgridLocked));
    if (refs.gridLock) refs.gridLock.textContent = deck.beatgridLocked ? "LOCKED" : "LOCK";
  };

  refs.cloneBtn?.addEventListener("click", async () => {
    const sourceOrder: DeckId[] = deckId === "A" ? ["B", "C", "D"] : deckId === "B" ? ["A", "D", "C"] : deckId === "C" ? ["A", "B", "D"] : ["B", "A", "C"];
    const sourceId = sourceOrder.find((id) => decks[id].hasTrack) ?? sourceOrder[0]!;
    if (!decks[sourceId].hasTrack) {
      toast("No active track on opposite deck to clone.");
      return;
    }
    await deck.cloneFrom(decks[sourceId]);
    meta[deckId] = meta[sourceId];
    const track = meta[deckId];
    if (track) {
      refs.title.textContent = track.name;
      refs.sub.textContent = track.file ? track.file.name : track.path;
      setVinylArt(deckId, track.artwork);
      applyTrackToDeck(track, deckId);
    }
    updatePads(deckId, true);
    syncLoopButtons(deckId);
    toast(`Instant Double ${sourceId} → ${deckId}`);
  });

  refs.ejectBtn?.addEventListener("click", () => ejectDeck(deckId));

  refs.slipToggle?.addEventListener("click", () => {
    const enabled = deck.toggleReturnMode();
    refs.slipToggle.setAttribute("aria-pressed", String(enabled));
  });

  if (refs.censorBtn) {
    const stopCensor = (): void => {
      if (!deck.censorActive) return;
      deck.endReverseOnHold();
      refs.censorBtn.setAttribute("aria-pressed", "false");
    };
    refs.censorBtn.addEventListener("pointerdown", (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      deck.beginReverseOnHold();
      refs.censorBtn.setAttribute("aria-pressed", "true");
    });
    refs.censorBtn.addEventListener("pointerup", stopCensor);
    refs.censorBtn.addEventListener("pointercancel", stopCensor);
    refs.censorBtn.addEventListener("pointerleave", stopCensor);
  }

  const updateKeyShiftUi = (): void => {
    if (!refs.keyVal) return;
    const st = deck.pitchShift;
    refs.keyVal.textContent = `${st > 0 ? "+" : ""}${st} st`;
  };
  refs.keyDown?.addEventListener("click", () => {
    deck.shiftKeySemitones(-1);
    updateKeyShiftUi();
  });
  refs.keyUp?.addEventListener("click", () => {
    deck.shiftKeySemitones(1);
    updateKeyShiftUi();
  });
  refs.keyVal?.addEventListener("click", () => {
    deck.resetKeyShift();
    updateKeyShiftUi();
  });

  refs.gridShiftLeft?.addEventListener("click", () => {
    if (deck.beatgridLocked) { toast("Beatgrid is locked."); return; }
    deck.shiftGrid(-0.01);
    refreshGridUi();
  });
  refs.gridShiftRight?.addEventListener("click", () => {
    if (deck.beatgridLocked) { toast("Beatgrid is locked."); return; }
    deck.shiftGrid(0.01);
    refreshGridUi();
  });
  refs.gridDownbeat?.addEventListener("click", () => {
    if (deck.beatgridLocked) { toast("Beatgrid is locked."); return; }
    deck.setGridDownbeatHere();
    refreshGridUi();
  });
  refs.gridHalf?.addEventListener("click", () => {
    if (deck.beatgridLocked) { toast("Beatgrid is locked."); return; }
    deck.scaleGridBpm(0.5);
    refreshGridUi();
  });
  refs.gridDouble?.addEventListener("click", () => {
    if (deck.beatgridLocked) { toast("Beatgrid is locked."); return; }
    deck.scaleGridBpm(2);
    refreshGridUi();
  });
  refs.gridTap?.addEventListener("click", () => {
    if (deck.beatgridLocked) { toast("Beatgrid is locked."); return; }
    deck.tapGridBpm(performance.now());
    refreshGridUi();
  });
  refs.gridLock?.addEventListener("click", () => {
    deck.toggleBeatgridLock();
    refreshGridUi();
  });

  refs.keylock.addEventListener("click", () => {
    deck.setKeylock(!deck.keylockOn);
    refs.keylock.setAttribute("aria-pressed", String(deck.keylockOn));
  });

  refs.play.addEventListener("click", () => toggleDeck(deckId));
  refs.cue.addEventListener("click", () => {
    if (deck.playing) {
      deck.jumpToCue();
      wave.setCue(deck.cuePoint);
    } else {
      deck.setCue(deck.currentTime);
      wave.setCue(deck.cuePoint);
    }
    refs.cue.classList.add("active");
    window.setTimeout(() => refs.cue.classList.remove("active"), 350);
  });
  refs.sync.addEventListener("click", () => applySync(deckId));
  refs.loop.addEventListener("click", () => {
    deck.toggleLoop();
    syncLoopButtons(deckId);
  });
  refs.loopHalf.addEventListener("click", () => {
    deck.halveLoop();
    syncLoopButtons(deckId);
  });
  refs.loopDouble.addEventListener("click", () => {
    deck.doubleLoop();
    syncLoopButtons(deckId);
  });
  refs.quantize.addEventListener("click", () => {
    const next = refs.quantize.getAttribute("aria-pressed") !== "true";
    refs.quantize.setAttribute("aria-pressed", String(next));
    deck.setQuantize(next);
  });
  refs.savedLoopToggle.addEventListener("click", () => {
    loopsOpen[deckId] = !loopsOpen[deckId];
    renderSavedLoops(deckId);
  });
  refs.saveLoop.addEventListener("click", () => {
    if (!(deck.loopEnd > deck.loopStart)) {
      toast("Set a loop before saving it.");
      return;
    }
    const loop: SavedLoop = {
      id: `${deckId}-${Date.now()}-${savedLoops[deckId].length}`,
      start: deck.loopStart,
      end: deck.loopEnd,
      name: `Loop ${savedLoops[deckId].length + 1}`,
      color: "#27AAE1",
      locked: false,
    };
    const next = addSavedLoop(savedLoops[deckId], loop);
    if (next.length === savedLoops[deckId].length) {
      toast("That loop range is already saved.");
      return;
    }
    savedLoops[deckId] = next;
    loopsOpen[deckId] = true;
    persistLoops(deckId);
    renderSavedLoops(deckId);
  });
  refs.jumpBtns.addEventListener("click", (event: MouseEvent) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("button[data-beats]");
    if (!target) return;
    deck.beatJump(Number(target.dataset.beats));
  });

  refs.pitch.addEventListener("input", () => applyTempo(deckId, Number(refs.pitch.value)));
  refs.eqHigh.addEventListener("input", () => deck.setEq("high", Number(refs.eqHigh.value)));
  refs.eqMid.addEventListener("input", () => deck.setEq("mid", Number(refs.eqMid.value)));
  refs.eqLow.addEventListener("input", () => deck.setEq("low", Number(refs.eqLow.value)));
  refs.trim.addEventListener("input", () => deck.setTrim(Number(refs.trim.value)));

  for (const stem of STEMS) {
    const wrap = document.createElement("div");
    wrap.className = "stem";
    wrap.dataset.stem = stem.id;
    wrap.innerHTML = `<div class="stem-label"><span>${stem.short}</span><button type="button" class="stem-mute" title="Mute stem">M</button></div>`;
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.01";
    slider.value = "1";
    slider.setAttribute("aria-label", stem.label);
    slider.addEventListener("input", () => deck.setStemGain(stem.id as StemId, Number(slider.value)));
    wrap.append(slider);
    const mute = wrap.querySelector(".stem-mute") as HTMLButtonElement;
    mute.addEventListener("click", () => {
      const muted = wrap.classList.toggle("muted");
      mute.setAttribute("aria-pressed", String(muted));
      deck.setStemMuted(stem.id as StemId, muted);
    });
    wrap.querySelector(".stem-label")!.addEventListener("dblclick", () => {
      const already = wrap.classList.contains("solo");
      for (const other of refs.stems.querySelectorAll(".stem")) other.classList.remove("solo");
      wrap.classList.toggle("solo", !already);
      deck.setStemSolo(already ? null : (stem.id as StemId));
    });
    refs.stems.append(wrap);
  }

  for (const part of PARTS) {
    const wrap = document.createElement("div");
    wrap.className = "part stem";
    wrap.dataset.part = part.id;
    wrap.innerHTML =
      '<div class="stem-label"><span>' + part.short + '</span>' +
      '<span class="part-buttons">' +
      '<button type="button" class="part-mute" title="Mute ' + part.label + '">M</button>' +
      '<button type="button" class="part-solo" title="Solo ' + part.label + '">S</button>' +
      '<button type="button" class="part-filter" title="Filter ' + part.label + '">F</button>' +
      '<button type="button" class="part-roll" title="Loop ' + part.label + '">R</button>' +
      '<button type="button" class="part-scratch" title="Scratch ' + part.label + '">X</button>' +
      '</span></div>';
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1.5";
    slider.step = "0.01";
    slider.value = "1";
    slider.setAttribute("aria-label", part.label + " level");
    slider.addEventListener("input", () => deck.setPartGain(part.id as PartId, Number(slider.value)));
    wrap.append(slider);
    const mute = wrap.querySelector(".part-mute") as HTMLButtonElement;
    mute.addEventListener("click", () => {
      const muted = !wrap.classList.contains("muted");
      wrap.classList.toggle("muted", muted);
      mute.setAttribute("aria-pressed", String(muted));
      deck.setPartMuted(part.id as PartId, muted);
      refs.instrumental.setAttribute("aria-pressed", String(deck.instrumental));
    });
    const solo = wrap.querySelector(".part-solo") as HTMLButtonElement;
    solo.addEventListener("click", () => {
      const on = deck.soloPart !== part.id;
      deck.setPartSolo(on ? (part.id as PartId) : null);
      for (const other of refs.parts.querySelectorAll(".part")) {
        (other as HTMLElement).classList.toggle("solo", on && other === wrap);
      }
      solo.setAttribute("aria-pressed", String(on));
      refs.vocalsOnly.setAttribute("aria-pressed", String(on && part.id === "vocals"));
      refs.instrumental.setAttribute("aria-pressed", String(deck.instrumental));
    });
    const filter = wrap.querySelector(".part-filter") as HTMLButtonElement;
    filter.addEventListener("click", () => {
      const on = !wrap.classList.contains("filtered");
      wrap.classList.toggle("filtered", on);
      filter.setAttribute("aria-pressed", String(on));
      deck.setPartFilter(part.id as PartId, on);
    });
    const roll = wrap.querySelector(".part-roll") as HTMLButtonElement;
    roll.addEventListener("click", () => {
      const on = deck.partLoop !== part.id;
      if (on) {
        const start = deck.currentTime;
        deck.setPartLoop(part.id as PartId, start, start + beatSeconds(deck.info.bpm || 120));
      } else {
        deck.setPartLoop(null);
      }
      for (const other of refs.parts.querySelectorAll(".part")) (other as HTMLElement).classList.toggle("rolled", on && other === wrap);
      roll.setAttribute("aria-pressed", String(on));
    });
    const scratch = wrap.querySelector(".part-scratch") as HTMLButtonElement;
    let scratchX = 0;
    let scratchAt = 0;
    let scratchHeld = false;
    scratch.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      scratch.setPointerCapture(event.pointerId);
      scratchHeld = deck.beginPartScratch(part.id as PartId);
      if (!scratchHeld) return;
      scratchX = event.clientX;
      scratchAt = performance.now();
      deck.partScratchRate(0);
      scratch.setAttribute("aria-pressed", "true");
    });
    scratch.addEventListener("pointermove", (event) => {
      if (!scratchHeld) return;
      const now = performance.now();
      const dt = Math.max(1, now - scratchAt);
      deck.partScratchRate(Math.max(-3, Math.min(3, ((event.clientX - scratchX) / dt) * 4)));
      scratchX = event.clientX;
      scratchAt = now;
    });
    const stopScratch = (): void => {
      scratchHeld = false;
      deck.endPartScratch();
      scratch.setAttribute("aria-pressed", "false");
    };
    scratch.addEventListener("pointerup", stopScratch);
    scratch.addEventListener("pointercancel", stopScratch);
    refs.parts.append(wrap);
  }

  refs.vocalsOnly.addEventListener("click", () => {
    const on = !deck.vocalsOnly;
    deck.setVocalsOnly(on);
    refs.vocalsOnly.setAttribute("aria-pressed", String(on));
    refs.instrumental.setAttribute("aria-pressed", "false");
    for (const card of refs.parts.querySelectorAll(".part")) {
      const node = card as HTMLElement;
      node.classList.toggle("solo", on && node.dataset.part === "vocals");
      if (on && node.dataset.part === "vocals") node.classList.remove("muted");
    }
  });
  refs.instrumental.addEventListener("click", () => {
    const on = !deck.instrumental;
    deck.setInstrumental(on);
    refs.instrumental.setAttribute("aria-pressed", String(on));
    refs.vocalsOnly.setAttribute("aria-pressed", "false");
    for (const card of refs.parts.querySelectorAll(".part")) {
      const node = card as HTMLElement;
      node.classList.remove("solo");
      if (node.dataset.part === "vocals") {
        node.classList.toggle("muted", on);
        (node.querySelector(".part-mute") as HTMLButtonElement | null)?.setAttribute("aria-pressed", String(on));
      }
    }
  });
  refs.separateBtn.addEventListener("click", () => void separateDeck(deckId));
  refs.installModel.addEventListener("click", () => void installStemModel());

  for (const def of FX_DEFS) {
    const option = document.createElement("option");
    option.value = def.id;
    option.textContent = def.label;
    refs.fxType.append(option);
  }
  for (const division of DIVISIONS) {
    const option = document.createElement("option");
    option.value = division;
    option.textContent = division;
    refs.fxDiv.append(option);
  }
  refs.fxType.addEventListener("change", () => {
    const type = refs.fxType.value as FxType;
    deck.setFx(type);
    const defaults = fxDefault(type);
    refs.fxWet.value = String(defaults.wet);
    deck.setFxWet(defaults.wet);
    refs.fxDiv.value = defaults.division;
    deck.setFxDivision(defaults.division);
    refs.fxDiv.disabled = !FX_DEFS.find((def) => def.id === type)?.beatSynced;
  });
  refs.fxWet.addEventListener("input", () => deck.setFxWet(Number(refs.fxWet.value)));
  refs.fxDiv.addEventListener("change", () => deck.setFxDivision(refs.fxDiv.value as Division));
  refs.fxDiv.disabled = true;

  deck.onUpdate = (state) => {
    states[deckId] = state;
    requestFrame();
  };

  node.addEventListener("dragover", (event) => event.preventDefault());
  node.addEventListener("drop", (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files.length) {
      loadFilesToDeck(event.dataTransfer.files, deckId);
    }
  });
}

/**
 * Eject: stops the deck and returns its whole view to the empty state on
 * every deck (A-D) in either waveform orientation. Before Nov 1 2026 only the
 * title, art and overview were cleared, so the scrolling waveform, markers
 * and time readout stayed, and the peak buffers stayed referenced.
 */
function ejectDeck(deckId: DeckId): boolean {
  const deck = decks[deckId];
  const refs = ui[deckId];
  if (!refs) return false;
  if (!deck.eject()) {
    toast(`Deck ${deckId} is playing with load lock on.`);
    return false;
  }
  closeStream(deckId);
  if (progressive[deckId]) {
    stopProgressive(deckId);
    void desktop?.separation?.cancel?.(deckId);
  }
  releasePadHold(deckId);
  delete meta[deckId];
  synced[deckId] = false;
  refs.sync.classList.remove("active");
  refs.syncChip.classList.add("hidden");
  refs.title.title = "";
  resetDeckReadouts(refs);
  setVinylArt(deckId, null);
  waves[deckId]?.clear();
  zooms[deckId]?.clear();
  resetPartCards(deckId);
  setPartsState(deckId, "parts not ready");
  syncLoopButtons(deckId);
  updatePads(deckId, true);
  requestFrame();
  return true;
}

function toggleDeck(deckId: DeckId): void {
  void mixer.resume();
  decks[deckId].toggle();
  setEngineState(mixer.ctx.state === "running" ? "audio engine running" : "audio engine suspended", mixer.ctx.state === "running");
}

function applyTempo(deckId: DeckId, percent: number): void {
  const deck = decks[deckId];
  const refs = ui[deckId]!;
  const clamped = Math.max(-deck.pitchRangePercent, Math.min(deck.pitchRangePercent, percent));
  (refs.pitch as HTMLInputElement).value = String(clamped);
  refs.pitchVal.textContent = `${clamped >= 0 ? "+" : ""}${clamped.toFixed(1)}%`;
  deck.setTempoPercent(clamped);
  synced[deckId] = false;
  refs.sync.classList.remove("active");
  refs.syncChip.classList.add("hidden");
}

function applySync(deckId: DeckId): void {
  const otherId: DeckId = deckId === "A" ? "B" : "A";
  const deck = decks[deckId];
  const master = decks[otherId];
  if (!deck.info.bpm || !master.info.bpm) {
    toast("Load analysed tracks on both decks to sync.");
    return;
  }
  const result = syncDeck({
    masterBpm: master.info.bpm,
    targetBpm: deck.info.bpm,
    masterPosition: master.currentTime,
    targetPosition: deck.currentTime,
    masterPhase: master.info.beatPhase,
    targetPhase: deck.info.beatPhase,
    maxTempoPercent: deck.pitchRangePercent,
  });
  applyTempo(deckId, result.tempoPercent);
  deck.seek(Math.max(0, result.seekTo));
  synced[deckId] = true;
  const refs = ui[deckId]!;
  refs.sync.classList.add("active");
  refs.syncChip.classList.remove("hidden");
  if (master.playing && !deck.playing) void deck.play();
  toast(`${deckId} synced to ${masterIdLabel(otherId)} · ${result.tempoPercent >= 0 ? "+" : ""}${result.tempoPercent.toFixed(1)}%`);
}

const masterIdLabel = (id: DeckId): string => `deck ${id}`;

function syncLoopButtons(deckId: DeckId): void {
  const deck = decks[deckId];
  const refs = ui[deckId]!;
  for (const button of Array.from(refs.loopBeats.querySelectorAll("button"))) {
    const value = button.textContent === "1/8" ? 1 / 8 : button.textContent === "1/4" ? 1 / 4 : button.textContent === "1/2" ? 1 / 2 : Number(button.textContent);
    button.classList.toggle("active", Math.abs(value - deck.loopBeats) < 1e-6);
  }
  refs.loop.classList.toggle("active", deck.loopActive);
  refs.loop.setAttribute("aria-pressed", String(deck.loopActive));
  waves[deckId]?.setLoop(deck.loopActive ? { start: deck.loopStart, end: deck.loopEnd } : null);
  zooms[deckId]?.setLoop(deck.loopActive ? { start: deck.loopStart, end: deck.loopEnd } : null);
}

function loopSignature(deck: Deck): string {
  return `${deck.loopActive}:${deck.loopStart.toFixed(3)}:${deck.loopEnd.toFixed(3)}:${deck.loopBeats}`;
}

/* ------------------------------------------------------------- analysis */

async function nativeAnalysis(track: Track, data: ArrayBuffer | null): Promise<NativeAnalysis | null> {
  const api = desktop?.analysis;
  if (!api) return null;
  try {
    if (data) return await api.fromBytes(new Uint8Array(data));
    if (/^[a-zA-Z]:[\\/]|^\//.test(track.path)) return await api.fromFile(track.path);
  } catch (error) {
    console.warn("native analysis unavailable, falling back", error);
  }
  return null;
}

function setVinylArt(deckId: DeckId, artwork: string | null): void {
  const refs = ui[deckId];
  if (!refs) return;
  refs.vinyl.classList.toggle("has-art", Boolean(artwork));
  refs.vinylLabel.style.backgroundImage = artwork ? `url("${artwork}")` : "";
  refs.vinylInitial.textContent = deckId;
}

function applyArtwork(track: Track, art: Artwork): void {
  const copy = new Uint8Array(art.data.length);
  copy.set(art.data);
  track.artwork = URL.createObjectURL(new Blob([copy], { type: art.mime }));
  for (const deckId of ["A", "B"] as const) {
    if (meta[deckId] === track) setVinylArt(deckId, track.artwork);
  }
}

const artworkLookups = new WeakSet<Track>();
const artworkCache = new Map<string, Promise<LookupResult | null>>();

function withTimeout<T>(promise: Promise<T>, ms = 7000): Promise<T | null> {
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms)),
  ]);
}

async function fetchArtworkText(url: string): Promise<string | null> {
  if (desktop?.media) {
    const native = await withTimeout(desktop.media.fetch(url));
    if (native?.ok && native.bytes) return new TextDecoder().decode(native.bytes);
  }
  try {
    const response = await withTimeout(fetch(url));
    if (response?.ok) return await response.text();
  } catch {
    // offline or blocked
  }
  return null;
}

async function fetchArtworkBytes(url: string): Promise<Uint8Array | null> {
  if (desktop?.media) {
    const native = await withTimeout(desktop.media.fetch(url));
    if (native?.ok && native.bytes) return native.bytes;
  }
  try {
    const response = await withTimeout(fetch(url));
    if (response?.ok) return new Uint8Array(await response.arrayBuffer());
  } catch {
    // offline or blocked
  }
  return null;
}

async function lookupArtwork(track: Track, query: string): Promise<void> {
  if (track.artwork || artworkLookups.has(track) || !query) return;
  artworkLookups.add(track);
  let pending = artworkCache.get(query);
  if (!pending) {
    pending = lookupCoverArt(query, { text: fetchArtworkText, bytes: fetchArtworkBytes });
    artworkCache.set(query, pending);
  }
  const result = await pending;
  if (result && !track.artwork) applyArtwork(track, result);
}

async function extractArtwork(track: Track, data: ArrayBuffer | null): Promise<void> {
  if (track.artwork) return;
  try {
    const info = data ? readMediaInfo(data) : null;
    if (info?.artwork) {
      applyArtwork(track, info.artwork);
      return;
    }
    void lookupArtwork(track, artworkQuery(info, track.name)).catch((error) =>
      console.warn("artwork lookup failed", track.name, error),
    );
  } catch (error) {
    console.warn("artwork extraction failed", track.name, error);
  }
}

/* Analysis runs on a pool of workers (D41): one per spare core, up to 8.
 * Tracks just loaded onto a deck jump ahead of library batches, at most
 * pool-size tracks are read/decoded at once, and a worker that fails takes
 * only its own track down (that track is retried on the main thread). */
const nativeResults = new Map<string, NativeAnalysis>();

const decodeForAnalysis = async (track: Track): Promise<AudioBuffer | null> => {
  const data = track.file ? await track.file.arrayBuffer() : null;
  await extractArtwork(track, data);
  const native = await nativeAnalysis(track, data);
  if (native) {
    nativeResults.set(track.id, native);
    return null;
  }
  if (!data) return null;
  return mixer.ctx.decodeAudioData(data);
};

const analysisPool = new WorkerPool<AnalysisResult>({
  size: defaultPoolSize(navigator.hardwareConcurrency),
  create: () => new Worker("analysis-worker.js"),
});

const analysisScheduler = new AnalysisScheduler<Track, AudioBuffer, AnalysisResult>(analysisPool, {
  key: (track) => track.id,
  decode: decodeForAnalysis,
  toMessage: (buffer) => {
    // Copies (an AudioBuffer's own storage cannot be transferred), then the
    // copies are transferred and the AudioBuffer is dropped.
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice());
    return {
      payload: { sampleRate: buffer.sampleRate, length: buffer.length, duration: buffer.duration, channels },
      transfer: channels.map((channel) => channel.buffer),
    };
  },
  fallback: async (track) => {
    const data = track.file ? await track.file.arrayBuffer() : null;
    if (!data) throw new Error("no audio to analyse");
    return analyzeBuffer(await mixer.ctx.decodeAudioData(data), 2000);
  },
});

async function analyseTrack(track: Track, priority: AnalysisPriority): Promise<void> {
  const result = await analysisScheduler.analyse(track, priority);
  const native = nativeResults.get(track.id);
  nativeResults.delete(track.id);
  if (result) {
    track.bpm = result.bpm;
    track.beatPhase = result.beatPhase;
    track.key = result.key.key;
    track.camelot = result.key.camelot;
    track.duration = result.duration;
    track.peaks = result.peaks;
    track.bands = result.bands;
  } else if (native) {
    track.bpm = native.bpm;
    track.beatPhase = native.beatPhase;
    track.key = native.key;
    track.camelot = native.camelot;
    track.duration = native.duration;
    track.peaks = Float32Array.from(native.peaks);
    track.bands = {
      low: Float32Array.from(native.bands.low),
      mid: Float32Array.from(native.bands.mid),
      high: Float32Array.from(native.bands.high),
    };
  } else {
    return;
  }
  track.analyzed = true;
  library.setMeta(track, {});
  for (const deckId of ALL_DECKS) {
    if (meta[deckId] === track) {
      applyTrackToDeck(track, deckId);
      setVinylArt(deckId, track.artwork);
    }
  }
}

function enqueueAnalysis(track: Track, priority: AnalysisPriority = "background"): void {
  if (track.analyzed || (!track.file && !desktop?.analysis)) return;
  if (track.queued) {
    // Already waiting: a deck load moves it to the front.
    if (priority === "deck") void analysisScheduler.analyse(track, "deck").catch(() => undefined);
    return;
  }
  track.queued = true;
  void analyseTrack(track, priority)
    .catch((error) => {
      console.warn("analysis failed", track.name, error);
      track.bpm = 0;
      track.key = "--";
      track.analyzed = true;
      library.setMeta(track, {});
    })
    .finally(() => {
      track.queued = false;
    });
}

/* -------------------------------------------------------------- stems */

const separating: Partial<Record<DeckId, boolean>> = {};

const trackPathFor = (track: Track | null): string | null => {
  if (!track) return null;
  if (track.file && desktop?.media.pathForFile) {
    try {
      const filePath = desktop.media.pathForFile(track.file);
      if (filePath) return filePath;
    } catch {
      // fall through to the stored path
    }
  }
  if (track.path && /^[a-zA-Z]:[\\/]|^\//.test(track.path)) return track.path;
  return null;
};

const setPartsState = (deckId: DeckId, text: string): void => {
  const refs = ui[deckId] as any;
  if (!refs) return;
  refs.partsState.textContent = text;
  refs.separateBtn.disabled = Boolean(separating[deckId]);
  refs.installModel.textContent = separating[deckId] ? "INSTALLING..." : "INSTALL MODEL";
};

const resetPartCards = (deckId: DeckId): void => {
  const refs = ui[deckId] as any;
  if (!refs) return;
  refs.vocalsOnly.setAttribute("aria-pressed", "false");
  refs.instrumental.setAttribute("aria-pressed", "false");
  for (const card of refs.parts.querySelectorAll(".part")) {
    const node = card as HTMLElement;
    node.classList.remove("muted", "solo", "filtered", "rolled");
    for (const button of node.querySelectorAll("button")) button.setAttribute("aria-pressed", "false");
  }
};

const loadStemManifest = async (deckId: DeckId, manifest: StemManifest): Promise<boolean> => {
  const api = desktop?.separation;
  if (!api || !manifest.dir) return false;
  const deck = decks[deckId];
  // Ask for the deck's own rate: a 44.1 kHz cache in a 48 kHz context used to
  // play ~9% fast through the direct engine.
  const targetRate = deck.audioBuffer?.sampleRate ?? deck.ctx.sampleRate;
  const result = await api.read(manifest.dir, targetRate);
  const rate = result.sampleRate ?? result.manifest.sampleRate;
  const buffers: Partial<Record<PartId, AudioBuffer>> = {};
  for (const part of PARTS) {
    const data = result.parts[part.id];
    if (!data) continue;
    const buffer = deck.ctx.createBuffer(2, data.left.length, rate);
    buffer.copyToChannel(data.left as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(data.right as Float32Array<ArrayBuffer>, 1);
    buffers[part.id] = buffer;
  }
  // Ejected or replaced while the cache was read: do not revive an empty deck.
  if (!deck.hasTrack || deck.audioHash !== manifest.hash) return false;
  await deck.loadStems(buffers, { live: true });
  setPartsState(deckId, "4 parts ready");
  return deck.hasStems;
};

/* Progressive separation: regions stream in from the playhead outward. The
 * deck switches to part voices on the first one; unfinished audio is the full
 * mix split evenly over the four parts, so it still plays (and sums back to
 * the mix) until its region lands. */
interface ProgressiveStems {
  hash: string;
  mix: AudioBuffer;
  started: boolean;
  chain: Promise<void>;
  done: number;
  total: number;
  provider: string;
  lastFocus: number;
  timer: ReturnType<typeof setInterval> | null;
}

const progressive: Partial<Record<DeckId, ProgressiveStems>> = {};

const placeholderStems = (deck: Deck, mix: AudioBuffer): Partial<Record<PartId, AudioBuffer>> => {
  const quarter = [0, 1].map((channel) => {
    const source = mix.getChannelData(Math.min(channel, mix.numberOfChannels - 1));
    const out = new Float32Array(source.length);
    for (let i = 0; i < source.length; i += 1) out[i] = source[i] * 0.25;
    return out;
  });
  const buffers: Partial<Record<PartId, AudioBuffer>> = {};
  for (const part of PARTS) {
    const buffer = deck.ctx.createBuffer(2, mix.length, mix.sampleRate);
    buffer.copyToChannel(quarter[0], 0);
    buffer.copyToChannel(quarter[1], 1);
    buffers[part.id] = buffer;
  }
  return buffers;
};

const stopProgressive = (deckId: DeckId): void => {
  const state = progressive[deckId];
  if (state?.timer) clearInterval(state.timer);
  delete progressive[deckId];
};

const focusFrameFor = (deck: Deck, sampleRate: number): number => {
  const seconds = deck.playing || deck.currentTime > 0 ? deck.currentTime : deck.cuePoint;
  return Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * sampleRate));
};

desktop?.separation?.onRegion?.((payload) => {
  const region = payload as SeparationRegion;
  const deckId = region.deck as DeckId;
  const state = progressive[deckId];
  const deck = decks[deckId];
  if (!state || !deck || state.hash !== region.hash || deck.audioHash !== region.hash) return;
  state.chain = state.chain.then(async () => {
    if (progressive[deckId] !== state) return;
    if (!state.started) {
      await deck.loadStems(placeholderStems(deck, state.mix), { live: true });
      state.started = true;
    }
    deck.patchStems(region.start, region.parts);
    state.done = region.chunksDone;
    state.total = region.chunksTotal;
    setPartsState(deckId, `parts ${Math.round((region.chunksDone / region.chunksTotal) * 100)}% - live where ready${state.provider ? ` (${state.provider})` : ""}`);
  }).catch(() => undefined);
});

const refreshParts = async (deckId: DeckId): Promise<void> => {
  const refs = ui[deckId] as any;
  const deck = decks[deckId];
  if (!refs) return;
  resetPartCards(deckId);
  const api = desktop?.separation;
  // A different track on this deck: stop separating the old one (the worker
  // drops it at the next chunk unless another deck still wants it).
  const running = progressive[deckId];
  if (running && running.hash !== deck.audioHash) {
    stopProgressive(deckId);
    void api?.cancel?.(deckId);
  }
  if (!api) {
    setPartsState(deckId, "parts need the desktop app");
    refs.separateBtn.disabled = true;
    return;
  }
  try {
    const status = await api.status();
    refs.installModel.classList.toggle("hidden", status.ready);
    if (!deck.audioHash) {
      setPartsState(deckId, "parts need a local file");
      return;
    }
    const track = meta[deckId];
    const cache = await api.cache({ hash: deck.audioHash, trackPath: trackPathFor(track ?? null) });
    if (cache.found && cache.manifest) {
      setPartsState(deckId, "loading cached parts...");
      if (await loadStemManifest(deckId, cache.manifest)) return;
    }
    setPartsState(deckId, status.ready ? "not separated" : "model not installed");
    if (status.ready) void separateDeck(deckId);
  } catch (error) {
    setPartsState(deckId, `parts unavailable: ${(error as Error).message}`);
  }
};

const separateDeck = async (deckId: DeckId): Promise<void> => {
  const api = desktop?.separation;
  const deck = decks[deckId];
  const refs = ui[deckId] as any;
  if (!api || !refs || separating[deckId]) return;
  const track = meta[deckId];
  if (!track || !deck.audioBuffer || !deck.audioHash) {
    toast("Load a local track before separating parts.");
    return;
  }
  const startHash = deck.audioHash;
  separating[deckId] = true;
  refs.separateBtn.disabled = true;
  try {
    let status = await api.status();
    if (!status.ready) {
      setPartsState(deckId, "installing stem model (166 MB)...");
      refs.installModel.classList.remove("hidden");
      await api.install();
      status = await api.status();
      if (!status.ready) throw new Error("Model install did not complete");
      refs.installModel.classList.add("hidden");
      toast("Stem model installed.");
    }
    const mix = deck.audioBuffer;
    if (!mix || deck.audioHash !== startHash) return;
    // IPC copies the channels itself; no extra slice() here.
    const left = mix.getChannelData(0);
    const right = mix.numberOfChannels > 1 ? mix.getChannelData(1) : left;
    stopProgressive(deckId);
    const state: ProgressiveStems = {
      hash: startHash,
      mix,
      started: false,
      chain: Promise.resolve(),
      done: 0,
      total: 0,
      provider: "",
      lastFocus: focusFrameFor(deck, mix.sampleRate),
      timer: null,
    };
    progressive[deckId] = state;
    // Follow the playhead: if the DJ jumps, separate from there next.
    state.timer = setInterval(() => {
      if (progressive[deckId] !== state || !api.focus) return;
      const frame = focusFrameFor(deck, mix.sampleRate);
      if (Math.abs(frame - state.lastFocus) > mix.sampleRate * 4) {
        state.lastFocus = frame;
        void api.focus(deckId, startHash, frame);
      }
    }, 1000);
    setPartsState(deckId, "separating parts...");
    const manifest = await api.run({
      hash: startHash,
      sampleRate: mix.sampleRate,
      left,
      right,
      trackPath: trackPathFor(track),
      deck: deckId,
      focusFrame: state.lastFocus,
    });
    if (manifest.cancelled || deck.audioHash !== manifest.hash) return;
    await state.chain;
    if (state.started && deck.hasStems) {
      // Every region is already in the deck: no need to read the cache back.
      deck.finishStems();
      setPartsState(deckId, `4 parts ready${manifest.provider ? ` (${manifest.provider})` : ""}`);
    } else {
      await loadStemManifest(deckId, manifest);
    }
    toast("Parts separated.");
  } catch (error) {
    toast(`Could not separate parts: ${(error as Error).message}`);
    setPartsState(deckId, "separation failed");
  } finally {
    if (progressive[deckId]?.hash === startHash) stopProgressive(deckId);
    separating[deckId] = false;
    refs.separateBtn.disabled = false;
  }
  if (deck.audioHash !== startHash) void refreshParts(deckId);
};

const installStemModel = async (): Promise<void> => {
  const api = desktop?.separation;
  if (!api) return;
  try {
    const status = await api.status();
    if (status.ready) return;
    await api.install();
    for (const deckId of ALL_DECKS) {
      const refs = ui[deckId];
      if (!refs) continue;
      refs.installModel.classList.add("hidden");
      if (!decks[deckId].hasStems) {
        setPartsState(deckId, "model ready, not separated");
        if (decks[deckId].hasTrack) void separateDeck(deckId);
      }
    }
    toast("Stem model installed.");
  } catch (error) {
    toast(`Model install failed: ${(error as Error).message}`);
  }
};

desktop?.separation?.onProgress((payload) => {
  const progress = payload as SeparationProgress;
  for (const deckId of ALL_DECKS) {
    if (!separating[deckId]) continue;
    if (progress.deck && progress.deck !== deckId) continue;
    const state = progressive[deckId];
    if (state && progress.provider) state.provider = progress.provider;
    // Once parts are playing, the region handler owns the status line.
    if (state?.started && progress.stage === "separate") continue;
    const hashMatches = !progress.hash || decks[deckId].audioHash === progress.hash;
    if (!hashMatches) continue;
    setPartsState(deckId, `${progress.stage} ${progress.percent}% - ${progress.detail}`);
  }
});

/* -------------------------------------------------------------- loading */

const mediaCues = new Map<string, LoadedCue[]>();

async function ensureMediaFile(track: Track, deckId: DeckId): Promise<boolean> {
  if (track.source === "stream" && !track.file) return ensureStreamFile(track, deckId);
  if (!track.media || track.file) return true;
  const api = desktop?.djmedia;
  if (!api) return false;
  const refs = ui[deckId];
  if (refs) {
    refs.title.textContent = track.name;
    refs.sub.textContent = track.media.origin === "cdj" ? "fetching from CDJ…" : "reading from USB drive…";
  }
  const result = await api.loadTrack(track.media.sourceId, track.media.trackId);
  if (!result.ok || !result.bytes) {
    toast(`Could not load ${track.name}: ${result.error ?? "no data"}`);
    if (refs) refs.sub.textContent = result.error ?? "load failed";
    return false;
  }
  const name = result.name || `${track.name}.mp3`;
  track.file = new File([result.bytes as BlobPart], name, { type: mimeFor(name) });
  if (result.cues?.length) mediaCues.set(track.id, result.cues);
  return true;
}

function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    { mp3: "audio/mpeg", wav: "audio/wav", aif: "audio/aiff", aiff: "audio/aiff", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac" } as Record<string, string>
  )[ext] ?? "application/octet-stream";
}

function applyMediaCues(track: Track, deckId: DeckId): boolean {
  const cues = mediaCues.get(track.id);
  if (!cues?.length || meta[deckId] !== track) return false;
  const deck = decks[deckId];
  let any = false;
  for (const cue of cues) {
    if (cue.index < 0 || cue.index >= 8) continue;
    deck.hotCues[cue.index] = { time: cue.timeMs / 1000, color: cue.color ?? HOT_CUE_COLORS[cue.index % HOT_CUE_COLORS.length], name: cue.name };
    any = true;
  }
  if (any) {
    updatePads(deckId, true);
    persistCues(deckId);
  }
  return any;
}

async function loadTrack(track: Track, deckId: DeckId): Promise<void> {
  if (!(await ensureMediaFile(track, deckId))) return;
  const source = track.file ?? track.url;
  if (!source) {
    toast("This crate entry has no linked file yet.");
    return;
  }
  closeStream(deckId);
  const deck = decks[deckId];
  const refs = ui[deckId]!;
  try {
    await deck.load(source as File | string, {
      id: track.id,
      title: track.name,
      bpm: track.bpm,
      beatPhase: track.beatPhase,
      key: track.key,
      camelot: track.camelot,
    });
  } catch (error) {
    toast(`Could not load ${track.name}: ${(error as Error).message}`);
    return;
  }
  meta[deckId] = track;
  deck.setBpm(track.bpm || 0, track.beatPhase || 0);
  deck.setQuantize(refs.quantize.getAttribute("aria-pressed") === "true");
  deck.setPitchRange(Number((refs.pitchRange as HTMLSelectElement).value));
  applyTempo(deckId, 0);
  refs.title.textContent = track.name;
  refs.title.title = track.path || track.name;
  refs.sub.textContent = track.file ? track.file.name : track.path;
  setVinylArt(deckId, track.artwork);
  refs.bpm.textContent = track.bpm ? `${track.bpm.toFixed(1)} BPM` : "analysing…";
  refs.key.textContent = track.key && track.key !== "--" ? `${track.camelot} ${track.key}` : "--";
  refs.time.textContent = `0:00 / ${formatTime(track.duration)}`;
  refs.bar.textContent = "1.1.1";
  waves[deckId]?.clear();
  // The scrolling view must not keep the previous track's peaks until the new
  // analysis lands.
  zooms[deckId]?.clear();
  zooms[deckId]?.setBpm(track.bpm, track.beatPhase);
  waves[deckId]?.setCue(deck.cuePoint);
  syncLoopButtons(deckId);
  const hadLocalCues = loadCues(deckId, track.id);
  loadLoops(deckId, track.id);
  if (!hadLocalCues && !applyMediaCues(track, deckId)) void applySeratoCues(track, deckId);
  if (track.analyzed) applyTrackToDeck(track, deckId);
  else enqueueAnalysis(track, "deck");
  if (track.file && isVideoFile(track.file)) {
    loadVideoOntoDeck(deckId, track.file);
  }
  await mixer.resume();
  setEngineState("audio engine running", true);
  void refreshParts(deckId);
}

function applyTrackToDeck(track: Track, deckId: DeckId): void {
  const deck = decks[deckId];
  const refs = ui[deckId]!;
  if (meta[deckId] !== track) return;
  deck.setBpm(track.bpm, track.beatPhase);
  refs.bpm.textContent = track.bpm ? `${track.bpm.toFixed(1)} BPM` : "no BPM";
  refs.key.textContent = track.key && track.key !== "--" ? `${track.camelot} ${track.key}` : "--";
  if (track.peaks && track.duration) {
    waves[deckId]?.setPeaks(track.peaks, track.duration, track.bands ?? undefined);
    zooms[deckId]?.setPeaks(track.peaks, track.duration, track.bands ?? undefined);
  }
  zooms[deckId]?.setBpm(track.bpm, track.beatPhase);
  if (deck.fx !== "off") deck.setFx(deck.fx);
}

function persistCues(deckId: DeckId): void {
  const track = meta[deckId];
  if (!track) return;
  const cues = decks[deckId].hotCues.map((cue) =>
    cue ? { time: cue.time, color: cue.color, name: cue.name ?? "" } : null,
  );
  try {
    localStorage.setItem(`opendeck.cues.${track.id}`, JSON.stringify(cues));
  } catch {
    // storage full or unavailable
  }
}

function loadCues(deckId: DeckId, trackId: string): boolean {
  const deck = decks[deckId];
  deck.hotCues = new Array(8).fill(null);
  let cues: (CueRecord | null)[] = new Array(8).fill(null);
  try {
    const raw = localStorage.getItem(`opendeck.cues.${trackId}`);
    if (raw) cues = normaliseCues(JSON.parse(raw) as unknown, HOT_CUE_COLORS);
  } catch {
    // corrupt entry
  }
  deck.hotCues = cues;
  updatePads(deckId, true);
  return cues.some(Boolean);
}

function persistLoops(deckId: DeckId): void {
  const track = meta[deckId];
  if (!track) return;
  try {
    localStorage.setItem(`opendeck.loops.${track.id}`, JSON.stringify(savedLoops[deckId]));
  } catch {
    // storage full or unavailable
  }
}

function loadLoops(deckId: DeckId, trackId: string): void {
  let loops: SavedLoop[] = [];
  try {
    const raw = localStorage.getItem(`opendeck.loops.${trackId}`);
    if (raw) loops = normaliseLoops(JSON.parse(raw) as unknown);
  } catch {
    // corrupt entry
  }
  savedLoops[deckId] = loops;
  loopsOpen[deckId] = false;
  renderSavedLoops(deckId);
}

function renderSavedLoops(deckId: DeckId): void {
  const refs = ui[deckId];
  if (!refs) return;
  const loops = savedLoops[deckId];
  const toggle = refs.savedLoopToggle as HTMLButtonElement;
  const panel = refs.savedLoopsPanel as HTMLElement;
  toggle.textContent = `LOOPS ${loops.length}`;
  toggle.setAttribute("aria-expanded", String(loopsOpen[deckId]));
  panel.hidden = !loopsOpen[deckId];
  panel.replaceChildren();
  if (loops.length === 0) {
    const empty = document.createElement("span");
    empty.className = "saved-loop-empty";
    empty.textContent = "No saved loops. Set a loop and press SAVE.";
    panel.append(empty);
    return;
  }
  loops.forEach((loop) => {
    const row = document.createElement("div");
    row.className = "saved-loop";
    row.dataset.id = loop.id;
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "saved-loop-apply";
    apply.title = "Apply this loop";
    const name = document.createElement("span");
    name.className = "saved-loop-name";
    name.textContent = loop.name || `${formatTime(loop.start)} - ${formatTime(loop.end)}`;
    const time = document.createElement("small");
    time.textContent = `${formatTime(loop.start)} - ${formatTime(loop.end)}`;
    apply.append(name, time);
    apply.addEventListener("click", () => {
      decks[deckId].setLoopRange(loop.start, loop.end, true);
      syncLoopButtons(deckId);
    });
    const lock = document.createElement("button");
    lock.type = "button";
    lock.className = "mini saved-loop-lock";
    lock.textContent = loop.locked ? "LOCK" : "FREE";
    lock.title = loop.locked ? "Unlock loop" : "Lock loop";
    lock.setAttribute("aria-pressed", String(loop.locked));
    lock.addEventListener("click", () => {
      loop.locked = !loop.locked;
      persistLoops(deckId);
      renderSavedLoops(deckId);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mini saved-loop-remove";
    remove.textContent = "x";
    remove.title = "Delete saved loop";
    remove.addEventListener("click", () => {
      savedLoops[deckId] = removeSavedLoop(savedLoops[deckId], loop.id);
      persistLoops(deckId);
      renderSavedLoops(deckId);
    });
    row.addEventListener("dblclick", () => {
      const next = window.prompt("Loop name", loop.name);
      if (next === null) return;
      loop.name = next.trim().slice(0, 32);
      persistLoops(deckId);
      renderSavedLoops(deckId);
    });
    row.append(apply, lock, remove);
    panel.append(row);
  });
}

async function applySeratoCues(track: Track, deckId: DeckId): Promise<void> {
  if (!track.file) return;
  const tags = await readSeratoTagsFromFile(track.file);
  if (!tags || meta[deckId] !== track) return;
  const deck = decks[deckId];
  if (tags.markers?.cues.length) {
    for (const cue of tags.markers.cues) {
      if (cue.index >= 8) continue;
      deck.hotCues[cue.index] = { time: cue.positionMs / 1000, color: cue.color, name: cue.name };
    }
    updatePads(deckId, true);
    persistCues(deckId);
  }
  if (tags.markers?.loops.length && savedLoops[deckId].length === 0) {
    savedLoops[deckId] = normaliseLoops(
      tags.markers.loops.map((loop) => ({
        id: `serato-${loop.index}-${loop.startMs}`,
        start: loop.startMs / 1000,
        end: loop.endMs / 1000,
        name: loop.name,
        color: loop.color,
        locked: loop.locked,
      })),
    );
    persistLoops(deckId);
    renderSavedLoops(deckId);
  }
  if (tags.markers?.trackColor && tags.markers.trackColor !== NO_TRACK_COLOR && !track.color) {
    track.color = tags.markers.trackColor;
  }
  const tempo = beatgridTempo(tags.beatgrid);
  const tagBpm = tempo?.bpm || tags.bpm || 0;
  if (tagBpm > 0 && !track.analyzed && track.bpm <= 0) {
    track.bpm = tagBpm;
    track.beatPhase = tempo?.phase ?? 0;
    deck.setBpm(track.bpm, track.beatPhase);
    ui[deckId]!.bpm.textContent = `${track.bpm.toFixed(1)} BPM`;
    zooms[deckId]?.setBpm(track.bpm, track.beatPhase);
  }
  if (tags.key && (!track.key || track.key === "--")) {
    track.key = tags.key;
    ui[deckId]!.key.textContent = track.key;
  }
  if (tags.beatgrid?.length) {
    deck.setBeatGrid(markersToBeatGrid(tags.beatgrid, track.bpm || 120, track.beatPhase || 0, Boolean(tags.markers?.bpmLocked)));
  } else if (tags.markers?.bpmLocked) {
    deck.setBeatgridLocked(true);
  }
  track.beatgridLocked = deck.beatgridLocked;
  ui[deckId]?.gridLock?.setAttribute("aria-pressed", String(deck.beatgridLocked));
  const loop = firstSavedLoop(tags.markers?.loops);
  if (loop) deck.setLoopRange(loop.start, loop.end, false);
}

function recordPadAction(
  deckId: DeckId,
  mode: PadMode,
  index: number,
  phase: "tap" | "press" | "release" = "tap",
  cue?: number,
): void {
  if (padSequences[deckId].recordAction(mode, index, performance.now(), phase, cue)) {
    updatePads(deckId, true);
  }
}

function triggerPadCue(deckId: DeckId, index: number): void {
  const deck = decks[deckId];
  deck.jumpHotCue(index);
  persistCues(deckId);
  updatePads(deckId, true);
  if (!deck.playing) void deck.play();
}

function stopSequencePlayback(deckId: DeckId): void {
  const active = sequencePlayback[deckId];
  if (!active) return;
  window.clearInterval(active.timer);
  delete sequencePlayback[deckId];
  if (padHolds[deckId]?.fromSequence) releasePadHold(deckId);
  updatePads(deckId, true);
}

function dispatchSequenceEvent(deckId: DeckId, event: ReturnType<SequenceRecorder["list"]>[number]): void {
  if (event.mode === undefined) {
    if (event.cue !== undefined) triggerPadCue(deckId, event.cue);
    return;
  }
  if (event.index === undefined) return;
  if (["loop-roll", "slicer", "pitch-play", "scratch"].includes(event.mode)) {
    if (event.phase === "release") {
      if (padHolds[deckId]?.fromSequence) releasePadHold(deckId);
    } else {
      startPadHold(deckId, event.index, undefined, event.mode, true);
    }
    return;
  }
  handlePadAction(deckId, event.index, event.mode, true);
}

function playSequence(deckId: DeckId): void {
  stopSequencePlayback(deckId);
  const events = padSequences[deckId].list();
  padSequenceEvents[deckId] = events;
  if (!events.length) {
    toast("Record a sequence first.");
    return;
  }
  const loopMs = Math.max(500, padSequences[deckId].durationMs() + 140);
  const startedAt = performance.now();
  const active = { timer: 0, startedAt, next: 0, cycle: -1, loopMs };
  const tick = (): void => {
    const elapsed = performance.now() - startedAt;
    const cycle = Math.floor(elapsed / loopMs);
    if (cycle !== active.cycle) {
      if (active.cycle >= 0 && padHolds[deckId]?.fromSequence) releasePadHold(deckId);
      active.cycle = cycle;
      active.next = 0;
    }
    const inCycle = elapsed - cycle * loopMs;
    while (active.next < events.length && events[active.next]!.atMs <= inCycle) {
      dispatchSequenceEvent(deckId, events[active.next]!);
      active.next += 1;
    }
  };
  active.timer = window.setInterval(tick, 20);
  sequencePlayback[deckId] = active;
  tick();
  void decks[deckId].play();
  updatePads(deckId, true);
}

function toggleSequenceRecording(deckId: DeckId): void {
  const recorder = padSequences[deckId];
  if (recorder.recording) {
    padSequenceEvents[deckId] = recorder.stop();
    toast(`${padSequenceEvents[deckId].length} sequence step(s) recorded.`);
  } else {
    stopSequencePlayback(deckId);
    padSequenceEvents[deckId] = [];
    recorder.start(performance.now());
    toast("Recording pad actions.");
  }
  updatePads(deckId, true);
}

function togglePartFx(deckId: DeckId, index: number): void {
  const action = PART_FX_PADS[index]!;
  const [kind, ...rest] = action.split("-");
  const part = rest.join("-") as PartId;
  const deck = decks[deckId];
  if (kind === "filter") {
    partFxFiltered[deckId][part] = !partFxFiltered[deckId][part];
    deck.setPartFilter(part, partFxFiltered[deckId][part]);
  } else {
    partFxMuted[deckId][part] = !partFxMuted[deckId][part];
    deck.setPartMuted(part, partFxMuted[deckId][part]);
  }
  updatePads(deckId, true);
}

function handlePadAction(
  deckId: DeckId,
  index: number,
  modeOverride?: PadMode,
  replay = false,
): void {
  const deck = decks[deckId];
  const mode = modeOverride ?? padModes[deckId];
  if (!replay && mode !== "sequence") {
    const cue = mode === "hot-cue" || mode === "cue-loop" ? index : undefined;
    recordPadAction(deckId, mode, index, "tap", cue);
  }
  switch (mode) {
    case "hot-cue":
      triggerPadCue(deckId, index);
      return;
    case "cue-loop": {
      const cue = deck.hotCues[index];
      if (cue) deck.seek(cue.time);
      const range = cueLoopRange(cue?.time ?? deck.currentTime, deck.info.bpm || 120, 4);
      deck.setLoopRange(range.start, range.end, true);
      syncLoopButtons(deckId);
      if (!deck.playing) void deck.play();
      return;
    }
    case "beat-jump":
      deck.beatJump(beatJumpStep(index));
      return;
    case "transport":
      if (index === 0) toggleDeck(deckId);
      else if (index === 1) {
        if (deck.playing) deck.jumpToCue();
        else deck.setCue(deck.currentTime);
      } else if (index === 2) applySync(deckId);
      else if (index === 3) {
        deck.toggleLoop();
        syncLoopButtons(deckId);
      } else if (index === 4) {
        deck.setKeylock(!deck.keylockOn);
        ui[deckId]!.keylock.setAttribute("aria-pressed", String(deck.keylockOn));
      } else if (index === 5) {
        const next = ui[deckId]!.quantize.getAttribute("aria-pressed") !== "true";
        ui[deckId]!.quantize.setAttribute("aria-pressed", String(next));
        deck.setQuantize(next);
      } else if (index === 6) {
        deck.setReverse(!deck.reversed);
        if (!deck.reversed && !deck.playing) void deck.play();
      } else {
        deck.pause();
        deck.seek(0);
      }
      return;
    case "sequence":
      if (index === 0) toggleSequenceRecording(deckId);
      else if (index === 1) {
        if (sequencePlayback[deckId]) stopSequencePlayback(deckId);
        else playSequence(deckId);
      } else {
        if (!replay) recordPadAction(deckId, "hot-cue", index - 2, "tap", index - 2);
        triggerPadCue(deckId, index - 2);
      }
      return;
    case "part-fx":
      togglePartFx(deckId, index);
      return;
    default:
      return;
  }
}

function loadScratchPad(deckId: DeckId, index: number): void {
  const buffer = decks[deckId].audioBuffer;
  if (!buffer) {
    toast("Load a local track before filling a scratch pad.");
    return;
  }
  scratchBank.load(index, buffer);
  toast(`Scratch pad S${index + 1} loaded with ${decks[deckId].info.title || "this track"}.`);
  updatePads(deckId, true);
}

function startPadHold(
  deckId: DeckId,
  index: number,
  event?: PointerEvent,
  modeOverride?: PadMode,
  replay = false,
): void {
  releasePadHold(deckId);
  const mode = modeOverride ?? padModes[deckId];
  if (!["loop-roll", "slicer", "pitch-play", "scratch"].includes(mode)) return;
  const deck = decks[deckId];
  const pad = ui[deckId]!.pads.children[index] as HTMLElement | undefined;
  event?.preventDefault();
  pad?.classList.add("pad-held");
  const now = performance.now();
  const cue = mode === "pitch-play" || mode === "scratch" ? index : undefined;
  if (!replay) recordPadAction(deckId, mode, index, "press", cue);
  if (mode === "loop-roll") {
    const position = deck.currentTime;
    deck.setLoop(position, loopRollBeats(index), true);
    padHolds[deckId] = {
      index, kind: mode, startedAt: now, position,
      rate: 1, previousRate: deck.playbackRate, previousKeylock: deck.keylockOn,
      fromSequence: replay,
    };
    if (!deck.playing) void deck.play();
  } else if (mode === "slicer") {
    const position = deck.currentTime;
    const range = sliceRange(index, deck.duration);
    deck.setLoopRange(range.start, range.end, true);
    padHolds[deckId] = {
      index, kind: mode, startedAt: now, position,
      rate: 1, previousRate: deck.playbackRate, previousKeylock: deck.keylockOn,
      fromSequence: replay,
    };
    if (!deck.playing) void deck.play();
  } else if (mode === "pitch-play") {
    const position = deck.hotCues[index]?.time ?? deck.currentTime;
    const previousRate = deck.playbackRate;
    const previousKeylock = deck.keylockOn;
    deck.seek(position);
    deck.setKeylock(false);
    deck.setRate(pitchPlayRate(index));
    padHolds[deckId] = {
      index, kind: mode, startedAt: now, position,
      rate: pitchPlayRate(index), previousRate, previousKeylock,
      fromSequence: replay,
    };
    if (!deck.playing) void deck.play();
  } else if (mode === "scratch") {
    const fromBank = scratchBank.has(index);
    if (fromBank) {
      scratchBank.start(index, deck.hotCues[index]?.time ?? 0, 1);
    } else if (deck.scratchReady) {
      if (deck.hotCues[index]) deck.seek(deck.hotCues[index]!.time);
      deck.beginScratch();
      deck.scratchRate(1);
    } else {
      delete padHolds[deckId];
      pad?.classList.remove("pad-held");
      toast("Shift+click a scratch pad to load the current track.");
      return;
    }
    padHolds[deckId] = {
      index, kind: mode, startedAt: now, position: deck.currentTime,
      rate: 1, previousRate: deck.playbackRate, previousKeylock: deck.keylockOn,
      fromSequence: replay, scratchBank: fromBank,
    };
  }
  updatePads(deckId, true);
}

function releasePadHold(deckId: DeckId): void {
  const hold = padHolds[deckId];
  if (!hold) return;
  delete padHolds[deckId];
  if (!hold.fromSequence) {
    const cue = hold.kind === "pitch-play" || hold.kind === "scratch" ? hold.index : undefined;
    recordPadAction(deckId, hold.kind, hold.index, "release", cue);
  }
  const deck = decks[deckId];
  const pad = ui[deckId]!.pads.children[hold.index] as HTMLElement | undefined;
  pad?.classList.remove("pad-held");
  if (hold.kind === "loop-roll" || hold.kind === "slicer") {
    if (deck.loopActive) deck.toggleLoop();
    deck.seek(rollingReleasePosition(hold.position, hold.startedAt, performance.now(), hold.rate, deck.duration));
    syncLoopButtons(deckId);
  } else if (hold.kind === "pitch-play") {
    deck.setRate(hold.previousRate);
    deck.setKeylock(hold.previousKeylock);
  } else if (hold.kind === "scratch") {
    scratchBank.stop();
    if (!hold.scratchBank) {
      deck.endScratch();
      if (deck.playbackRate > 0 && !deck.playing) void deck.play();
    }
  }
  updatePads(deckId, true);
}

function updatePads(deckId: DeckId, force = false): void {
  const deck = decks[deckId];
  const refs = ui[deckId]!;
  const mode = padModes[deckId];
  const scratchLoaded = Array.from({ length: 8 }, (_, index) => (scratchBank.has(index) ? "1" : "0")).join("");
  const signature = `${deck.hotCueVersion}|${mode}|${padSequences[deckId].recording}|${padSequenceEvents[deckId].length}|${Boolean(sequencePlayback[deckId])}|${scratchLoaded}|${JSON.stringify(partFxFiltered[deckId])}|${JSON.stringify(partFxMuted[deckId])}`;
  if (!force && lastPadVersion[deckId] === signature) return;
  lastPadVersion[deckId] = signature;
  const modeDef = PAD_MODE_DEFS.find((item) => item.id === mode)!;
  (refs["padModeState"] as HTMLElement).textContent = modeDef.label;
  const sequencer = padSequences[deckId];
  (refs["padSeqState"] as HTMLElement).textContent = sequencePlayback[deckId]
    ? "SEQ PLAY"
    : sequencer.recording
      ? `REC ${sequencer.length}`
      : padSequenceEvents[deckId].length
        ? `SEQ ${padSequenceEvents[deckId].length}`
        : "";
  const pads = Array.from(refs.pads.querySelectorAll<HTMLButtonElement>(".pad"));
  pads.forEach((pad, index) => {
    const cue = deck.hotCues[index];
    let top: string = String(index + 1);
    let bottom: string = "-";
    let active = false;
    let color: string = "";
    let title: string = modeDef.hint;
    if (mode === "hot-cue" || mode === "cue-loop") {
      active = Boolean(cue);
      color = cue?.color ?? "";
      bottom = cue ? cue.name || formatTime(cue.time) : "-";
      if (mode === "cue-loop") bottom = cue ? "4 beat" : "loop";
      title = cue ? `${cue.name || `Cue ${index + 1}`} at ${formatTime(cue.time)}` : modeDef.hint;
    } else if (mode === "loop-roll") {
      const beats = loopRollBeats(index);
      top = beats < 1 ? `1/${Math.round(1 / beats)}` : String(beats);
      bottom = "roll";
    } else if (mode === "slicer") {
      const range = sliceRange(index, deck.duration);
      top = String(index + 1);
      bottom = deck.duration ? `${formatTime(range.start)}` : "slice";
    } else if (mode === "beat-jump") {
      const step = beatJumpStep(index);
      top = step > 0 ? `+${step}` : String(step);
      bottom = "jump";
    } else if (mode === "transport") {
      top = ["PLAY", "CUE", "SYNC", "LOOP", "KEY", "Q", "REV", "STOP"][index]!;
      bottom = "deck";
    } else if (mode === "pitch-play") {
      const semis = pitchPlaySemitones(index);
      top = semis > 0 ? `+${semis}` : String(semis);
      bottom = cue ? cue.name || formatTime(cue.time) : "pitch";
      active = Boolean(cue);
      color = cue?.color ?? "";
    } else if (mode === "scratch") {
      const loaded = scratchBank.has(index);
      top = `S${index + 1}`;
      bottom = loaded ? "loaded" : "shift+load";
      active = Boolean(cue) || loaded;
      color = cue?.color ?? "";
      title = loaded
        ? "Hold to scratch the loaded track. Shift+click to replace it."
        : "Shift+click to load the current local track, then hold to scratch.";
    } else if (mode === "sequence") {
      if (index === 0) {
        top = sequencer.recording ? "STOP" : "REC";
        bottom = `${sequencer.length} step`;
        active = sequencer.recording;
      } else if (index === 1) {
        top = sequencePlayback[deckId] ? "STOP" : "PLAY";
        bottom = `${padSequenceEvents[deckId].length} step`;
        active = Boolean(sequencePlayback[deckId]);
      } else {
        const seqCue = deck.hotCues[index - 2];
        active = Boolean(seqCue);
        color = seqCue?.color ?? "";
        top = String(index - 1);
        bottom = seqCue ? seqCue.name || formatTime(seqCue.time) : "cue";
      }
    } else if (mode === "part-fx") {
      const action = PART_FX_PADS[index]!;
      const [kind, ...rest] = action.split("-");
      const part = rest.join("-") as PartId;
      top = part === "vocals" ? "VOX" : part.toUpperCase();
      bottom = kind === "filter" ? "filter" : "mute";
      active = kind === "filter" ? partFxFiltered[deckId][part] : partFxMuted[deckId][part];
      title = `${kind === "filter" ? "Filter" : "Mute"} ${part}`;
    }
    pad.classList.toggle("set", active);
    pad.style.background = color;
    pad.style.color = color ? "#fff" : "";
    pad.firstChild!.textContent = top;
    pad.querySelector("small")!.textContent = bottom;
    pad.title = title;
  });
  const cues = deck.hotCues.filter((cue): cue is { time: number; color: string } => Boolean(cue));
  waves[deckId]?.setHotCues(cues);
  zooms[deckId]?.setHotCues(cues);
}

/* ----------------------------------------------------------- library UI */

const library = new Library({
  listEl: $("trackList"),
  countEl: $("libCount"),
  onLoad: (track, deck) => void loadTrack(track, deck),
  onQueue: (track) => {
    streamQueue.add({
      id: track.id,
      title: track.name,
      artist: "Local library",
      durationSec: track.duration,
      provider: "local",
      url: "",
    });
    renderQueue();
    toast("Added to queue");
  },
});

try {
  const played = JSON.parse(localStorage.getItem("opendeck.played") ?? "[]") as unknown;
  if (Array.isArray(played)) {
    for (const item of [...played].reverse()) library.playedLog.add(item as PlayedEntry);
  }
  const scratch = JSON.parse(localStorage.getItem("opendeck.scratchpad") ?? "[]") as unknown;
  if (Array.isArray(scratch)) {
    for (const id of scratch) if (typeof id === "string" && id) library.scratchpad.add(id);
  }
} catch {
  // storage unavailable or corrupt
}

function persistLibraryUx(): void {
  try {
    localStorage.setItem("opendeck.played", JSON.stringify(library.playedLog.list()));
    localStorage.setItem("opendeck.scratchpad", JSON.stringify(library.scratchpad.list()));
  } catch {
    // storage full or unavailable
  }
}

function addFiles(files: FileList | File[]): Track[] {
  const added = library.addFiles(files);
  for (const track of added) enqueueAnalysis(track);
  if (added.length) void mixer.resume();
  return added;
}

async function loadFilesToDeck(files: FileList, deckId: DeckId): Promise<void> {
  const added = addFiles(files);
  if (added[0]) await loadTrack(added[0], deckId);
}

$("fileInput").addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) addFiles(input.files);
  input.value = "";
});

const drop = $("dropZone");
for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.remove("over");
  });
}
drop.addEventListener("drop", (event) => {
  const files = (event as DragEvent).dataTransfer?.files;
  if (files?.length) addFiles(files);
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

$("search").addEventListener("input", (event) => library.setFilter((event.target as HTMLInputElement).value));

function renderPlayedLog(): void {
  const entries = library.playedLog.list();
  $("playedCount").textContent = String(entries.length);
  const list = $("playedList");
  list.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("span");
    empty.className = "played-empty";
    empty.textContent = "Play something to start the log.";
    list.append(empty);
    return;
  }
  for (const entry of entries.slice(0, 100)) {
    const row = document.createElement("div");
    row.className = "played-row";
    const name = document.createElement("span");
    name.className = "played-name";
    name.textContent = entry.name;
    const detail = document.createElement("small");
    const when = new Date(entry.startedAt);
    detail.textContent = `${Number.isNaN(when.getTime()) ? entry.startedAt : when.toLocaleString()} / ${entry.crate || "no crate"}`;
    row.append(name, detail);
    list.append(row);
  }
}

function refreshLibraryChrome(): void {
  const scratch = library.scratchpad.list().length;
  const scratchBtn = $("scratchBtn");
  scratchBtn.textContent = `Scratchpad ${scratch}`;
  scratchBtn.setAttribute("aria-pressed", String(library.scratchOnly));
  $("sortDir").textContent = library.sortDirection === "asc" ? "A-Z" : "Z-A";
  renderPlayedLog();
}

$("sortBy").addEventListener("change", (event) =>
  library.setSort((event.target as HTMLSelectElement).value as TrackSortKey),
);

function refreshPlaylistOptions(): void {
  const select = document.getElementById("playlistFilter") as HTMLSelectElement | null;
  if (!select) return;
  const current = select.value;
  select.replaceChildren();
  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "All tracks";
  select.append(allOpt);
  for (const pl of library.playlists.list()) {
    const opt = document.createElement("option");
    opt.value = `playlist:${pl.id}`;
    opt.textContent = `Playlist · ${pl.name} (${pl.trackIds.length})`;
    select.append(opt);
  }
  for (const lp of library.livePlaylists.list()) {
    const opt = document.createElement("option");
    opt.value = `live:${lp.id}`;
    opt.textContent = `Smart · ${lp.name}`;
    select.append(opt);
  }
  for (const crate of library.crates()) {
    const opt = document.createElement("option");
    opt.value = `crate:${crate}`;
    opt.textContent = `Crate · ${crate}`;
    select.append(opt);
  }
  select.value = [...select.options].some((o) => o.value === current) ? current : "all";
}

refreshPlaylistOptions();

document.getElementById("playlistFilter")?.addEventListener("change", (event) => {
  const val = (event.target as HTMLSelectElement).value;
  library.setActiveView(val || "all");
});

document.getElementById("newPlaylistBtn")?.addEventListener("click", () => {
  const name = window.prompt("New playlist name", `Set ${library.playlists.list().length + 1}`);
  if (!name?.trim()) return;
  const visible = library.visible();
  library.createPlaylist(name.trim(), visible.map((t) => t.id));
  refreshPlaylistOptions();
  toast(`Created playlist "${name.trim()}" (${visible.length} tracks)`);
});

document.getElementById("newLivePlaylistBtn")?.addEventListener("click", () => {
  const name = window.prompt("Smart Crate name", "House 120-130 BPM");
  if (!name?.trim()) return;
  const minBpmStr = window.prompt("Minimum BPM (or leave blank)", "120");
  const maxBpmStr = window.prompt("Maximum BPM (or leave blank)", "130");
  const rules: LivePlaylistRule[] = [];
  if (minBpmStr && Number.isFinite(Number(minBpmStr))) rules.push({ field: "bpm", operator: "gte", value: Number(minBpmStr) });
  if (maxBpmStr && Number.isFinite(Number(maxBpmStr))) rules.push({ field: "bpm", operator: "lte", value: Number(maxBpmStr) });
  library.createLivePlaylist(name.trim(), rules, "all");
  refreshPlaylistOptions();
  toast(`Created Smart Crate "${name.trim()}"`);
});
$("sortDir").addEventListener("click", () =>
  library.setSort(library.sortKey, library.sortDirection === "asc" ? "desc" : "asc"),
);
$("scratchBtn").addEventListener("click", () => {
  library.setScratchOnly(!library.scratchOnly);
  refreshLibraryChrome();
});
$("trackList").addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest(".scratch-toggle")) {
    persistLibraryUx();
    refreshLibraryChrome();
  }
});
$("playedExport").addEventListener("click", () => {
  const blob = new Blob([library.playedLog.exportCsv()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "opendeck-played.csv";
  link.click();
  URL.revokeObjectURL(url);
});
$("playedClear").addEventListener("click", () => {
  library.playedLog.clear();
  persistLibraryUx();
  renderPlayedLog();
});
refreshLibraryChrome();

const crateNote = $("crateNote");
const linkBtn = $("linkBtn");

function setNote(text: string, warn = false): void {
  crateNote.textContent = text;
  crateNote.classList.toggle("hidden", !text);
  crateNote.classList.toggle("warn", warn);
}

function refreshLinkButton(): void {
  linkBtn.classList.toggle("hidden", library.missingCount === 0);
}

async function importCrate(name: string, bytes: Uint8Array): Promise<void> {
  if (!isSerato(bytes)) {
    setNote(`${name} is not a Serato crate or database file.`, true);
    return;
  }
  const parsed = parseCrate(bytes);
  const added = library.addCrate(name.replace(/\.crate$/i, ""), parsed.tracks);
  refreshLinkButton();
  setNote(
    `Imported ${name}: ${parsed.tracks.length} tracks, ${added.length} new.` +
      (library.missingCount ? " Link the music folder to load them." : ""),
    library.missingCount > 0,
  );
}


/* ------------------------------------------- detected media (CDJ / USB) */

const mediaApi = desktop?.djmedia;
const mediaSources = new Map<string, CdjMediaLibrary>();
let mediaSnapshot: ProlinkSnapshot | null = null;
const mediaPrompts = new Map<string, MediaPrompt>();

function addMediaLibrary(lib: CdjMediaLibrary): void {
  mediaSources.set(lib.sourceId, lib);
  const tracks = library.addMediaSource(lib.sourceId, tracksFromMedia(lib));
  refreshPlaylistOptions();
  const crates = mediaCrates(lib).length - 1;
  toast(`Added ${lib.sourceName}: ${tracks.length} track${tracks.length === 1 ? "" : "s"}${crates ? `, ${crates} playlist${crates === 1 ? "" : "s"}` : ""}`);
  renderMediaStatus();
}

function removeMediaLibrary(sourceId: string): void {
  const lib = mediaSources.get(sourceId);
  mediaSources.delete(sourceId);
  const removed = library.removeMediaSource(sourceId);
  for (const id of [...mediaCues.keys()]) if (id.startsWith(`media:${sourceId}:`)) mediaCues.delete(id);
  refreshPlaylistOptions();
  if (lib) toast(`${lib.sourceName} disconnected (${removed} track${removed === 1 ? "" : "s"} removed)`);
  renderMediaStatus();
}

function renderMediaPrompts(): void {
  const host = document.getElementById("mediaPrompts");
  if (!host) return;
  host.replaceChildren();
  host.classList.toggle("hidden", mediaPrompts.size === 0);
  for (const prompt of mediaPrompts.values()) {
    const view = promptView(prompt);
    const row = document.createElement("div");
    row.className = "media-prompt";
    row.dataset.sourceId = prompt.sourceId;
    const text = document.createElement("span");
    text.className = "media-prompt-text";
    text.textContent = view.text;
    const always = document.createElement("label");
    always.className = "media-prompt-always micro";
    const check = document.createElement("input");
    check.type = "checkbox";
    always.append(check, document.createTextNode(` ${view.rememberLabel}`));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "pill-btn media-prompt-add";
    add.textContent = view.addLabel;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "ghost media-prompt-dismiss";
    dismiss.textContent = view.dismissLabel;
    const answer = async (action: "add" | "ignore"): Promise<void> => {
      add.disabled = true;
      dismiss.disabled = true;
      mediaPrompts.delete(prompt.sourceId);
      renderMediaPrompts();
      const result = await mediaApi?.respond(prompt.sourceId, action, check.checked);
      if (result && !result.ok && result.error) toast(result.error);
    };
    add.addEventListener("click", () => void answer("add"));
    dismiss.addEventListener("click", () => void answer("ignore"));
    row.append(text, always, add, dismiss);
    host.append(row);
  }
}

function renderMediaStatus(): void {
  const chip = document.getElementById("cdjStatus");
  if (!chip) return;
  const snap = mediaSnapshot;
  if (!snap) {
    chip.classList.add("hidden");
    return;
  }
  chip.classList.remove("hidden");
  const players = snap.players.filter((p) => p.kind === "player");
  const ready = snap.media.filter((m) => m.state === "ready");
  const parts: string[] = [];
  if (snap.enabled) parts.push(snap.running ? `${players.length} CDJ${players.length === 1 ? "" : "s"}` : "DJ Link off");
  if (ready.length) parts.push(`${ready.length} drive${ready.length === 1 ? "" : "s"}`);
  chip.textContent = parts.length ? `Link: ${parts.join(" · ")}` : "Link";
  chip.classList.toggle("live", players.length > 0 || ready.length > 0);
  chip.title = snap.error ?? (snap.address ? `Pro DJ Link on ${snap.interfaceName} (${snap.address}) as player ${snap.deviceNumber ?? "-"}` : "Pro DJ Link: waiting for players");
  const panel = document.getElementById("cdjPanel");
  if (!panel || panel.classList.contains("hidden")) return;
  const enabled = panel.querySelector<HTMLInputElement>("#cdjEnabled");
  const localDrives = panel.querySelector<HTMLInputElement>("#cdjLocalDrives");
  const iface = panel.querySelector<HTMLSelectElement>("#cdjInterface");
  if (enabled) enabled.checked = snap.settings.enabled;
  if (localDrives) localDrives.checked = snap.settings.localDrives;
  if (iface) {
    iface.replaceChildren();
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = "Automatic (follow the CDJs)";
    iface.append(auto);
    for (const i of snap.interfaces) {
      const opt = document.createElement("option");
      opt.value = i.name;
      opt.textContent = `${i.name} · ${i.address}`;
      iface.append(opt);
    }
    iface.value = snap.settings.interface;
  }
  const list = panel.querySelector("#cdjList");
  if (list) {
    list.replaceChildren();
    const line = (text: string, cls = ""): void => {
      const el = document.createElement("div");
      el.className = `cdj-line ${cls}`.trim();
      el.textContent = text;
      list.append(el);
    };
    if (snap.error) line(snap.error, "warn");
    else if (snap.enabled) line(snap.address ? `Linked on ${snap.interfaceName} (${snap.address}) as player ${snap.deviceNumber ?? "-"}` : "Waiting for CDJs on the network…");
    for (const p of snap.players) line(`${p.kind === "mixer" ? "Mixer" : p.kind === "player" ? "CDJ" : "Device"} ${p.deviceNumber} · ${p.name} · ${p.ip}${p.kind === "player" ? ` · USB ${p.usb} · SD ${p.sd}` : ""}`);
    for (const m of snap.media) {
      const name = m.sourceName || (m.origin === "cdj" ? `CDJ ${m.deviceNumber} · ${m.slot.toUpperCase()}` : "USB drive");
      const state = m.state === "ready" ? `${m.trackCount} tracks` : m.state === "error" ? `error: ${m.error ?? ""}` : m.state;
      line(`${name} — ${state}`, m.state === "error" ? "warn" : "");
    }
    const remembered = Object.keys(snap.settings.remembered).length;
    const forget = panel.querySelector<HTMLButtonElement>("#cdjForget");
    if (forget) {
      forget.disabled = remembered === 0;
      forget.textContent = remembered ? `Forget ${remembered} remembered drive${remembered === 1 ? "" : "s"}` : "No remembered drives";
    }
  }
}

function applyMediaStatus(snap: ProlinkSnapshot): void {
  mediaSnapshot = snap;
  const live = new Set(snap.prompts.map((p) => p.sourceId));
  for (const id of [...mediaPrompts.keys()]) if (!live.has(id)) mediaPrompts.delete(id);
  for (const p of snap.prompts) mediaPrompts.set(p.sourceId, p);
  renderMediaPrompts();
  renderMediaStatus();
}

if (mediaApi) {
  mediaApi.onStatus((payload) => applyMediaStatus(payload as ProlinkSnapshot));
  mediaApi.onPrompt((payload) => {
    const prompt = payload as MediaPrompt;
    mediaPrompts.set(prompt.sourceId, prompt);
    renderMediaPrompts();
  });
  mediaApi.onPromptCleared((payload) => {
    mediaPrompts.delete(String(payload));
    renderMediaPrompts();
  });
  mediaApi.onLibrary((payload) => addMediaLibrary(payload as CdjMediaLibrary));
  mediaApi.onRemoved((payload) => removeMediaLibrary(String(payload)));
  mediaApi.onProgress((payload) => {
    const p = payload as CdjFetchProgress;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    for (const deckId of ALL_DECKS) {
      const refs = ui[deckId];
      const pending = refs && refs.sub.textContent?.startsWith("fetching from CDJ");
      if (pending) refs.sub.textContent = `fetching from CDJ… ${pct}%`;
    }
  });
  mediaApi
    .state()
    .then(({ snapshot, libraries }) => {
      for (const lib of libraries) if (!mediaSources.has(lib.sourceId)) addMediaLibrary(lib);
      applyMediaStatus(snapshot);
    })
    .catch(() => undefined);
  document.getElementById("cdjStatus")?.addEventListener("click", () => {
    const panel = document.getElementById("cdjPanel");
    panel?.classList.toggle("hidden");
    renderMediaStatus();
  });
  const update = async (patch: Partial<ProlinkSettings>): Promise<void> => {
    try {
      applyMediaStatus(await mediaApi.settings(patch));
    } catch (error) {
      toast(`Could not change Link settings: ${(error as Error).message}`);
    }
  };
  document.getElementById("cdjEnabled")?.addEventListener("change", (e) => void update({ enabled: (e.target as HTMLInputElement).checked }));
  document.getElementById("cdjLocalDrives")?.addEventListener("change", (e) => void update({ localDrives: (e.target as HTMLInputElement).checked }));
  document.getElementById("cdjInterface")?.addEventListener("change", (e) => void update({ interface: (e.target as HTMLSelectElement).value }));
  document.getElementById("cdjForget")?.addEventListener("click", async () => applyMediaStatus(await mediaApi.forget()));
}

$("crateBtn").addEventListener("click", () => $<HTMLInputElement>("crateInput").click());
$("crateInput").addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) await importCrate(file.name, new Uint8Array(await file.arrayBuffer()));
  input.value = "";
});

async function collectAudio(dir: FileSystemDirectoryHandle, depth: number): Promise<File[]> {
  const found: File[] = [];
  for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (entry.kind === "file") {
      const file = await (entry as FileSystemFileHandle).getFile();
      if (isAudioFile(file.name)) found.push(file);
    } else if (entry.kind === "directory" && depth > 0) {
      found.push(...(await collectAudio(entry as FileSystemDirectoryHandle, depth - 1)));
    }
  }
  return found;
}

linkBtn.addEventListener("click", async () => {
  if (!("showDirectoryPicker" in window)) {
    setNote("Folder linking needs Chromium. Drag the audio files in instead.", true);
    return;
  }
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await (window as unknown as { showDirectoryPicker(options: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: "opendeck-music", mode: "read" });
  } catch {
    return;
  }
  setNote(`Scanning ${dir.name}…`);
  const files = await collectAudio(dir, 6);
  const linked = library.resolveFolder(files);
  for (const track of linked) enqueueAnalysis(track);
  refreshLinkButton();
  setNote(
    `Linked ${linked.length} crate track${linked.length === 1 ? "" : "s"} from ${dir.name}.` +
      (library.missingCount ? ` ${library.missingCount} still missing.` : ""),
    linked.length === 0,
  );
});

async function writeDirectoryFile(
  root: FileSystemDirectoryHandle,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await file.createWritable();
  await writable.write(bytes as unknown as FileSystemWriteChunkType);
  await writable.close();
}

async function copyDirectory(
  source: FileSystemDirectoryHandle,
  target: FileSystemDirectoryHandle,
): Promise<number> {
  const entries = (source as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
  let copied = 0;
  for await (const entry of entries) {
    if (entry.kind === "file") {
      const file = await (entry as FileSystemFileHandle).getFile();
      const writable = await (await target.getFileHandle(entry.name, { create: true })).createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();
      copied += 1;
    } else {
      const child = await target.getDirectoryHandle(entry.name, { create: true });
      copied += await copyDirectory(entry as FileSystemDirectoryHandle, child);
    }
  }
  return copied;
}

async function backupSeratoFolder(serato: FileSystemDirectoryHandle): Promise<string | null> {
  let existing = false;
  try {
    await serato.getFileHandle("database V2");
    existing = true;
  } catch {
    // no existing database
  }
  if (!existing) return null;
  const name = `OpenDecks Backup ${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const backup = await serato.getDirectoryHandle(name, { create: true });
  let copied = 0;
  for (const file of ["database V2", "neworder.pref"]) {
    try {
      const source = await (await serato.getFileHandle(file)).getFile();
      const writable = await (await backup.getFileHandle(file, { create: true })).createWritable();
      await writable.write(await source.arrayBuffer());
      await writable.close();
      copied += 1;
    } catch {
      // missing file
    }
  }
  try {
    const subcrates = await serato.getDirectoryHandle("Subcrates");
    const target = await backup.getDirectoryHandle("Subcrates", { create: true });
    copied += await copyDirectory(subcrates, target);
  } catch {
    // no subcrates
  }
  return copied > 0 ? name : null;
}

async function saveSeratoFiles(files: Map<string, Uint8Array>): Promise<"folder" | "zip" | "cancelled"> {
  if ("showDirectoryPicker" in window) {
    let root: FileSystemDirectoryHandle;
    try {
      root = await (window as unknown as {
        showDirectoryPicker(options: object): Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker({ id: "opendeck-serato-export", mode: "readwrite" });
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return "cancelled";
      throw error;
    }
    const serato = await root.getDirectoryHandle("_Serato_", { create: true });
    await backupSeratoFolder(serato);
    for (const [path, bytes] of files) {
      await writeDirectoryFile(root, path, bytes);
    }
    return "folder";
  }

  const zip = zipSync(Object.fromEntries(files), { level: 0 });
  const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "opendeck-serato.zip";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "zip";
}

$("exportBtn").addEventListener("click", async () => {
  const tracks = library.tracks
    .filter((track) => track.source === "local" || track.source === "crate")
    .map((track) => ({
      path: track.file?.webkitRelativePath || track.path,
      crate: track.crate,
      title: track.name,
      bpm: track.bpm,
      key: track.key,
      duration: track.duration,
      grouping: track.grouping,
      remixer: track.remixer,
      color: track.color,
      playCount: track.playCount,
      beatgridLocked: track.beatgridLocked,
    }));
  if (tracks.length === 0) {
    setNote("Load or import tracks before exporting.", true);
    return;
  }
  const result = buildSeratoExport(tracks);
  if (result.trackCount === 0) {
    setNote("No local paths to export. Load files from disk first.", true);
    return;
  }
  try {
    const mode = await saveSeratoFiles(result.files);
    if (mode === "cancelled") return;
    setNote(
      `Exported ${result.trackCount} tracks and ${result.crates.length} crate${result.crates.length === 1 ? "" : "s"} ` +
        (mode === "folder"
          ? "into _Serato_. Any existing library files were backed up inside that folder."
          : "as a zip. Unzip it beside your audio files."),
    );
    toast(mode === "folder" ? "Serato export written" : "Serato export downloaded");
  } catch (error) {
    setNote(`Export failed: ${(error as Error).message}`, true);
  }
});

function cueRecordsFor(track: Track): (CueRecord | null)[] {
  for (const deckId of ALL_DECKS) {
    if (meta[deckId]?.id === track.id) {
      return decks[deckId].hotCues.map((cue) =>
        cue ? { time: cue.time, color: cue.color, name: cue.name ?? "" } : null,
      );
    }
  }
  try {
    const raw = localStorage.getItem(`opendeck.cues.${track.id}`);
    if (raw) return normaliseCues(JSON.parse(raw) as unknown, HOT_CUE_COLORS);
  } catch {
    // storage unavailable
  }
  return new Array(8).fill(null);
}

function savedLoopsFor(track: Track): SavedLoop[] {
  for (const deckId of ALL_DECKS) {
    if (meta[deckId]?.id === track.id) return savedLoops[deckId];
  }
  try {
    const raw = localStorage.getItem(`opendeck.loops.${track.id}`);
    if (raw) return normaliseLoops(JSON.parse(raw) as unknown);
  } catch {
    // storage unavailable
  }
  return [];
}

function writePayload(track: Track): SeratoWritePayload {
  const records = cueRecordsFor(track);
  const cues = records.flatMap((cue, index) =>
    cue === null
      ? []
      : [
          {
            index,
            positionMs: Math.round(cue.time * 1000),
            color: cue.color || DEFAULT_SLOT_COLORS[index],
            name: cue.name,
          },
        ],
  );
  const loops: SeratoMarkers["loops"] = savedLoopsFor(track)
    .slice(0, 9)
    .map((loop, index) => ({
      index,
      startMs: Math.round(loop.start * 1000),
      endMs: Math.round(loop.end * 1000),
      color: loop.color,
      name: loop.name,
      locked: loop.locked,
    }));
  const activeDeck = ALL_DECKS.map((id) => (meta[id]?.id === track.id ? decks[id] : null)).find(Boolean) ?? null;
  const gridMarkers = activeDeck
    ? beatGridToMarkers(activeDeck.beatgrid)
    : track.bpm > 0
      ? [{ position: track.beatPhase || 0, bpm: track.bpm }]
      : null;
  const locked = activeDeck ? activeDeck.beatgridLocked : Boolean(track.beatgridLocked ?? track.bpm > 0);
  return {
    path: track.file?.webkitRelativePath || track.path,
    name: track.file?.name || track.path.split(/[\\/]/).pop() || track.name,
    markers: { cues, loops, trackColor: track.color || NO_TRACK_COLOR, bpmLocked: locked },
    beatgrid: gridMarkers,
    meta: {
      bpm: track.bpm > 0 ? track.bpm : undefined,
      key: track.key && track.key !== "--" ? track.key : undefined,
      title: track.name || undefined,
    },
  };
}

$("writeTagsBtn").addEventListener("click", async () => {
  if (!desktop?.serato) {
    setNote("Embedded tag writing is available in the Electron desktop app.", true);
    return;
  }
  const tracks = library.tracks
    .filter((track) => track.source === "local" || track.source === "crate")
    .map(writePayload)
    .filter((track) => /\.(mp3|wav|aiff?|flac|m4a|mp4|aac)$/i.test(track.name));
  if (tracks.length === 0) {
    setNote("Load MP3, WAV, AIFF, FLAC or M4A files before writing tags.", true);
    return;
  }
  if (await desktop.serato.running()) {
    setNote("Close Serato DJ before writing tags.", true);
    return;
  }
  try {
    const result = await desktop.serato.writeTags({ root: null, tracks });
    setNote(result.detail, !result.ok);
    if (result.ok) toast("Cues and beatgrid written");
  } catch (error) {
    setNote(`Tag write failed: ${(error as Error).message}`, true);
  }
});

document.getElementById("applyColumnsBtn")?.addEventListener("click", async () => {
  if (!desktop?.serato?.applyCrateColumns) {
    setNote("SQLite column layout sync requires the Electron desktop app.", true);
    return;
  }
  if (await desktop.serato.running()) {
    setNote("Close Serato DJ Pro before syncing crate columns.", true);
    return;
  }
  try {
    const res = await desktop.serato.applyCrateColumns({
      columns: [
        { name: "song", width: 280 },
        { name: "artist", width: 200 },
        { name: "bpm", width: 72 },
        { name: "key", width: 64 },
        { name: "length", width: 80 },
        { name: "playCount", width: 64 },
      ],
    });
    setNote(res.detail, !res.ok);
    if (res.ok) toast("Serato SQLite crate columns synced");
  } catch (error) {
    setNote(`Column sync failed: ${(error as Error).message}`, true);
  }
});

$("undoTagsBtn").addEventListener("click", async () => {
  if (!desktop?.serato) {
    setNote("Undo is available in the Electron desktop app.", true);
    return;
  }
  if (!confirm("Restore the files changed by the last OpenDecks tag write?")) return;
  try {
    const result = await desktop.serato.undo();
    setNote(result.detail, !result.ok);
    if (result.ok) toast("Tag write undone");
  } catch (error) {
    setNote(`Undo failed: ${(error as Error).message}`, true);
  }
});

/* --------------------------------------------------------------- mixer */

$("crossfader").addEventListener("input", (event) => {
  videoMixer.setAudioCrossfader(Number((event.target as HTMLInputElement).value), false);
  const vxf = document.getElementById("videoCrossfader") as HTMLInputElement | null;
  if (vxf && videoMixer.linkToAudioCrossfader) vxf.value = String(videoMixer.crossfader);
  renderVideoMixFrame();
  mixer.setCrossfader(Number((event.target as HTMLInputElement).value), $<HTMLSelectElement>("xfCurve").value as CrossfaderCurve);
});
$("xfCurve").addEventListener("change", () => {
  mixer.setCrossfader(mixer.crossfader, $<HTMLSelectElement>("xfCurve").value as CrossfaderCurve);
});
$("chA").addEventListener("input", (event) => decks.A.setChannelGain(Number((event.target as HTMLInputElement).value)));
$("chB").addEventListener("input", (event) => decks.B.setChannelGain(Number((event.target as HTMLInputElement).value)));
document.getElementById("chC")?.addEventListener("input", (event) => decks.C.setChannelGain(Number((event.target as HTMLInputElement).value)));
document.getElementById("chD")?.addEventListener("input", (event) => decks.D.setChannelGain(Number((event.target as HTMLInputElement).value)));
document.getElementById("xfReverse")?.addEventListener("click", (event) => {
  const btn = event.currentTarget as HTMLButtonElement;
  const next = !mixer.crossfaderReverse;
  mixer.setCrossfaderReverse(next);
  btn.setAttribute("aria-pressed", String(next));
});
$("master").addEventListener("input", (event) => mixer.setMaster(Number((event.target as HTMLInputElement).value)));
$("auxGain").addEventListener("input", (event) => mixer.setAuxGain(Number((event.target as HTMLInputElement).value)));

let auxStream: MediaStream | null = null;
$("auxBtn").addEventListener("click", async () => {
  if (auxStream) {
    for (const track of auxStream.getTracks()) track.stop();
    mixer.setAuxStream(null);
    auxStream = null;
    $("auxState").textContent = "off";
    $("auxState").classList.remove("live");
    $("auxBtn").textContent = "Capture output";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const audio = stream.getAudioTracks();
    for (const track of stream.getVideoTracks()) track.stop();
    if (!audio.length) {
      toast("No system audio track. Enable loopback audio in your OS settings.");
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    auxStream = new MediaStream(audio);
    mixer.setAuxStream(auxStream);
    await mixer.resume();
    $("auxState").textContent = "live";
    $("auxState").classList.add("live");
    $("auxBtn").textContent = "Stop capture";
    toast("System audio is now on the master bus.");
  } catch (error) {
    toast(`Capture failed: ${(error as Error).message}`);
  }
});

/* ---------------------------------------------------------- streaming UI */
// Stream sources (D42): every service is a StreamSource. Decodable audio is
// loaded into the library and onto a deck exactly like a local file; services
// that only allow their own (DRM) player get it embedded in the deck panel,
// labelled monitor-only. Nothing opens a separate window.

const streamQueue = new PlayQueue();
const queuedStreamTracks = new Map<string, StreamTrack>();
const streamSources = createDefaultSources((sourceId): StreamHttp => ({
  request: async (req) => {
    if (!desktop?.streaming) return { status: 0, body: "", error: "network", detail: "streaming needs the desktop app" };
    return desktop.streaming.request(sourceId, req);
  },
}));
let selectedSource: StreamSource = streamSources.list()[0];
let streamStatus: Record<string, CredentialStatus> = {};
let widevineAvailable = false;
let browseStack: string[] = [];

function sourceStatus(source: StreamSource): AuthStatus {
  return source.authStatus(streamStatus[source.id]);
}

function renderProviders(): void {
  const list = $("providerList");
  list.replaceChildren();
  for (const source of streamSources.list()) {
    const status = sourceStatus(source);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "provider";
    button.dataset.source = source.id;
    button.setAttribute("aria-selected", String(source.id === selectedSource.id));
    const label = status.state === "needs-partner-key" ? NEEDS_PARTNER_KEY : status.state === "signed-in" ? "signed in" : status.state === "expired" ? "sign in again" : status.state === "signed-out" ? "key saved, signed out" : source.id === "web-player" ? "no key needed" : "catalogue key saved";
    button.innerHTML = `<strong>${escapeHtml(source.name)}</strong><span class="${status.state === "signed-in" || status.state === "app-only" ? "ok" : ""}">${escapeHtml(label)}</span>`;
    button.addEventListener("click", () => {
      selectedSource = source;
      browseStack = [];
      searchResults = [];
      renderProviders();
      renderStreamHead();
      renderResults();
    });
    list.append(button);
  }
}

function renderStreamHead(): void {
  const source = selectedSource;
  const status = sourceStatus(source);
  $("streamTitle").textContent = source.name;
  $("streamNote").textContent = status.message;
  const loginState = $("loginState");
  loginState.textContent = status.state === "needs-partner-key" ? NEEDS_PARTNER_KEY : status.state.replace(/-/g, " ");
  loginState.classList.toggle("live", status.state === "signed-in" || status.state === "app-only");
  const canSignIn = source.capabilities.userAuth && status.state !== "needs-partner-key";
  $("loginBtn").classList.toggle("hidden", !canSignIn || status.state === "signed-in");
  $("logoutBtn").classList.toggle("hidden", status.state !== "signed-in" && status.state !== "expired");
  $("streamKeyForm").classList.toggle("hidden", !source.oauth);
  $("streamSearchForm").classList.toggle("hidden", !source.capabilities.search);
  $("streamBrowseBtn").classList.toggle("hidden", !source.capabilities.browse);
  $<HTMLInputElement>("streamSearch").placeholder = source.id === "web-player" ? "Paste a Spotify, Apple Music, Deezer, YouTube, TIDAL, SoundCloud or Beatport track link" : `Search ${source.name}`;
  $("streamWarn").textContent = source.capabilities.decodable
    ? "Tracks this service hands out as plain audio load onto the decks like local files (BPM, key, waveform, stems, FX). Anything it only allows in its own player plays monitor-only."
    : "Official players only: monitor-only, so no deck EQ, FX or analysis. Mix them in with System audio capture (AUX).";
}

async function refreshStreamStatus(): Promise<void> {
  if (!desktop?.streaming) return;
  try {
    const status = await desktop.streaming.status();
    streamStatus = Object.fromEntries(status.sources.map((s) => [s.source, s]));
    widevineAvailable = widevineAvailable || status.widevineBuild;
  } catch {
    /* main process not ready; keep "needs partner API key" */
  }
  renderProviders();
  renderStreamHead();
}

$("streamKeyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!desktop?.streaming) {
    toast("Keys are stored by the desktop app.");
    return;
  }
  const idInput = $<HTMLInputElement>("streamClientId");
  const secretInput = $<HTMLInputElement>("streamClientSecret");
  const result = await desktop.streaming.setKey(selectedSource.id, idInput.value.trim(), secretInput.value.trim());
  secretInput.value = "";
  if (!result.ok) {
    toast(result.error ?? "Key not saved.");
    return;
  }
  idInput.value = "";
  await refreshStreamStatus();
  toast(`${selectedSource.name}: key saved. ${sourceStatus(selectedSource).message}`);
});

$("streamKeyClear").addEventListener("click", async () => {
  if (!desktop?.streaming) return;
  await desktop.streaming.clearKey(selectedSource.id);
  await refreshStreamStatus();
  toast(`${selectedSource.name}: key removed.`);
});

$("loginBtn").addEventListener("click", async () => {
  if (!desktop?.streaming) {
    toast("Sign-in needs the desktop app.");
    return;
  }
  const source = selectedSource;
  toast(`Finish signing in to ${source.name} in your browser, then come back here.`, 6000);
  const result = await desktop.streaming.signIn(source.id);
  await refreshStreamStatus();
  toast(result.ok ? `${source.name}: signed in.` : `${source.name}: ${result.error ?? "sign-in failed"}`);
});

$("logoutBtn").addEventListener("click", async () => {
  if (!desktop?.streaming) return;
  await desktop.streaming.signOut(selectedSource.id);
  await refreshStreamStatus();
});

let searchResults: StreamTrack[] = [];
let browseNodes: BrowseNode[] = [];

function deckButtons(track: StreamTrack): HTMLButtonElement[] {
  return ALL_DECKS.map((deckId) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mini deck-btn";
    button.textContent = deckId;
    button.title = `Load on deck ${deckId}`;
    button.addEventListener("click", () => void playStreamOnDeck(track, deckId));
    return button;
  });
}

function accessLabel(track: StreamTrack): string {
  if (track.source === "web-player") return " · official player, monitor only";
  if (track.access === "preview") return " · preview";
  if (track.access === "blocked") return " · not streamable";
  return "";
}

function renderResults(): void {
  const list = $("resultList");
  $("resultCount").textContent = String(searchResults.length);
  list.replaceChildren();
  if (browseNodes.length || browseStack.length) {
    if (browseStack.length) {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "ghost small";
      back.textContent = "← Back";
      back.addEventListener("click", () => {
        browseStack.pop();
        void browseSource(browseStack.pop());
      });
      list.append(back);
    }
    for (const node of browseNodes) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "result browse-node";
      row.textContent = node.title;
      row.addEventListener("click", () => void browseSource(node.id));
      list.append(row);
    }
  }
  if (!searchResults.length && !browseNodes.length) {
    list.classList.add("empty");
    const status = sourceStatus(selectedSource);
    list.textContent =
      status.state === "needs-partner-key"
        ? `${selectedSource.name}: ${NEEDS_PARTNER_KEY}. ${selectedSource.keyHelp}`
        : selectedSource.id === "web-player"
          ? "Paste a track link above."
          : "Search or browse to find tracks.";
    return;
  }
  list.classList.remove("empty");
  for (const track of searchResults) {
    const row = document.createElement("div");
    row.className = "result";
    row.innerHTML = `<div class="result-main"><div class="result-title">${escapeHtml(track.title)}</div><div class="result-sub">${escapeHtml(track.artist)}${track.durationSec ? ` · ${formatTime(track.durationSec)}` : ""}${track.bpm ? ` · ${Math.round(track.bpm)} BPM` : ""}${track.key ? ` · ${escapeHtml(track.key)}` : ""}${accessLabel(track)}</div></div>`;
    const queueButton = document.createElement("button");
    queueButton.type = "button";
    queueButton.className = "primary";
    queueButton.textContent = "Queue";
    queueButton.disabled = track.access === "blocked";
    queueButton.addEventListener("click", () => {
      queuedStreamTracks.set(streamTrackKey(track), track);
      streamQueue.add({ id: streamTrackKey(track), title: track.title, artist: track.artist, durationSec: track.durationSec, provider: track.source, url: track.permalink ?? "", thumbnail: track.artworkUrl });
      renderQueue();
      toast(`Queued: ${track.title}`);
    });
    const buttons = deckButtons(track);
    for (const b of buttons) b.disabled = track.access === "blocked";
    row.append(queueButton, ...buttons);
    list.append(row);
  }
}

function streamErrorToast(error: unknown): void {
  toast(describeError(error), 6000);
}

$("streamSearchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $<HTMLInputElement>("streamSearch").value.trim();
  if (!query) return;
  if (!desktop?.streaming && selectedSource.id !== "web-player") {
    toast("Search needs the desktop app.");
    return;
  }
  const status = sourceStatus(selectedSource);
  if (status.state === "needs-partner-key") {
    toast(`${selectedSource.name}: ${NEEDS_PARTNER_KEY}.`);
    renderResults();
    return;
  }
  try {
    browseNodes = [];
    browseStack = [];
    searchResults = await selectedSource.search(query);
    renderResults();
    if (!searchResults.length) toast(selectedSource.id === "web-player" ? "That link isn't one of the supported players." : "No tracks found.");
  } catch (error) {
    streamErrorToast(error);
  }
});

async function browseSource(nodeId?: string): Promise<void> {
  if (sourceStatus(selectedSource).state === "needs-partner-key") {
    toast(`${selectedSource.name}: ${NEEDS_PARTNER_KEY}.`);
    return;
  }
  try {
    const result = await selectedSource.browse(nodeId);
    if (nodeId) browseStack.push(nodeId);
    browseNodes = result.nodes;
    searchResults = result.tracks;
    renderResults();
    if (result.note && !result.nodes.length && !result.tracks.length) toast(result.note);
  } catch (error) {
    streamErrorToast(error);
  }
}

$("streamBrowseBtn").addEventListener("click", () => {
  browseStack = [];
  void browseSource();
});

function renderQueue(): void {
  const list = $("queueList");
  if (!streamQueue.items.length) {
    list.classList.add("empty");
    list.textContent = "Nothing queued yet.";
    $("queueNow").textContent = "—";
    return;
  }
  list.classList.remove("empty");
  list.replaceChildren();
  streamQueue.items.forEach((item, index) => {
    const track = queuedStreamTracks.get(item.id);
    const row = document.createElement("div");
    row.className = "queue-item" + (index === streamQueue.index ? " active" : "");
    row.innerHTML = `<span class="idx">${index + 1}</span><span class="q-main">${escapeHtml(item.title)} — ${escapeHtml(item.artist)}</span>`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.textContent = "✕";
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      streamQueue.remove(item.id);
      queuedStreamTracks.delete(item.id);
      renderQueue();
    });
    row.append(...(track ? deckButtons(track) : []), remove);
    list.append(row);
  });
  $("queueNow").textContent = streamQueue.current ? `${streamQueue.current.title} — ${streamQueue.current.artist}` : "—";
}

function loadQueued(item: QueueTrack | null, deckId: DeckId = "A"): void {
  const track = item ? queuedStreamTracks.get(item.id) : undefined;
  if (track) void playStreamOnDeck(track, deckId);
}

$("queueNext").addEventListener("click", () => {
  streamQueue.next();
  renderQueue();
});
$("queuePrev").addEventListener("click", () => {
  streamQueue.previous();
  renderQueue();
});
$("queueRepeat").addEventListener("click", () => {
  streamQueue.repeat = streamQueue.repeat === "off" ? "all" : streamQueue.repeat === "all" ? "one" : "off";
  $("queueRepeat").classList.toggle("active", streamQueue.repeat !== "off");
  toast(`Repeat ${streamQueue.repeat}`);
});
$("queueClear").addEventListener("click", () => {
  streamQueue.clear();
  queuedStreamTracks.clear();
  renderQueue();
});
$("queueOpen").addEventListener("click", () => loadQueued(streamQueue.current, "A"));

void probeKeySystems().then((report) => {
  widevineAvailable = widevineAvailable || report.keySystems.widevine;
  const chip = document.getElementById("drmStatusChip");
  if (chip) chip.textContent = widevineStatusText(report);
});

$("urlBtn").addEventListener("click", async () => {
  const url = $<HTMLInputElement>("urlInput").value.trim();
  if (!url) return;
  if (!desktop) {
    toast("URL loading needs the desktop app.");
    return;
  }
  try {
    const result = await desktop.media.fetch(url);
    if (!result.ok || !result.bytes) throw new Error(result.error ?? "fetch failed");
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "stream-audio");
    const file = new File([result.bytes as BlobPart], name, { type: result.type || "audio/mpeg" });
    const [track] = addFiles([file]);
    if (track) {
      await loadTrack(track, "A");
      toast(`Loaded ${name}`);
    }
  } catch (error) {
    toast(`Could not load URL: ${(error as Error).message}`);
  }
});

/* ------------------------------------------------------------- recording */

let saveUrl: string | null = null;

function setRecordUI(active: boolean): void {
  $("recBtn").setAttribute("aria-pressed", String(active));
  $("broadcastRecBtn").textContent = active ? "Stop recording" : "Start recording";
  $("recState").textContent = active ? "recording" : "idle";
  $("recState").classList.toggle("live", active);
}

async function toggleRecording(): Promise<void> {
  if (!mixer.recording) {
    await mixer.resume();
    mixer.startRecording();
    setRecordUI(true);
    requestFrame();
    return;
  }
  const result = await mixer.stopRecording();
  setRecordUI(false);
  requestFrame();
  $("recTime").textContent = "00:00";
  $("broadcastRecTime").textContent = "00:00";
  if (!result) return;
  if (saveUrl) URL.revokeObjectURL(saveUrl);
  saveUrl = URL.createObjectURL(result.blob);
  const save = $<HTMLAnchorElement>("saveMix");
  save.href = saveUrl;
  save.classList.remove("hidden");
  if (desktop) {
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const saved = await desktop.recording.save("opendeck-mix.webm", bytes);
    if (saved.ok) {
      $("recPath").textContent = `Saved to ${saved.path}`;
      toast(`Mix saved (${formatClock(result.seconds)})`);
      return;
    }
  }
  $("recPath").textContent = "Use Save mix in the top bar.";
  toast(`Mix ready (${formatClock(result.seconds)})`);
}

$("recBtn").addEventListener("click", () => void toggleRecording());
$("broadcastRecBtn").addEventListener("click", () => void toggleRecording());
$("saveMix").addEventListener("click", async (event) => {
  if (!desktop || !saveUrl) return;
  event.preventDefault();
  const blob = await (await fetch(saveUrl)).blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const saved = await desktop.recording.save("opendeck-mix.webm", bytes);
  if (saved.ok) toast(`Saved to ${saved.path}`);
});

/* ------------------------------------------------------------ broadcast */

const whip = new WhipBroadcaster();
let whipLive = false;

whip.onStatus = (status: BroadcastStatus) => {
  $("whipState").textContent = status.state;
  $("whipState").classList.toggle("live", status.state === "live");
  if (status.state === "error") toast(`WHIP: ${status.detail}`);
};

$("whipBtn").addEventListener("click", async () => {
  if (whipLive) {
    await whip.stop();
    whipLive = false;
    $("whipBtn").textContent = "Go live";
    return;
  }
  const endpoint = $<HTMLInputElement>("whipEndpoint").value.trim();
  if (!/^https:\/\//.test(endpoint)) {
    toast("Enter an https WHIP endpoint.");
    return;
  }
  try {
    $("whipBtn").textContent = "Connecting…";
    await mixer.resume();
    await whip.start(mixer.getStream(), endpoint, $<HTMLInputElement>("whipToken").value.trim() || undefined);
    whipLive = true;
    $("whipBtn").textContent = "Stop broadcast";
    toast("WHIP broadcast live");
  } catch (error) {
    $("whipBtn").textContent = "Go live";
    toast(`WHIP failed: ${(error as Error).message}`);
  }
});

let rtmpRecorder: MediaRecorder | null = null;
let rtmpLive = false;

desktop?.rtmp.available().then((available) => {
  $("rtmpState").textContent = available ? "ffmpeg ready" : "ffmpeg missing";
  $("rtmpState").classList.toggle("live", available);
  $<HTMLButtonElement>("rtmpBtn").disabled = !available;
  if (!available) {
    $("rtmpLog").textContent = "RTMP needs FFmpeg. Install it, add ffmpeg to PATH, then restart OpenDecks.";
  }
});

desktop?.rtmp.onLog((payload) => {
  const el = $("rtmpLog");
  el.textContent = `${el.textContent}${String(payload)}`.slice(-1200);
});
desktop?.rtmp.onExit((payload) => {
  const info = payload as { code: number; error?: string };
  if (rtmpLive) toast(`RTMP stopped (code ${info.code})${info.error ? `: ${info.error}` : ""}`);
  rtmpLive = false;
  $("rtmpBtn").textContent = "Go live";
  $("rtmpState").textContent = "idle";
  $("rtmpState").classList.remove("live");
});

$("rtmpBtn").addEventListener("click", async () => {
  if (!desktop) return;
  if (rtmpLive) {
    rtmpRecorder?.stop();
    rtmpRecorder = null;
    await desktop.rtmp.stop();
    rtmpLive = false;
    $("rtmpBtn").textContent = "Go live";
    $("rtmpState").textContent = "idle";
    $("rtmpState").classList.remove("live");
    return;
  }
  const endpoint = $<HTMLInputElement>("rtmpUrl").value.trim();
  const key = $<HTMLInputElement>("rtmpKey").value.trim();
  if (!/^rtmps?:\/\//.test(endpoint)) {
    toast("Enter an rtmp:// or rtmps:// ingest URL.");
    return;
  }
  await mixer.resume();
  const started = await desktop.rtmp.start(endpoint, key);
  if (!started.ok) {
    toast(`RTMP failed: ${started.detail ?? "unknown error"}`);
    return;
  }
  const mime = ["audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
  rtmpRecorder = new MediaRecorder(mixer.getStream(), mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
  rtmpRecorder.ondataavailable = async (event) => {
    if (!event.data.size) return;
    const bytes = new Uint8Array(await event.data.arrayBuffer());
    await desktop.rtmp.chunk(bytes);
  };
  rtmpRecorder.start(400);
  rtmpLive = true;
  $("rtmpBtn").textContent = "Stop broadcast";
  $("rtmpState").textContent = "live";
  $("rtmpState").classList.add("live");
  toast("RTMP broadcast started");
});

/* ---------------------------------------------------------------- tabs */

for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"))) {
  tab.addEventListener("click", () => {
    for (const other of Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"))) {
      other.setAttribute("aria-selected", String(other === tab));
    }
    for (const panel of Array.from(document.querySelectorAll<HTMLElement>(".panel"))) {
      panel.classList.toggle("hidden", panel.dataset.panel !== tab.dataset.tab);
    }
    $("consoleHint").textContent =
      tab.dataset.tab === "stream"
        ? "Sign in and queue music from streaming services"
        : tab.dataset.tab === "broadcast"
          ? "Record the mix, or push it live"
          : tab.dataset.tab === "video"
            ? "Deck-locked video mixing, independent crossfader, fit/fill scaling and 2nd output window"
            : "Local files, Serato crates and streamed sources";
  });
}

/* -------------------------------------------------------------- meters */

function drawMeter(canvas: HTMLCanvasElement, level: number, accent = "brand"): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b111c";
  ctx.fillRect(0, 0, w, h);
  const scaled = Math.min(1, level * 2.6);
  const bars = 20;
  let style = "";
  ctx.beginPath();
  for (let i = 0; i < bars; i += 1) {
    const lit = i / bars < scaled;
    const y = h - ((i + 1) * h) / bars;
    const ratio = i / bars;
    const next = lit
      ? ratio > 0.88
        ? "#e8567a"
        : ratio > 0.7
          ? "#f0a726"
          : accent === "master"
            ? "#8aa2ff"
            : "#4d6bfe"
      : "#1c2637";
    if (next !== style) {
      if (style) ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = next;
      style = next;
    }
    ctx.rect(2, y + 2, w - 4, h / bars - 3);
  }
  ctx.fill();
}

/* ------------------------------------------------------------- main loop */

function updateClock(): void {
  $("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderDeckFrame(deckId: DeckId): void {
  const state = states[deckId];
  const deck = decks[deckId];
  const refs = ui[deckId]!;
  if (!state) return;

  const loaded = deck.hasTrack && Boolean(meta[deckId]);
  refs.time.textContent = deckTimeText(loaded, deck.currentTime, deck.duration);
  refs.time.classList.toggle("track-end-warn", loaded && Boolean(state.trackEndWarning));
  refs.slipToggle?.setAttribute("aria-pressed", String(Boolean(state.returnMode)));
  refs.bar.textContent = state.bpm ? formatBeatPosition(deck.currentTime, state.bpm, deck.info.beatPhase) : "—";
  refs.tempo.textContent = `${state.tempoPercent >= 0 ? "+" : ""}${state.tempoPercent.toFixed(1)}%`;
  refs.play.textContent = state.playing ? "PAUSE" : "PLAY";
  refs.play.classList.toggle("active", state.playing);
  refs.vinyl.classList.toggle("playing", state.playing);
  refs.loop.classList.toggle("active", state.loopActive);
  refs.keylock.setAttribute("aria-pressed", String(state.keylock));

  waves[deckId]?.setProgress(loaded ? deck.currentTime : 0);
  zooms[deckId]?.update(loaded ? deck.currentTime : 0);
  updatePads(deckId);

  const signature = loopSignature(deck);
  if ((refs.root as HTMLElement & { loopSig?: string }).loopSig !== signature) {
    (refs.root as HTMLElement & { loopSig?: string }).loopSig = signature;
    syncLoopButtons(deckId);
  }
}

function frame(): void {
  rafPending = true;
  for (const deckId of ALL_DECKS) decks[deckId].tick();
  for (const deckId of ALL_DECKS) {
    const playing = decks[deckId].playing;
    if (playing && !wasPlaying[deckId]) {
      const track = meta[deckId];
      if (track) {
        library.recordPlay(track);
        persistLibraryUx();
        renderPlayedLog();
      }
    }
    wasPlaying[deckId] = playing;
  }
  updateEngineDiagnostics(performance.now());
  for (const deckId of ALL_DECKS) {
    renderDeckFrame(deckId);
    syncDeckVideoFrame(deckId);
  }
  renderVideoMixFrame();
  drawMeter($<HTMLCanvasElement>("meterA"), decks.A.level, "deck");
  drawMeter($<HTMLCanvasElement>("meterB"), decks.B.level, "deck");
  drawMeter($<HTMLCanvasElement>("meterMaster"), mixer.level(), "master");

  const playing = (["A", "B"] as const).find((id) => decks[id].playing);
  const bpm = playing ? decks[playing].info.bpm : decks.A.info.bpm || decks.B.info.bpm;
  $("masterBpmChip").textContent = bpm ? `${bpm.toFixed(1)} BPM` : "-- BPM";

  if (mixer.recording) {
    const seconds = mixer.recordedSeconds;
    $("recTime").textContent = formatClock(seconds).slice(3);
    $("broadcastRecTime").textContent = formatClock(seconds);
  }
  const active =
    ALL_DECKS.some((id) => decks[id].playing || decks[id].scratchingActive) ||
    mixer.recording;
  rafPending = false;
  if (active) requestFrame();
}

function requestFrame(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(frame);
}

/* -------------------------------------------------------------- keyboard */

const MIDI_TARGETS: { id: string; label: string }[] = [
  { id: "mix.crossfader", label: "Crossfader" },
  { id: "mix.chA", label: "Channel A fader" },
  { id: "mix.chB", label: "Channel B fader" },
  { id: "mix.chC", label: "Channel C fader" },
  { id: "mix.chD", label: "Channel D fader" },
  { id: "mix.master", label: "Master fader" },
  { id: "mix.aux", label: "System audio (AUX)" },
  { id: "mix.rec", label: "Record start/stop" },
];
for (const deckId of ALL_DECKS) {
  MIDI_TARGETS.push(
    { id: `${deckId}.play`, label: `${deckId} Play/Pause` },
    { id: `${deckId}.cue`, label: `${deckId} Cue` },
    { id: `${deckId}.sync`, label: `${deckId} Sync` },
    { id: `${deckId}.loop`, label: `${deckId} Loop` },
    { id: `${deckId}.pitch`, label: `${deckId} Tempo` },
    { id: `${deckId}.eqHigh`, label: `${deckId} EQ high` },
    { id: `${deckId}.eqMid`, label: `${deckId} EQ mid` },
    { id: `${deckId}.eqLow`, label: `${deckId} EQ low` },
    { id: `${deckId}.trim`, label: `${deckId} Trim` },
    { id: `${deckId}.fxWet`, label: `${deckId} FX wet` },
  );
  for (let index = 1; index <= 8; index += 1) {
    MIDI_TARGETS.push({ id: `${deckId}.pad${index}`, label: `${deckId} Hot cue ${index}` });
  }
}
for (const pad of SAMPLER_SLOTS) {
  MIDI_TARGETS.push({ id: `smp.${pad.slot + 1}`, label: `Sampler ${pad.slot + 1} ${pad.label}` });
}


const midiBindings: MidiBindings = loadBindings(window.localStorage);
let midiLearnTarget: string | null = null;
let midiAccess: {
  inputs: Map<
    string,
    {
      id?: string;
      name?: string | null;
      manufacturer?: string | null;
      state?: string;
      onmidimessage: ((event: { data: ArrayLike<number> }) => void) | null;
    }
  >;
  addEventListener: (type: string, handler: () => void) => void;
} | null = null;

function midiLabel(id: string): string {
  return MIDI_TARGETS.find((target) => target.id === id)?.label ?? id;
}

function setMidiHint(text: string): void {
  $("midiHint").textContent = text;
}

function midiInputFor(target: string): HTMLInputElement | null {
  if (target === "mix.crossfader") return $<HTMLInputElement>("crossfader");
  if (target === "mix.chA") return $<HTMLInputElement>("chA");
  if (target === "mix.chB") return $<HTMLInputElement>("chB");
  if (target === "mix.chC") return $<HTMLInputElement>("chC");
  if (target === "mix.chD") return $<HTMLInputElement>("chD");
  if (target === "mix.master") return $<HTMLInputElement>("master");
  if (target === "mix.aux") return $<HTMLInputElement>("auxGain");
  const [deckId, name] = target.split(".") as [DeckId, string];
  const refs = ui[deckId];
  if (!refs) return null;
  const names: Record<string, string> = {
    pitch: "pitch",
    eqHigh: "eqHigh",
    eqMid: "eqMid",
    eqLow: "eqLow",
    trim: "trim",
    fxWet: "fxWet",
  };
  return names[name] ? (refs[names[name]] as HTMLInputElement) : null;
}

function midiActionFor(target: string): HTMLElement | null {
  if (target === "mix.rec") return $("recBtn");
  const [deckId, name] = target.split(".") as [DeckId, string];
  const refs = ui[deckId];
  if (!refs) return null;
  if (name === "play" || name === "cue" || name === "sync" || name === "loop") {
    return refs[name] as HTMLElement;
  }
  if (name.startsWith("pad")) {
    return (refs.pads.children[Number(name.slice(3)) - 1] as HTMLElement | undefined) ?? null;
  }
  return null;
}

function applyMidiEvent(event: MidiEvent): void {
  $("midiMonitor").textContent = describeMidiEvent(event);
  if (event.type === "noteoff") return;
  if (midiLearnTarget) {
    const target = midiLearnTarget;
    midiBindings[target] = bindingFor(event);
    saveBindings(window.localStorage, midiBindings);
    midiLearnTarget = null;
    $("midiLearn").setAttribute("aria-pressed", "false");
    const kind = event.type === "cc" ? `CC ${event.controller}` : `note ${event.note}`;
    setMidiHint(`${midiLabel(target)} bound to ${kind}. ${Object.keys(midiBindings).length} mapping(s).`);
    return;
  }
  let matched = false;
  for (const [target, binding] of Object.entries(midiBindings)) {
    if (!matchesBinding(binding, event)) continue;
    matched = true;
    if (event.type === "cc") {
      const input = midiInputFor(target);
      if (!input) continue;
      const min = Number(input.min || 0);
      const max = Number(input.max || 1);
      input.value = String(mapControlValue(binding, event.normalized, min, max));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (event.type === "noteon") {
      if (target.startsWith("smp.")) {
        triggerSamplerPad(Number(target.slice(4)) - 1, event.normalized);
      } else {
        midiActionFor(target)?.click();
      }
    }
  }
  if (!matched && event.type === "noteon") {
    const pad = defaultPadIndex(event.note);
    if (pad !== null) triggerSamplerPad(pad, event.normalized);
  }
}

function renderMidiDevices(inputs: { name?: string | null; manufacturer?: string | null }[]): void {
  const list = $("midiDevices");
  list.replaceChildren();
  if (!inputs.length) {
    const empty = document.createElement("span");
    empty.className = "micro";
    empty.textContent = "No devices";
    list.append(empty);
    return;
  }
  for (const input of inputs) {
    const row = document.createElement("div");
    row.className = "midi-device";
    const name = document.createElement("strong");
    name.textContent = input.name || "MIDI input";
    const maker = document.createElement("span");
    const profile = profileForDevice(`${input.manufacturer ?? ""} ${input.name ?? ""}`);
    const badges: string[] = [];
    if (profile) {
      if (profile.decks === 4) badges.push("4-Deck");
      else if (profile.decks === 1) badges.push("1-Deck");
      if (profile.dvsUpgrade) badges.push("DVS Upgrade");
      else if (profile.dvsReady) badges.push("DVS Ready");
    }
    const presetTag = profile
      ? `preset: ${profile.label}${badges.length ? ` [${badges.join(" · ")}]` : ""}`
      : "";
    maker.textContent = [input.manufacturer, presetTag]
      .filter(Boolean)
      .join(" · ");
    row.append(name, maker);
    list.append(row);
  }
}

function refreshMidiInputs(): void {
  if (!midiAccess) return;
  const inputs = [...midiAccess.inputs.values()];
  for (const input of inputs) {
    input.onmidimessage = (event) => {
      const parsed = parseMidiMessage(event.data);
      if (parsed) applyMidiEvent(parsed);
    };
  }
  renderMidiDevices(inputs);
  $("midiState").textContent = inputs.length ? `${inputs.length} in` : "no device";
  const detected: string[] = [];
  let hasFourDeckDevice = false;
  for (const input of inputs) {
    const profile = profileForDevice(`${input.manufacturer ?? ""} ${input.name ?? ""}`);
    if (!profile) continue;
    if (profile.decks === 4) {
      hasFourDeckDevice = true;
    }
    if (applyProfile(midiBindings, profile).length) {
      detected.push(profile.label);
    }
  }
  if (hasFourDeckDevice && document.getElementById("fourDeckToggle")?.getAttribute("aria-pressed") !== "true") {
    setFourDeckMode(true);
  }
  if (detected.length) {
    saveBindings(window.localStorage, midiBindings);
  }
  if (!inputs.length) {
    setMidiHint("No MIDI input found. Plug in a controller and it will appear here.");
  } else if (detected.length) {
    setMidiHint(`Loaded preset for ${detected.join(", ")}. ${Object.keys(midiBindings).length} mapping(s).`);
  } else {
    setMidiHint(`${inputs.length} input(s). Notes 36-43 play sampler pads 1-8; use Learn for other controls.`);
  }
}

async function enableMidi(): Promise<void> {
  const bridge = navigator as unknown as {
    requestMIDIAccess?: () => Promise<NonNullable<typeof midiAccess>>;
  };
  if (!bridge.requestMIDIAccess) {
    setMidiHint("Web MIDI is unavailable in this build (needs the Tauri/Edge runtime or Chrome).");
    return;
  }
  setMidiHint("Requesting MIDI access...");
  try {
    midiAccess = await Promise.race([
      bridge.requestMIDIAccess(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("no answer from the host - MIDI permission is not being granted")), 6000);
      }),
    ]);
  } catch (error) {
    setMidiHint(`MIDI permission denied: ${(error as Error).message}`);
    return;
  }
  midiAccess.addEventListener("statechange", refreshMidiInputs);
  $("midiEnable").classList.add("hidden");
  setMidiHint("MIDI ready. Pick a target, press Learn, then move that knob or pad.");
  refreshMidiInputs();
}

function initMidiUi(): void {
  const select = $<HTMLSelectElement>("midiTarget");
  for (const target of MIDI_TARGETS) {
    const option = document.createElement("option");
    option.value = target.id;
    option.textContent = target.label;
    select.append(option);
  }
  $("midiEnable").addEventListener("click", () => void enableMidi());
  $("midiLearn").addEventListener("click", () => {
    if (!midiAccess) {
      setMidiHint("Enable MIDI first.");
      return;
    }
    midiLearnTarget = select.value;
    $("midiLearn").setAttribute("aria-pressed", "true");
    setMidiHint(`Listening for ${midiLabel(midiLearnTarget)} - move a knob or hit a pad.`);
  });
  $("midiForget").addEventListener("click", () => {
    const target = select.value;
    if (!midiBindings[target]) {
      setMidiHint(`${midiLabel(target)} has no mapping.`);
      return;
    }
    delete midiBindings[target];
    saveBindings(window.localStorage, midiBindings);
    setMidiHint(`Cleared ${midiLabel(target)}. ${Object.keys(midiBindings).length} mapping(s) left.`);
  });
  if (Object.keys(midiBindings).length) {
    $("midiEnable").classList.remove("hidden");
    setMidiHint(`${Object.keys(midiBindings).length} saved mapping(s). Enable MIDI to reconnect.`);
  }
}

const samplerBankOffset = (): number => SAMPLER_BANKS.indexOf(samplerBank) * 8;

function triggerSamplerPad(slot: number, velocity = 1): void {
  void mixer.resume();
  sampler.trigger(slot, velocity);
  const offset = samplerBankOffset();
  if (slot < offset || slot >= offset + 8) return;
  const button = $("samplerPads").children[slot - offset] as HTMLElement | undefined;
  if (!button) return;
  button.classList.add("hit");
  window.setTimeout(() => button.classList.remove("hit"), 120);
}

function renderSamplerPads(): void {
  const host = $("samplerPads");
  host.replaceChildren();
  const offset = samplerBankOffset();
  SAMPLER_SLOTS.slice(offset, offset + 8).forEach((pad, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sampler-pad";
    button.title = `${pad.label} (NumPad ${index + 1})`;
    button.innerHTML = `<span class="smp-index">${index + 1}</span><small>${pad.label}</small>`;
    button.addEventListener("click", () => triggerSamplerPad(offset + index, 1));
    host.append(button);
  });
  $("samplerState").textContent = `Bank ${samplerBank} · ${offset + 1}-${offset + 8} of 32`;
  for (const button of Array.from($("samplerBanks").children)) {
    button.setAttribute("aria-pressed", String(button.textContent === samplerBank));
  }
}

function setSamplerBank(bank: SamplerBank): void {
  samplerBank = bank;
  renderSamplerPads();
}

function initSamplerUi(): void {
  const banks = $("samplerBanks");
  for (const bank of SAMPLER_BANKS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sampler-bank";
    button.textContent = bank;
    button.title = `Sampler bank ${bank}`;
    button.addEventListener("click", () => setSamplerBank(bank));
    banks.append(button);
  }
  renderSamplerPads();
  $("samplerVol").addEventListener("input", (event) =>
    sampler.setVolume(Number((event.target as HTMLInputElement).value)),
  );
  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const match = /^Numpad([1-8])$/.exec(event.code);
    if (!match) return;
    event.preventDefault();
    triggerSamplerPad(samplerBankOffset() + Number(match[1]) - 1, 1);
  });
}

async function toggleFullscreen(): Promise<void> {
  const tauri = (
    window as unknown as {
      __TAURI__?: {
        window?: {
          getCurrentWindow?: () => {
            isFullscreen: () => Promise<boolean>;
            setFullscreen: (value: boolean) => Promise<void>;
          };
        };
      };
    }
  ).__TAURI__?.window?.getCurrentWindow?.();
  if (tauri) {
    try {
      await tauri.setFullscreen(!(await tauri.isFullscreen()));
      return;
    } catch {
      // fall through to the DOM API
    }
  }
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
}

function keyHandler(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (target.matches("input, textarea, select") || event.metaKey || event.ctrlKey) return;
  const key = event.key.toLowerCase();
  if (key === "f11") {
    event.preventDefault();
    void toggleFullscreen();
    return;
  }
  if (key === "q") toggleDeck("A");
  else if (key === "p") toggleDeck("B");
  else if (key === "a") decks.A.jumpToCue();
  else if (key === "l") decks.B.jumpToCue();
  else if (key === "s") applySync("A");
  else if (key === "d") applySync("B");
  else if (key === "arrowleft" || key === "arrowright") {
    const xf = $<HTMLInputElement>("crossfader");
    const step = event.shiftKey ? 0.1 : 0.02;
    xf.value = String(Math.max(0, Math.min(1, Number(xf.value) + (key === "arrowright" ? step : -step))));
    mixer.setCrossfader(Number(xf.value), $<HTMLSelectElement>("xfCurve").value as CrossfaderCurve);
    videoMixer.setAudioCrossfader(Number(xf.value), false);
  } else if (/^[1-8]$/.test(key)) {
    const deckId: DeckId = event.shiftKey ? "B" : "A";
    decks[deckId].jumpHotCue(Number(key) - 1);
    persistCues(deckId);
  } else if (key === " ") {
    event.preventDefault();
    toggleDeck("A");
  } else return;
  event.preventDefault();
}

/* ------------------------------------------------------------------ init */

for (const deckId of ALL_DECKS) {
  buildDeck(deckId);
  applyTempo(deckId, 0);
  syncLoopButtons(deckId);
}

function setFourDeckMode(enabled: boolean): void {
  document.getElementById("deckSlotC")?.classList.toggle("hidden", !enabled);
  document.getElementById("deckSlotD")?.classList.toggle("hidden", !enabled);
  document.getElementById("chCWrap")?.classList.toggle("hidden", !enabled);
  document.getElementById("chDWrap")?.classList.toggle("hidden", !enabled);
  const btn = document.getElementById("fourDeckToggle");
  btn?.setAttribute("aria-pressed", String(enabled));
  library.setFourDeckMode(enabled);
}
setFourDeckMode(localStorage.getItem("opendeck.fourDecks") === "1");
document.getElementById("fourDeckToggle")?.addEventListener("click", () => {
  const next = document.getElementById("fourDeckToggle")?.getAttribute("aria-pressed") !== "true";
  localStorage.setItem("opendeck.fourDecks", next ? "1" : "0");
  setFourDeckMode(next);
});
function setWaveMode(vertical: boolean): void {
  document.body.classList.toggle("vertical-waves", vertical);
  const button = $("waveMode");
  button.setAttribute("aria-pressed", String(vertical));
  button.textContent = vertical ? "Horizontal waves" : "Vertical waves";
  // Every deck, not just A and B: C and D used to stay horizontal.
  applyWaveOrientation(zooms, vertical, ALL_DECKS);
}

setWaveMode(storedWaveVertical(localStorage.getItem("opendeck.waveMode")));
$("waveMode").addEventListener("click", () => {
  const next = !document.body.classList.contains("vertical-waves");
  localStorage.setItem("opendeck.waveMode", next ? "1" : "0");
  setWaveMode(next);
});

mixer.setCrossfader(0.5);
mixer.setMaster(0.8);
$<HTMLSelectElement>("xfCurve").value = "smooth";
/* ------------------------------------------------------- fullscreen chrome */

const topbarElement = document.querySelector(".topbar") as HTMLElement | null;
const topbarSensor = document.createElement("div");
topbarSensor.className = "topbar-sensor";
document.body.append(topbarSensor);
let topbarCloseTimer = 0;

function revealTopbar(): void {
  document.body.classList.add("topbar-open");
  if (topbarCloseTimer) window.clearTimeout(topbarCloseTimer);
}

function scheduleTopbarHide(): void {
  topbarCloseTimer = window.setTimeout(() => document.body.classList.remove("topbar-open"), 420);
}

topbarSensor.addEventListener("pointerenter", revealTopbar);
topbarElement?.addEventListener("pointerenter", revealTopbar);
topbarElement?.addEventListener("pointerleave", scheduleTopbarHide);

function updateImmersive(): void {
  const screenWidth = window.screen?.width ?? window.innerWidth;
  const screenHeight = window.screen?.height ?? window.innerHeight;
  const fullscreen =
    Boolean(document.fullscreenElement) ||
    (window.innerWidth >= screenWidth * 0.94 && window.innerHeight >= screenHeight * 0.9);
  document.body.classList.toggle("immersive", fullscreen);
  if (!fullscreen) document.body.classList.remove("topbar-open");
}

window.addEventListener("resize", updateImmersive);
document.addEventListener("fullscreenchange", updateImmersive);
updateImmersive();


const deckVideoElements: Partial<Record<DeckId, HTMLVideoElement>> = {};
let videoOutputChannel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== "undefined") {
    videoOutputChannel = new BroadcastChannel("opendeck-video-output");
  }
} catch {
  videoOutputChannel = null;
}

function ensureDeckVideoElement(deckId: DeckId): HTMLVideoElement {
  let el = deckVideoElements[deckId];
  if (!el) {
    el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    el.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(el!.duration) && el!.duration > 0) {
        videoMixer.setDuration(deckId, el!.duration);
      }
      renderVideoMixFrame();
    });
    deckVideoElements[deckId] = el;
  }
  return el;
}

function attachVideoToDeck(deckId: DeckId, url: string, fileName: string, duration = 0): void {
  const v = ensureDeckVideoElement(deckId);
  v.src = url;
  v.load();
  videoMixer.loadVideo(deckId, url, fileName, duration);
  renderVideoMixFrame();
}

function loadVideoOntoDeck(deckId: DeckId, file: File): void {
  const url = URL.createObjectURL(file);
  const v = ensureDeckVideoElement(deckId);
  v.src = url;
  v.load();
  videoMixer.loadVideo(deckId, url, file.name, 0);
  toast(`Loaded video "${file.name}" onto Deck ${deckId}`);
  renderVideoMixFrame();
}

function syncDeckVideoFrame(deckId: DeckId): void {
  const deck = decks[deckId];
  const slot = videoMixer.syncDeck(deckId, {
    currentTime: deck.currentTime,
    duration: deck.duration,
    playing: deck.playing,
    rate: deck.state().rate,
    reversed: deck.censorActive || deck.state().rate < 0,
    scratching: deck.scratchingActive || deck.partScratching !== null,
  });
  if (!slot.loaded || !slot.url) return;
  const v = ensureDeckVideoElement(deckId);
  const decision = shouldResyncVideoElement(
    v.currentTime || 0,
    slot.currentTime,
    slot.playing,
    slot.rate,
    slot.reversed,
    slot.scratching,
  );
  if (Math.abs(v.playbackRate - decision.playbackRate) > 0.01) {
    try { v.playbackRate = decision.playbackRate; } catch {}
  }
  if (decision.seek) {
    try { v.currentTime = decision.target; } catch {}
  }
  if (decision.shouldPlay) {
    if (v.paused) void v.play().catch(() => {});
  } else if (!v.paused) {
    v.pause();
  }
}

function drawVideoSlotToCanvas(canvas: HTMLCanvasElement | null, deckId: DeckId): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "#05070b";
  ctx.fillRect(0, 0, w, h);
  const slot = videoMixer.decks[deckId];
  if (!slot.loaded) {
    ctx.fillStyle = "rgba(180,195,220,0.45)";
    ctx.font = "12px monospace";
    ctx.fillText(`Deck ${deckId} · No video`, 14, h * 0.5);
    return;
  }
  const v = deckVideoElements[deckId];
  if (v && v.readyState >= 2) {
    ctx.save();
    ctx.filter = formatVideoCssFilter(slot.fx);
    const r = computeAspectRect(v.videoWidth || 320, v.videoHeight || 180, w, h, slot.scaleMode);
    ctx.drawImage(v, r.x, r.y, r.width, r.height);
    ctx.restore();
  } else {
    ctx.fillStyle = "#58a6ff";
    ctx.font = "12px monospace";
    ctx.fillText(`Deck ${deckId}: ${slot.fileName} (${slot.currentTime.toFixed(1)}s)`, 12, h * 0.5);
  }
}

function renderVideoMixFrame(): void {
  const leftCanvas = document.getElementById("videoLeftCanvas") as HTMLCanvasElement | null;
  const rightCanvas = document.getElementById("videoRightCanvas") as HTMLCanvasElement | null;
  const masterCanvas = document.getElementById("videoMasterCanvas") as HTMLCanvasElement | null;
  const snap = videoMixer.getSnapshot();

  drawVideoSlotToCanvas(leftCanvas, snap.leftDeck);
  drawVideoSlotToCanvas(rightCanvas, snap.rightDeck);

  const leftTitle = document.getElementById("videoLeftTitle");
  const rightTitle = document.getElementById("videoRightTitle");
  const leftTime = document.getElementById("videoLeftTime");
  const rightTime = document.getElementById("videoRightTime");
  const leftSlot = snap.decks[snap.leftDeck];
  const rightSlot = snap.decks[snap.rightDeck];
  if (leftTitle) leftTitle.textContent = leftSlot.loaded ? leftSlot.fileName : "No video loaded";
  if (rightTitle) rightTitle.textContent = rightSlot.loaded ? rightSlot.fileName : "No video loaded";
  if (leftTime) leftTime.textContent = `${leftSlot.currentTime.toFixed(1)}s${leftSlot.reversed ? " REV" : ""}`;
  if (rightTime) rightTime.textContent = `${rightSlot.currentTime.toFixed(1)}s${rightSlot.reversed ? " REV" : ""}`;

  if (masterCanvas) {
    const ctx = masterCanvas.getContext("2d");
    if (ctx) {
      const w = masterCanvas.width;
      const h = masterCanvas.height;
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);

      const drawMasterDeck = (deckId: DeckId, alpha: number, additive: boolean): void => {
        const slot = snap.decks[deckId];
        if (!slot.loaded || alpha <= 0.001) return;
        const v = deckVideoElements[deckId];
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.globalCompositeOperation = additive ? "lighter" : "source-over";
        ctx.filter = formatVideoCssFilter(slot.fx);
        if (v && v.readyState >= 2) {
          const r = computeAspectRect(v.videoWidth || 480, v.videoHeight || 270, w, h, slot.scaleMode);
          ctx.drawImage(v, r.x, r.y, r.width, r.height);
        } else {
          ctx.fillStyle = deckId === snap.leftDeck ? "#1f6feb" : "#d29922";
          const r = computeAspectRect(16, 9, w, h, slot.scaleMode);
          ctx.fillRect(r.x, r.y, r.width, r.height);
          ctx.fillStyle = "#ffffff";
          ctx.font = "13px monospace";
          ctx.fillText(`${deckId}: ${slot.fileName} @ ${slot.currentTime.toFixed(2)}s`, r.x + 16, r.y + 32);
        }
        ctx.restore();
      };

      drawMasterDeck(snap.leftDeck, snap.weights.left, false);
      drawMasterDeck(snap.rightDeck, snap.weights.right, snap.blendMode === "add");
    }
  }

  try {
    videoOutputChannel?.postMessage(snap);
  } catch {}
  if (snap.outputOpen && desktop?.video?.syncOutput) {
    void desktop.video.syncOutput(snap);
  }
}

function initVideoUi(): void {
  const fileInput = document.getElementById("videoFileInput") as HTMLInputElement | null;
  let targetVideoDeck: DeckId = "A";

  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) loadVideoOntoDeck(targetVideoDeck, file);
    fileInput.value = "";
  });

  document.getElementById("videoLeftDeck")?.addEventListener("change", (ev) => {
    const id = (ev.target as HTMLSelectElement).value as DeckId;
    videoMixer.setLeftDeck(id);
    const chip = document.getElementById("videoLeftChip");
    if (chip) chip.textContent = `Left: Deck ${id}`;
    renderVideoMixFrame();
  });

  document.getElementById("videoRightDeck")?.addEventListener("change", (ev) => {
    const id = (ev.target as HTMLSelectElement).value as DeckId;
    videoMixer.setRightDeck(id);
    const chip = document.getElementById("videoRightChip");
    if (chip) chip.textContent = `Right: Deck ${id}`;
    renderVideoMixFrame();
  });

  for (const id of ALL_DECKS) {
    document.getElementById(`videoLoad${id}`)?.addEventListener("click", () => {
      targetVideoDeck = id;
      fileInput?.click();
    });
  }
  document.getElementById("videoLoadLeftBtn")?.addEventListener("click", () => {
    targetVideoDeck = videoMixer.leftDeck;
    fileInput?.click();
  });

  document.getElementById("videoLoadRightBtn")?.addEventListener("click", () => {
    targetVideoDeck = videoMixer.rightDeck;
    fileInput?.click();
  });

  document.getElementById("videoEjectLeftBtn")?.addEventListener("click", () => {
    videoMixer.ejectVideo(videoMixer.leftDeck);
    renderVideoMixFrame();
  });

  document.getElementById("videoEjectRightBtn")?.addEventListener("click", () => {
    videoMixer.ejectVideo(videoMixer.rightDeck);
    renderVideoMixFrame();
  });

  const videoXf = document.getElementById("videoCrossfader") as HTMLInputElement | null;
  videoXf?.addEventListener("input", () => {
    videoMixer.setCrossfader(Number(videoXf.value));
    renderVideoMixFrame();
  });

  const linkXf = document.getElementById("videoLinkXf") as HTMLInputElement | null;
  linkXf?.addEventListener("change", () => {
    const audioXf = Number(($<HTMLInputElement>("crossfader")?.value) ?? 0.5);
    videoMixer.setLinkToAudioCrossfader(linkXf.checked, audioXf);
    if (videoXf) videoXf.value = String(videoMixer.crossfader);
    renderVideoMixFrame();
  });

  document.getElementById("videoBlendMode")?.addEventListener("change", (ev) => {
    videoMixer.setBlendMode((ev.target as HTMLSelectElement).value as VideoBlendMode);
    renderVideoMixFrame();
  });

  document.getElementById("videoScaleMode")?.addEventListener("change", (ev) => {
    videoMixer.setScaleMode((ev.target as HTMLSelectElement).value as VideoScaleMode);
    renderVideoMixFrame();
  });

  const applyFxUi = (): void => {
    const brightness = Number((document.getElementById("videoFxBright") as HTMLInputElement | null)?.value ?? 1);
    const contrast = Number((document.getElementById("videoFxContrast") as HTMLInputElement | null)?.value ?? 1);
    const monochrome = Boolean((document.getElementById("videoFxMono") as HTMLInputElement | null)?.checked);
    const invert = Boolean((document.getElementById("videoFxInvert") as HTMLInputElement | null)?.checked);
    for (const id of ALL_DECKS) {
      videoMixer.setDeckFx(id, { brightness, contrast, monochrome, invert });
    }
    renderVideoMixFrame();
  };
  document.getElementById("videoFxBright")?.addEventListener("input", applyFxUi);
  document.getElementById("videoFxContrast")?.addEventListener("input", applyFxUi);
  document.getElementById("videoFxMono")?.addEventListener("change", applyFxUi);
  document.getElementById("videoFxInvert")?.addEventListener("change", applyFxUi);

  const updateOutStatus = (open: boolean, fullscreen: boolean): void => {
    videoMixer.setOutputWindowState(open, fullscreen);
    const chip = document.getElementById("videoOutputState");
    if (chip) chip.textContent = open ? (fullscreen ? "Window: fullscreen" : "Window: open") : "Window: closed";
  };

  document.getElementById("videoOutputBtn")?.addEventListener("click", async () => {
    if (desktop?.video?.openOutput) {
      const res = await desktop.video.openOutput({ fullscreen: false });
      updateOutStatus(res.open, res.fullscreen);
      renderVideoMixFrame();
    } else {
      window.open("video-output.html", "opendeck-video-output", "width=1280,height=720");
      updateOutStatus(true, false);
      renderVideoMixFrame();
    }
  });

  document.getElementById("videoFullscreenBtn")?.addEventListener("click", async () => {
    if (desktop?.video?.openOutput && desktop?.video?.fullscreenOutput) {
      if (!videoMixer.outputOpen) {
        const res = await desktop.video.openOutput({ fullscreen: true });
        updateOutStatus(res.open, res.fullscreen);
      } else {
        const res = await desktop.video.fullscreenOutput();
        updateOutStatus(res.open, res.fullscreen);
      }
      renderVideoMixFrame();
    }
  });

  desktop?.video?.onOutputClosed?.(() => {
    updateOutStatus(false, false);
  });

  renderVideoMixFrame();
}

initSamplerUi();
initVideoUi();
initMidiUi();
document.addEventListener("keydown", keyHandler);
renderProviders();
renderStreamHead();
renderQueue();
updateClock();
window.setInterval(updateClock, 30_000);

// Link status readout only — no controls. See docs/mobile/ADR-D35.md.
if (desktop?.link) {
  const linkApi = desktop.link;
  const pollLink = async (): Promise<void> => {
    try {
      const status = await linkApi.status();
      tempoAuthority.onLinkStatus(status as LinkTempoStatus);
      const chip = $("linkStatus");
      chip.textContent = status.status;
      chip.title = `${status.protocol} · session tempo transport, not Ableton Link compatible`;
      chip.classList.toggle("hidden", !status.enabled && !status.error);
    } catch {
      /* main process not reachable yet */
    }
  };
  void pollLink();
  window.setInterval(() => void pollLink(), 1_000);
}
requestFrame();

void refreshStreamStatus();

window.openDeck = { mixer, decks, waves, zooms, library, videoMixer, streamSources, loadTrack, addFiles, streamQueue, setVinylArt, playStreamOnDeck, closeStream, tempoAuthority };

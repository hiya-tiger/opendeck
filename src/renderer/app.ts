import { Mixer, type CrossfaderCurve } from "./engine/mixer.ts";
import { Deck, HOT_CUE_COLORS, type DeckState, type DeckId } from "./engine/deck.ts";
import { analyzeBuffer, formatTime, formatClock, type AnalysisResult } from "./engine/analyze.ts";
import { formatBeatPosition, LOOP_BEATS } from "./engine/beatgrid.ts";
import { syncDeck } from "./engine/sync.ts";
import { FX_DEFS, DIVISIONS, fxDefault, type Division, type FxType } from "./engine/fx.ts";
import { STEMS, type StemId } from "./engine/stems.ts";
import { Waveform, ZoomWaveform } from "./media/waveform.ts";
import { Library, isAudioFile, type Track } from "./media/library.ts";
import { parseCrate, isSerato } from "./media/serato.ts";
import { readMediaInfo, type Artwork } from "./media/artwork.ts";
import { readSeratoTagsFromFile } from "./media/serato-file.ts";
import { buildSeratoExport } from "./media/serato-export.ts";
import { beatgridTempo, firstSavedLoop } from "./media/serato-import.ts";
import { zipSync } from "fflate";
import { artworkQuery, lookupCoverArt, type LookupResult } from "./media/artwork-lookup.ts";
import { PlayQueue, type QueueTrack } from "./streaming/queue.ts";
import { PROVIDERS, findProvider } from "./streaming/providers.ts";
import { parseSearchResponse, videoIdFromTrackUrl, youtubeEmbedUrl } from "./streaming/youtube.ts";
import { WhipBroadcaster, type BroadcastStatus } from "./broadcast/whip.ts";
import { normaliseDegrees, pointerAngle, scratchPosition } from "./engine/scratch.ts";
import { Sampler, SAMPLER_PADS } from "./engine/sampler.ts";
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

interface DesktopApi {
  platform: string;
  analysis?: {
    fromFile: (path: string) => Promise<NativeAnalysis>;
    fromBytes: (bytes: Uint8Array) => Promise<NativeAnalysis>;
  };
  streaming: {
    login: (provider: string, url: string, hints: string[]) => Promise<{ ok: boolean; loggedIn: boolean }>;
    open: (provider: string, url: string, hints: string[]) => Promise<{ ok: boolean; loggedIn: boolean }>;
    status: (provider: string, hints: string[]) => Promise<{ loggedIn: boolean }>;
    logout: (provider: string) => Promise<{ ok: boolean }>;
    search: (provider: string, url: string) => Promise<{ status: number; body: string }>;
    onLogin: (handler: (payload: unknown) => void) => () => void;
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
  media: { fetch: (url: string) => Promise<{ ok: boolean; bytes?: Uint8Array; type?: string; error?: string }> };
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
const decks: Record<DeckId, Deck> = { A: mixer.deck("A"), B: mixer.deck("B") };
const waves: Partial<Record<DeckId, Waveform>> = {};
const zooms: Partial<Record<DeckId, ZoomWaveform>> = {};
const meta: Partial<Record<DeckId, Track>> = {};
const ui: Partial<Record<DeckId, Record<string, HTMLElement>>> = {};
const synced: Record<DeckId, boolean> = { A: false, B: false };
const states: Partial<Record<DeckId, DeckState>> = {};
let lastPadVersion: Partial<Record<DeckId, number>> = {};
let rafPending = false;

const analysisQueue: Track[] = [];
let analysing = false;
let analysisWorker: Worker | null = null;
let analysisRequestId = 0;
const analysisRequests = new Map<
  number,
  { resolve: (result: AnalysisResult) => void; reject: (error: Error) => void }
>();
const desktop = window.opendeckDesktop;

function workerAnalysis(buffer: AudioBuffer): Promise<AnalysisResult> {
  if (!analysisWorker) {
    analysisWorker = new Worker("analysis-worker.js");
    analysisWorker.addEventListener("message", (event: MessageEvent<{ id: number; result: AnalysisResult }>) => {
      const request = analysisRequests.get(event.data.id);
      request?.resolve(event.data.result);
      analysisRequests.delete(event.data.id);
    });
    analysisWorker.addEventListener("error", () => {
      for (const request of analysisRequests.values()) request.reject(new Error("Analysis worker failed"));
      analysisRequests.clear();
      analysisWorker?.terminate();
      analysisWorker = null;
    });
  }
  const id = (analysisRequestId += 1);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
    buffer.getChannelData(channel).slice(),
  );
  return new Promise((resolve, reject) => {
    analysisRequests.set(id, { resolve, reject });
    analysisWorker!.postMessage(
      {
        id,
        sampleRate: buffer.sampleRate,
        length: buffer.length,
        duration: buffer.duration,
        channels,
      },
      channels.map((channel) => channel.buffer),
    );
  });
}

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

function playStreamOnDeck(track: QueueTrack, deckId: DeckId): void {
  const refs = ui[deckId];
  if (!refs) return;
  if (track.provider !== "youtube-music") {
    toast(`${track.provider} needs its own DRM player; use Open instead.`);
    return;
  }
  const videoId = videoIdFromTrackUrl(track.url, track.id);
  const src = youtubeEmbedUrl(videoId);
  if (!src) {
    toast("No YouTube video id for that track.");
    return;
  }
  closeStream(deckId);
  decks[deckId].pause();
  const frame = document.createElement("iframe");
  frame.className = "deck-stream-frame";
  frame.src = src;
  frame.title = `${track.title} - YouTube player`;
  frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.allowFullscreen = true;
  (refs.streamSlot as HTMLElement).append(frame);
  (refs.streamTitle as HTMLElement).textContent = `Deck ${deckId} - ${track.title}`;
  (refs.stream as HTMLElement).hidden = false;
  refs.root.classList.add("streaming");
  $("streamWarn").textContent = `Deck ${deckId}: ${track.title}. Press play in the mini-player, then Capture output to mix it. Deck EQ and faders apply to AUX capture, not the stream itself.`;
  toast(`Deck ${deckId}: ${track.title}`);
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
    play: node.querySelector(".play"),
    cue: node.querySelector(".cue"),
    sync: node.querySelector(".sync"),
    loop: node.querySelector(".loop"),
    loopBeats: node.querySelector(".loop-beats"),
    loopHalf: node.querySelector(".loop-half"),
    loopDouble: node.querySelector(".loop-double"),
    quantize: node.querySelector(".quantize"),
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
    fxType: node.querySelector(".fx-type") as HTMLSelectElement,
    fxWet: node.querySelector(".fx-wet") as HTMLInputElement,
    fxDiv: node.querySelector(".fx-div") as HTMLSelectElement,
  };
  ui[deckId] = refs;

  const streamPanel = document.createElement("div");
  streamPanel.className = "deck-stream";
  streamPanel.hidden = true;
  streamPanel.innerHTML =
    '<div class="deck-stream-head"><span class="deck-stream-title"></span>' +
    '<button type="button" class="mini deck-stream-close" title="Close stream player">x</button></div>' +
    '<div class="deck-stream-slot"></div>' +
    '<span class="deck-stream-note">YouTube player. Mix it with Capture output (AUX).</span>';
  node.append(streamPanel);
  refs.stream = streamPanel;
  refs.streamTitle = streamPanel.querySelector(".deck-stream-title");
  refs.streamSlot = streamPanel.querySelector(".deck-stream-slot");
  (streamPanel.querySelector(".deck-stream-close") as HTMLElement).addEventListener("click", () =>
    closeStream(deckId),
  );

  refs.chip.textContent = deckId;
  const deck = decks[deckId];
  const wave = new Waveform(refs.overview as HTMLCanvasElement);
  const zoom = new ZoomWaveform(refs.zoom as HTMLCanvasElement, 8);
  waves[deckId] = wave;
  zooms[deckId] = zoom;

  wave.onSeek((seconds) => {
    deck.seek(seconds);
    if (deck.playing) void deck.play();
  });

  setupScratch(deckId);

  for (let i = 0; i < 8; i += 1) {
    const pad = document.createElement("button");
    pad.type = "button";
    pad.className = "pad";
    pad.dataset.index = String(i);
    pad.innerHTML = `${i + 1}<small>—</small>`;
    pad.addEventListener("click", () => {
      deck.jumpHotCue(i);
      persistCues(deckId);
      if (!deck.playing) void deck.play();
    });
    pad.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      deck.clearHotCue(i);
      persistCues(deckId);
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

async function analyseTrack(track: Track): Promise<void> {
  const data = track.file ? await track.file.arrayBuffer() : null;
  await extractArtwork(track, data);
  const native = await nativeAnalysis(track, data);
  if (native) {
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
    if (!data) return;
    const buffer = await mixer.ctx.decodeAudioData(data);
    let result: AnalysisResult;
    try {
      result = await workerAnalysis(buffer);
    } catch {
      result = analyzeBuffer(buffer, 2000);
    }
    track.bpm = result.bpm;
    track.beatPhase = result.beatPhase;
    track.key = result.key.key;
    track.camelot = result.key.camelot;
    track.duration = result.duration;
    track.peaks = result.peaks;
    track.bands = result.bands;
  }
  track.analyzed = true;
  library.setMeta(track, {});
  for (const deckId of ["A", "B"] as const) {
    if (meta[deckId] === track) {
      applyTrackToDeck(track, deckId);
      setVinylArt(deckId, track.artwork);
    }
  }
}

function enqueueAnalysis(track: Track): void {
  if (track.analyzed || track.queued || (!track.file && !desktop?.analysis)) return;
  track.queued = true;
  analysisQueue.push(track);
  void pumpAnalysis();
}

async function pumpAnalysis(): Promise<void> {
  if (analysing) return;
  analysing = true;
  const track = analysisQueue.shift();
  if (!track) {
    analysing = false;
    return;
  }
  try {
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    await analyseTrack(track);
  } catch (error) {
    console.warn("analysis failed", track.name, error);
    track.bpm = 0;
    track.key = "--";
    track.analyzed = true;
    library.setMeta(track, {});
  } finally {
    analysing = false;
    if (analysisQueue.length) await pumpAnalysis();
  }
}

/* -------------------------------------------------------------- loading */

async function loadTrack(track: Track, deckId: DeckId): Promise<void> {
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
  zooms[deckId]?.setBpm(track.bpm, track.beatPhase);
  waves[deckId]?.setCue(deck.cuePoint);
  syncLoopButtons(deckId);
  const hadLocalCues = loadCues(deckId, track.id);
  if (!hadLocalCues) void applySeratoCues(track, deckId);
  if (track.analyzed) applyTrackToDeck(track, deckId);
  else enqueueAnalysis(track);
  await mixer.resume();
  setEngineState("audio engine running", true);
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
  const cues = decks[deckId].hotCues.map((cue) => (cue ? cue.time : null));
  try {
    localStorage.setItem(`opendeck.cues.${track.id}`, JSON.stringify(cues));
  } catch {
    // storage full or unavailable
  }
}

function loadCues(deckId: DeckId, trackId: string): boolean {
  let found = false;
  const deck = decks[deckId];
  deck.hotCues = new Array(8).fill(null);
  try {
    const raw = localStorage.getItem(`opendeck.cues.${trackId}`);
    if (raw) {
      const cues = JSON.parse(raw) as (number | null)[];
      cues.forEach((time, index) => {
        if (typeof time === "number" && Number.isFinite(time) && index < 8) {
          deck.hotCues[index] = { time, color: HOT_CUE_COLORS[index] };
          found = true;
        }
      });
    }
  } catch {
    // corrupt entry
  }
  updatePads(deckId, true);
  return found;
}

async function applySeratoCues(track: Track, deckId: DeckId): Promise<void> {
  if (!track.file) return;
  const tags = await readSeratoTagsFromFile(track.file);
  if (!tags || meta[deckId] !== track) return;
  const deck = decks[deckId];
  if (tags.markers?.cues.length) {
    for (const cue of tags.markers.cues) {
      if (cue.index >= 8) continue;
      deck.hotCues[cue.index] = { time: cue.positionMs / 1000, color: cue.color };
    }
    updatePads(deckId, true);
    persistCues(deckId);
  }
  const tempo = beatgridTempo(tags.beatgrid);
  if (tempo && !track.analyzed && track.bpm <= 0) {
    track.bpm = tempo.bpm;
    track.beatPhase = tempo.phase;
    deck.setBpm(track.bpm, track.beatPhase);
    ui[deckId]!.bpm.textContent = `${track.bpm.toFixed(1)} BPM`;
    zooms[deckId]?.setBpm(track.bpm, track.beatPhase);
  }
  const loop = firstSavedLoop(tags.markers?.loops);
  if (loop) deck.setLoopRange(loop.start, loop.end, false);
}

function updatePads(deckId: DeckId, force = false): void {
  const deck = decks[deckId];
  const refs = ui[deckId]!;
  const version = deck.hotCueVersion;
  if (!force && lastPadVersion[deckId] === version) return;
  lastPadVersion[deckId] = version;
  const pads = Array.from(refs.pads.querySelectorAll<HTMLButtonElement>(".pad"));
  pads.forEach((pad, index) => {
    const cue = deck.hotCues[index];
    pad.classList.toggle("set", Boolean(cue));
    pad.style.background = cue ? cue.color : "";
    pad.style.color = cue ? "#fff" : "";
    pad.querySelector("small")!.textContent = cue ? formatTime(cue.time) : "—";
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
  const name = `OpenDeck Backup ${new Date().toISOString().replace(/[:.]/g, "-")}`;
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

/* --------------------------------------------------------------- mixer */

$("crossfader").addEventListener("input", (event) => {
  mixer.setCrossfader(Number((event.target as HTMLInputElement).value), $<HTMLSelectElement>("xfCurve").value as CrossfaderCurve);
});
$("xfCurve").addEventListener("change", () => {
  mixer.setCrossfader(mixer.crossfader, $<HTMLSelectElement>("xfCurve").value as CrossfaderCurve);
});
$("chA").addEventListener("input", (event) => decks.A.setChannelGain(Number((event.target as HTMLInputElement).value)));
$("chB").addEventListener("input", (event) => decks.B.setChannelGain(Number((event.target as HTMLInputElement).value)));
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

const streamQueue = new PlayQueue();
let selectedProvider = PROVIDERS[0];
let loggedIn: Record<string, boolean> = {};

function renderProviders(): void {
  const list = $("providerList");
  list.replaceChildren();
  for (const provider of PROVIDERS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "provider";
    button.setAttribute("aria-selected", String(provider.id === selectedProvider.id));
    button.innerHTML = `<strong>${escapeHtml(provider.name)}</strong><span class="${loggedIn[provider.id] ? "ok" : ""}">${loggedIn[provider.id] ? "signed in" : "signed out"}</span>`;
    button.addEventListener("click", () => {
      selectedProvider = provider;
      renderProviders();
      renderStreamHead();
    });
    list.append(button);
  }
}

function renderStreamHead(): void {
  $("streamTitle").textContent = selectedProvider.name;
  $("streamNote").textContent = selectedProvider.note;
  const isIn = Boolean(loggedIn[selectedProvider.id]);
  const loginState = $("loginState");
  loginState.textContent = isIn ? "signed in" : "signed out";
  loginState.classList.toggle("live", isIn);
  $("loginBtn").classList.toggle("hidden", isIn);
  $("logoutBtn").classList.toggle("hidden", !isIn);
  $("streamSearchForm").classList.toggle("hidden", !selectedProvider.supportsSearch);
  if (!selectedProvider.supportsSearch) {
    $("resultList").classList.add("empty");
    $("resultList").textContent = isIn
      ? "This service opens tracks in its own player. Use System audio capture to mix them."
      : "Sign in, then open tracks in the service and capture system audio.";
  }
  $("streamWarn").textContent = isIn
    ? "Playback stays inside the service. OpenDeck never extracts or decrypts its audio."
    : "";
}

async function refreshLogin(providerId: string): Promise<void> {
  if (!desktop) return;
  const provider = findProvider(providerId);
  if (!provider) return;
  const status = await desktop.streaming.status(provider.id, provider.cookieHints);
  loggedIn[provider.id] = status.loggedIn;
  renderProviders();
  if (selectedProvider.id === provider.id) renderStreamHead();
}

$("loginBtn").addEventListener("click", async () => {
  if (!desktop) {
    toast("Sign-in needs the desktop app.");
    return;
  }
  await desktop.streaming.login(selectedProvider.id, selectedProvider.loginUrl, selectedProvider.cookieHints);
  toast(`Sign in to ${selectedProvider.name} in the window that opened.`);
  window.setTimeout(() => void refreshLogin(selectedProvider.id), 2500);
});

$("logoutBtn").addEventListener("click", async () => {
  if (!desktop) return;
  await desktop.streaming.logout(selectedProvider.id);
  loggedIn[selectedProvider.id] = false;
  renderProviders();
  renderStreamHead();
});

let searchResults: QueueTrack[] = [];

function deckButtons(track: QueueTrack): HTMLButtonElement[] {
  return (["A", "B"] as DeckId[]).map((deckId) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mini deck-btn";
    button.textContent = deckId;
    button.title = `Play on deck ${deckId}`;
    button.addEventListener("click", () => playStreamOnDeck(track, deckId));
    return button;
  });
}

function renderResults(): void {
  const list = $("resultList");
  $("resultCount").textContent = String(searchResults.length);
  if (!searchResults.length) {
    list.classList.add("empty");
    list.textContent = selectedProvider.supportsSearch
      ? loggedIn[selectedProvider.id]
        ? "No results. Try another query."
        : "Sign in to search."
      : "This service has no search integration; open it and capture system audio.";
    return;
  }
  list.classList.remove("empty");
  list.replaceChildren();
  for (const track of searchResults) {
    const row = document.createElement("div");
    row.className = "result";
    row.innerHTML = `<div class="result-main"><div class="result-title">${escapeHtml(track.title)}</div><div class="result-sub">${escapeHtml(track.artist)}${track.durationSec ? ` · ${formatTime(track.durationSec)}` : ""}</div></div>`;
    const queueButton = document.createElement("button");
    queueButton.type = "button";
    queueButton.className = "primary";
    queueButton.textContent = "Queue";
    queueButton.addEventListener("click", () => {
      streamQueue.add(track);
      renderQueue();
      toast(`Queued: ${track.title}`);
    });
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "ghost";
    openButton.textContent = "Open";
    openButton.addEventListener("click", () => openInService(track));
    row.append(queueButton, ...deckButtons(track), openButton);
    list.append(row);
  }
}

$("streamSearchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = $<HTMLInputElement>("streamSearch").value.trim();
  if (!query) return;
  if (!desktop) {
    toast("Search needs the desktop app.");
    return;
  }
  if (!loggedIn[selectedProvider.id]) {
    toast(`Sign in to ${selectedProvider.name} first.`);
    return;
  }
  const url = selectedProvider.searchUrl(query);
  try {
    const response = await desktop.streaming.search(selectedProvider.id, url);
    if (response.status !== 200) {
      toast(`Search returned HTTP ${response.status}.`);
      return;
    }
    searchResults = parseSearchResponse(response.body);
    renderResults();
    if (!searchResults.length) toast("No tracks parsed; the service layout may have changed.");
  } catch (error) {
    toast(`Search failed: ${(error as Error).message}`);
  }
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
  streamQueue.items.forEach((track, index) => {
    const row = document.createElement("div");
    row.className = "queue-item" + (index === streamQueue.index ? " active" : "");
    row.innerHTML = `<span class="idx">${index + 1}</span><span class="q-main">${escapeHtml(track.title)} — ${escapeHtml(track.artist)}</span>`;
    const play = document.createElement("button");
    play.type = "button";
    play.className = "icon-btn";
    play.textContent = "▶";
    play.title = "Open this track";
    play.addEventListener("click", () => {
      streamQueue.jump(index);
      renderQueue();
      void openInService(track);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn";
    remove.textContent = "✕";
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      streamQueue.remove(track.id);
      renderQueue();
    });
    row.append(...deckButtons(track), play, remove);
    list.append(row);
  });
  $("queueNow").textContent = streamQueue.current ? `${streamQueue.current.title} — ${streamQueue.current.artist}` : "—";
}

async function openInService(track: QueueTrack): Promise<void> {
  if (!desktop) return;
  const provider = findProvider(track.provider) ?? selectedProvider;
  if (track.provider === "local") {
    toast("Local tracks play on the decks.");
    return;
  }
  await desktop.streaming.open(provider.id, track.url, provider.cookieHints);
  $("streamWarn").textContent = "Playing in the service window. Enable System audio capture to bring it into the mix.";
}

$("queueNext").addEventListener("click", () => {
  const next = streamQueue.next();
  renderQueue();
  if (next) void openInService(next);
});
$("queuePrev").addEventListener("click", () => {
  const previous = streamQueue.previous();
  renderQueue();
  if (previous) void openInService(previous);
});
$("queueRepeat").addEventListener("click", () => {
  streamQueue.repeat = streamQueue.repeat === "off" ? "all" : streamQueue.repeat === "all" ? "one" : "off";
  $("queueRepeat").classList.toggle("active", streamQueue.repeat !== "off");
  toast(`Repeat ${streamQueue.repeat}`);
});
$("queueClear").addEventListener("click", () => {
  streamQueue.clear();
  renderQueue();
});
$("queueOpen").addEventListener("click", () => {
  if (streamQueue.current) void openInService(streamQueue.current);
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
    $("rtmpLog").textContent = "RTMP needs FFmpeg. Install it, add ffmpeg to PATH, then restart OpenDeck.";
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

  refs.time.textContent = `${formatTime(deck.currentTime)} / ${formatTime(deck.duration)}`;
  refs.bar.textContent = state.bpm ? formatBeatPosition(deck.currentTime, state.bpm, deck.info.beatPhase) : "—";
  refs.tempo.textContent = `${state.tempoPercent >= 0 ? "+" : ""}${state.tempoPercent.toFixed(1)}%`;
  refs.play.textContent = state.playing ? "PAUSE" : "PLAY";
  refs.play.classList.toggle("active", state.playing);
  refs.vinyl.classList.toggle("playing", state.playing);
  refs.loop.classList.toggle("active", state.loopActive);
  refs.keylock.setAttribute("aria-pressed", String(state.keylock));

  waves[deckId]?.setProgress(deck.currentTime);
  zooms[deckId]?.update(deck.currentTime);
  updatePads(deckId);

  const signature = loopSignature(deck);
  if ((refs.root as HTMLElement & { loopSig?: string }).loopSig !== signature) {
    (refs.root as HTMLElement & { loopSig?: string }).loopSig = signature;
    syncLoopButtons(deckId);
  }
}

function frame(): void {
  rafPending = true;
  decks.A.tick();
  decks.B.tick();
  updateEngineDiagnostics(performance.now());
  renderDeckFrame("A");
  renderDeckFrame("B");
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
    decks.A.playing ||
    decks.B.playing ||
    decks.A.scratchingActive ||
    decks.B.scratchingActive ||
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
  { id: "mix.master", label: "Master fader" },
  { id: "mix.aux", label: "System audio (AUX)" },
  { id: "mix.rec", label: "Record start/stop" },
];
for (const deckId of ["A", "B"] as DeckId[]) {
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
for (let index = 1; index <= 8; index += 1) {
  MIDI_TARGETS.push({ id: `smp.${index}`, label: `Sampler ${index} ${SAMPLER_PADS[index - 1].label}` });
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
    maker.textContent = [input.manufacturer, profile ? `preset: ${profile.label}` : ""]
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
  for (const input of inputs) {
    const profile = profileForDevice(`${input.manufacturer ?? ""} ${input.name ?? ""}`);
    if (!profile) continue;
    if (applyProfile(midiBindings, profile).length) {
      detected.push(profile.label);
    }
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

function triggerSamplerPad(index: number, velocity = 1): void {
  void mixer.resume();
  sampler.trigger(index, velocity);
  const button = $("samplerPads").children[index] as HTMLElement | undefined;
  if (!button) return;
  button.classList.add("hit");
  window.setTimeout(() => button.classList.remove("hit"), 120);
}

function initSamplerUi(): void {
  const host = $("samplerPads");
  SAMPLER_PADS.forEach((pad, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sampler-pad";
    button.title = `${pad.label} (NumPad ${index + 1})`;
    button.innerHTML = `<span class="smp-index">${index + 1}</span><small>${pad.label}</small>`;
    button.addEventListener("click", () => triggerSamplerPad(index, 1));
    host.append(button);
  });
  $("samplerVol").addEventListener("input", (event) =>
    sampler.setVolume(Number((event.target as HTMLInputElement).value)),
  );
  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const match = /^Numpad([1-8])$/.exec(event.code);
    if (!match) return;
    event.preventDefault();
    triggerSamplerPad(Number(match[1]) - 1, 1);
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

buildDeck("A");
buildDeck("B");
for (const deckId of ["A", "B"] as const) {
  applyTempo(deckId, 0);
  syncLoopButtons(deckId);
}
function setWaveMode(vertical: boolean): void {
  document.body.classList.toggle("vertical-waves", vertical);
  const button = $("waveMode");
  button.setAttribute("aria-pressed", String(vertical));
  button.textContent = vertical ? "Horizontal waves" : "Vertical waves";
  for (const deckId of ["A", "B"] as const) zooms[deckId]?.setVertical(vertical);
}

setWaveMode(localStorage.getItem("opendeck.waveMode") === "1");
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

initSamplerUi();
initMidiUi();
document.addEventListener("keydown", keyHandler);
renderProviders();
renderStreamHead();
renderQueue();
updateClock();
window.setInterval(updateClock, 30_000);
requestFrame();

if (desktop) {
  for (const provider of PROVIDERS) void refreshLogin(provider.id);
  desktop.streaming.onLogin((payload) => {
    const info = payload as { provider: string; loggedIn: boolean };
    loggedIn[info.provider] = info.loggedIn;
    renderProviders();
    if (selectedProvider.id === info.provider) renderStreamHead();
  });
}

window.openDeck = { mixer, decks, waves, zooms, library, loadTrack, addFiles, streamQueue, setVinylArt, playStreamOnDeck, closeStream };

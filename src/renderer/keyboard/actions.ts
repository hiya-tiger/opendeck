/**
 * The app side of the Serato keymap (D45): one handler per action id in
 * serato-keymap.ts. app.ts hands in what the handlers need through
 * `ShortcutApp`, so this file holds the behaviour and app.ts only wires it.
 */
import type { Deck } from "../engine/deck.ts";
import type { Library, Track } from "../media/library.ts";
import type { ZoomWaveform } from "../media/waveform.ts";
import { KeyboardController, type Phase, type ShortcutEvent } from "./controller.ts";
import { ConfirmDialog, SettingsPopover, ShortcutsOverlay, storeShortcutsEnabled, storedShortcutsEnabled } from "./overlay.ts";
import {
  DEFAULT_FOCUS,
  LoadHistory,
  deckForSide,
  firstFreeCue,
  focusForMode,
  isTextInputTarget,
  isZoomIn,
  moveCursor,
  neighbourTrack,
  nextSpan,
  nextTextScale,
  otherSide,
  toggleFocus,
  type DeckFocus,
  type DeckLetter,
  type Match,
  type Platform,
  type Side,
} from "./serato-keymap.ts";

export interface ShortcutDesktop {
  shell?: {
    reveal?: (path: string) => Promise<unknown>;
    open?: (path: string) => Promise<unknown>;
    trash?: (path: string) => Promise<{ ok: boolean; error?: string }>;
  };
  app?: {
    quit?: () => Promise<unknown>;
    zoom?: (direction: "in" | "out" | "reset") => Promise<unknown>;
  };
  shortcuts?: {
    onShow?: (handler: () => void) => unknown;
    onKey?: (handler: (payload: unknown) => void) => unknown;
  };
}

export interface ShortcutApp {
  platform: Platform;
  decks: Record<DeckLetter, Deck>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ui: Partial<Record<DeckLetter, Record<string, any>>>;
  meta: Partial<Record<DeckLetter, Track>>;
  zooms: Partial<Record<DeckLetter, ZoomWaveform>>;
  library: Library;
  desktop?: ShortcutDesktop | null;
  toast(message: string, ms?: number): void;
  loadTrack(track: Track, deck: DeckLetter): Promise<void>;
  ejectDeck(deck: DeckLetter): boolean;
  toggleDeck(deck: DeckLetter): void;
  applyTempo(deck: DeckLetter, percent: number): void;
  applySync(deck: DeckLetter): void;
  instantDouble(target: DeckLetter, source: DeckLetter): Promise<void>;
  persistCues(deck: DeckLetter): void;
  updatePads(deck: DeckLetter, force: boolean): void;
  requestFrame(): void;
  nudgeCrossfader(delta: number): void;
  triggerSamplerPad(index: number): void;
  toggleFullscreen(): void;
  isFourDeck(): boolean;
  setFourDeck(enabled: boolean): void;
  isRecording(): boolean;
  toggleRecording(): Promise<void>;
  persistLibraryUx(): void;
  refreshLibraryChrome(): void;
  refreshPlaylistOptions(): void;
  pathFor(track: Track | null): string | null;
}

/** Shared with app.ts's loadTrack (records what each load replaced). */
export const loadHistory = new LoadHistory();
let suppressHistory = false;
let modeListener: ((fourDeck: boolean) => void) | null = null;

/** app.ts calls this from loadTrack once a track is on the deck. */
export function noteTrackLoaded(deck: DeckLetter, previous: Track | undefined, previousPosition: number, track: Track): void {
  if (suppressHistory) return;
  loadHistory.record(deck, previous?.id ?? null, previous ? previousPosition : 0, track.id);
}

/** app.ts calls this from setFourDeckMode; leaving 4-deck mode resets focus to A/B. */
export function noteFourDeckMode(enabled: boolean): void {
  modeListener?.(enabled);
}

const SIDE_OF: Record<DeckLetter, Side> = { A: "left", C: "left", B: "right", D: "right" };
const TEXT_SCALE_KEY = "opendeck.libraryTextScale";
const SCAN_STEP_S = 0.18; // per 40 ms tick: about 4.5x on top of playback

export interface InstalledShortcuts {
  controller: KeyboardController;
  overlay: ShortcutsOverlay;
  confirm: ConfirmDialog;
  focus(): DeckFocus;
  setEnabled(enabled: boolean): void;
  /** For the smoke test: which deck a side's keys act on right now. */
  targetDeck(side: Side): DeckLetter;
}

export function installShortcuts(app: ShortcutApp): InstalledShortcuts {
  let focus: DeckFocus = { ...DEFAULT_FOCUS };
  let enabled = storedShortcutsEnabled();
  let region: "tracks" | "crates" = "tracks";
  let gridEditDeck: DeckLetter | null = null;
  const scans: Partial<Record<DeckLetter, number>> = {};

  const target = (side: Side): DeckLetter => deckForSide(side, focus, app.isFourDeck());
  const confirm = new ConfirmDialog();
  const overlay = new ShortcutsOverlay({
    platform: app.platform,
    focus: () => ({ focus, fourDeck: app.isFourDeck() }),
    enabled: () => enabled,
    setEnabled: (on) => setEnabled(on),
  });
  const settings = new SettingsPopover(document.querySelector(".topbar-right"), {
    enabled: () => enabled,
    setEnabled: (on) => setEnabled(on),
    showShortcuts: () => overlay.show(),
  });

  const paintFocus = (): void => {
    const four = app.isFourDeck();
    for (const id of ["A", "B", "C", "D"] as DeckLetter[]) {
      const root = app.ui[id]?.root as HTMLElement | undefined;
      const on = four && enabled && (id === focus.left || id === focus.right);
      root?.classList.toggle("kb-target", on);
      root?.setAttribute("data-kb-side", on ? SIDE_OF[id] : "");
    }
    if (overlay.open) overlay.refresh();
  };

  modeListener = (fourDeck) => {
    focus = focusForMode(focus, fourDeck);
    paintFocus();
  };

  function setEnabled(on: boolean): void {
    enabled = on;
    storeShortcutsEnabled(on);
    controller.setEnabled(on);
    settings.sync(on);
    if (overlay.open) overlay.refresh();
    paintFocus();
    app.toast(on ? "Keyboard shortcuts on" : "Keyboard shortcuts off");
  }

  // Clicking into a deck in 4-deck mode makes it its side's keyboard target.
  for (const id of ["A", "B", "C", "D"] as DeckLetter[]) {
    document.getElementById(`deckSlot${id}`)?.addEventListener("pointerdown", () => {
      if (!app.isFourDeck()) return;
      if (SIDE_OF[id] === "left") focus = { ...focus, left: id as "A" | "C" };
      else focus = { ...focus, right: id as "B" | "D" };
      paintFocus();
    });
  }

  // ---------------------------------------------------------- library bits
  const trackList = document.getElementById("trackList");
  const crateSelect = document.getElementById("playlistFilter") as HTMLSelectElement | null;
  const searchInput = document.getElementById("search") as HTMLInputElement | null;

  const paintRegion = (): void => {
    trackList?.closest("table")?.classList.toggle("kb-region", region === "tracks");
    crateSelect?.classList.toggle("kb-region", region === "crates");
  };

  const scrollToCursor = (): void => {
    const id = app.library.cursor;
    if (id) app.library.rowFor(id)?.scrollIntoView({ block: "nearest" });
  };

  const cursorTrack = (): Track | null => {
    const id = app.library.cursor;
    const track = id ? app.library.find(id) : undefined;
    return track ?? null;
  };

  const moveCrate = (delta: number): void => {
    if (!crateSelect || !crateSelect.options.length) return;
    const next = Math.max(0, Math.min(crateSelect.options.length - 1, crateSelect.selectedIndex + delta));
    if (next === crateSelect.selectedIndex) return;
    crateSelect.selectedIndex = next;
    crateSelect.dispatchEvent(new Event("change", { bubbles: true }));
    app.toast(crateSelect.options[next]!.textContent ?? "", 1400);
  };

  const showAll = (): void => {
    if (searchInput && searchInput.value) {
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    app.library.setFilter("");
    if (crateSelect && crateSelect.value !== "all") {
      crateSelect.value = "all";
      crateSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  const selectTrack = (id: string): void => {
    if (!app.library.visible().some((track) => track.id === id)) showAll();
    app.library.select([id], id);
    scrollToCursor();
  };

  let textScale = Number(localStorage.getItem(TEXT_SCALE_KEY) ?? "1") || 1;
  document.documentElement.style.setProperty("--lib-text-scale", String(textScale));

  // ----------------------------------------------------------- BPM editor
  const openBpmEditor = (deckId: DeckLetter): void => {
    const refs = app.ui[deckId];
    const deck = app.decks[deckId];
    if (!refs || !deck.hasTrack) return;
    if (deck.beatgridLocked) {
      app.toast("Beatgrid is locked.");
      return;
    }
    const chip = refs.bpm as HTMLElement;
    if (chip.querySelector("input")) return;
    const before = chip.textContent ?? "";
    const input = document.createElement("input");
    input.className = "bpm-edit mono";
    input.type = "text";
    input.inputMode = "decimal";
    input.value = deck.info.bpm ? deck.info.bpm.toFixed(2) : "";
    input.setAttribute("aria-label", `Deck ${deckId} BPM`);
    let done = false;
    const finish = (apply: boolean): void => {
      if (done) return;
      done = true;
      const value = Number(input.value.replace(",", "."));
      input.remove();
      chip.textContent = before;
      if (!apply || !Number.isFinite(value) || value < 20 || value > 400) return;
      const old = deck.info.bpm;
      if (old > 0) deck.scaleGridBpm(value / old);
      else deck.setBpm(value, deck.info.beatPhase);
      (refs.refreshGridUi as (() => void) | undefined)?.();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    chip.textContent = "";
    chip.append(input);
    input.focus();
    input.select();
  };
  for (const id of ["A", "B", "C", "D"] as DeckLetter[]) {
    (app.ui[id]?.bpm as HTMLElement | undefined)?.addEventListener("dblclick", () => openBpmEditor(id));
    const bpmChip = app.ui[id]?.bpm as HTMLElement | undefined;
    if (bpmChip) bpmChip.title = "Double-click to edit the BPM (Alt+Up/Down doubles/halves while editing)";
  }

  // -------------------------------------------------------- grid edit mode
  const setGridEdit = (deckId: DeckLetter | null): void => {
    gridEditDeck = deckId;
    for (const id of ["A", "B", "C", "D"] as DeckLetter[]) (app.ui[id]?.root as HTMLElement | undefined)?.classList.toggle("grid-edit", id === deckId);
    if (deckId) app.toast(`Beatgrid edit: deck ${deckId} (←/→ slide, Esc to leave)`, 2400);
  };

  // -------------------------------------------------------- scan (hold)
  const stopScan = (deckId: DeckLetter): void => {
    if (scans[deckId] !== undefined) {
      window.clearInterval(scans[deckId]);
      delete scans[deckId];
    }
  };
  const startScan = (deckId: DeckLetter, direction: 1 | -1): void => {
    stopScan(deckId);
    const deck = app.decks[deckId];
    if (!deck.hasTrack) return;
    const tick = (): void => {
      const next = Math.max(0, Math.min(deck.duration, deck.currentTime + direction * SCAN_STEP_S));
      deck.seek(next);
      app.requestFrame();
    };
    tick();
    scans[deckId] = window.setInterval(tick, 40);
  };

  const needTrackFor = (deckId: DeckLetter): boolean => {
    if (app.decks[deckId].hasTrack) return true;
    app.toast(`Deck ${deckId} has no track.`, 1600);
    return false;
  };

  // Backwards play needs the decoded (PCM) engine. A media-element deck (a
  // track still decoding, a video) cannot run backwards and setRate(<0) would
  // just stop it, so say so instead.
  const reverseReady = (deckId: DeckLetter): boolean => {
    if (app.decks[deckId].engine === "pcm") return true;
    app.toast(`Deck ${deckId} can play backwards once the track has finished decoding.`, 2000);
    return false;
  };

  const loadInto = (deckId: DeckLetter): void => {
    const track = cursorTrack();
    if (!track) {
      app.toast("Pick a track first (up/down or click).", 1800);
      return;
    }
    if (track.missing) {
      app.toast("That track's file is not linked.");
      return;
    }
    if ((deckId === "C" || deckId === "D") && !app.isFourDeck()) app.setFourDeck(true);
    void app.loadTrack(track, deckId);
  };

  const loadNeighbour = (deckId: DeckLetter, delta: 1 | -1): void => {
    const ids = app.library.visible().map((track) => track.id);
    const current = app.meta[deckId]?.id ?? app.library.cursor;
    const id = neighbourTrack(ids, current, delta);
    const track = id ? app.library.find(id) : undefined;
    if (!track) {
      app.toast(delta > 0 ? "No next track in this view." : "No previous track in this view.", 1600);
      return;
    }
    app.library.select([track.id], track.id);
    scrollToCursor();
    void app.loadTrack(track, deckId);
  };

  const quit = async (): Promise<void> => {
    if (!(await confirm.ask("Quit OpenDecks?", "Quit"))) return;
    if (app.desktop?.app?.quit) void app.desktop.app.quit();
    else window.close();
  };

  const escape = (): boolean => {
    const active = document.activeElement as HTMLElement | null;
    if (overlay.open) {
      overlay.hide();
      return true;
    }
    const settingsPanel = document.getElementById("settingsPanel");
    if (settingsPanel && !settingsPanel.classList.contains("hidden")) {
      settings.close();
      return true;
    }
    if (active && active.classList.contains("bpm-edit")) {
      (active as HTMLInputElement).blur();
      return true;
    }
    if (active && active === searchInput) {
      if (searchInput.value) {
        searchInput.value = "";
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        app.library.setFilter("");
      }
      searchInput.blur();
      return true;
    }
    if (active && active !== document.body && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
      active.blur();
      return true;
    }
    if (gridEditDeck) {
      setGridEdit(null);
      return true;
    }
    if (searchInput && searchInput.value) {
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      app.library.setFilter("");
      return true;
    }
    void quit();
    return true;
  };

  // --------------------------------------------------------------- actions
  const run = (match: Match, phase: Phase): boolean => {
    const { binding, side, index } = match;
    const deckId: DeckLetter = binding.deck ?? target(side);
    const deck = app.decks[deckId];
    const refs = app.ui[deckId];
    if (phase === "up") {
      switch (binding.id) {
        case "rewind":
        case "fast-forward":
          stopScan(deckId);
          return true;
        case "censor":
          if (deck.censorActive) deck.endReverseOnHold();
          refs?.censorBtn?.setAttribute("aria-pressed", "false");
          return true;
        case "cue":
        case "hot-cue-a":
        case "hot-cue-b":
          deck.releaseHotCue();
          return true;
      }
      return true;
    }
    switch (binding.id) {
      // ------------------------------------------------------ playback
      case "load-selected":
        loadInto(deckId);
        return true;
      case "load-c":
      case "load-d":
        loadInto(deckId);
        return true;
      case "double-track": {
        const source = target(otherSide(side));
        if (!app.decks[source].hasTrack) {
          app.toast(`Deck ${source} has no track to double.`, 1800);
          return true;
        }
        void app.instantDouble(deckId, source);
        return true;
      }
      case "eject":
        app.ejectDeck(deckId);
        return true;
      case "play-pause":
      case "play-a":
      case "play-b":
        app.toggleDeck(deckId);
        return true;
      case "reverse":
        if (!needTrackFor(deckId)) return true;
        if (!reverseReady(deckId)) return true;
        deck.setReverse(!deck.reversed);
        app.toast(`Deck ${deckId} reverse ${deck.reversed ? "on" : "off"}`, 1200);
        return true;
      case "set-cue":
        if (!needTrackFor(deckId) || !index) return true;
        deck.setHotCue(index - 1);
        app.persistCues(deckId);
        app.updatePads(deckId, true);
        return true;
      case "cue":
      case "hot-cue-a":
      case "hot-cue-b":
        if (!needTrackFor(deckId) || !index) return true;
        deck.jumpHotCue(index - 1);
        app.persistCues(deckId);
        app.updatePads(deckId, true);
        app.requestFrame();
        return true;
      case "add-next-cue": {
        if (!needTrackFor(deckId)) return true;
        const free = firstFreeCue(deck.hotCues);
        if (free < 0) {
          app.toast(`All 8 cue points on deck ${deckId} are set.`, 1800);
          return true;
        }
        deck.setHotCue(free);
        app.persistCues(deckId);
        app.updatePads(deckId, true);
        app.toast(`Deck ${deckId}: cue ${free + 1} set`, 1200);
        return true;
      }
      case "temp-cue":
      case "cue-b":
        if (!needTrackFor(deckId)) return true;
        deck.jumpToCue();
        app.requestFrame();
        return true;
      case "load-next":
        loadNeighbour(deckId, 1);
        return true;
      case "load-prev":
        loadNeighbour(deckId, -1);
        return true;
      case "rewind":
        startScan(deckId, -1);
        return true;
      case "fast-forward":
        startScan(deckId, 1);
        return true;
      case "tempo-down":
      case "tempo-up":
        app.applyTempo(deckId, deck.tempo + (binding.id === "tempo-up" ? 0.1 : -0.1));
        return true;
      case "censor":
        if (!deck.hasTrack || !deck.playing || !reverseReady(deckId)) return true;
        deck.beginReverseOnHold();
        refs?.censorBtn?.setAttribute("aria-pressed", "true");
        return true;
      case "keylock":
        (refs?.keylock as HTMLElement | undefined)?.click();
        app.toast(`Deck ${deckId} key lock ${deck.keylockOn ? "on" : "off"}`, 1200);
        return true;
      case "flip-record":
        app.toast("Flip recording is not available yet.", 2000);
        return true;

      // ------------------------------------------------------- library
      case "library-move": {
        const delta = match.chord === "ArrowUp" ? -1 : 1;
        if (region === "crates") {
          moveCrate(delta);
          return true;
        }
        const ids = app.library.visible().map((track) => track.id);
        const next = moveCursor(ids, app.library.cursor, delta);
        if (next) {
          app.library.select([next], next);
          scrollToCursor();
        }
        return true;
      }
      case "crate-move":
        moveCrate(match.chord.endsWith("ArrowUp") ? -1 : 1);
        return true;
      case "shift-focus": {
        const active = document.activeElement;
        if (active && active !== document.body && !trackList?.closest("table")?.contains(active)) return false;
        region = region === "tracks" ? "crates" : "tracks";
        paintRegion();
        app.toast(region === "tracks" ? "Focus: tracks" : "Focus: crates", 1000);
        return true;
      }
      case "search":
        searchInput?.focus();
        searchInput?.select();
        return true;
      case "crate-search":
        region = "crates";
        paintRegion();
        crateSelect?.focus();
        return true;
      case "reveal":
      case "open-default": {
        const track = app.library.selectedTracks()[0] ?? null;
        const path = app.pathFor(track);
        const fn = binding.id === "reveal" ? app.desktop?.shell?.reveal : app.desktop?.shell?.open;
        if (!track) app.toast("Pick a track first.", 1600);
        else if (!fn) app.toast("Available in the desktop app.", 1800);
        else if (!path) app.toast("This track has no file on disk.", 1800);
        else void fn(path);
        return true;
      }
      case "show-in-crates": {
        const track = app.library.selectedTracks()[0];
        if (!track) {
          app.toast("Pick a track first.", 1600);
          return true;
        }
        const views: { value: string; name: string }[] = [];
        for (const crate of new Set([track.crate, ...(track.crates ?? [])].filter(Boolean))) views.push({ value: `crate:${crate}`, name: `Crate · ${crate}` });
        for (const pl of app.library.playlists.list()) if (pl.trackIds.includes(track.id)) views.push({ value: `playlist:${pl.id}`, name: `Playlist · ${pl.name}` });
        if (!views.length) {
          app.toast(`${track.name} is in no crate or playlist.`, 2000);
          return true;
        }
        if (crateSelect && [...crateSelect.options].some((o) => o.value === views[0]!.value)) {
          crateSelect.value = views[0]!.value;
          crateSelect.dispatchEvent(new Event("change", { bubbles: true }));
          app.library.select([track.id], track.id);
          scrollToCursor();
        }
        app.toast(`In: ${views.map((v) => v.name).join(", ")}`, 3000);
        return true;
      }
      case "locate-loaded": {
        const entry = loadHistory.locate();
        const track = entry ? app.library.find(entry.trackId) : undefined;
        if (!entry || !track) {
          app.toast("Nothing loaded yet.", 1400);
          return true;
        }
        selectTrack(track.id);
        app.toast(`Deck ${entry.deck}: ${track.name}`, 1600);
        return true;
      }
      case "select-all": {
        const ids = app.library.visible().map((track) => track.id);
        app.library.select(ids, app.library.cursor ?? ids[0] ?? null);
        app.toast(`${ids.length} tracks selected`, 1200);
        return true;
      }
      case "undo-load": {
        const record = loadHistory.undo();
        if (!record) {
          app.toast("No track load to undo.", 1400);
          return true;
        }
        const previous = record.previousTrackId ? app.library.find(record.previousTrackId) : undefined;
        if (!previous) {
          app.ejectDeck(record.deck);
          app.toast(`Undo load: deck ${record.deck} ejected`, 1600);
          return true;
        }
        suppressHistory = true;
        void app
          .loadTrack(previous, record.deck)
          .then(() => {
            if (app.meta[record.deck] === previous) app.decks[record.deck].seek(record.previousPosition);
            app.requestFrame();
          })
          .finally(() => {
            suppressHistory = false;
          });
        app.toast(`Undo load: deck ${record.deck} ← ${previous.name}`, 1600);
        return true;
      }
      case "delete-track": {
        const view = app.library.activeView;
        if (region === "crates" && (view.startsWith("playlist:") || view.startsWith("live:"))) {
          const name = crateSelect?.selectedOptions[0]?.textContent ?? view;
          void confirm.ask(`Delete ${name}? Its tracks stay in the library.`, "Delete").then((ok) => {
            if (!ok) return;
            if (view.startsWith("playlist:")) app.library.playlists.remove(view.slice(9));
            else app.library.livePlaylists.remove(view.slice(5));
            app.library.saveStores();
            app.refreshPlaylistOptions();
            app.library.setActiveView("all");
          });
          return true;
        }
        const tracks = app.library.selectedTracks();
        if (!tracks.length) {
          app.toast("Pick a track first.", 1600);
          return true;
        }
        const what = tracks.length === 1 ? `"${tracks[0]!.name}"` : `${tracks.length} tracks`;
        void confirm.ask(`Remove ${what} from the library? The files stay on disk.`, "Remove").then((ok) => {
          if (!ok) return;
          const removed = app.library.remove(tracks.map((t) => t.id));
          app.persistLibraryUx();
          app.refreshLibraryChrome();
          app.toast(`Removed ${removed.length} from the library`, 1600);
        });
        return true;
      }
      case "trash-file": {
        const tracks = app.library.selectedTracks();
        const trash = app.desktop?.shell?.trash;
        if (!tracks.length) {
          app.toast("Pick a track first.", 1600);
          return true;
        }
        if (!trash) {
          app.toast("Available in the desktop app.", 1800);
          return true;
        }
        const withPaths = tracks.map((t) => ({ track: t, path: app.pathFor(t) })).filter((x): x is { track: Track; path: string } => Boolean(x.path));
        if (!withPaths.length) {
          app.toast("These tracks have no file on disk.", 1800);
          return true;
        }
        const what = withPaths.length === 1 ? `"${withPaths[0]!.track.name}"` : `${withPaths.length} files`;
        void confirm.ask(`Move ${what} to the trash? This removes the file from disk.`, "Move to trash").then(async (ok) => {
          if (!ok) return;
          const done: string[] = [];
          for (const item of withPaths) {
            const result = await trash(item.path).catch((error: unknown) => ({ ok: false, error: String(error) }));
            if (result?.ok) done.push(item.track.id);
          }
          app.library.remove(done);
          app.persistLibraryUx();
          app.refreshLibraryChrome();
          app.toast(done.length === withPaths.length ? `Moved ${done.length} to the trash` : `Moved ${done.length} of ${withPaths.length} to the trash`, 2000);
        });
        return true;
      }
      case "prepare": {
        const tracks = app.library.selectedTracks();
        if (!tracks.length) {
          app.toast("Pick a track first.", 1600);
          return true;
        }
        for (const track of tracks) app.library.scratchpad.add(track.id);
        app.persistLibraryUx();
        app.refreshLibraryChrome();
        app.library.render();
        app.toast(`Added ${tracks.length} to the Scratchpad`, 1400);
        return true;
      }
      case "wave-zoom": {
        const zoomIn = isZoomIn(match.chord.split("+").pop()!);
        let span = 8;
        for (const id of ["A", "B", "C", "D"] as DeckLetter[]) {
          const zoom = app.zooms[id];
          if (!zoom) continue;
          span = nextSpan(zoom.spanSeconds, zoomIn);
          zoom.setSpan(span);
        }
        app.requestFrame();
        app.toast(`Waveform: ${span} s`, 900);
        return true;
      }
      case "text-zoom": {
        textScale = nextTextScale(textScale, isZoomIn(match.chord.split("+").pop()!));
        document.documentElement.style.setProperty("--lib-text-scale", String(textScale));
        try {
          localStorage.setItem(TEXT_SCALE_KEY, String(textScale));
        } catch {
          // storage unavailable
        }
        app.toast(`Library text ${Math.round(textScale * 100)}%`, 900);
        return true;
      }
      case "new-recording":
        if (app.isRecording()) app.toast("A recording is already running: stop it with Record first.", 2400);
        else void app.toggleRecording();
        return true;
      case "bpm-scale": {
        const input = document.activeElement as HTMLInputElement | null;
        if (!input || !input.classList.contains("bpm-edit")) return false;
        const value = Number(input.value.replace(",", "."));
        if (!Number.isFinite(value) || value <= 0) return true;
        const next = match.chord.endsWith("ArrowUp") ? value * 2 : value / 2;
        input.value = next.toFixed(2);
        return true;
      }
      case "beatgrid-edit": {
        const left = target("left");
        const right = target("right");
        setGridEdit(gridEditDeck === left ? right : left);
        return true;
      }
      case "am-hide": {
        const on = !document.body.classList.contains("am-hide");
        document.body.classList.toggle("am-hide", on);
        app.toast(on ? "AM mode: titles hidden" : "AM mode off", 1400);
        return true;
      }
      case "escape":
        return escape();

      // ----------------------------------------------------- OpenDecks
      case "focus-left":
      case "focus-right": {
        const s: Side = binding.id === "focus-left" ? "left" : "right";
        if (!app.isFourDeck()) {
          app.toast("Turn on 4 Decks to switch the keys to C / D.", 1800);
          return true;
        }
        focus = toggleFocus(focus, s, true);
        paintFocus();
        app.toast(`${s === "left" ? "Left" : "Right"} keys → deck ${s === "left" ? focus.left : focus.right}`, 1200);
        return true;
      }
      case "shortcuts-help":
        overlay.toggleOpen();
        return true;
      case "sync":
        app.applySync(deckId);
        return true;
      case "crossfader":
      case "crossfader-big": {
        const right = match.chord.endsWith("ArrowRight");
        if (gridEditDeck && binding.id === "crossfader") {
          const button = app.ui[gridEditDeck]?.[right ? "gridShiftRight" : "gridShiftLeft"] as HTMLElement | undefined;
          button?.click();
          return true;
        }
        const step = binding.id === "crossfader-big" ? 0.1 : 0.02;
        app.nudgeCrossfader(right ? step : -step);
        return true;
      }
      case "sampler":
        if (index) app.triggerSamplerPad(index - 1);
        return true;
      case "fullscreen":
        app.toggleFullscreen();
        return true;
      case "page-zoom": {
        const code = match.chord.split("+").pop();
        const direction = code === "Equal" ? "in" : code === "Minus" ? "out" : "reset";
        if (app.desktop?.app?.zoom) void app.desktop.app.zoom(direction);
        else app.toast("Use the browser's zoom here.", 1600);
        return true;
      }
      case "reload":
        window.location.reload();
        return true;
    }
    return false;
  };

  const controller = new KeyboardController(
    {
      run,
      modalKey: (event: ShortcutEvent) => {
        if (confirm.open) return confirm.key(event);
        if (overlay.open && (event.code === "Escape" || (event.code === "Slash" && event.shiftKey))) {
          overlay.hide();
          return true;
        }
        return false;
      },
    },
    app.platform,
  );
  controller.setEnabled(enabled);

  document.addEventListener("keydown", (event) => {
    // macOS: the Edit menu has no Cmd+A / Cmd+Z (they are Serato library keys),
    // so text fields get select-all / undo from here.
    if (app.platform === "mac" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.code === "KeyA" || event.code === "KeyZ") && isTextInputTarget(event.target as HTMLElement)) {
      document.execCommand(event.code === "KeyA" ? "selectAll" : "undo");
      event.preventDefault();
      return;
    }
    controller.keydown(event as unknown as ShortcutEvent);
  });
  document.addEventListener("keyup", (event) => {
    controller.keyup(event as unknown as ShortcutEvent);
  });
  window.addEventListener("blur", () => controller.releaseAll());

  // Keys the main process takes before the page can (F10 opens the menu bar on Windows/Linux).
  app.desktop?.shortcuts?.onKey?.((payload) => {
    const p = payload as { type: "keyDown" | "keyUp"; code: string; key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean; isAutoRepeat: boolean };
    const synthetic: ShortcutEvent = {
      code: p.code,
      key: p.key,
      ctrlKey: p.control,
      metaKey: p.meta,
      shiftKey: p.shift,
      altKey: p.alt,
      repeat: p.isAutoRepeat,
      target: document.activeElement as HTMLElement | null,
    };
    if (p.type === "keyDown") controller.keydown(synthetic);
    else controller.keyup(synthetic);
  });
  app.desktop?.shortcuts?.onShow?.(() => overlay.show());

  paintRegion();
  paintFocus();

  return {
    controller,
    overlay,
    confirm,
    focus: () => ({ ...focus }),
    setEnabled,
    targetDeck: target,
  };
}

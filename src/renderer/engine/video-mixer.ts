import type { DeckId } from "./deck.ts";

export type VideoBlendMode = "fade" | "cut" | "add" | "luma";
export type VideoScaleMode = "fit" | "fill";

export interface VideoFxState {
  brightness: number;
  contrast: number;
  saturation: number;
  monochrome: boolean;
  invert: boolean;
}

export interface VideoDeckSlot {
  deckId: DeckId;
  loaded: boolean;
  url: string;
  fileName: string;
  duration: number;
  currentTime: number;
  playing: boolean;
  rate: number;
  reversed: boolean;
  scratching: boolean;
  offsetSeconds: number;
  scaleMode: VideoScaleMode;
  fx: VideoFxState;
}

export interface VideoTransportState {
  currentTime: number;
  duration?: number;
  playing: boolean;
  rate: number;
  reversed?: boolean;
  scratching?: boolean;
  loop?: boolean;
}

export interface VideoResyncDecision {
  seek: boolean;
  target: number;
  playbackRate: number;
  shouldPlay: boolean;
}

export interface VideoMixerSnapshot {
  decks: Record<DeckId, VideoDeckSlot>;
  leftDeck: DeckId;
  rightDeck: DeckId;
  crossfader: number;
  linkToAudioCrossfader: boolean;
  blendMode: VideoBlendMode;
  scaleMode: VideoScaleMode;
  outputOpen: boolean;
  outputFullscreen: boolean;
  weights: { left: number; right: number };
}

export type VideoFrameSource = CanvasImageSource & {
  videoWidth?: number;
  videoHeight?: number;
  width?: number;
  height?: number;
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ogv"]);
const ALL_DECK_IDS: readonly DeckId[] = ["A", "B", "C", "D"] as const;

export function defaultVideoFx(): VideoFxState {
  return {
    brightness: 1,
    contrast: 1,
    saturation: 1,
    monochrome: false,
    invert: false,
  };
}

export function isVideoFile(fileOrName: { name?: string; type?: string } | string | null | undefined): boolean {
  if (typeof fileOrName === "string") {
    const clean = fileOrName.trim().toLowerCase().split(/[?#]/)[0] ?? "";
    const dot = clean.lastIndexOf(".");
    if (dot < 0) return false;
    return VIDEO_EXTENSIONS.has(clean.slice(dot));
  }
  if (!fileOrName) return false;
  if (typeof fileOrName.type === "string" && fileOrName.type.toLowerCase().startsWith("video/")) {
    return true;
  }
  if (typeof fileOrName.name === "string") {
    return isVideoFile(fileOrName.name);
  }
  return false;
}

export function computeVideoSyncTarget(
  deckTime: number,
  videoDuration: number,
  offsetSeconds = 0,
  loop = true,
): number {
  const safeDeck = Number.isFinite(deckTime) ? deckTime : 0;
  const safeOffset = Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
  const raw = safeDeck + safeOffset;
  if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
    return Math.max(0, raw);
  }
  if (loop) {
    const mod = raw % videoDuration;
    return mod < 0 ? mod + videoDuration : mod;
  }
  return Math.max(0, Math.min(videoDuration, raw));
}

export function shouldResyncVideoElement(
  videoTime: number,
  targetTime: number,
  playing: boolean,
  rate: number,
  reversed: boolean,
  scratching: boolean,
  toleranceSeconds = 0.045,
): VideoResyncDecision {
  const safeTarget = Math.max(0, Number.isFinite(targetTime) ? targetTime : 0);
  const safeVideo = Math.max(0, Number.isFinite(videoTime) ? videoTime : 0);
  const safeRate = Number.isFinite(rate) ? rate : 1;
  const absRate = Math.max(0.0625, Math.min(4, Math.abs(safeRate) || 1));
  const isReverseOrScratch = Boolean(reversed || safeRate < 0 || scratching);
  const delta = Math.abs(safeVideo - safeTarget);

  if (!playing || isReverseOrScratch) {
    return {
      seek: delta > 0.001,
      target: safeTarget,
      playbackRate: absRate,
      shouldPlay: false,
    };
  }

  return {
    seek: delta > Math.max(0.005, toleranceSeconds),
    target: safeTarget,
    playbackRate: absRate,
    shouldPlay: true,
  };
}

export function computeVideoCrossfaderWeights(
  crossfader: number,
  mode: VideoBlendMode = "fade",
): { left: number; right: number } {
  const xf = Math.max(-1, Math.min(1, Number.isFinite(crossfader) ? crossfader : 0));
  const t = (xf + 1) * 0.5; // 0 = full left, 0.5 = center, 1 = full right

  switch (mode) {
    case "cut":
      return xf <= 0 ? { left: 1, right: 0 } : { left: 0, right: 1 };
    case "add": {
      const left = xf <= 0 ? 1 : Math.max(0, 1 - xf);
      const right = xf >= 0 ? 1 : Math.max(0, 1 + xf);
      return { left: Number(left.toFixed(4)), right: Number(right.toFixed(4)) };
    }
    case "luma": {
      const left = Math.cos(t * Math.PI * 0.5);
      const right = Math.sin(t * Math.PI * 0.5);
      return { left: Number(left.toFixed(4)), right: Number(right.toFixed(4)) };
    }
    case "fade":
    default:
      return {
        left: Number((1 - t).toFixed(4)),
        right: Number(t.toFixed(4)),
      };
  }
}

export function computeAspectRect(
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
  scaleMode: VideoScaleMode,
): { x: number; y: number; width: number; height: number } {
  const sw = Math.max(1, Number.isFinite(srcWidth) && srcWidth > 0 ? srcWidth : 16);
  const sh = Math.max(1, Number.isFinite(srcHeight) && srcHeight > 0 ? srcHeight : 9);
  const dw = Math.max(1, Number.isFinite(dstWidth) && dstWidth > 0 ? dstWidth : 320);
  const dh = Math.max(1, Number.isFinite(dstHeight) && dstHeight > 0 ? dstHeight : 180);

  const scale = scaleMode === "fill" ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
  const width = sw * scale;
  const height = sh * scale;
  const x = (dw - width) * 0.5;
  const y = (dh - height) * 0.5;

  return { x, y, width, height };
}

export function formatVideoCssFilter(fx: Partial<VideoFxState>): string {
  const brightness = Number.isFinite(fx.brightness) ? Math.max(0, Math.min(3, fx.brightness!)) : 1;
  const contrast = Number.isFinite(fx.contrast) ? Math.max(0, Math.min(3, fx.contrast!)) : 1;
  const saturation = Number.isFinite(fx.saturation) ? Math.max(0, Math.min(3, fx.saturation!)) : 1;
  const grayscale = fx.monochrome ? 1 : 0;
  const invert = fx.invert ? 1 : 0;
  return `brightness(${brightness.toFixed(2)}) contrast(${contrast.toFixed(2)}) saturate(${saturation.toFixed(2)}) grayscale(${grayscale}) invert(${invert})`;
}

function createSlot(deckId: DeckId, scaleMode: VideoScaleMode = "fit"): VideoDeckSlot {
  return {
    deckId,
    loaded: false,
    url: "",
    fileName: "",
    duration: 0,
    currentTime: 0,
    playing: false,
    rate: 1,
    reversed: false,
    scratching: false,
    offsetSeconds: 0,
    scaleMode,
    fx: defaultVideoFx(),
  };
}

function cloneSlot(slot: VideoDeckSlot): VideoDeckSlot {
  return {
    ...slot,
    fx: { ...slot.fx },
  };
}

export class VideoMixer {
  readonly decks: Record<DeckId, VideoDeckSlot> = {
    A: createSlot("A"),
    B: createSlot("B"),
    C: createSlot("C"),
    D: createSlot("D"),
  };

  leftDeck: DeckId = "A";
  rightDeck: DeckId = "B";
  crossfader = 0;
  linkToAudioCrossfader = false;
  blendMode: VideoBlendMode = "fade";
  scaleMode: VideoScaleMode = "fit";
  outputOpen = false;
  outputFullscreen = false;

  loadVideo(deckId: DeckId, url: string, fileName: string, duration = 0): VideoDeckSlot {
    const slot = this.decks[deckId];
    slot.loaded = Boolean(url);
    slot.url = url;
    slot.fileName = fileName || url;
    slot.duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    slot.currentTime = computeVideoSyncTarget(slot.currentTime, slot.duration, slot.offsetSeconds, true);
    return cloneSlot(slot);
  }

  ejectVideo(deckId: DeckId): VideoDeckSlot {
    const prevScale = this.decks[deckId].scaleMode;
    this.decks[deckId] = createSlot(deckId, prevScale);
    return cloneSlot(this.decks[deckId]);
  }

  setDuration(deckId: DeckId, duration: number): void {
    if (Number.isFinite(duration) && duration >= 0) {
      this.decks[deckId].duration = duration;
    }
  }

  getDeck(deckId: DeckId): VideoDeckSlot {
    return cloneSlot(this.decks[deckId]);
  }

  setLeftDeck(deckId: DeckId): void {
    if (ALL_DECK_IDS.includes(deckId)) {
      this.leftDeck = deckId;
    }
  }

  setRightDeck(deckId: DeckId): void {
    if (ALL_DECK_IDS.includes(deckId)) {
      this.rightDeck = deckId;
    }
  }

  setCrossfader(value: number): number {
    this.crossfader = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
    return this.crossfader;
  }

  setAudioCrossfader(value: number, signed = false): number {
    if (this.linkToAudioCrossfader) {
      const mapped = signed ? value : (value >= 0 && value <= 1 ? value * 2 - 1 : value);
      this.setCrossfader(mapped);
    }
    return this.crossfader;
  }

  setLinkToAudioCrossfader(linked: boolean, currentAudioXf?: number): void {
    this.linkToAudioCrossfader = Boolean(linked);
    if (this.linkToAudioCrossfader && typeof currentAudioXf === "number" && Number.isFinite(currentAudioXf)) {
      const mapped = currentAudioXf >= 0 && currentAudioXf <= 1 ? currentAudioXf * 2 - 1 : currentAudioXf;
      this.setCrossfader(mapped);
    }
  }

  setBlendMode(mode: VideoBlendMode): void {
    if (mode === "fade" || mode === "cut" || mode === "add" || mode === "luma") {
      this.blendMode = mode;
    }
  }

  setScaleMode(mode: VideoScaleMode, deckId?: DeckId): void {
    if (mode !== "fit" && mode !== "fill") return;
    if (deckId) {
      this.decks[deckId].scaleMode = mode;
      return;
    }
    this.scaleMode = mode;
    for (const id of ALL_DECK_IDS) {
      this.decks[id].scaleMode = mode;
    }
  }

  setDeckFx(deckId: DeckId, patch: Partial<VideoFxState>): VideoFxState {
    const slot = this.decks[deckId];
    slot.fx = {
      ...slot.fx,
      ...patch,
    };
    return { ...slot.fx };
  }

  setDeckOffset(deckId: DeckId, offsetSeconds: number): number {
    const slot = this.decks[deckId];
    slot.offsetSeconds = Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
    slot.currentTime = computeVideoSyncTarget(slot.currentTime, slot.duration, slot.offsetSeconds, true);
    return slot.offsetSeconds;
  }

  setOutputWindowState(open: boolean, fullscreen = false): void {
    this.outputOpen = Boolean(open);
    this.outputFullscreen = Boolean(open && fullscreen);
  }

  weights(): { left: number; right: number } {
    return computeVideoCrossfaderWeights(this.crossfader, this.blendMode);
  }

  syncDeck(deckId: DeckId, transport: VideoTransportState): VideoDeckSlot {
    const slot = this.decks[deckId];
    if (slot.duration <= 0 && typeof transport.duration === "number" && Number.isFinite(transport.duration) && transport.duration > 0) {
      slot.duration = transport.duration;
    }
    const rate = Number.isFinite(transport.rate) ? transport.rate : 1;
    const reversed = Boolean(transport.reversed || rate < 0);
    const scratching = Boolean(transport.scratching);
    slot.rate = rate;
    slot.reversed = reversed;
    slot.scratching = scratching;
    slot.playing = Boolean(transport.playing);
    slot.currentTime = computeVideoSyncTarget(
      transport.currentTime,
      slot.duration,
      slot.offsetSeconds,
      transport.loop ?? true,
    );
    return cloneSlot(slot);
  }

  getSnapshot(): VideoMixerSnapshot {
    return {
      decks: {
        A: cloneSlot(this.decks.A),
        B: cloneSlot(this.decks.B),
        C: cloneSlot(this.decks.C),
        D: cloneSlot(this.decks.D),
      },
      leftDeck: this.leftDeck,
      rightDeck: this.rightDeck,
      crossfader: this.crossfader,
      linkToAudioCrossfader: this.linkToAudioCrossfader,
      blendMode: this.blendMode,
      scaleMode: this.scaleMode,
      outputOpen: this.outputOpen,
      outputFullscreen: this.outputFullscreen,
      weights: computeVideoCrossfaderWeights(this.crossfader, this.blendMode),
    };
  }

  renderComposite(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    sources?: Partial<Record<DeckId, VideoFrameSource>>,
  ): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    ctx.save();
    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, w, h);

    const weights = computeVideoCrossfaderWeights(this.crossfader, this.blendMode);
    const drawSide = (deckId: DeckId, weight: number, compositeOp: GlobalCompositeOperation): void => {
      if (weight <= 0.001) return;
      const slot = this.decks[deckId];
      const src = sources?.[deckId];
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, weight));
      ctx.globalCompositeOperation = compositeOp;
      ctx.filter = formatVideoCssFilter(slot.fx);
      if (src) {
        const sw = Number(src.videoWidth ?? src.width ?? w) || w;
        const sh = Number(src.videoHeight ?? src.height ?? h) || h;
        const rect = computeAspectRect(sw, sh, w, h, slot.scaleMode || this.scaleMode);
        try {
          ctx.drawImage(src, rect.x, rect.y, rect.width, rect.height);
        } catch {
          // Video element not ready for drawImage yet
        }
      } else if (slot.loaded) {
        // Synthetic placeholder frame when no DOM video element is supplied (e.g. headless/test)
        const rect = computeAspectRect(16, 9, w, h, slot.scaleMode || this.scaleMode);
        const hue = deckId === "A" ? 215 : deckId === "B" ? 340 : deckId === "C" ? 160 : 42;
        const phase = (slot.currentTime % 4) / 4;
        ctx.fillStyle = `hsl(${hue} 70% ${22 + Math.round(phase * 18)}%)`;
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
      ctx.restore();
    };

    const rightOp: GlobalCompositeOperation =
      this.blendMode === "add" ? "lighter" : this.blendMode === "luma" ? "screen" : "source-over";
    drawSide(this.leftDeck, weights.left, "source-over");
    drawSide(this.rightDeck, weights.right, rightOp);
    ctx.restore();
  }
}

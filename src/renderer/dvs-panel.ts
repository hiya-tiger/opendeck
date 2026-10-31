import { TIMECODES, findTimecode } from "../timecode/defs.ts";
import { DvsTransport, type DvsMode } from "../dvs/transport.ts";
import { profileForDevice } from "./midi/profiles.ts";

type DeckKey = "A" | "B" | "C" | "D";

interface DeckLike {
  readonly duration: number;
  readonly currentTime: number;
  readonly playing: boolean;
  readonly hasTrack: boolean;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
  driveTimecode(rate: number, positionSeconds: number | null): void;
  setPlaybackMode?(mode: "INT" | "REL" | "ABS"): void;
}

interface OpenDecksGlobal {
  decks: Record<DeckKey, DeckLike>;
}

const bridge = window as unknown as { openDeck?: OpenDecksGlobal };

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const enable = byId<HTMLInputElement>("dvsEnable");
const deviceSelect = byId<HTMLSelectElement>("dvsDevice");
const timecodeSelect = byId<HTMLSelectElement>("dvsTimecode");
const targetSelect = byId<HTMLSelectElement>("dvsTarget");
const modeSelect = document.getElementById("dvsMode") as HTMLSelectElement | null;
const statusText = byId<HTMLSpanElement>("dvsStatus");
const calibrate = byId<HTMLButtonElement>("dvsCalibrate");
const scopeCanvas = document.getElementById("dvsScope") as HTMLCanvasElement | null;

for (const timecode of TIMECODES) {
  const option = document.createElement("option");
  option.value = timecode.id;
  option.textContent = `${timecode.name} · ${timecode.carrierHz} Hz`;
  timecodeSelect.append(option);
}

let context: AudioContext | null = null;
let stream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let processor: ScriptProcessorNode | null = null;
let sink: GainNode | null = null;
let transport: DvsTransport | null = null;
let offset = 0;
let offsetReady = false;
let lastStatus = "";
let lastLeft: Float32Array | null = null;
let lastRight: Float32Array | null = null;

const setStatus = (text: string, state: "off" | "wait" | "live" | "warn"): void => {
  statusText.textContent = text;
  statusText.dataset.state = state;
};

const targetDeck = (): DeckLike | null => {
  const decks = bridge.openDeck?.decks;
  if (!decks) return null;
  const key = (["A", "B", "C", "D"].includes(targetSelect.value) ? targetSelect.value : "A") as DeckKey;
  return decks[key] ?? null;
};

const currentMode = (): DvsMode => {
  const val = modeSelect?.value;
  if (val === "internal" || val === "relative" || val === "absolute") return val;
  return "absolute";
};

const buildTransport = (sampleRate: number): void => {
  const definition = findTimecode(timecodeSelect.value) ?? TIMECODES[0];
  transport = new DvsTransport(definition, sampleRate, {
    jumpSeconds: 0.35,
    mode: currentMode(),
  });
  offsetReady = false;
  offset = 0;
};

const drawScope = (left: Float32Array, right: Float32Array, locked: boolean): void => {
  if (!scopeCanvas) return;
  const ctx = scopeCanvas.getContext("2d");
  if (!ctx) return;
  const w = scopeCanvas.width;
  const h = scopeCanvas.height;
  ctx.fillStyle = "#080c14";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = locked ? "#23b5a5" : "#e8567a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(left.length / 96));
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) * 0.85;
  for (let i = 0; i < left.length; i += step) {
    const x = cx + Math.max(-1, Math.min(1, left[i])) * r;
    const y = cy - Math.max(-1, Math.min(1, right[i])) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
};

const stopCapture = (): void => {
  processor?.disconnect();
  source?.disconnect();
  sink?.disconnect();
  stream?.getTracks().forEach((track) => track.stop());
  processor = null;
  source = null;
  sink = null;
  stream = null;
  transport = null;
  void context?.close();
  context = null;
  setStatus("off", "off");
};

const handleBlock = (left: Float32Array, right: Float32Array): void => {
  if (!transport) return;
  lastLeft = left;
  lastRight = right;
  const reading = transport.push(left, right);
  drawScope(left, right, reading.status === "locked");
  const modeTag = (reading.mode ?? "absolute").slice(0, 3).toUpperCase();
  const label = `${modeTag} · ${reading.status === "locked" ? "lock" : reading.status} · ${reading.speedPercent.toFixed(1)}%`;
  const next = `${label} · ${reading.carrierHz.toFixed(0)} Hz`;
  if (next !== lastStatus) {
    lastStatus = next;
    setStatus(next, reading.status === "locked" ? "live" : reading.status === "stalled" ? "warn" : "wait");
  }

  const deck = targetDeck();
  if (!deck || !deck.hasTrack) return;

  if (reading.mode === "internal") {
    return;
  }

  if (reading.status !== "locked") {
    if (deck.playing) deck.pause();
    return;
  }

  if (!offsetReady) {
    offset = deck.currentTime - reading.positionSeconds;
    offsetReady = true;
  }

  const driftCorr = transport.computeDriftCorrection(deck.currentTime - offset);
  const wanted = Math.max(-1.6, Math.min(1.6, reading.rate + driftCorr));
  if (reading.jump !== null && reading.mode === "absolute") {
    deck.driveTimecode(wanted, reading.jump + offset);
    return;
  }

  const desired = reading.positionSeconds + offset;
  const align =
    reading.mode === "absolute" && Math.abs(desired - deck.currentTime) > 0.09 ? desired : null;
  deck.driveTimecode(wanted, align);
};

const listDevices = async (): Promise<void> => {
  const previousDeviceId = deviceSelect.value;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((device) => device.kind === "audioinput");
  deviceSelect.replaceChildren();
  const fallback = document.createElement("option");
  fallback.value = "";
  fallback.textContent = "Default stereo input";
  deviceSelect.append(fallback);
  let autoSelectedDvsId: string | null = null;
  for (const input of inputs) {
    if (!input.deviceId || input.deviceId === "default") continue;
    const option = document.createElement("option");
    option.value = input.deviceId;
    const rawLabel = input.label || `Input ${deviceSelect.options.length}`;
    const profile = profileForDevice(rawLabel);
    if (profile?.dvsReady) {
      const badge = profile.dvsUpgrade ? " [DVS Upgrade]" : " [DVS Ready]";
      option.textContent = `${rawLabel}${badge}`;
      if (!autoSelectedDvsId) {
        autoSelectedDvsId = input.deviceId;
      }
    } else {
      option.textContent = rawLabel;
    }
    deviceSelect.append(option);
  }
  if (previousDeviceId && [...deviceSelect.options].some((opt) => opt.value === previousDeviceId)) {
    deviceSelect.value = previousDeviceId;
  } else if (autoSelectedDvsId) {
    deviceSelect.value = autoSelectedDvsId;
  }
};

const startCapture = async (): Promise<void> => {
  setStatus("requesting input", "wait");
  const request = navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceSelect.value ? { exact: deviceSelect.value } : undefined,
      channelCount: 2,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
  try {
    stream = await Promise.race([
      request,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("no stereo input available")), 8000),
      ),
    ]);
  } catch (error) {
    request.catch(() => undefined);
    setStatus(`input failed: ${(error as Error).message}`, "warn");
    enable.checked = false;
    return;
  }

  context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  await context.resume();
  buildTransport(context.sampleRate);
  source = context.createMediaStreamSource(stream);
  const splitter = context.createChannelSplitter(2);
  source.connect(splitter);
  processor = context.createScriptProcessor(1024, 2, 2);
  splitter.connect(processor, 0, 0);
  splitter.connect(processor, 1, 1);
  sink = context.createGain();
  sink.gain.value = 0;
  processor.connect(sink);
  sink.connect(context.destination);
  processor.onaudioprocess = (event) => {
    handleBlock(event.inputBuffer.getChannelData(0), event.inputBuffer.getChannelData(1));
  };
  await listDevices();
  setStatus("listening", "wait");
};

enable.addEventListener("change", () => {
  if (enable.checked) void startCapture();
  else stopCapture();
});

timecodeSelect.addEventListener("change", () => {
  if (context) buildTransport(context.sampleRate);
});

modeSelect?.addEventListener("change", () => {
  const mode = currentMode();
  transport?.setMode(mode);
  const deck = targetDeck();
  deck?.setPlaybackMode?.(mode === "internal" ? "INT" : mode === "relative" ? "REL" : "ABS");
});

calibrate.addEventListener("click", () => {
  const deck = targetDeck();
  if (!deck || !transport) return;
  if (lastLeft && lastRight) {
    transport.calibrate(lastLeft, lastRight);
  }
  const state = transport.decoder.state;
  offset = deck.currentTime - state.positionSeconds;
  offsetReady = true;
  setStatus(`offset ${offset.toFixed(2)} s`, "wait");
});

void navigator.mediaDevices
  ?.enumerateDevices()
  .then(() => listDevices())
  .catch(() => setStatus("no audio devices", "warn"));

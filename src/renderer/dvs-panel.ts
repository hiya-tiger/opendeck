import { TIMECODES, findTimecode } from "../timecode/defs.ts";
import { DvsTransport } from "../dvs/transport.ts";

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
}

interface OpenDeckGlobal {
  decks: Record<"A" | "B", DeckLike>;
}

const bridge = window as unknown as { openDeck?: OpenDeckGlobal };

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const enable = byId<HTMLInputElement>("dvsEnable");
const deviceSelect = byId<HTMLSelectElement>("dvsDevice");
const timecodeSelect = byId<HTMLSelectElement>("dvsTimecode");
const targetSelect = byId<HTMLSelectElement>("dvsTarget");
const statusText = byId<HTMLSpanElement>("dvsStatus");
const calibrate = byId<HTMLButtonElement>("dvsCalibrate");

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

const setStatus = (text: string, state: "off" | "wait" | "live" | "warn"): void => {
  statusText.textContent = text;
  statusText.dataset.state = state;
};

const targetDeck = (): DeckLike | null => {
  const decks = bridge.openDeck?.decks;
  if (!decks) return null;
  return decks[targetSelect.value === "B" ? "B" : "A"] ?? null;
};

const buildTransport = (sampleRate: number): void => {
  const definition = findTimecode(timecodeSelect.value) ?? TIMECODES[0];
  transport = new DvsTransport(definition, sampleRate, { jumpSeconds: 0.35 });
  offsetReady = false;
  offset = 0;
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
  const reading = transport.push(left, right);
  const label = `${reading.status === "locked" ? "lock" : reading.status} · ${reading.speedPercent.toFixed(1)}%`;
  const next = `${label} · ${reading.carrierHz.toFixed(0)} Hz`;
  if (next !== lastStatus) {
    lastStatus = next;
    setStatus(next, reading.status === "locked" ? "live" : reading.status === "stalled" ? "warn" : "wait");
  }

  const deck = targetDeck();
  if (!deck || !deck.hasTrack) return;

  if (reading.status !== "locked") {
    if (deck.playing) deck.pause();
    return;
  }

  if (!offsetReady) {
    offset = deck.currentTime - reading.positionSeconds;
    offsetReady = true;
  }

  const wanted = Math.max(-1.6, Math.min(1.6, reading.rate));
  if (reading.jump !== null) {
    deck.driveTimecode(wanted, reading.jump + offset);
    return;
  }

  const desired = reading.positionSeconds + offset;
  const align = Math.abs(desired - deck.currentTime) > 0.09 ? desired : null;
  deck.driveTimecode(wanted, align);
};

const listDevices = async (): Promise<void> => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((device) => device.kind === "audioinput");
  deviceSelect.replaceChildren();
  const fallback = document.createElement("option");
  fallback.value = "";
  fallback.textContent = "Default stereo input";
  deviceSelect.append(fallback);
  for (const input of inputs) {
    if (!input.deviceId || input.deviceId === "default") continue;
    const option = document.createElement("option");
    option.value = input.deviceId;
    option.textContent = input.label || `Input ${deviceSelect.options.length}`;
    deviceSelect.append(option);
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

calibrate.addEventListener("click", () => {
  const deck = targetDeck();
  if (!deck || !transport) return;
  const state = transport.decoder.state;
  offset = deck.currentTime - state.positionSeconds;
  offsetReady = true;
  setStatus(`offset ${offset.toFixed(2)} s`, "wait");
});

void navigator.mediaDevices
  ?.enumerateDevices()
  .then(() => listDevices())
  .catch(() => setStatus("no audio devices", "warn"));

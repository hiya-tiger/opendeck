export type MidiEvent =
  | { type: "cc"; channel: number; controller: number; value: number; normalized: number }
  | { type: "noteon"; channel: number; note: number; velocity: number; normalized: number }
  | { type: "noteoff"; channel: number; note: number; velocity: number; normalized: number };

export interface MidiBinding {
  message: "cc" | "note";
  number: number;
  channel: number | null;
}

export type MidiBindings = Record<string, MidiBinding>;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const DEFAULT_PAD_BASE_NOTE = 36;

export function defaultPadIndex(note: number): number | null {
  const index = note - DEFAULT_PAD_BASE_NOTE;
  return index >= 0 && index < 8 ? index : null;
}

export function describeMidiEvent(event: MidiEvent): string {
  if (event.type === "cc") {
    return `ch${event.channel} CC${event.controller} ${event.value}`;
  }
  return `ch${event.channel} note ${event.note} vel ${event.velocity}`;
}

export function parseMidiMessage(data: ArrayLike<number>): MidiEvent | null {
  if (!data || data.length < 2) return null;
  const status = data[0];
  if (status < 0x80) return null;
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  if (type === 0x90 && data.length >= 3) {
    const note = data[1];
    const velocity = data[2];
    if (velocity === 0) return { type: "noteoff", channel, note, velocity: 0, normalized: 0 };
    return { type: "noteon", channel, note, velocity, normalized: clamp(velocity / 127, 0, 1) };
  }
  if (type === 0x80 && data.length >= 3) {
    const note = data[1];
    const velocity = data[2];
    return { type: "noteoff", channel, note, velocity, normalized: 0 };
  }
  if (type === 0xb0 && data.length >= 3) {
    const controller = data[1];
    const value = data[2];
    return { type: "cc", channel, controller, value, normalized: clamp(value / 127, 0, 1) };
  }
  return null;
}

export function bindingFor(event: MidiEvent): MidiBinding {
  return {
    message: event.type === "cc" ? "cc" : "note",
    number: event.type === "cc" ? event.controller : event.note,
    channel: event.channel,
  };
}

export function matchesBinding(binding: MidiBinding, event: MidiEvent): boolean {
  if (binding.message === "cc" && event.type !== "cc") return false;
  if (binding.message === "note" && event.type === "cc") return false;
  if (binding.channel != null && event.channel !== binding.channel) return false;
  const number = event.type === "cc" ? event.controller : event.note;
  return number === binding.number;
}

export function mapControlValue(binding: MidiBinding, value: number, min: number, max: number): number {
  if (binding.message === "note") return value >= 0.5 ? max : min;
  return min + (max - min) * clamp(value, 0, 1);
}

export function loadBindings(storage: Storage | null): MidiBindings {
  if (!storage) return {};
  try {
    const raw = storage.getItem("opendeck.midi.map.v1");
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const result: MidiBindings = {};
    for (const [target, binding] of Object.entries(parsed as Record<string, unknown>)) {
      const record = binding as Partial<MidiBinding> | null;
      if (!record) continue;
      if (record.message !== "cc" && record.message !== "note") continue;
      if (typeof record.number !== "number") continue;
      result[target] = {
        message: record.message,
        number: record.number,
        channel: typeof record.channel === "number" ? record.channel : null,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function saveBindings(storage: Storage | null, bindings: MidiBindings): void {
  if (!storage) return;
  try {
    storage.setItem("opendeck.midi.map.v1", JSON.stringify(bindings));
  } catch {
    // storage may be unavailable in private contexts
  }
}

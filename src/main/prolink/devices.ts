// Pure state machines for Pro DJ Link discovery and media-slot tracking.
// No sockets here so the logic can be tested with crafted packets.
import { KIND_CLAIM_2, KIND_CLAIM_FINAL, KIND_KEEPALIVE, type AnnouncePacket, type CdjStatus, type SlotName } from "./packets.ts";

export interface DjDevice {
  deviceNumber: number;
  name: string;
  ip: string;
  mac: string;
  /** 1 = player, 2 = mixer, anything else = software or unknown. */
  deviceType: number;
  firstSeen: number;
  lastSeen: number;
}

export const DEVICE_TIMEOUT_MS = 5000;

export const isPlayer = (d: DjDevice): boolean => d.deviceType === 1 && d.deviceNumber >= 1 && d.deviceNumber <= 15;

export class DeviceTracker {
  private devices = new Map<number, DjDevice>();
  readonly timeoutMs: number;

  constructor(timeoutMs = DEVICE_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /** Feed a keep-alive. Returns the device when it is new (or changed address). */
  update(pkt: AnnouncePacket, fromIp: string, now: number): DjDevice | null {
    if (pkt.kind !== KIND_KEEPALIVE || pkt.deviceNumber === null) return null;
    const existing = this.devices.get(pkt.deviceNumber);
    const ip = pkt.ip && pkt.ip !== "0.0.0.0" ? pkt.ip : fromIp;
    if (existing && existing.ip === ip) {
      existing.lastSeen = now;
      existing.name = pkt.name || existing.name;
      return null;
    }
    const device: DjDevice = {
      deviceNumber: pkt.deviceNumber,
      name: pkt.name,
      ip,
      mac: pkt.mac ?? "",
      deviceType: pkt.deviceType ?? 0,
      firstSeen: now,
      lastSeen: now,
    };
    this.devices.set(pkt.deviceNumber, device);
    return device;
  }

  /** Drop devices silent for longer than the timeout. Returns those removed. */
  expire(now: number): DjDevice[] {
    const gone: DjDevice[] = [];
    for (const [n, d] of this.devices) {
      if (now - d.lastSeen > this.timeoutMs) {
        this.devices.delete(n);
        gone.push(d);
      }
    }
    return gone;
  }

  get(n: number): DjDevice | undefined {
    return this.devices.get(n);
  }

  list(): DjDevice[] {
    return [...this.devices.values()].sort((a, b) => a.deviceNumber - b.deviceNumber);
  }

  players(): DjDevice[] {
    return this.list().filter(isPlayer);
  }

  clear(): void {
    this.devices.clear();
  }
}

/**
 * Choose the virtual player's device number.
 * auto: the lowest unused 1-4 while fewer than four players are present
 * (real-player numbers are needed for some queries), otherwise the lowest
 * unused number from 5 upwards. A fixed preference is used as given.
 */
export function pickDeviceNumber(inUse: Iterable<number>, preferred: number | "auto" = "auto", avoid: Iterable<number> = []): number {
  const used = new Set([...inUse, ...avoid]);
  if (preferred !== "auto" && Number.isInteger(preferred) && preferred >= 1 && preferred <= 0x20) return preferred;
  const playersInRange = [...used].filter((n) => n >= 1 && n <= 4).length;
  if (playersInRange < 4) {
    for (let n = 1; n <= 4; n++) if (!used.has(n)) return n;
  }
  for (let n = 5; n <= 15; n++) if (!used.has(n)) return n;
  return 15;
}

/** True when a packet means another device is claiming or using `ours`. */
export function claimsNumber(pkt: AnnouncePacket, ours: number): boolean {
  return (pkt.kind === KIND_CLAIM_2 || pkt.kind === KIND_CLAIM_FINAL || pkt.kind === KIND_KEEPALIVE) && pkt.deviceNumber === ours;
}

export interface MountEvent {
  type: "mount" | "unmount";
  deviceNumber: number;
  slot: SlotName;
}

/** Tracks the USB / SD local-media byte per player and emits transitions. */
export class MountTracker {
  private state = new Map<string, boolean>();

  update(status: CdjStatus): MountEvent[] {
    const events: MountEvent[] = [];
    for (const slot of ["usb", "sd"] as const) {
      const value = status[slot];
      if (value === "unknown") continue;
      const key = `${status.deviceNumber}:${slot}`;
      const was = this.state.get(key) ?? false;
      const now = value === "mounted";
      this.state.set(key, now);
      if (now && !was) events.push({ type: "mount", deviceNumber: status.deviceNumber, slot });
      if (!now && was) events.push({ type: "unmount", deviceNumber: status.deviceNumber, slot });
    }
    return events;
  }

  dropDevice(deviceNumber: number): MountEvent[] {
    const events: MountEvent[] = [];
    for (const slot of ["usb", "sd"] as const) {
      const key = `${deviceNumber}:${slot}`;
      if (this.state.get(key)) events.push({ type: "unmount", deviceNumber, slot });
      this.state.delete(key);
    }
    return events;
  }

  mounted(): { deviceNumber: number; slot: SlotName }[] {
    const out: { deviceNumber: number; slot: SlotName }[] = [];
    for (const [key, on] of this.state) {
      if (!on) continue;
      const [n, slot] = key.split(":");
      out.push({ deviceNumber: Number(n), slot: slot as SlotName });
    }
    return out;
  }

  clear(): void {
    this.state.clear();
  }
}

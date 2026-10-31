// Pro DJ Link network presence: listens for keep-alives (50000) and CDJ status
// (50002), announces a virtual player so players send us status, tracks
// devices and media-slot mount transitions, and answers media queries.
//
// Sockets bind to 0.0.0.0 (needed to receive broadcasts on Windows), but only
// traffic from the chosen interface's subnet is accepted, and keep-alives go
// to that interface's directed broadcast address so they leave on it.
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { claimsNumber, DeviceTracker, isPlayer, MountTracker, pickDeviceNumber, type DjDevice, type MountEvent } from "./devices.ts";
import { broadcastAddress, interfaceForPeer, listInterfaces, sameSubnet, type NetInterface } from "./interfaces.ts";
import {
  buildKeepalive,
  buildMediaQuery,
  hasMagic,
  KIND_CONFLICT,
  KIND_MEDIA_RESPONSE,
  KIND_CDJ_STATUS,
  parseAnnounce,
  parseCdjStatus,
  parseMediaResponse,
  PORT_ANNOUNCE,
  PORT_STATUS,
  slotNumber,
  type CdjStatus,
  type MediaDetails,
  type SlotName,
} from "./packets.ts";

export interface ProlinkNetworkOptions {
  name?: string;
  interface?: string; // name or "auto"
  deviceNumber?: number | "auto";
  announcePort?: number; // where we listen for keep-alives
  statusPort?: number; // where we listen for status
  peerAnnouncePort?: number; // where keep-alives are sent
  peerStatusPort?: number; // where media queries are sent
  broadcastOverride?: string; // tests: send keep-alives here instead of the broadcast address
  keepaliveMs?: number;
  timeoutMs?: number;
  interfaces?: () => NetInterface[];
}

export interface PlayerState {
  device: DjDevice;
  status: CdjStatus | null;
}

export class ProlinkNetwork extends EventEmitter {
  readonly devices: DeviceTracker;
  readonly mounts = new MountTracker();
  private statuses = new Map<number, CdjStatus>();
  private statusIps = new Map<number, string>();
  private opts: Required<Omit<ProlinkNetworkOptions, "broadcastOverride">> & { broadcastOverride?: string };
  private announceSocket: dgram.Socket | null = null;
  private statusSocket: dgram.Socket | null = null;
  private timers: NodeJS.Timeout[] = [];
  private mediaWaiters = new Map<string, ((d: MediaDetails) => void)[]>();
  private avoid = new Set<number>();
  iface: NetInterface | null = null;
  deviceNumber: number | null = null;
  running = false;
  lastError: string | null = null;

  constructor(opts: ProlinkNetworkOptions = {}) {
    super();
    this.opts = {
      name: opts.name ?? "OpenDecks",
      interface: opts.interface ?? "auto",
      deviceNumber: opts.deviceNumber ?? "auto",
      announcePort: opts.announcePort ?? PORT_ANNOUNCE,
      statusPort: opts.statusPort ?? PORT_STATUS,
      peerAnnouncePort: opts.peerAnnouncePort ?? PORT_ANNOUNCE,
      peerStatusPort: opts.peerStatusPort ?? PORT_STATUS,
      broadcastOverride: opts.broadcastOverride,
      keepaliveMs: opts.keepaliveMs ?? 1500,
      timeoutMs: opts.timeoutMs ?? 5000,
      interfaces: opts.interfaces ?? listInterfaces,
    };
    this.devices = new DeviceTracker(this.opts.timeoutMs);
  }

  get ports(): { announce: number; status: number } {
    return {
      announce: (this.announceSocket?.address() as { port: number } | undefined)?.port ?? 0,
      status: (this.statusSocket?.address() as { port: number } | undefined)?.port ?? 0,
    };
  }

  private bindSocket(port: number, onMessage: (msg: Buffer, rinfo: dgram.RemoteInfo) => void): Promise<dgram.Socket> {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (msg, rinfo) => {
      try {
        onMessage(msg, rinfo);
      } catch (error) {
        this.lastError = (error as Error).message;
      }
    });
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind({ port, address: "0.0.0.0" }, () => {
        socket.off("error", reject);
        socket.on("error", (error) => {
          this.lastError = error.message;
          this.emit("error", error);
        });
        try {
          socket.setBroadcast(true);
        } catch {
          // not fatal
        }
        resolve(socket);
      });
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.lastError = null;
    try {
      this.announceSocket = await this.bindSocket(this.opts.announcePort, (m, r) => this.onAnnounce(m, r));
      this.statusSocket = await this.bindSocket(this.opts.statusPort, (m, r) => this.onStatus(m, r));
    } catch (error) {
      this.lastError = `Could not open DJ Link ports: ${(error as Error).message}`;
      this.stopSockets();
      throw error;
    }
    this.running = true;
    if (this.opts.interface !== "auto") this.selectInterface(this.opts.interface);
    this.timers.push(setInterval(() => this.sendKeepalive(), this.opts.keepaliveMs));
    this.timers.push(setInterval(() => this.expire(), 1000));
    this.emit("change");
  }

  private stopSockets(): void {
    for (const s of [this.announceSocket, this.statusSocket]) {
      try {
        s?.close();
      } catch {
        // already closed
      }
    }
    this.announceSocket = null;
    this.statusSocket = null;
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const mounted = this.mounts.mounted();
    this.stopSockets();
    this.running = false;
    for (const m of mounted) this.emit("unmount", { type: "unmount", ...m } as MountEvent);
    this.mounts.clear();
    this.devices.clear();
    this.statuses.clear();
    this.statusIps.clear();
    this.deviceNumber = null;
    this.emit("change");
  }

  private selectInterface(name: string): void {
    const iface = this.opts.interfaces().find((i) => i.name === name) ?? null;
    if (!iface) {
      this.lastError = `Network interface ${name} not found`;
      return;
    }
    this.iface = iface;
    this.chooseNumber();
    this.sendKeepalive();
  }

  private chooseNumber(): void {
    const inUse = this.devices.list().map((d) => d.deviceNumber);
    this.deviceNumber = pickDeviceNumber(inUse, this.opts.deviceNumber, this.avoid);
  }

  private isOwn(ip: string, deviceNumber: number | null): boolean {
    return Boolean(this.iface && ip === this.iface.address && (deviceNumber === null || deviceNumber === this.deviceNumber));
  }

  private accepts(ip: string): boolean {
    return !this.iface || sameSubnet(ip, this.iface.address, this.iface.netmask) || ip === this.iface.address;
  }

  private onAnnounce(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (!hasMagic(msg)) return;
    const pkt = parseAnnounce(msg);
    if (!pkt) return;
    const sender = pkt.ip && pkt.ip !== "0.0.0.0" ? pkt.ip : rinfo.address;
    if (this.isOwn(rinfo.address, pkt.deviceNumber) && pkt.name === this.opts.name) return;
    if (!this.iface && this.opts.interface === "auto") {
      const iface = interfaceForPeer(this.opts.interfaces(), sender);
      if (iface) {
        this.iface = iface;
        this.emit("change");
      }
    }
    if (!this.accepts(sender)) return;
    if (pkt.kind === KIND_CONFLICT && pkt.deviceNumber === this.deviceNumber) {
      this.yieldNumber();
      return;
    }
    if (this.deviceNumber !== null && claimsNumber(pkt, this.deviceNumber) && sender !== this.iface?.address) {
      this.yieldNumber();
    }
    const added = this.devices.update(pkt, rinfo.address, Date.now());
    if (added) {
      if (this.deviceNumber === null && this.iface) this.chooseNumber();
      this.emit("device", added);
      this.emit("change");
    }
  }

  private yieldNumber(): void {
    if (this.deviceNumber !== null) this.avoid.add(this.deviceNumber);
    if (this.opts.deviceNumber !== "auto") {
      this.lastError = `Device number ${this.opts.deviceNumber} is in use by another device`;
    }
    this.chooseNumber();
    this.emit("change");
  }

  private onStatus(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (!hasMagic(msg) || !this.accepts(rinfo.address)) return;
    const kind = msg[0x0a];
    if (kind === KIND_CDJ_STATUS) {
      const status = parseCdjStatus(msg);
      if (!status) return;
      const previous = this.statuses.get(status.deviceNumber);
      this.statuses.set(status.deviceNumber, status);
      this.statusIps.set(status.deviceNumber, rinfo.address);
      for (const event of this.mounts.update(status)) this.emit(event.type, event);
      if (!previous || previous.usb !== status.usb || previous.sd !== status.sd) this.emit("change");
    } else if (kind === KIND_MEDIA_RESPONSE) {
      const details = parseMediaResponse(msg);
      if (!details) return;
      const key = `${details.deviceNumber}:${details.slot}`;
      const waiters = this.mediaWaiters.get(key) ?? [];
      this.mediaWaiters.delete(key);
      for (const w of waiters) w(details);
      this.emit("media", details);
    }
  }

  private expire(): void {
    for (const gone of this.devices.expire(Date.now())) {
      this.statuses.delete(gone.deviceNumber);
      this.statusIps.delete(gone.deviceNumber);
      for (const event of this.mounts.dropDevice(gone.deviceNumber)) this.emit(event.type, event);
      this.emit("device-lost", gone);
      this.emit("change");
    }
  }

  private sendKeepalive(): void {
    if (!this.running || !this.iface || this.deviceNumber === null || !this.announceSocket) return;
    const packet = buildKeepalive({
      name: this.opts.name,
      deviceNumber: this.deviceNumber,
      mac: this.iface.mac,
      ip: this.iface.address,
      peers: this.devices.list().length + 1,
    });
    const target = this.opts.broadcastOverride ?? broadcastAddress(this.iface.address, this.iface.netmask);
    this.announceSocket.send(packet, this.opts.peerAnnouncePort, target, () => undefined);
  }

  /** Ask a player about the media in one of its slots. Resolves null on timeout. */
  async queryMedia(deviceNumber: number, slot: SlotName, timeoutMs = 1500, attempts = 2): Promise<MediaDetails | null> {
    const ip = this.deviceIp(deviceNumber);
    if (!ip || !this.iface || this.deviceNumber === null || !this.statusSocket) return null;
    const slotN = slotNumber(slot);
    const key = `${deviceNumber}:${slotN}`;
    for (let i = 0; i < attempts; i++) {
      const result = await new Promise<MediaDetails | null>((resolve) => {
        const list = this.mediaWaiters.get(key) ?? [];
        const waiter = (d: MediaDetails): void => {
          clearTimeout(timer);
          resolve(d);
        };
        list.push(waiter);
        this.mediaWaiters.set(key, list);
        const timer = setTimeout(() => {
          const current = this.mediaWaiters.get(key) ?? [];
          this.mediaWaiters.set(key, current.filter((w) => w !== waiter));
          resolve(null);
        }, timeoutMs);
        const packet = buildMediaQuery({
          name: this.opts.name,
          deviceNumber: this.deviceNumber!,
          ip: this.iface!.address,
          targetDevice: deviceNumber,
          slot: slotN,
        });
        this.statusSocket!.send(packet, this.opts.peerStatusPort, ip, () => undefined);
      });
      if (result) return result;
    }
    return null;
  }

  /** Address of a player, from its keep-alive or, failing that, its status packets. */
  deviceIp(deviceNumber: number): string | null {
    return this.devices.get(deviceNumber)?.ip ?? this.statusIps.get(deviceNumber) ?? null;
  }

  deviceName(deviceNumber: number): string {
    return this.devices.get(deviceNumber)?.name || this.statuses.get(deviceNumber)?.name || `Player ${deviceNumber}`;
  }

  players(): PlayerState[] {
    return this.devices.list().map((device) => ({ device, status: this.statuses.get(device.deviceNumber) ?? null }));
  }

  playerCount(): number {
    return this.devices.list().filter(isPlayer).length;
  }
}

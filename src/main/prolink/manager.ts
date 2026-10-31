// Orchestrates detected media from both origins — a CDJ slot over Pro DJ Link
// and a USB drive on this computer — through probe -> prompt -> import ->
// track loading -> removal. Nothing is imported until the user says Add, or a
// remembered "Always" choice for that mediaKey says so.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fetchToCache, MAX_TRACK_BYTES, pruneCache } from "./cache.ts";
import type { MountEvent } from "./devices.ts";
import { importMedia, LocalMediaReader, NfsMediaReader, probeMedia, readCues, type MediaProbe, type MediaReader } from "./importer.ts";
import { listInterfaces, type NetInterface } from "./interfaces.ts";
import { NfsClient, type NfsClientOptions, type ReadProgress } from "./nfs.ts";
import { ProlinkNetwork } from "./network.ts";
import { exportPathFor, type SlotName } from "./packets.ts";
import { buildPrompt, cdjMediaKey, decideMediaAction, localMediaKey, rememberChoice } from "./prompt.ts";
import type {
  CdjFetchProgress,
  CdjMediaLibrary,
  CdjMediaSnapshot,
  CdjTrackInfo,
  LoadedTrack,
  MediaOrigin,
  MediaPrompt,
  ProlinkSettings,
  ProlinkSnapshot,
} from "./types.ts";
import { DEFAULT_PROLINK_SETTINGS } from "./types.ts";
import { defaultScanner, VolumeWatcher, type LocalVolume } from "./volumes.ts";

interface Entry {
  sourceId: string;
  origin: MediaOrigin;
  mediaKey: string;
  sourceName: string;
  mediaName: string;
  deviceNumber: number;
  playerName: string;
  slot: SlotName;
  where: string;
  state: CdjMediaSnapshot["state"];
  kind: CdjMediaSnapshot["kind"];
  trackCount: number | null;
  error?: string;
  reader: MediaReader | null;
  probe: MediaProbe | null;
  library: CdjMediaLibrary | null;
  tracks: Map<string, CdjTrackInfo>;
  prompt: MediaPrompt | null;
  root?: string;
}

export interface MediaManagerOptions {
  settings?: Partial<ProlinkSettings>;
  saveSettings?: (s: ProlinkSettings) => void | Promise<void>;
  cacheDir: string;
  nfsOptions?: NfsClientOptions;
  openNfs?: (host: string, exportPath: string) => Promise<MediaReader>;
  createNetwork?: (s: ProlinkSettings) => ProlinkNetwork;
  createVolumes?: () => VolumeWatcher | null;
  interfaces?: () => NetInterface[];
  mediaQueryTimeoutMs?: number;
}

export class MediaManager extends EventEmitter {
  settings: ProlinkSettings;
  network: ProlinkNetwork | null = null;
  volumes: VolumeWatcher | null = null;
  private entries = new Map<string, Entry>();
  private generation = new Map<string, number>();
  private opts: MediaManagerOptions;
  private networkError: string | null = null;

  constructor(opts: MediaManagerOptions) {
    super();
    this.opts = opts;
    this.settings = { ...DEFAULT_PROLINK_SETTINGS, ...(opts.settings ?? {}), remembered: { ...(opts.settings?.remembered ?? {}) } };
  }

  async start(): Promise<void> {
    if (this.settings.enabled) await this.startNetwork();
    if (this.settings.localDrives) this.startVolumes();
    void pruneCache(this.opts.cacheDir).catch(() => undefined);
  }

  async stop(): Promise<void> {
    await this.stopNetwork();
    this.stopVolumes();
  }

  async applySettings(patch: Partial<ProlinkSettings>): Promise<ProlinkSettings> {
    const before = this.settings;
    const next: ProlinkSettings = { ...before, ...patch, remembered: patch.remembered ?? before.remembered };
    this.settings = next;
    await this.persist();
    const netChanged = next.enabled !== before.enabled || next.interface !== before.interface || next.deviceNumber !== before.deviceNumber;
    if (netChanged) {
      await this.stopNetwork();
      if (next.enabled) await this.startNetwork();
    }
    if (next.localDrives !== before.localDrives) {
      if (next.localDrives) this.startVolumes();
      else this.stopVolumes();
    }
    this.emit("change");
    return next;
  }

  private async persist(): Promise<void> {
    try {
      await this.opts.saveSettings?.(this.settings);
    } catch {
      // settings are best effort
    }
  }

  private async startNetwork(): Promise<void> {
    if (this.network) return;
    const net = this.opts.createNetwork
      ? this.opts.createNetwork(this.settings)
      : new ProlinkNetwork({ interface: this.settings.interface, deviceNumber: this.settings.deviceNumber });
    net.on("mount", (ev: MountEvent) => void this.onCdjMount(ev));
    net.on("unmount", (ev: MountEvent) => this.removeSource(`cdj-${ev.deviceNumber}-${ev.slot}`));
    net.on("change", () => this.emit("change"));
    net.on("error", () => undefined);
    this.network = net;
    try {
      await net.start();
      this.networkError = null;
    } catch (error) {
      this.networkError = net.lastError ?? (error as Error).message;
      this.network = null;
    }
    this.emit("change");
  }

  private async stopNetwork(): Promise<void> {
    const net = this.network;
    if (!net) return;
    await net.stop(); // emits unmount for everything mounted
    net.removeAllListeners();
    this.network = null;
    for (const e of [...this.entries.values()]) if (e.origin === "cdj") this.removeSource(e.sourceId);
  }

  private startVolumes(): void {
    if (this.volumes) return;
    const watcher = this.opts.createVolumes ? this.opts.createVolumes() : (() => {
      const scanner = defaultScanner();
      return scanner ? new VolumeWatcher(scanner) : null;
    })();
    if (!watcher) return;
    watcher.on("added", (v: LocalVolume) => void this.onLocalVolume(v));
    watcher.on("removed", (v: LocalVolume) => this.removeSource(localSourceId(v.root)));
    watcher.on("error", () => undefined);
    this.volumes = watcher;
    watcher.start();
  }

  private stopVolumes(): void {
    this.volumes?.stop();
    this.volumes?.removeAllListeners();
    this.volumes = null;
    for (const e of [...this.entries.values()]) if (e.origin === "local") this.removeSource(e.sourceId);
  }

  private nextGeneration(sourceId: string): number {
    const g = (this.generation.get(sourceId) ?? 0) + 1;
    this.generation.set(sourceId, g);
    return g;
  }

  private current(sourceId: string, g: number): boolean {
    return this.generation.get(sourceId) === g;
  }

  private async onCdjMount(ev: MountEvent): Promise<void> {
    const net = this.network;
    if (!net) return;
    const sourceId = `cdj-${ev.deviceNumber}-${ev.slot}`;
    this.removeSource(sourceId);
    const g = this.nextGeneration(sourceId);
    const playerName = net.deviceName(ev.deviceNumber);
    const entry = this.newEntry({
      sourceId,
      origin: "cdj",
      deviceNumber: ev.deviceNumber,
      playerName,
      slot: ev.slot,
      where: `CDJ ${ev.deviceNumber}`,
    });
    this.entries.set(sourceId, entry);
    this.emit("change");
    try {
      const details = await net.queryMedia(ev.deviceNumber, ev.slot, this.opts.mediaQueryTimeoutMs ?? 1500);
      if (!this.current(sourceId, g)) return;
      const ip = net.deviceIp(ev.deviceNumber);
      if (!ip) throw new Error(`no address known for player ${ev.deviceNumber}`);
      const reader = await this.openNfs(ip, exportPathFor(ev.slot));
      if (!this.current(sourceId, g)) {
        reader.close();
        return;
      }
      entry.reader = reader;
      const probe = await probeMedia(reader);
      if (!this.current(sourceId, g)) return;
      entry.probe = probe;
      const pdbCount = probe.kind === "rekordbox" ? probe.db.tracks.length : null;
      entry.kind = probe.kind;
      entry.mediaName = details?.name || "";
      entry.trackCount = details && details.trackType === 1 && details.trackCount ? details.trackCount : pdbCount;
      const slotLabel = ev.slot === "usb" ? "USB" : "SD";
      entry.sourceName = `CDJ ${ev.deviceNumber} · ${slotLabel}${entry.mediaName ? ` · ${entry.mediaName}` : ""}`;
      entry.mediaKey = cdjMediaKey({
        name: details?.name ?? "",
        created: details?.created,
        totalBytes: details?.totalBytes,
        trackCount: details?.trackCount ?? pdbCount ?? 0,
      });
      await this.decide(entry, g);
    } catch (error) {
      if (!this.current(sourceId, g)) return;
      entry.state = "error";
      entry.error = (error as Error).message;
      this.emit("change");
    }
  }

  private async onLocalVolume(v: LocalVolume): Promise<void> {
    const sourceId = localSourceId(v.root);
    this.removeSource(sourceId);
    const g = this.nextGeneration(sourceId);
    const entry = this.newEntry({ sourceId, origin: "local", deviceNumber: 0, playerName: "", slot: "usb", where: "this computer" });
    entry.root = v.root;
    entry.mediaName = v.label;
    entry.sourceName = `USB · ${v.label}`;
    entry.mediaKey = localMediaKey(v);
    this.entries.set(sourceId, entry);
    try {
      const reader = new LocalMediaReader(v.root);
      entry.reader = reader;
      const probe = await probeMedia(reader);
      if (!this.current(sourceId, g)) return;
      entry.probe = probe;
      entry.kind = probe.kind;
      entry.trackCount = probe.kind === "rekordbox" ? probe.db.tracks.length : null;
      await this.decide(entry, g);
    } catch (error) {
      if (!this.current(sourceId, g)) return;
      entry.state = "error";
      entry.error = (error as Error).message;
      this.emit("change");
    }
  }

  private newEntry(p: Pick<Entry, "sourceId" | "origin" | "deviceNumber" | "playerName" | "slot" | "where">): Entry {
    return {
      ...p,
      mediaKey: "",
      sourceName: "",
      mediaName: "",
      state: "detected",
      kind: "unknown",
      trackCount: null,
      reader: null,
      probe: null,
      library: null,
      tracks: new Map(),
      prompt: null,
    };
  }

  private async decide(entry: Entry, g: number): Promise<void> {
    const decision = decideMediaAction(entry.mediaKey, this.settings);
    if (decision === "import") return this.doImport(entry, g);
    if (decision === "ignore") {
      entry.state = "ignored";
      this.emit("change");
      return;
    }
    entry.state = "detected";
    entry.prompt = buildPrompt({
      sourceId: entry.sourceId,
      origin: entry.origin,
      mediaKey: entry.mediaKey,
      sourceName: entry.sourceName,
      mediaName: entry.mediaName,
      slot: entry.slot,
      where: entry.where,
      trackCount: entry.trackCount,
      kind: entry.kind,
    });
    this.emit("prompt", entry.prompt);
    this.emit("change");
  }

  /** The user's answer to a prompt. */
  async respond(sourceId: string, action: "add" | "ignore", always = false): Promise<{ ok: boolean; error?: string }> {
    const entry = this.entries.get(sourceId);
    if (!entry) return { ok: false, error: "That drive is no longer connected." };
    if (always && entry.mediaKey) {
      this.settings = rememberChoice(this.settings, entry.mediaKey, action, true);
      await this.persist();
    }
    entry.prompt = null;
    this.emit("prompt-cleared", sourceId);
    if (action === "ignore") {
      entry.state = "ignored";
      this.emit("change");
      return { ok: true };
    }
    if (entry.state === "ready" || entry.state === "importing") return { ok: true };
    await this.doImport(entry, this.generation.get(sourceId) ?? 0);
    return (entry.state as string) === "ready" ? { ok: true } : { ok: false, error: entry.error };
  }

  private async doImport(entry: Entry, g: number): Promise<void> {
    if (!entry.reader) return;
    entry.state = "importing";
    entry.prompt = null;
    this.emit("change");
    try {
      const library = await importMedia(
        entry.reader,
        {
          sourceId: entry.sourceId,
          origin: entry.origin,
          mediaKey: entry.mediaKey,
          sourceName: entry.sourceName,
          deviceNumber: entry.deviceNumber,
          playerName: entry.playerName,
          slot: entry.slot,
          mediaName: entry.mediaName,
        },
        entry.probe ?? undefined,
      );
      if (!this.current(entry.sourceId, g)) return;
      entry.library = library;
      entry.tracks = new Map(library.tracks.map((t) => [t.id, t]));
      entry.kind = library.kind;
      entry.trackCount = library.tracks.length;
      entry.state = "ready";
      entry.probe = null; // free the parsed database
      this.emit("library", library);
    } catch (error) {
      entry.state = "error";
      entry.error = (error as Error).message;
    }
    this.emit("change");
  }

  removeSource(sourceId: string): void {
    const entry = this.entries.get(sourceId);
    if (!entry) return;
    this.nextGeneration(sourceId);
    this.entries.delete(sourceId);
    try {
      entry.reader?.close();
    } catch {
      // ignore
    }
    if (entry.prompt) this.emit("prompt-cleared", sourceId);
    if (entry.library) this.emit("removed", sourceId);
    this.emit("change");
  }

  private openNfs(host: string, exportPath: string): Promise<MediaReader> {
    if (this.opts.openNfs) return this.opts.openNfs(host, exportPath);
    return NfsClient.mount(host, exportPath, this.opts.nfsOptions).then((c) => new NfsMediaReader(c));
  }

  /**
   * Fetch one imported track's bytes. Only ids from an imported library are
   * accepted, so the renderer can never name an arbitrary path.
   */
  async loadTrack(sourceId: string, trackId: string, onProgress?: (p: CdjFetchProgress) => void): Promise<LoadedTrack> {
    const entry = this.entries.get(sourceId);
    if (!entry || entry.state !== "ready" || !entry.reader) return { ok: false, error: "That drive is not connected." };
    const track = entry.tracks.get(trackId);
    if (!track) return { ok: false, error: "Unknown track." };
    const progress = (p: ReadProgress): void => onProgress?.({ sourceId, trackId, done: p.done, total: p.total });
    try {
      let bytes: Buffer;
      if (entry.origin === "cdj") {
        const { file } = await fetchToCache(
          entry.reader,
          this.opts.cacheDir,
          { deviceNumber: entry.deviceNumber, slot: entry.slot, path: track.path, size: track.size },
          progress,
        );
        bytes = await (await import("node:fs")).promises.readFile(file);
      } else {
        bytes = await entry.reader.readFile(track.path, { onProgress: progress, maxBytes: MAX_TRACK_BYTES });
      }
      const cues = track.analyzePath ? await readCues(entry.reader, track.analyzePath) : [];
      return { ok: true, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), name: path.posix.basename(track.path), cues };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  libraries(): CdjMediaLibrary[] {
    return [...this.entries.values()].filter((e) => e.state === "ready" && e.library).map((e) => e.library!);
  }

  prompts(): MediaPrompt[] {
    return [...this.entries.values()].filter((e) => e.prompt).map((e) => e.prompt!);
  }

  snapshot(): ProlinkSnapshot {
    const net = this.network;
    const ifaces = (this.opts.interfaces ?? listInterfaces)();
    return {
      enabled: this.settings.enabled,
      running: Boolean(net?.running),
      interfaceName: net?.iface?.name ?? null,
      address: net?.iface?.address ?? null,
      deviceNumber: net?.deviceNumber ?? null,
      players: (net?.players() ?? []).map(({ device, status }) => ({
        deviceNumber: device.deviceNumber,
        name: device.name,
        ip: device.ip,
        kind: device.deviceType === 1 ? "player" : device.deviceType === 2 ? "mixer" : "other",
        usb: status?.usb ?? "unknown",
        sd: status?.sd ?? "unknown",
      })),
      media: [...this.entries.values()].map((e) => ({
        sourceId: e.sourceId,
        origin: e.origin,
        mediaKey: e.mediaKey,
        sourceName: e.sourceName,
        deviceNumber: e.deviceNumber,
        playerName: e.playerName,
        slot: e.slot,
        name: e.mediaName,
        state: e.state,
        trackCount: e.trackCount ?? 0,
        playlistCount: e.library?.playlists.length ?? 0,
        kind: e.kind,
        error: e.error,
      })),
      prompts: this.prompts(),
      error: this.networkError ?? net?.lastError ?? null,
      interfaces: ifaces.map((i) => ({ name: i.name, address: i.address, netmask: i.netmask })),
      settings: this.settings,
    };
  }
}

export const localSourceId = (root: string): string => `local-${createHash("sha1").update(root).digest("hex").slice(0, 12)}`;

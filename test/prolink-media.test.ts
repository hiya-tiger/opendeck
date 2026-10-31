import assert from "node:assert/strict";
import dgram from "node:dgram";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPrompt, cdjMediaKey, decideMediaAction, forgetChoice, localMediaKey, promptMessage, rememberChoice } from "../src/main/prolink/prompt.ts";
import { LocalMediaReader, importMedia, metadataFromFilename, probeMedia, readCues } from "../src/main/prolink/importer.ts";
import { MediaManager } from "../src/main/prolink/manager.ts";
import { ProlinkNetwork } from "../src/main/prolink/network.ts";
import { buildCdjStatus, buildKeepalive, buildMediaResponse, parseAnnounce, parseMediaQuery, SLOT_USB, KIND_KEEPALIVE } from "../src/main/prolink/packets.ts";
import { cacheKey } from "../src/main/prolink/cache.ts";
import { diffVolumes, VolumeWatcher, type LocalVolume } from "../src/main/prolink/volumes.ts";
import { DEFAULT_PROLINK_SETTINGS, type CdjMediaLibrary, type MediaPrompt, type ProlinkSettings } from "../src/main/prolink/types.ts";
import { convertKey, mediaCrates, tracksFromMedia } from "../src/renderer/media/cdj.ts";
import { FakeNfsServer } from "./helpers/fake-nfs.ts";
import { anlzWithHotCues, sampleDatabase } from "./helpers/pdb-builder.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await wait(20);
  }
}

test("prompt decision: unknown drives always prompt; remembered choices decide", () => {
  const settings = { ...DEFAULT_PROLINK_SETTINGS, remembered: {} };
  const key = cdjMediaKey({ name: "DJ STICK", created: "2026-10-01", totalBytes: 64e9, trackCount: 412 });
  assert.equal(decideMediaAction(key, settings), "prompt");
  const notAlways = rememberChoice(settings, key, "add", false);
  assert.equal(notAlways, settings, "Add without Always remembers nothing");
  assert.equal(decideMediaAction(key, notAlways), "prompt");
  const always = rememberChoice(settings, key, "add", true);
  assert.equal(decideMediaAction(key, always), "import");
  assert.equal(decideMediaAction(cdjMediaKey({ name: "OTHER", totalBytes: 1 }), always), "prompt", "per drive");
  const ignore = rememberChoice(always, key, "ignore", true);
  assert.equal(decideMediaAction(key, ignore), "ignore");
  assert.equal(decideMediaAction(key, forgetChoice(ignore, key)), "prompt");
  assert.deepEqual(settings.remembered, {}, "inputs are not mutated");
  assert.equal(cdjMediaKey({ name: "dj stick ", created: "2026-10-01", totalBytes: 64e9, trackCount: 412 }), key, "case/whitespace insensitive");
  assert.equal(localMediaKey({ label: "X", serial: "ABC123" }), localMediaKey({ label: "Y", serial: "abc123" }), "serial wins over label");
});

test("prompt text", () => {
  assert.equal(promptMessage({ origin: "cdj", mediaName: "NAME", where: "CDJ 2", trackCount: 412 }), "USB drive 'NAME' found on CDJ 2 (412 tracks). Add it to your library?");
  assert.equal(promptMessage({ origin: "local", mediaName: "STICK", where: "this computer", trackCount: null }), "USB drive 'STICK' found on this computer. Add it to your library?");
  assert.equal(promptMessage({ origin: "cdj", mediaName: "", where: "CDJ 3", trackCount: 1, slot: "sd" }), "SD card (unnamed) found on CDJ 3 (1 track). Add it to your library?");
});

test("filename-derived metadata and key conversion", () => {
  assert.deepEqual(metadataFromFilename("Music/01 - Artist Name - Song Title.mp3"), { artist: "Artist Name", title: "Song Title" });
  assert.deepEqual(metadataFromFilename("just_a_tune.wav"), { artist: "", title: "just a tune" });
  assert.deepEqual(convertKey("Am"), { key: "A min", camelot: "8A" });
  assert.deepEqual(convertKey("F#"), { key: "F# maj", camelot: "2B" });
  assert.deepEqual(convertKey("Bbm"), { key: "A# min", camelot: "3A" });
  assert.deepEqual(convertKey("8A"), { key: "A min", camelot: "8A" });
  assert.deepEqual(convertKey(""), { key: "--", camelot: "--" });
  assert.notEqual(cacheKey({ deviceNumber: 2, slot: "usb", path: "a.mp3", size: 1 }), cacheKey({ deviceNumber: 2, slot: "usb", path: "a.mp3", size: 2 }));
});

test("volume diff detects plug and unplug", () => {
  const a: LocalVolume = { root: "/media/u/A", label: "A" };
  const b: LocalVolume = { root: "/media/u/B", label: "B" };
  const prev = new Map([[a.root, a]]);
  assert.deepEqual(diffVolumes(prev, [a, b]), { added: [b], removed: [] });
  assert.deepEqual(diffVolumes(prev, []), { added: [], removed: [a] });
});

async function makeDrive(withPdb: boolean): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "od-usb-"));
  await mkdir(path.join(root, "Contents", "Artist One"), { recursive: true });
  await writeFile(path.join(root, "Contents", "Artist One", "Opening Track.mp3"), Buffer.from("ID3-opening"));
  await writeFile(path.join(root, "Contents", "Artist One", "Closer.wav"), Buffer.from("RIFF-closer"));
  await mkdir(path.join(root, "Loose"), { recursive: true });
  await writeFile(path.join(root, "Loose", "DJ X - Tool.flac"), Buffer.from("fLaC"));
  await writeFile(path.join(root, "Loose", "._DJ X - Tool.flac"), Buffer.from("appledouble"));
  await writeFile(path.join(root, "notes.txt"), "not audio");
  if (withPdb) {
    await mkdir(path.join(root, "PIONEER", "rekordbox"), { recursive: true });
    await writeFile(path.join(root, "PIONEER", "rekordbox", "export.pdb"), sampleDatabase());
    await mkdir(path.join(root, "PIONEER", "USBANLZ", "P001", "00000001"), { recursive: true });
    await writeFile(path.join(root, "PIONEER", "USBANLZ", "P001", "00000001", "ANLZ0000.EXT"), anlzWithHotCues([{ hotCue: 1, timeMs: 1500, rgb: [255, 0, 0] }]));
  }
  return root;
}

test("local drive reader: rekordbox stick and plain folder stick; path confinement", async () => {
  const pdbRoot = await makeDrive(true);
  const plainRoot = await makeDrive(false);
  try {
    const reader = new LocalMediaReader(pdbRoot);
    assert.throws(() => reader.resolve("../../etc/passwd"), /escapes/);
    const probe = await probeMedia(reader);
    assert.equal(probe.kind, "rekordbox");
    const meta = { sourceId: "s1", origin: "local" as const, mediaKey: "k", sourceName: "USB · STICK", deviceNumber: 0, playerName: "", slot: "usb" as const, mediaName: "STICK" };
    const lib = await importMedia(reader, meta, probe);
    assert.equal(lib.kind, "rekordbox");
    assert.equal(lib.tracks.length, 3);
    const cues = await readCues(reader, lib.tracks[0].analyzePath);
    assert.deepEqual(cues, [{ index: 0, timeMs: 1500, loopEndMs: undefined, color: "#FF0000", name: undefined }]);

    const plain = await importMedia(new LocalMediaReader(plainRoot), { ...meta, sourceId: "s2" });
    assert.equal(plain.kind, "files");
    assert.deepEqual(plain.tracks.map((t) => t.path), ["Contents/Artist One/Closer.wav", "Contents/Artist One/Opening Track.mp3", "Loose/DJ X - Tool.flac"]);
    assert.equal(plain.tracks[2].artist, "DJ X");
    assert.deepEqual(plain.playlists.map((p) => p.path[0]), ["Contents", "Loose"]);
  } finally {
    await rm(pdbRoot, { recursive: true, force: true });
    await rm(plainRoot, { recursive: true, force: true });
  }
});

test("renderer conversion: source crate, playlist sub-crates, colours and keys", () => {
  const lib: CdjMediaLibrary = {
    sourceId: "cdj-2-usb",
    origin: "cdj",
    mediaKey: "k",
    sourceName: "CDJ 2 · USB · NAME",
    deviceNumber: 2,
    playerName: "CDJ-3000",
    slot: "usb",
    mediaName: "NAME",
    kind: "rekordbox",
    tracks: [
      { id: "pdb:1", title: "One", artist: "A", album: "", genre: "House", label: "", remixer: "", comment: "", bpm: 124, key: "Am", duration: 300, rating: 3, colorId: 5, path: "Contents/one.mp3", size: 10, fileType: "mp3", trackNumber: 0, year: 0, analyzePath: "" },
      { id: "pdb:2", title: "Two", artist: "", album: "", genre: "", label: "", remixer: "", comment: "", bpm: 0, key: "", duration: 0, rating: 0, colorId: 0, path: "Contents/two.mp3", size: 10, fileType: "mp3", trackNumber: 0, year: 0, analyzePath: "" },
    ],
    playlists: [{ path: ["Gigs", "Friday"], trackIds: ["pdb:2", "pdb:1"] }],
    importedAt: 0,
    warnings: [],
  };
  const tracks = tracksFromMedia(lib);
  assert.equal(tracks[0].name, "A - One");
  assert.equal(tracks[0].source, "removable");
  assert.equal(tracks[0].crate, "CDJ 2 · USB · NAME");
  assert.deepEqual(tracks[0].crates, ["CDJ 2 · USB · NAME", "CDJ 2 · USB · NAME / Gigs / Friday"]);
  assert.equal(tracks[0].camelot, "8A");
  assert.equal(tracks[0].color, "#99FF99");
  assert.deepEqual(tracks[0].media, { sourceId: "cdj-2-usb", trackId: "pdb:1", origin: "cdj", rating: 3 });
  assert.equal(tracks[1].missing, false);
  assert.deepEqual(mediaCrates(lib), ["CDJ 2 · USB · NAME", "CDJ 2 · USB · NAME / Gigs / Friday"]);
});

class ListScanner {
  volumes: LocalVolume[] = [];
  async scan(): Promise<LocalVolume[]> {
    return this.volumes;
  }
}

test("local USB drive: prompt, Not now, Always add on re-plug, play from drive, eject", async () => {
  const root = await makeDrive(true);
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "od-cache-"));
  const scanner = new ListScanner();
  let watcher: VolumeWatcher | null = null;
  let saved: ProlinkSettings | null = null;
  const manager = new MediaManager({
    settings: { enabled: false, localDrives: true },
    cacheDir,
    saveSettings: (s) => {
      saved = s;
    },
    createVolumes: () => (watcher = new VolumeWatcher(scanner, 60_000)),
    interfaces: () => [],
  });
  const prompts: MediaPrompt[] = [];
  const libraries: CdjMediaLibrary[] = [];
  const removed: string[] = [];
  manager.on("prompt", (p) => prompts.push(p));
  manager.on("library", (l) => libraries.push(l));
  manager.on("removed", (id) => removed.push(id));
  try {
    await manager.start();
    const vol = { root, label: "STICK", totalBytes: 1000 };
    scanner.volumes = [vol];
    await watcher!.rescan();
    const prompt = await until(() => prompts[0]);
    assert.equal(prompt.message, "USB drive 'STICK' found on this computer (3 tracks). Add it to your library?");
    assert.equal(prompt.sourceName, "USB · STICK");
    assert.equal(libraries.length, 0, "nothing imported before the user answers");
    assert.deepEqual(manager.prompts().map((p) => p.sourceId), [prompt.sourceId]);

    assert.deepEqual(await manager.respond(prompt.sourceId, "ignore", false), { ok: true });
    assert.equal(libraries.length, 0);
    assert.equal(manager.snapshot().media[0].state, "ignored");

    // Unplug and plug back: asks again because "Not now" was not remembered.
    scanner.volumes = [];
    await watcher!.rescan();
    scanner.volumes = [vol];
    await watcher!.rescan();
    await until(() => prompts.length === 2);
    assert.deepEqual(await manager.respond(prompts[1].sourceId, "add", true), { ok: true });
    assert.equal(libraries.length, 1);
    assert.equal(saved!.remembered[localMediaKey(vol)], "add");
    const lib = libraries[0];
    assert.equal(lib.tracks.length, 3);
    assert.deepEqual(lib.playlists.map((p) => p.path.join("/")).sort(), ["Gigs/Friday", "Warmup"]);

    const loaded = await manager.loadTrack(lib.sourceId, "pdb:1");
    assert.equal(loaded.ok, true);
    assert.equal(Buffer.from(loaded.bytes!).toString(), "ID3-opening");
    assert.equal(loaded.cues![0].index, 0);
    assert.deepEqual(await readdir(cacheDir), [], "local drives play directly, no cache copy");
    assert.equal((await manager.loadTrack(lib.sourceId, "fs:../../secret")).ok, false);

    // Eject: source removed. Re-plug: remembered Always imports with no prompt.
    scanner.volumes = [];
    await watcher!.rescan();
    assert.deepEqual(removed, [lib.sourceId]);
    assert.equal((await manager.loadTrack(lib.sourceId, "pdb:1")).ok, false);
    scanner.volumes = [vol];
    await watcher!.rescan();
    await until(() => libraries.length === 2);
    assert.equal(prompts.length, 2, "no third prompt");
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("CDJ end to end: discovery, USB mount, media query, prompt, import over NFS, cached fetch, unmount", async () => {
  const audio = Buffer.alloc(30_000, 7);
  const nfs = new FakeNfsServer({
    exports: {
      "/C/": {
        "PIONEER/rekordbox/export.pdb": sampleDatabase(),
        "PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT": anlzWithHotCues([{ hotCue: 2, timeMs: 64_000 }]),
        "Contents/Artist One/Opening Track.mp3": audio,
        "Contents/Artist Two/Ünïcödé Dub.flac": Buffer.from("flac"),
        "Contents/Artist One/Closer.wav": Buffer.from("wav"),
      },
    },
  });
  const nfsPort = await nfs.start();
  const cdj = dgram.createSocket("udp4");
  await new Promise<void>((r) => cdj.bind(0, "127.0.0.1", () => r()));
  const cdjPort = cdj.address().port;
  const heard: number[] = [];
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "od-cache-"));
  const lo = [{ name: "test-lo", address: "127.0.0.1", netmask: "255.0.0.0", mac: "02:00:00:00:00:01" }];
  let net: ProlinkNetwork | null = null;
  const manager = new MediaManager({
    settings: { enabled: true, localDrives: false, remembered: {} },
    cacheDir,
    nfsOptions: { portmapPort: nfsPort, timeoutMs: 200 },
    interfaces: () => lo,
    createNetwork: () =>
      (net = new ProlinkNetwork({
        announcePort: 0,
        statusPort: 0,
        peerAnnouncePort: cdjPort,
        peerStatusPort: cdjPort,
        broadcastOverride: "127.0.0.1",
        keepaliveMs: 50,
        interfaces: () => lo,
      })),
  });
  const prompts: MediaPrompt[] = [];
  const libraries: CdjMediaLibrary[] = [];
  const removed: string[] = [];
  manager.on("prompt", (p) => prompts.push(p));
  manager.on("library", (l) => libraries.push(l));
  manager.on("removed", (id) => removed.push(id));
  // The fake CDJ answers media queries and records our keep-alives.
  cdj.on("message", (msg) => {
    const ka = parseAnnounce(msg);
    if (ka && ka.kind === KIND_KEEPALIVE && ka.deviceNumber) heard.push(ka.deviceNumber);
    const q = parseMediaQuery(msg);
    if (q && q.slot === SLOT_USB) {
      const resp = buildMediaResponse({ playerName: "CDJ-3000", deviceNumber: 2, slot: SLOT_USB, name: "NAME", created: "2026-10-01", trackCount: 3, trackType: 1, playlistCount: 2, totalBytes: 32e9 });
      cdj.send(resp, net!.ports.status, "127.0.0.1");
    }
  });
  try {
    await manager.start();
    const ports = net!.ports;
    const keepalive = buildKeepalive({ name: "CDJ-3000", deviceNumber: 2, mac: "02:00:00:00:00:02", ip: "127.0.0.1" });
    const ka = setInterval(() => cdj.send(keepalive, ports.announce, "127.0.0.1"), 100);
    try {
      cdj.send(keepalive, ports.announce, "127.0.0.1");
      await until(() => manager.snapshot().players.length === 1);
      const snap = manager.snapshot();
      assert.equal(snap.interfaceName, "test-lo");
      assert.equal(snap.deviceNumber, 1, "virtual player takes the free number 1");
      await until(() => heard.includes(1));

      cdj.send(buildCdjStatus({ name: "CDJ-3000", deviceNumber: 2, usb: 0x04 }), ports.status, "127.0.0.1");
      await wait(50);
      cdj.send(buildCdjStatus({ name: "CDJ-3000", deviceNumber: 2, usb: 0x00 }), ports.status, "127.0.0.1");
      const prompt = await until(() => prompts[0]);
      assert.equal(prompt.message, "USB drive 'NAME' found on CDJ 2 (3 tracks). Add it to your library?");
      assert.equal(prompt.sourceName, "CDJ 2 · USB · NAME");
      assert.equal(libraries.length, 0, "no automatic import");

      assert.deepEqual(await manager.respond(prompt.sourceId, "add", false), { ok: true });
      const lib = libraries[0];
      assert.equal(lib.sourceId, "cdj-2-usb");
      assert.equal(lib.tracks.length, 3);
      assert.equal(lib.tracks[1].title, "Ünïcödé Dub ☂");
      assert.equal(lib.tracks[1].path, "Contents/Artist Two/Ünïcödé Dub.flac");
      assert.deepEqual(mediaCrates(lib), ["CDJ 2 · USB · NAME", "CDJ 2 · USB · NAME / Warmup", "CDJ 2 · USB · NAME / Gigs / Friday"]);
      assert.deepEqual(manager.settings.remembered, {}, "Add without Always is not remembered");

      const progress: number[] = [];
      manager.on("x", () => undefined);
      const first = await manager.loadTrack(lib.sourceId, "pdb:1", (p) => progress.push(p.done));
      assert.equal(first.ok, true, first.error);
      assert.ok(Buffer.from(first.bytes!).equals(audio));
      assert.equal(progress.at(-1), audio.length);
      assert.deepEqual(first.cues, [{ index: 1, timeMs: 64000, loopEndMs: undefined, color: undefined, name: undefined }]);
      assert.equal((await readdir(cacheDir)).length, 1, "fetched into cdj-cache");
      const reads = nfs.calls.filter((c) => c.proc === 6).length;
      const again = await manager.loadTrack(lib.sourceId, "pdb:1");
      assert.ok(Buffer.from(again.bytes!).equals(audio));
      const audioReads = nfs.calls.filter((c) => c.proc === 6).length - reads;
      assert.ok(audioReads <= 2, "second load served from the cache (only the small ANLZ file is re-read)");

      cdj.send(buildCdjStatus({ name: "CDJ-3000", deviceNumber: 2, usb: 0x02 }), ports.status, "127.0.0.1");
      await until(() => removed.length === 1);
      assert.deepEqual(removed, ["cdj-2-usb"]);
    } finally {
      clearInterval(ka);
    }
  } finally {
    await manager.stop();
    cdj.close();
    nfs.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("virtual player yields its number on a conflict and devices expire", async () => {
  const lo = [{ name: "test-lo", address: "127.0.0.1", netmask: "255.0.0.0", mac: "02:00:00:00:00:01" }];
  const net = new ProlinkNetwork({ announcePort: 0, statusPort: 0, peerAnnouncePort: 9, broadcastOverride: "127.0.0.1", keepaliveMs: 1000, timeoutMs: 300, interfaces: () => lo, interface: "test-lo" });
  const sock = dgram.createSocket("udp4");
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
  try {
    await net.start();
    assert.equal(net.deviceNumber, 1);
    const { buildConflict } = await import("../src/main/prolink/packets.ts");
    sock.send(buildConflict("CDJ-2000", 1, "127.0.0.1"), net.ports.announce, "127.0.0.1");
    await until(() => net.deviceNumber === 2);
    sock.send(buildKeepalive({ name: "CDJ-2000", deviceNumber: 3, mac: "0:0:0:0:0:3", ip: "127.0.0.1" }), net.ports.announce, "127.0.0.1");
    await until(() => net.players().length === 1);
    const lost = once(net, "device-lost");
    await lost;
    assert.equal(net.players().length, 0);
  } finally {
    await net.stop();
    sock.close();
  }
});

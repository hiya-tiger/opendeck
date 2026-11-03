import assert from "node:assert/strict";
import { mkdtempSync, promises as fs, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContentCache, DEFAULT_CACHE_LIMIT, MIN_CACHE_LIMIT, type CachedAnalysis } from "../src/main/cache/content-cache.ts";
import { PartialStore, decodeChunk, encodeChunk } from "../src/main/stems/partial.ts";
import { runStemJob, type StemJob } from "../src/main/stems/job-runner.ts";
import { PART_ORDER, type StemPart } from "../src/main/stems/core.ts";
import { StemHost, type WorkerHandle } from "../src/main/stems/host.ts";
import type { HostMessage, WorkerMessage } from "../src/main/stems/protocol.ts";
import {
  CLOSE_DIALOG,
  actionFromAnswer,
  backgroundThreads,
  decideClose,
  doneNotice,
  overallPercent,
  resolveClose,
  trayMenuModel,
} from "../src/main/background/close-policy.ts";
import { normalizeSettings, SessionFile, SettingsStore } from "../src/main/app-settings.ts";
import { resolveTrackFile } from "../src/main/session-files.ts";
import { contentStemDir, cacheCandidates } from "../src/main/separation.ts";
import {
  keyShiftDelta,
  normaliseSession,
  restoreOrder,
  restorePosition,
  resumeDecision,
  sessionSummary,
} from "../src/renderer/session/session-state.ts";

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), "od-resume-"));
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const analysis = (bpm = 124): CachedAnalysis => ({
  bpm,
  beatPhase: 0.12,
  key: "A minor",
  camelot: "8A",
  duration: 201.5,
  peaks: Float32Array.from({ length: 2000 }, (_, i) => (i % 50) / 50),
  bands: { low: new Float32Array([0.1, 0.2]), mid: new Float32Array([0.3, 0.4]), high: new Float32Array([0.5, 0.6]) },
});

/* -------------------------------------------------------- analysis cache */

test("analysis cache: miss, then hit with identical values after put", async () => {
  const cache = new ContentCache({ root: tmp() });
  assert.equal(await cache.getAnalysis(HASH_A, "v1"), null, "cold cache misses");
  await cache.putAnalysis(HASH_A, "v1", analysis());
  const hit = await cache.getAnalysis(HASH_A, "v1");
  assert.ok(hit, "hit after put");
  assert.equal(hit.bpm, 124);
  assert.equal(hit.key, "A minor");
  assert.equal(hit.camelot, "8A");
  assert.equal(hit.beatPhase, 0.12);
  assert.deepEqual(Array.from(hit.peaks), Array.from(analysis().peaks));
  assert.deepEqual(Array.from(hit.bands!.high), [0.5, 0.6].map((v) => Math.fround(v)));
});

test("analysis cache: another file hash or algorithm version is a miss", async () => {
  const cache = new ContentCache({ root: tmp() });
  await cache.putAnalysis(HASH_A, "v1", analysis());
  assert.equal(await cache.getAnalysis(HASH_B, "v1"), null, "other content");
  assert.equal(await cache.getAnalysis(HASH_A, "v2"), null, "other version");
});

test("analysis cache: a truncated waveform file is a miss, not garbage", async () => {
  const cache = new ContentCache({ root: tmp() });
  const dir = await cache.putAnalysis(HASH_A, "v1", analysis());
  await fs.writeFile(path.join(dir, "peaks.f32"), Buffer.alloc(12));
  assert.equal(await cache.getAnalysis(HASH_A, "v1"), null);
});

test("cache dirs are content-addressed: same hash+model+version, same dir; version changes it", () => {
  const cache = new ContentCache({ root: "/r" });
  assert.equal(cache.dirFor("stems", HASH_A, "htdemucs", "1"), cache.dirFor("stems", HASH_A.toUpperCase(), "htdemucs", "1"));
  assert.notEqual(cache.dirFor("stems", HASH_A, "htdemucs", "1"), cache.dirFor("stems", HASH_A, "htdemucs", "2"));
  assert.notEqual(cache.dirFor("stems", HASH_A, "htdemucs", "1"), cache.dirFor("analysis", HASH_A, "htdemucs", "1"));
  assert.ok(cache.dirFor("stems", HASH_A, "m", "1").startsWith(path.join("/r", "stems", "aa")));
});

test("stems: new caches go to the content cache in userData, legacy locations are still read", () => {
  const appData = "/u";
  const candidates = cacheCandidates("/music/set/track.mp3", HASH_A, appData);
  assert.equal(candidates[0], contentStemDir(HASH_A, appData));
  assert.ok(candidates[0].startsWith(path.join("/u", "cache", "stems")));
  assert.ok(candidates.some((dir) => dir.startsWith(path.join("/music/set", ".opendeck-stems"))), "next-to-track cache still found");
  assert.ok(candidates.some((dir) => dir.startsWith(path.join("/u", "stems", ".opendeck-stems"))), "old userData cache still found");
});

/* -------------------------------------------------------------- eviction */

const fakeEntry = async (cache: ContentCache, hash: string, bytes: number, lastAccess: number): Promise<string> => {
  const dir = cache.dirFor("stems", hash, "m", "1");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "drums.i16"), Buffer.alloc(bytes));
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ kind: "stems", hash, model: "m", version: "1", createdAt: "", lastAccess }));
  return dir;
};

test("eviction removes least-recently-used entries until under the limit, never pinned ones", async () => {
  const root = tmp();
  const cache = new ContentCache({ root, limit: MIN_CACHE_LIMIT });
  const MB = 1024 * 1024;
  const old = await fakeEntry(cache, "1".repeat(64), 120 * MB, 1000);
  const pinned = await fakeEntry(cache, "2".repeat(64), 120 * MB, 500); // oldest, but on a deck
  const fresh = await fakeEntry(cache, "3".repeat(64), 120 * MB, 9000);
  const removed = await cache.evict(["2".repeat(64)]);
  assert.deepEqual(removed.map((entry) => entry.dir), [old]);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(pinned), true, "pinned entry kept although it is the oldest");
  assert.equal(existsSync(fresh), true);
  const usage = await cache.usage();
  assert.ok(usage.bytes <= usage.limit + 1024);
  assert.equal(usage.byKind.stems.entries, 2);
});

test("eviction does nothing under the limit; a hit refreshes an entry's age", async () => {
  let now = 1000;
  const cache = new ContentCache({ root: tmp(), now: () => now });
  await cache.putAnalysis(HASH_A, "v1", analysis());
  assert.deepEqual(await cache.evict(), []);
  now = 5000;
  await cache.getAnalysis(HASH_A, "v1");
  const [entry] = await cache.entries();
  assert.equal(entry.lastAccess, 5000);
});

test("clear cache removes everything except what is in use", async () => {
  const cache = new ContentCache({ root: tmp() });
  await cache.putAnalysis(HASH_A, "v1", analysis());
  await cache.putAnalysis(HASH_B, "v1", analysis());
  const result = await cache.clear([HASH_B]);
  assert.equal(result.removed, 1);
  assert.equal(result.kept, 1);
  assert.equal(await cache.getAnalysis(HASH_A, "v1"), null);
  assert.ok(await cache.getAnalysis(HASH_B, "v1"));
});

test("cache limit is clamped to a sane minimum and defaults", () => {
  assert.equal(ContentCache.clampLimit(10), MIN_CACHE_LIMIT);
  assert.equal(ContentCache.clampLimit(Number.NaN), DEFAULT_CACHE_LIMIT);
  assert.equal(normalizeSettings({ cacheLimitBytes: -5 }).cacheLimitBytes, DEFAULT_CACHE_LIMIT);
});

/* ----------------------------------------------------- moved/missing files */

test("moved or missing files: found in place, found where the same content was seen, or missing", async () => {
  const root = tmp();
  const cache = new ContentCache({ root: path.join(root, "cache") });
  const here = path.join(root, "a", "track.mp3");
  mkdirSync(path.dirname(here), { recursive: true });
  writeFileSync(here, "x");
  assert.deepEqual(await resolveTrackFile({ path: here, hash: HASH_A }, cache), { status: "found", path: here });

  const moved = path.join(root, "b", "renamed.mp3");
  mkdirSync(path.dirname(moved), { recursive: true });
  writeFileSync(moved, "x");
  await cache.recordPath(HASH_A, moved);
  const gone = path.join(root, "old", "track.mp3");
  assert.deepEqual(await resolveTrackFile({ path: gone, hash: HASH_A }, cache), { status: "moved", path: moved, from: gone });
  assert.deepEqual(await resolveTrackFile({ path: gone, hash: HASH_B }, cache), { status: "missing", from: gone });
  assert.equal((await resolveTrackFile({ path: "/etc/passwd" }, cache)).status, "missing", "non-media paths are never read");
});

/* ------------------------------------------------- partial stem resume */

const FRAME = 4096;
const OVERLAP = 1024;
const WEIGHTS = [0.1, 0.2, 0.3, 0.4];

/** Deterministic stand-in for htdemucs: each part is the input scaled. */
const fakeModel = (counter: { runs: number }) => async (input: Float32Array): Promise<Float32Array> => {
  counter.runs += 1;
  const out = new Float32Array(PART_ORDER.length * 2 * FRAME);
  for (let part = 0; part < PART_ORDER.length; part += 1) {
    for (let ch = 0; ch < 2; ch += 1) {
      const base = part * 2 * FRAME + ch * FRAME;
      for (let i = 0; i < FRAME; i += 1) out[base + i] = input[ch * FRAME + i] * WEIGHTS[part];
    }
  }
  return out;
};

const makeJob = (cacheDir: string, id = "j1"): StemJob => {
  const n = 20000;
  const left = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 37) * 0.8);
  const right = Float32Array.from({ length: n }, (_, i) => Math.cos(i / 53) * 0.7);
  return { type: "job", id, hash: HASH_A, sampleRate: 44100, left, right, focusFrame: 9000, cacheDir };
};

const runWith = async (job: StemJob, options: { cancelAfter?: number } = {}) => {
  const counter = { runs: 0 };
  const sent: WorkerMessage[] = [];
  let written: Record<StemPart, Int16Array> | null = null;
  const outcome = await runStemJob(job, {
    runChunk: fakeModel(counter),
    send: (message) => sent.push(message),
    isCancelled: () => options.cancelAfter !== undefined && counter.runs >= options.cancelAfter,
    writeCache: async (dir, _hash, _frames, parts) => {
      // like separation.writeCache: the entry dir is replaced, partial/ included
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      written = parts;
      return { dir };
    },
    model: { id: "fake", version: "1" },
    overlap: OVERLAP,
    frameCount: FRAME,
    modelRate: 44100,
  });
  return { outcome, counter, sent, written: written as Record<StemPart, Int16Array> | null };
};

test("partial chunk encoding round-trips within one int16 step of its own peak", () => {
  const data = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 1.7);
  const { scale, bytes } = encodeChunk(data);
  const back = decodeChunk(bytes, scale);
  for (let i = 0; i < data.length; i += 1) assert.ok(Math.abs(back[i] - data[i]) <= scale / 32767);
});

test("resume after a partial run: only the missing chunks go through the model, output matches", async () => {
  const reference = await runWith(makeJob(path.join(tmp(), "entry")));
  assert.equal(reference.outcome.status, "done");
  const total = reference.counter.runs;
  assert.ok(total >= 6, `track splits into several chunks (${total})`);

  const dir = path.join(tmp(), "entry");
  const first = await runWith(makeJob(dir), { cancelAfter: 3 });
  assert.equal(first.outcome.status, "cancelled");
  assert.equal(first.outcome.computed, 3);
  const store = await PartialStore.open(dir, { model: "fake", modelVersion: "1", hash: HASH_A, frames: 20000, frameCount: FRAME, overlap: OVERLAP, chunks: total });
  assert.equal(store.doneIndices.length, 3, "three finished chunks on disk");

  const second = await runWith(makeJob(dir, "j2"));
  assert.equal(second.outcome.status, "done");
  assert.equal(second.outcome.resumed, 3, "continued from the finished chunks");
  assert.equal(second.counter.runs, total - 3, "the model ran only the rest");
  assert.ok(second.sent.some((m) => m.type === "progress" && /Resumed 3 of/.test(m.detail)));
  assert.equal(second.sent.filter((m) => m.type === "region").length, total, "every chunk still reaches the deck");
  for (const part of PART_ORDER) {
    const a = reference.written![part];
    const b = second.written![part];
    assert.equal(a.length, b.length);
    let worst = 0;
    for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    assert.ok(worst <= 2, `${part}: resumed output within 2 LSB of an uninterrupted run (got ${worst})`);
  }
  assert.equal(existsSync(path.join(dir, "partial")), false, "partial work removed once the cache is complete");
});

test("partial work for another model version or track length is thrown away", async () => {
  const dir = path.join(tmp(), "entry");
  await runWith(makeJob(dir), { cancelAfter: 2 });
  const other = await PartialStore.open(dir, { model: "fake", modelVersion: "2", hash: HASH_A, frames: 20000, frameCount: FRAME, overlap: OVERLAP, chunks: 7 });
  assert.deepEqual(other.doneIndices, []);
  const again = await runWith(makeJob(dir));
  assert.equal(again.outcome.resumed, 0, "nothing resumed after the mismatch wiped it");
});

test("a chunk listed in progress.json but missing on disk is recomputed", async () => {
  const dir = path.join(tmp(), "entry");
  await runWith(makeJob(dir), { cancelAfter: 3 });
  const files = (await fs.readdir(path.join(dir, "partial"))).filter((f) => f.endsWith(".i16"));
  await fs.rm(path.join(dir, "partial", files[0]));
  const resumed = await runWith(makeJob(dir));
  assert.equal(resumed.outcome.resumed, 2);
  assert.equal(resumed.outcome.status, "done");
});

/* --------------------------------------------- close dialog + tray model */

test("close: nothing separating closes normally without asking", async () => {
  let asked = 0;
  const { result } = await resolveClose({ busy: false, preference: "ask", quitConfirmed: false }, async () => {
    asked += 1;
    return { response: 0, checkboxChecked: false };
  });
  assert.deepEqual(result, { action: "close" });
  assert.equal(asked, 0);
});

test("close while separating asks; Keep going in tray / Quit now / Remember my choice", async () => {
  const busy = { busy: true, preference: "ask" as const, quitConfirmed: false };
  const tray = await resolveClose(busy, async () => ({ response: 0, checkboxChecked: false }));
  assert.deepEqual(tray, { result: { action: "tray", remember: false }, savePreference: null });
  const quit = await resolveClose(busy, async () => ({ response: 1, checkboxChecked: false }));
  assert.deepEqual(quit, { result: { action: "quit", remember: false }, savePreference: null });
  const trayRemember = await resolveClose(busy, async () => ({ response: 0, checkboxChecked: true }));
  assert.equal(trayRemember.savePreference, "tray");
  const quitRemember = await resolveClose(busy, async () => ({ response: 1, checkboxChecked: true }));
  assert.equal(quitRemember.savePreference, "quit");
  assert.equal(CLOSE_DIALOG.message, "Keep separating stems in the background?");
  assert.deepEqual([...CLOSE_DIALOG.buttons], ["Keep going in tray", "Quit now"]);
  assert.equal(CLOSE_DIALOG.checkboxLabel, "Remember my choice");
  assert.equal(CLOSE_DIALOG.buttons[CLOSE_DIALOG.cancelId], "Keep going in tray", "Escape never throws work away");
});

test("close: a remembered choice is applied without asking; a confirmed quit always closes", async () => {
  const never = async (): Promise<never> => {
    throw new Error("should not ask");
  };
  assert.deepEqual((await resolveClose({ busy: true, preference: "tray", quitConfirmed: false }, never)).result, { action: "tray", remember: true });
  assert.deepEqual((await resolveClose({ busy: true, preference: "quit", quitConfirmed: false }, never)).result, { action: "quit", remember: true });
  assert.deepEqual(decideClose({ busy: true, preference: "ask", quitConfirmed: true }), { action: "close" });
  assert.equal(decideClose({ busy: true, preference: "ask", quitConfirmed: false }), null);
  assert.deepEqual(actionFromAnswer({ response: 7, checkboxChecked: false }), { action: "tray", remember: false });
});

test("close preference and always-resume persist through the settings file", async () => {
  const dir = tmp();
  const store = new SettingsStore(dir);
  assert.equal((await store.get()).closeWhileSeparating, "ask");
  await store.update({ closeWhileSeparating: "tray", alwaysResume: true });
  const reread = await new SettingsStore(dir).get();
  assert.equal(reread.closeWhileSeparating, "tray");
  assert.equal(reread.alwaysResume, true);
  assert.equal(normalizeSettings({ closeWhileSeparating: "explode" }).closeWhileSeparating, "ask");
});

test("tray menu shows progress with Open, Pause/Resume and Quit", () => {
  const running = trayMenuModel({ jobs: [{ title: "Track One", percent: 40, running: true }, { title: "Track Two", percent: 0, running: false }], paused: false });
  assert.equal(running[0].label, "Stems separating: 2 tracks, 20%");
  assert.deepEqual(running.filter((i) => i.enabled).map((i) => i.id), ["open", "pause", "quit"]);
  assert.equal(running.find((i) => i.id === "pause")!.label, "Pause separating");
  const paused = trayMenuModel({ jobs: [{ title: "Track One", percent: 40, running: true }], paused: true });
  assert.equal(paused.find((i) => i.id === "pause")!.label, "Resume separating");
  assert.match(paused[0].label, /paused/);
  const done = trayMenuModel({ jobs: [], paused: false });
  assert.equal(done[0].label, "Stems: all done");
  assert.equal(done.find((i) => i.id === "pause")!.enabled, false);
  assert.equal(overallPercent({ jobs: [], paused: false }), 100);
  assert.equal(backgroundThreads(8), 4);
  assert.equal(backgroundThreads(1), 1);
  assert.match(doneNotice([{ title: "Track One", ok: true }]).body, /Track One is separated/);
  assert.equal(doneNotice([{ title: "x", ok: false }]).title, "Stem separation stopped");
});

class FakeWorker implements WorkerHandle {
  sent: HostMessage[] = [];
  private message: ((m: WorkerMessage) => void) | null = null;
  postMessage(message: HostMessage): void {
    this.sent.push(message);
  }
  onMessage(handler: (m: WorkerMessage) => void): void {
    this.message = handler;
  }
  onExit(): void {}
  kill(): void {}
  pid(): number {
    return 4242;
  }
  emit(message: WorkerMessage): void {
    this.message?.(message);
  }
}

test("host: busy while a job is queued, pause/background reach the worker, done is reported", async () => {
  const worker = new FakeWorker();
  const host = new StemHost(() => worker, { modelPath: () => "/m", statePath: "/s.json" });
  const activity: number[] = [];
  host.onActivity((a) => activity.push(a.jobs.length));
  const done: string[] = [];
  host.onJobDone((job) => done.push(`${job.title}:${job.ok}`));
  assert.equal(host.busy, false);
  const result = host.run(
    { hash: HASH_A, sampleRate: 48000, left: new Float32Array(4), right: new Float32Array(4), cacheDir: "/c", title: "Track One" },
    { deck: "A", onRegion: () => undefined, onProgress: () => undefined },
  );
  assert.equal(host.busy, true);
  assert.deepEqual(host.activeHashes, [HASH_A]);
  host.setPaused(true);
  host.setBackground(true, 2);
  assert.deepEqual(worker.sent.filter((m) => m.type === "pause"), [{ type: "pause", paused: true }]);
  assert.deepEqual(worker.sent.filter((m) => m.type === "background"), [{ type: "background", on: true, threads: 2 }]);
  assert.equal(host.workerPid, 4242);
  const id = (worker.sent.find((m) => m.type === "job") as { id: string }).id;
  worker.emit({ type: "progress", id, stage: "separate", percent: 50, detail: "Chunk 1 of 2" });
  assert.equal(host.activity().jobs[0].percent, 50);
  assert.equal(host.activity().paused, true);
  worker.emit({ type: "done", id, manifest: { hash: HASH_A }, ms: 1, provider: "cpu", firstRegionMs: 1 });
  await result;
  await tick();
  assert.equal(host.busy, false);
  assert.deepEqual(done, ["Track One:true"]);
  assert.equal(activity.at(-1), 0);
});

/* ------------------------------------------------------- session snapshot */

const savedSession = {
  version: 1,
  savedAt: "2026-11-03T19:00:00.000Z",
  fourDecks: false,
  decks: [
    {
      deck: "B",
      path: "/music/two.mp3",
      name: "Two.mp3",
      hash: HASH_B,
      position: 400,
      cuePoint: 12.5,
      hotCues: [{ time: 30, color: "#CC0000", name: "drop" }],
      loop: { start: 64, end: 72, active: true, beats: 4 },
      savedLoops: [],
      tempoPercent: 2.5,
      pitchRange: 8,
      keylock: true,
      keyShift: -2,
      quantize: true,
      eq: { high: -3, mid: 0, low: -24 },
      trim: 1.1,
      fx: { type: "echo", wet: 0.4, division: "1/2" },
    },
    { deck: "A", path: "/music/one.mp3", name: "One.mp3", hash: HASH_A, position: 61.2 },
    { deck: "Z", path: "/x.mp3", hash: HASH_A },
    { deck: "C", path: "/x.mp3", hash: "not-a-hash" },
  ],
  mixer: { crossfader: 0.3, curve: "cut", reverse: false, master: 0.9, aux: 0.5, channels: { A: 0.8, B: 1 } },
  library: { view: "playlist:p1", filter: "house", sortKey: "bpm", sortDirection: "desc", colorFilter: "" },
};

test("session snapshot: invalid decks dropped, values kept, restore order A..D", () => {
  const session = normaliseSession(savedSession)!;
  assert.ok(session);
  assert.deepEqual(session.decks.map((d) => d.deck), ["B", "A"]);
  assert.deepEqual(restoreOrder(session).map((d) => d.deck), ["A", "B"]);
  const b = session.decks[0];
  assert.equal(b.tempoPercent, 2.5);
  assert.equal(b.keyShift, -2);
  assert.equal(b.keylock, true);
  assert.equal(b.fx.type, "echo");
  assert.equal(b.hotCues[0]?.name, "drop");
  assert.deepEqual(b.loop, { start: 64, end: 72, active: true, beats: 4 });
  assert.equal(session.mixer.curve, "cut");
  assert.equal(session.library.sortDirection, "desc");
  assert.equal(sessionSummary(session), "B: Two · A: One");
  assert.equal(normaliseSession({ ...savedSession, version: 99 }), null);
  assert.equal(normaliseSession("nonsense"), null);
});

test("resume decision: none without decks, ask by default, auto with always-resume", () => {
  const session = normaliseSession(savedSession);
  assert.equal(resumeDecision(session, { alwaysResume: false }), "ask");
  assert.equal(resumeDecision(session, { alwaysResume: true }), "auto");
  assert.equal(resumeDecision(normaliseSession({ ...savedSession, decks: [] }), { alwaysResume: true }), "none");
  assert.equal(resumeDecision(null, null), "none");
});

test("restored playhead is clamped into the track and into an active loop", () => {
  const session = normaliseSession(savedSession)!;
  const [b, a] = session.decks;
  assert.equal(restorePosition(a, 300), 61.2);
  assert.equal(restorePosition(a, 30), 30 - 0.05, "shorter file than before");
  assert.equal(restorePosition(b, 600), 72, "inside the active loop");
  assert.equal(restorePosition(a, 0), 0);
  assert.equal(keyShiftDelta(1, -2), -3);
});

test("session file: atomic write and read back; oversized sessions are refused", async () => {
  const dir = tmp();
  const file = new SessionFile(dir);
  assert.equal(await file.read(), null);
  assert.equal(await file.write(savedSession), true);
  assert.deepEqual(await file.read(), savedSession);
  assert.equal(await file.write({ blob: "x".repeat(600 * 1024) }), false);
  assert.deepEqual(await file.read(), savedSession, "previous session kept");
});

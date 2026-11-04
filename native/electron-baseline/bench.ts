// Today's Electron build, measured with the app's own code paths, in Electron 44's renderer:
//  * decode: AudioContext.decodeAudioData (what deck.ts / app.ts use) on the committed fixtures
//  * stretch: the shipping signalsmith-stretch 1.3.2 WASM AudioWorklet in an OfflineAudioContext
//  * library: trackFromCrate + filterTracks / sortTracks / evaluateLivePlaylist + the
//    localStorage JSON meta persistence that src/renderer/media/library.ts does
//  * render: the app's ZoomWaveform + Waveform (overview) canvases and the CSS-rotated vinyl
//    disc (its jog), N decks, per-frame script time and rAF interval
// Every number is printed as `RESULT {json}` through console.log; main.cjs forwards it.
import SignalsmithStretch from "signalsmith-stretch";
import { ZoomWaveform, Waveform } from "../../src/renderer/media/waveform.ts";
import { trackFromCrate, type Track } from "../../src/renderer/media/library.ts";
import { filterTracks, sortTracks, evaluateLivePlaylist } from "../../src/renderer/media/library-ux.ts";

const RUNS = 5;
const out = (o: Record<string, unknown>) => console.log("RESULT " + JSON.stringify(o));
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.round((s.length - 1) * p)];
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const params = new URLSearchParams(location.search);

async function benchDecode(base: string, files: string[]) {
  for (const f of files) {
    const buf = await (await fetch(base + "/" + encodeURIComponent(f))).arrayBuffer();
    const ctx = new OfflineAudioContext(2, 1, 44100);
    try {
      await ctx.decodeAudioData(buf.slice(0));
    } catch (e) {
      out({ kind: "decode_electron", file: f, ok: false, error: String(e) });
      continue;
    }
    const times: number[] = [];
    let frames = 0;
    let rate = 0;
    for (let i = 0; i < RUNS; i += 1) {
      const t = performance.now();
      const ab = await ctx.decodeAudioData(buf.slice(0));
      times.push(performance.now() - t);
      frames = ab.length;
      rate = ab.sampleRate;
    }
    const secs = frames / rate;
    const med = median(times);
    out({ kind: "decode_electron", file: f, ok: true, frames, rate, audio_s: r3(secs), median_ms: r3(med), x_realtime: r3((secs * 1000) / med),
      note: "decodeAudioData resamples to the context rate (44.1 kHz)" });
  }
}

function sine(seconds: number, sr: number, f: number): Float32Array {
  const a = new Float32Array(seconds * sr);
  for (let i = 0; i < a.length; i += 1) a[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / sr);
  return a;
}

async function renderStretch(decks: number, rates: number[], preset: "default" | "cheaper"): Promise<number> {
  const sr = 44100;
  const ctx = new OfflineAudioContext(2, 10 * sr, sr);
  const tone = sine(30, sr, 440);
  for (let d = 0; d < decks; d += 1) {
    const node = await SignalsmithStretch(ctx as unknown as AudioContext);
    await node.configure({ preset });
    await node.addBuffers([tone, tone.slice()]);
    node.connect(ctx.destination);
    await node.schedule({ active: true, rate: rates[d % rates.length], input: 0, semitones: 0 });
  }
  const t = performance.now();
  await ctx.startRendering();
  return (performance.now() - t) / 1000;
}

async function benchStretch() {
  for (const preset of ["default", "cheaper"] as const) {
    for (const rate of [0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0]) {
      try {
        await renderStretch(1, [rate], preset);
        const t: number[] = [];
        for (let i = 0; i < RUNS; i += 1) t.push(await renderStretch(1, [rate], preset));
        out({ kind: "stretch_electron", preset, rate, cpu_pct_per_deck: r3((median(t) / 10) * 100),
          note: "OfflineAudioContext render of 10 s; includes AudioWorklet/WASM overhead of the shipping package" });
      } catch (e) {
        out({ kind: "stretch_electron", preset, rate, ok: false, error: String(e) });
      }
    }
    try {
      const t: number[] = [];
      for (let i = 0; i < RUNS; i += 1) t.push(await renderStretch(4, [1.0, 1.03, 0.97, 1.06], preset));
      out({ kind: "stretch_4deck_electron", preset, cpu_pct_total: r3((median(t) / 10) * 100) });
    } catch (e) {
      out({ kind: "stretch_4deck_electron", preset, ok: false, error: String(e) });
    }
  }
}

// Same xorshift generator and word lists as rn-engine/src/library.rs.
const GENRES = ["House", "Techno", "Hip-Hop", "Drum & Bass", "Disco", "Pop", "Trance", "Afro"];
const KEYS = ["1A","2A","3A","4A","5A","6A","7A","8A","9A","10A","11A","12A","1B","2B","3B","4B","5B","6B","7B","8B","9B","10B","11B","12B"];
const WORDS = ["night","drive","sun","blue","fire","deep","rhythm","love","city","dream","echo","gold","wave","storm","velvet","neon","moon","river","heart","shadow","light","tokyo","lagos","berlin","toronto","summer","glass","pulse","orbit","silk","motion","signal"];

function synthTracks(n: number): Track[] {
  let s = 1 >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
  const out: Track[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = WORDS[rnd() % 32], b = WORDS[rnd() % 32], c = WORDS[rnd() % 32];
    const artist = `${WORDS[rnd() % 32]} ${WORDS[rnd() % 32]}`;
    const genre = GENRES[rnd() % 8];
    const bpm = 80 + (rnd() % 9000) / 100;
    const key = KEYS[rnd() % 24];
    const duration = 120 + (rnd() % 360);
    const crate = `Crate ${rnd() % 100}`;
    const title = `${a} ${b} ${c} ${i}`;
    const t = trackFromCrate({ path: `/music/${genre}/${crate}/${artist} - ${title}.mp3`, name: `${title}.mp3` }, crate);
    t.artist = artist; t.album = `${c} ${b}`; t.genre = genre; t.bpm = bpm; t.key = key; t.duration = duration;
    t.playCount = rnd() % 20;
    out.push(t);
  }
  return out;
}

function benchLibrary(n: number) {
  const acc: Record<string, number[]> = {};
  const rows: Record<string, number> = {};
  const time = (k: string, f: () => number) => {
    const t = performance.now();
    const v = f();
    (acc[k] ??= []).push(performance.now() - t);
    rows[k] = v;
  };
  for (let run = 0; run < RUNS; run += 1) {
    localStorage.clear();
    let tracks: Track[] = [];
    time("import_ms", () => {
      tracks = synthTracks(n);
      const meta: Record<string, unknown> = {};
      for (const t of tracks) meta[t.id] = { color: t.color, playCount: t.playCount, beatgridLocked: false };
      try { localStorage.setItem("opendeck.trackMeta.v1", JSON.stringify(meta)); } catch { rows.quota_exceeded = 1; }
      return tracks.length;
    });
    time("open_count_ms", () => {
      const raw = localStorage.getItem("opendeck.trackMeta.v1");
      return raw ? Object.keys(JSON.parse(raw)).length : 0;
    });
    time("search_like_ms", () => filterTracks(tracks, "night").length);
    time("sort_page500_ms", () => sortTracks(tracks, "bpm", "desc").slice(0, 500).length);
    time("sort_all_ms", () => sortTracks(tracks, "artist" as never).length);
    time("live_playlist_ms", () => evaluateLivePlaylist(tracks, { id: "x", name: "x", match: "all", rules: [
      { field: "genre", operator: "equals", value: "House" }, { field: "bpm", operator: "between", value: 120, valueTo: 128 },
      { field: "playCount", operator: "gt", value: 3 }] }).length);
    time("update_meta_1000_ms", () => {
      for (let i = 0; i < 1000; i += 1) { const t = tracks[(i * 37) % tracks.length]; t.color = "#ff0000"; t.playCount = (t.playCount ?? 0) + 1; }
      const meta: Record<string, unknown> = {};
      for (const t of tracks) meta[t.id] = { color: t.color, playCount: t.playCount, beatgridLocked: false };
      try { localStorage.setItem("opendeck.trackMeta.v1", JSON.stringify(meta)); } catch { rows.quota_exceeded = 1; }
      return 1000;
    });
  }
  const res: Record<string, unknown> = { kind: "db_electron", tracks: n, result_rows: rows,
    note: "today's library is an in-memory array + localStorage JSON (no DB); FTS has no equivalent" };
  for (const [k, v] of Object.entries(acc)) res[k] = r3(median(v));
  out(res);
}

function synthPeaks(seed: number, duration: number) {
  const n = 2000;
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s % 1000) / 1000; };
  const peaks = new Float32Array(n), low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = (i / n) * duration;
    const ph = (t * 2) % 1;
    low[i] = Math.exp(-ph * 8) * 0.9 + 0.05 * rnd(); mid[i] = 0.3 + 0.3 * rnd(); high[i] = 0.2 + 0.4 * rnd();
    peaks[i] = Math.max(low[i], mid[i], high[i]);
  }
  return { peaks, bands: { low, mid, high } };
}

async function benchRender(decks: number, frames: number) {
  document.body.innerHTML = "";
  document.body.style.cssText = "margin:0;background:#111;width:1920px;height:1080px;overflow:hidden";
  const h = 1080 / decks;
  const items: { zoom: ZoomWaveform; ov: Waveform; disc: HTMLElement; dur: number }[] = [];
  for (let d = 0; d < decks; d += 1) {
    const row = document.createElement("div");
    row.style.cssText = `position:relative;height:${h}px;display:flex;gap:6px`;
    const col = document.createElement("div");
    col.style.cssText = "flex:1;display:flex;flex-direction:column;gap:6px";
    const zc = document.createElement("canvas"); zc.style.cssText = "width:100%;height:72%";
    const oc = document.createElement("canvas"); oc.style.cssText = "width:100%;flex:1";
    col.append(zc, oc);
    const vinyl = document.createElement("div");
    const size = Math.min(h - 12, 220);
    vinyl.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:radial-gradient(#c22 0 30%,#111 31%);position:relative`;
    const disc = document.createElement("div");
    disc.style.cssText = "position:absolute;inset:0;border-radius:50%;background:linear-gradient(#fff 0 0) 50% 2%/3px 34% no-repeat";
    vinyl.append(disc);
    row.append(col, vinyl);
    document.body.append(row);
    const zoom = new ZoomWaveform(zc, 8);
    const ov = new Waveform(oc);
    const dur = 300;
    const { peaks, bands } = synthPeaks(d + 1, dur);
    zoom.setPeaks(peaks, dur, bands); zoom.setBpm(120 + d, 0);
    ov.setPeaks(peaks, dur, bands);
    items.push({ zoom, ov, disc, dur });
  }
  const script: number[] = [];
  const intervals: number[] = [];
  await new Promise<void>((resolve) => {
    let f = 0;
    let last = 0;
    const tick = (now: number) => {
      if (last) intervals.push(now - last);
      last = now;
      const t0 = performance.now();
      items.forEach((it, i) => {
        const t = 30 + f / 60 + i;
        it.zoom.update(t);
        it.ov.setProgress(t);
        it.disc.style.transform = `rotate(${((t / 1.8) * 360).toFixed(1)}deg)`;
      });
      script.push(performance.now() - t0);
      f += 1;
      if (f < frames + 10) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  const s = script.slice(10), iv = intervals.slice(10);
  out({ kind: "render_electron", decks, frames: s.length, script_median_ms: r3(median(s)), script_p99_ms: r3(pct(s, 0.99)),
    raf_interval_median_ms: r3(median(iv)), raf_interval_p99_ms: r3(pct(iv, 0.99)),
    pct_intervals_within_60hz: r3((iv.filter((x) => x <= 1000 / 60 + 1).length / iv.length) * 100),
    note: "canvas 2D (Skia) + DOM; script time excludes async GPU raster; rAF capped by the display/compositor rate" });
}

async function main() {
  const which = (params.get("which") ?? "decode,stretch,library,render").split(",");
  try {
    if (which.includes("decode")) await benchDecode(params.get("fx")!, (params.get("files") ?? "").split("|").filter(Boolean));
    if (which.includes("stretch")) await benchStretch();
    if (which.includes("library")) benchLibrary(Number(params.get("tracks") ?? 100000));
    if (which.includes("render")) {
      for (const d of [2, 4]) {
        const runs: Record<string, number>[] = [];
        for (let i = 0; i < RUNS; i += 1) await benchRender(d, 300);
      }
    }
  } catch (e) {
    out({ kind: "electron_error", error: String((e as Error)?.stack ?? e) });
  }
  console.log("BENCH_DONE");
}
void main();

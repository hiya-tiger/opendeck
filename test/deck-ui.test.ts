import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DECK_LETTERS,
  EMPTY_DECK_TEXT,
  applyWaveOrientation,
  deckTimeText,
  resetDeckReadouts,
  storedWaveVertical,
} from "../src/renderer/ui/deck-view.ts";

// Minimal canvas + window so the real waveform classes can draw in Node.
(globalThis as { window?: unknown }).window ??= { devicePixelRatio: 1 };

function fakeCanvas(width = 300, height = 80) {
  const calls: string[] = [];
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        calls.push(prop + (prop === "fillText" ? `:${String(args[0])}` : ""));
        return prop.startsWith("create") ? gradient : undefined;
      };
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
  const canvas = {
    width,
    height,
    style: {} as Record<string, string>,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }),
    addEventListener() {},
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, calls };
}

const { Waveform, ZoomWaveform } = await import("../src/renderer/media/waveform.ts");

function peaks(n = 400, seed = 1): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.abs(Math.sin(i * 0.05 * seed)) * 0.9;
  return out;
}

function bands(n = 400, low = 1) {
  return { low: new Float32Array(n).fill(low), mid: new Float32Array(n).fill(0.2), high: new Float32Array(n).fill(0.1) };
}

describe("vertical waveform switch reaches all four decks (bug: C and D stayed horizontal)", () => {
  test("applyWaveOrientation sets every deck, A-D, both ways", () => {
    const zooms = Object.fromEntries(DECK_LETTERS.map((id) => [id, new ZoomWaveform(fakeCanvas().canvas)]));
    assert.deepEqual(applyWaveOrientation(zooms, true), ["A", "B", "C", "D"]);
    for (const id of DECK_LETTERS) assert.equal(zooms[id]!.vertical, true, `deck ${id} vertical`);
    applyWaveOrientation(zooms, false);
    for (const id of DECK_LETTERS) assert.equal(zooms[id]!.vertical, false, `deck ${id} horizontal`);
  });

  test("decks missing from the map are skipped (2-deck layout before C/D exist)", () => {
    const zooms = { A: new ZoomWaveform(fakeCanvas().canvas), B: new ZoomWaveform(fakeCanvas().canvas) };
    assert.deepEqual(applyWaveOrientation(zooms, true), ["A", "B"]);
  });

  test("the stored switch survives a restart the same way it is written", () => {
    assert.equal(storedWaveVertical("1"), true);
    assert.equal(storedWaveVertical("0"), false);
    assert.equal(storedWaveVertical(null), false);
  });

  test("app.ts no longer limits the switch to A/B and new zooms pick up the mode", () => {
    const source = readFileSync(new URL("../src/renderer/app.ts", import.meta.url), "utf8");
    const fn = source.slice(source.indexOf("function setWaveMode"), source.indexOf("setWaveMode(storedWaveVertical"));
    assert.ok(fn.includes("applyWaveOrientation(zooms, vertical, ALL_DECKS)"));
    assert.ok(!/\["A", "B"\][^\n]*setVertical/.test(source), "hardcoded A/B orientation loop is gone");
    assert.ok(source.includes('zoom.setVertical(document.body.classList.contains("vertical-waves"))'));
  });

  test("vertical drawing uses the column layout on a C/D-sized canvas", () => {
    const { canvas, calls } = fakeCanvas(240, 240);
    const zoom = new ZoomWaveform(canvas);
    zoom.setPeaks(peaks(), 120, bands());
    zoom.setVertical(true);
    calls.length = 0;
    zoom.update(10);
    assert.ok(calls.includes("fillRect"));
    assert.ok(!calls.some((c) => c.startsWith("fillText:beat grid")), "a loaded deck does not draw the empty state");
  });
});

describe("eject fully resets the deck view (bug: waveform and time stayed)", () => {
  for (const vertical of [false, true]) {
    test(`ZoomWaveform.clear empties peaks, markers, grid and colour buffers (${vertical ? "vertical" : "horizontal"})`, () => {
      const { canvas, calls } = fakeCanvas();
      const zoom = new ZoomWaveform(canvas);
      zoom.setVertical(vertical);
      zoom.setPeaks(peaks(), 200, bands());
      zoom.setBpm(124, 0.1);
      zoom.setLoop({ start: 4, end: 8 });
      zoom.setHotCues([{ time: 3, color: "#ff0000" }]);
      zoom.update(5);
      assert.equal(zoom.holdsColumns, true);
      calls.length = 0;
      zoom.clear();
      assert.equal(zoom.peaks, null);
      assert.equal(zoom.bands, null);
      assert.equal(zoom.duration, 0);
      assert.equal(zoom.bpm, 0);
      assert.equal(zoom.loop, null);
      assert.deepEqual(zoom.hotCues, []);
      assert.equal(zoom.holdsColumns, false, "colour buffer released");
      assert.equal(zoom.vertical, vertical, "orientation is a view setting and survives eject");
      assert.ok(calls.includes("fillText:beat grid"), "redrawn as empty");
    });
  }

  test("Waveform.clear releases the overview colour buffer too", () => {
    const wave = new Waveform(fakeCanvas().canvas);
    wave.setPeaks(peaks(), 200, bands());
    assert.equal(wave.holdsColumns, true);
    wave.clear();
    assert.equal(wave.peaks, null);
    assert.equal(wave.holdsColumns, false);
  });

  test("a track loaded after eject draws with its own colours, not the previous track's", () => {
    const zoom = new ZoomWaveform(fakeCanvas().canvas);
    const first = bands(400, 1);
    zoom.setPeaks(peaks(400, 1), 200, first);
    zoom.update(1);
    const before = (zoom as unknown as { colors: { cache: { color: string }[] } }).colors.cache[0]!.color;
    zoom.clear();
    // Same column count, different spectrum (all mids).
    const second = { low: new Float32Array(400), mid: new Float32Array(400).fill(1), high: new Float32Array(400) };
    zoom.setPeaks(peaks(400, 2), 180, second);
    zoom.update(1);
    const after = (zoom as unknown as { colors: { cache: { color: string }[] } }).colors.cache[0]!.color;
    assert.notEqual(after, before);
    assert.equal(zoom.duration, 180);
    assert.equal(zoom.holdsColumns, true);
  });

  test("the colour cache is keyed by the peak arrays, not their length", () => {
    const zoom = new ZoomWaveform(fakeCanvas().canvas);
    zoom.setPeaks(peaks(), 100, bands(400, 1));
    zoom.update(1);
    zoom.setPeaks(peaks(), 100, { low: new Float32Array(400), mid: new Float32Array(400), high: new Float32Array(400).fill(1) });
    zoom.update(2);
    const color = (zoom as unknown as { colors: { cache: { color: string }[] } }).colors.cache[0]!.color;
    assert.equal(color, "rgb(88, 156, 255)", "high-band colour, not the stale low-band one");
  });

  test("resetDeckReadouts puts every readout back to the empty text", () => {
    const slot = (text: string) => ({ textContent: text });
    const removed: string[] = [];
    const refs = {
      title: slot("Track"),
      sub: slot("file.mp3"),
      bpm: slot("124.0 BPM"),
      key: slot("8A Am"),
      time: { textContent: "3:12 / 6:01", classList: { remove: (...t: string[]) => removed.push(...t) } },
      bar: slot("65.2.1"),
      partsState: slot("4 parts ready"),
    };
    resetDeckReadouts(refs);
    assert.equal(refs.title.textContent, EMPTY_DECK_TEXT.title);
    assert.equal(refs.sub.textContent, EMPTY_DECK_TEXT.sub);
    assert.equal(refs.bpm.textContent, "-- BPM");
    assert.equal(refs.key.textContent, "--");
    assert.equal(refs.time.textContent, "0:00 / 0:00");
    assert.equal(refs.bar.textContent, "1.1.1");
    assert.equal(refs.partsState.textContent, "parts not ready");
    assert.deepEqual(removed, ["track-end-warn"]);
  });

  test("time readout stays empty on an ejected deck whatever late state reports", () => {
    assert.equal(deckTimeText(false, 192.4, 361), "0:00 / 0:00");
    assert.equal(deckTimeText(true, 192.4, 361), "3:12 / 6:01");
    assert.equal(deckTimeText(true, Number.NaN, Number.POSITIVE_INFINITY), "0:00 / 0:00");
  });

  test("app.ts eject goes through ejectDeck, which clears the zoom and the readouts", () => {
    const source = readFileSync(new URL("../src/renderer/app.ts", import.meta.url), "utf8");
    const fn = source.slice(source.indexOf("function ejectDeck"), source.indexOf("function toggleDeck"));
    for (const needle of ["zooms[deckId]?.clear()", "waves[deckId]?.clear()", "resetDeckReadouts(refs)", "setVinylArt(deckId, null)", "stopProgressive(deckId)", "delete meta[deckId]"]) {
      assert.ok(fn.includes(needle), `ejectDeck does ${needle}`);
    }
    assert.ok(source.includes('refs.ejectBtn?.addEventListener("click", () => ejectDeck(deckId))'));
  });
});

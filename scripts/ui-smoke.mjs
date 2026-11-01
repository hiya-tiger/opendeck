import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist", "ui-smoke");
await mkdir(outDir, { recursive: true });

// Load the real renderer against the real bundle and report any script error.
const main = `const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// This harness loads only the renderer, so main-process IPC handlers that the
// real dist/main.cjs registers do not exist. Stub the two the renderer polls,
// otherwise the probe reports "No handler registered" instead of renderer bugs.
ipcMain.handle("rtmp:available", () => false);
ipcMain.handle("streaming:status", () => ({ providers: [], active: null }));
// Detected-media stub: one pending CDJ prompt, so the probe can check it renders.
const prompt = { sourceId: "cdj-2-usb", origin: "cdj", mediaKey: "cdj:smoke", sourceName: "CDJ 2 · USB · SMOKE", mediaName: "SMOKE", slot: "usb", where: "CDJ 2", trackCount: 412, kind: "rekordbox", message: "USB drive 'SMOKE' found on CDJ 2 (412 tracks). Add it to your library?" };
ipcMain.handle("djmedia:state", () => ({
  libraries: [],
  snapshot: { enabled: true, running: true, interfaceName: "eth0", address: "169.254.1.5", deviceNumber: 1, players: [{ deviceNumber: 2, name: "CDJ-3000", ip: "169.254.1.2", kind: "player", usb: "mounted", sd: "empty" }], media: [], prompts: [prompt], error: null, interfaces: [], settings: { enabled: true, interface: "auto", deviceNumber: "auto", localDrives: true, remembered: {} } },
}));
const errors = [];
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1500,
    height: 980,
    webPreferences: { backgroundThrottling: false, offscreen: true, preload: path.join(__dirname, "..", "preload.cjs") },
  });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(String(event.message).slice(0, 300));
  });
  win.webContents.on("render-process-gone", (_e, d) => errors.push("render-process-gone " + d.reason));
  try {
    await win.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
    await new Promise((r) => setTimeout(r, 3500));
    const probe = await win.webContents.executeJavaScript(\`(() => ({
      title: document.title,
      brand: (document.querySelector('.brand-name') || {}).textContent || null,
      decks: document.querySelectorAll('.deck').length,
      slots: ['A','B','C','D'].filter(id => document.getElementById('deckSlot'+id)).length,
      crossfader: !!document.getElementById('crossfader'),
      trackRows: document.querySelectorAll('#trackList tr').length,
      engineState: (document.getElementById('engineState') || {}).textContent || null,
      mediaPrompt: (document.querySelector('#mediaPrompts .media-prompt-text') || {}).textContent || null,
      mediaPromptButtons: document.querySelectorAll('#mediaPrompts button').length,
      cdjStatus: (document.getElementById('cdjStatus') || {}).textContent || null,
    }))()\`, true);
    if (!probe.mediaPrompt || !probe.mediaPrompt.includes("SMOKE") || probe.mediaPromptButtons !== 2) errors.push("detected-media prompt did not render");
    // Vertical waveform switch on all four decks, and a full eject reset (Nov 1 2026 fixes).
    const decks = await win.webContents.executeJavaScript(\`(async () => {
      const od = window.openDeck;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const four = document.getElementById('fourDeckToggle');
      if (four && four.getAttribute('aria-pressed') !== 'true') four.click();
      const waveBtn = document.getElementById('waveMode');
      if (!document.body.classList.contains('vertical-waves')) waveBtn.click();
      const vertical = ['A','B','C','D'].map((id) => Boolean(od.zooms[id] && od.zooms[id].vertical));
      // A 3 s sine as a real file, loaded through the normal path onto deck C.
      const rate = 44100, n = rate * 3, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
      const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * 12000 * (1 + Math.sin(i / 4000)) / 2), true);
      const file = new File([buf], 'smoke-sine.wav', { type: 'audio/wav' });
      const [track] = od.addFiles([file]);
      const waitPeaks = async () => { for (let i = 0; i < 80 && !(od.zooms.C.peaks && od.waves.C.peaks); i++) await sleep(100); return Boolean(od.zooms.C.peaks && od.waves.C.peaks); };
      await od.loadTrack(track, 'C');
      const loadedPeaks = await waitPeaks();
      const slot = document.getElementById('deckSlotC');
      slot.querySelector('.eject-btn').click();
      await sleep(150);
      const after = {
        zoomPeaks: od.zooms.C.peaks, overviewPeaks: od.waves.C.peaks, zoomColumns: od.zooms.C.holdsColumns,
        time: slot.querySelector('.deck-time').textContent, title: slot.querySelector('.deck-title').textContent,
        bpm: slot.querySelector('.deck-bpm').textContent, cues: od.zooms.C.hotCues.length, stillVertical: od.zooms.C.vertical,
      };
      await od.loadTrack(track, 'C');
      const reloadedPeaks = await waitPeaks();
      return { vertical, loadedPeaks, after: { ...after, zoomPeaks: Boolean(after.zoomPeaks), overviewPeaks: Boolean(after.overviewPeaks) }, reloadedPeaks, reloadedTime: slot.querySelector('.deck-time').textContent };
    })()\`, true);
    if (!decks.vertical.every(Boolean)) errors.push("vertical waveform switch missed a deck: " + JSON.stringify(decks.vertical));
    if (!decks.loadedPeaks) errors.push("deck C never drew its waveform");
    if (decks.after.zoomPeaks || decks.after.overviewPeaks || decks.after.zoomColumns) errors.push("eject left waveform data on deck C");
    if (decks.after.time !== "0:00 / 0:00" || decks.after.title !== "No track" || decks.after.bpm !== "-- BPM" || decks.after.cues !== 0) errors.push("eject left readouts: " + JSON.stringify(decks.after));
    if (!decks.after.stillVertical) errors.push("eject reset the waveform orientation");
    if (!decks.reloadedPeaks) errors.push("a track loaded after eject did not draw");
    // Restart: the stored switch must reach C and D again.
    await win.webContents.reloadIgnoringCache();
    await new Promise((r) => setTimeout(r, 3000));
    const restart = await win.webContents.executeJavaScript(\`['A','B','C','D'].map((id) => Boolean(window.openDeck.zooms[id] && window.openDeck.zooms[id].vertical))\`, true);
    if (!restart.every(Boolean)) errors.push("vertical waveform not restored on every deck after restart: " + JSON.stringify(restart));
    probe.deckChecks = { ...decks, restart };
    console.log("UI_RESULT " + JSON.stringify({ ok: errors.length === 0, errors, probe }));
    process.exitCode = errors.length === 0 ? 0 : 1;
  } catch (error) {
    console.log("UI_RESULT " + JSON.stringify({ ok: false, errors: [...errors, String(error)] }));
    process.exitCode = 1;
  }
  // app.quit() can leave the offscreen window (and the process) alive, which
  // made the wrapper report a timeout and exit 1 even after a clean result.
  app.exit(process.exitCode ?? 0);
});
`;
const mainPath = path.join(outDir, "main.cjs");
await writeFile(mainPath, main);

// dist/ is regenerated by scripts/build.mjs; reuse the built preload.
const require = createRequire(import.meta.url);
const electron = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [mainPath], { stdio: "inherit", env });
const timer = setTimeout(() => {
  console.error("UI_TIMEOUT");
  child.kill();
  process.exitCode = 1;
}, 90_000);
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});

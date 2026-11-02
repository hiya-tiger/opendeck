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
// Stream sources with no partner keys stored: every partner source must say so.
ipcMain.handle("stream:status", () => ({ sources: [], widevineBuild: false, redirectUri: "http://127.0.0.1:43827/callback" }));
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
      streamSources: Array.from(document.querySelectorAll('#providerList .provider')).map(b => b.dataset.source + '=' + (b.querySelector('span') || {}).textContent),
      streamLogin: (document.getElementById('loginState') || {}).textContent || null,
      streamWidevine: (document.getElementById('drmStatusChip') || {}).textContent || null,
    }))()\`, true);
    const partners = (probe.streamSources || []).filter((s) => /^(beatport|beatsource|tidal|soundcloud)=/.test(s));
    if (partners.length !== 4 || !partners.every((s) => s.endsWith("=needs partner API key"))) errors.push("stream sources did not show 'needs partner API key': " + JSON.stringify(probe.streamSources));
    if (probe.streamLogin !== "needs partner API key") errors.push("stream head state: " + probe.streamLogin);
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
    // Serato keyboard shortcuts (D45): drive the real renderer with key events.
    const kb = await win.webContents.executeJavaScript(\`(async () => {
      const od = window.openDeck;
      const sc = od.shortcuts;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const opts = (code, m = {}) => ({ code, key: m.key || code, bubbles: true, cancelable: true, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta });
      const key = (code, m = {}, target = document.body) => { const e = new KeyboardEvent('keydown', opts(code, m)); target.dispatchEvent(e); return e.defaultPrevented; };
      const up = (code, m = {}, target = document.body) => target.dispatchEvent(new KeyboardEvent('keyup', opts(code, m)));
      const shown = (id) => !document.getElementById(id).classList.contains('hidden');
      const waitFor = async (fn, ms = 6000) => { for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50); } return false; };
      const r = {};
      const four = document.getElementById('fourDeckToggle');
      if (four.getAttribute('aria-pressed') === 'true') four.click();
      r.platformDefault = sc.targetDeck('left') + sc.targetDeck('right');
      key('Slash', { shift: true, key: '?' });
      r.overlayOpen = shown('shortcutsOverlay');
      r.overlayRows = document.querySelectorAll('#shortcutsOverlay .kb-action').length;
      r.overlayHeads2 = [...document.querySelectorAll('#shortcutsOverlay .kb-head')].map((e) => e.textContent).join('|');
      key('Escape');
      r.overlayClosedByEscape = !shown('shortcutsOverlay');
      r.settingsButton = !!document.getElementById('settingsBtn');
      const wav = (name, hz) => {
        const rate = 44100, n = rate * 4, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
        w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
        v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
        v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i * 2 * Math.PI * hz / rate) * 9000), true);
        return new File([buf], name, { type: 'audio/wav' });
      };
      const added = od.addFiles([wav('kb-one.wav', 220), wav('kb-two.wav', 330), wav('kb-three.wav', 440)]);
      await sleep(200);
      const visible = od.library.visible().map((t) => t.id);
      key('ArrowDown');
      r.cursorFirst = od.library.cursor === visible[0];
      key('ArrowLeft', { shift: true });
      r.loadA = await waitFor(() => od.decks.A.info.id === visible[0] && od.decks.A.hasTrack);
      key('KeyW');
      r.playA = await waitFor(() => od.decks.A.playing, 3000);
      await sleep(300);
      r.engineAtCensor = od.decks.A.engine;
      key('KeyU');
      r.censorHeld = od.decks.A.censorActive;
      await sleep(150);
      r.playingWhileCensor = od.decks.A.playing;
      up('KeyU');
      r.censorReleased = !od.decks.A.censorActive;
      r.playingAfterRelease = od.decks.A.playing;
      await sleep(300);
      r.playingAfterRelease300 = od.decks.A.playing;
      key('KeyW');
      r.pauseA = await waitFor(() => !od.decks.A.playing, 3000);
      const search = document.getElementById('search');
      search.focus();
      r.typingPrevented = key('KeyW', { key: 'w' }, search);
      await sleep(150);
      r.typingDidNotPlay = !od.decks.A.playing;
      search.value = 'zzz'; search.dispatchEvent(new Event('input', { bubbles: true }));
      key('Escape', {}, search);
      r.escapeClearedSearch = search.value === '' && document.activeElement !== search;
      key('Digit1', { ctrl: true });
      r.setCue1 = !!od.decks.A.hotCues[0];
      const lock = od.decks.A.keylockOn;
      key('F5');
      r.keylockToggled = od.decks.A.keylockOn !== lock;
      key('F5');
      key('KeyR');
      r.tempoUp = Math.abs(od.decks.A.tempo - 0.1) < 1e-6;
      key('KeyE');
      key('Equal');
      r.waveZoom = od.zooms.A.spanSeconds === 6;
      key('Minus');
      key('KeyQ');
      r.reverseOn = od.decks.A.reversed;
      key('KeyQ');
      r.reverseOff = !od.decks.A.reversed;
      key('KeyF', { ctrl: true });
      r.ctrlFFocusesSearch = document.activeElement === search;
      search.blur();
      key('Delete', { ctrl: true });
      r.deleteAsks = shown('shortcutConfirm');
      key('Escape');
      r.deleteCancelled = !shown('shortcutConfirm') && od.library.find(visible[0]) !== undefined;
      key('Escape');
      r.exitAsks = shown('shortcutConfirm') && document.querySelector('#shortcutConfirm .kb-confirm-text').textContent.includes('Quit');
      document.querySelector('#shortcutConfirm [data-answer="cancel"]').click();
      r.exitCancelled = !shown('shortcutConfirm');
      // 4-deck focus and routing.
      key('F1');
      r.f1In2DeckStaysA = sc.targetDeck('left') === 'A';
      four.click();
      await sleep(100);
      key('F1');
      r.f1Left = sc.targetDeck('left');
      r.headerHighlightC = document.querySelector('#deckSlotC .deck').classList.contains('kb-target') && !document.querySelector('#deckSlotA .deck').classList.contains('kb-target');
      key('Slash', { shift: true, key: '?' });
      r.overlayHeads4 = [...document.querySelectorAll('#shortcutsOverlay .kb-head')].map((e) => e.textContent).join('|');
      key('Escape');
      key('ArrowDown');
      key('ArrowLeft', { shift: true });
      r.leftLoadGoesToC = await waitFor(() => od.decks.C.info.id === visible[1]);
      r.aUntouched = od.decks.A.info.id === visible[0];
      key('KeyW');
      r.wPlaysC = await waitFor(() => od.decks.C.playing, 3000) && !od.decks.A.playing;
      key('KeyW');
      await waitFor(() => !od.decks.C.playing, 3000);
      key('F6');
      r.f6Right = sc.targetDeck('right');
      key('ArrowDown');
      key('ArrowRight', { ctrl: true, shift: true, alt: true });
      r.directLoadD = await waitFor(() => od.decks.D.info.id === visible[2]);
      key('KeyS');
      r.sPlaysD = await waitFor(() => od.decks.D.playing, 3000) && !od.decks.B.playing;
      key('KeyS');
      await waitFor(() => !od.decks.D.playing, 3000);
      key('ArrowUp');
      key('ArrowLeft', { ctrl: true, shift: true, alt: true });
      r.directLoadC = await waitFor(() => od.decks.C.info.id === visible[1] && od.library.cursor === visible[1]);
      key('F1');
      r.f1Back = sc.targetDeck('left');
      key('F1');
      four.click();
      await sleep(100);
      r.resetTo2Deck = sc.targetDeck('left') + sc.targetDeck('right');
      r.highlightCleared = document.querySelectorAll('.deck.kb-target').length === 0;
      four.click();
      await sleep(100);
      r.focusStillReset = sc.targetDeck('left') + sc.targetDeck('right');
      four.click();
      await sleep(100);
      sc.setEnabled(false);
      key('KeyW');
      await sleep(200);
      r.offDoesNothing = !od.decks.A.playing;
      r.settingsUnchecked = document.getElementById('shortcutsEnabled').checked === false;
      sc.setEnabled(true);
      for (const id of ['A', 'B', 'C', 'D']) od.decks[id].pause();
      return r;
    })()\`, true);
    const kbExpect = {
      platformDefault: "AB", overlayOpen: true, overlayClosedByEscape: true, settingsButton: true, cursorFirst: true, loadA: true, playA: true,
      censorHeld: true, censorReleased: true, pauseA: true, typingPrevented: false, typingDidNotPlay: true, escapeClearedSearch: true,
      setCue1: true, keylockToggled: true, tempoUp: true, waveZoom: true, reverseOn: true, reverseOff: true, ctrlFFocusesSearch: true,
      deleteAsks: true, deleteCancelled: true, exitAsks: true, exitCancelled: true, f1In2DeckStaysA: true, f1Left: "C", headerHighlightC: true,
      leftLoadGoesToC: true, aUntouched: true, wPlaysC: true, f6Right: "D", directLoadD: true, sPlaysD: true, directLoadC: true, f1Back: "A",
      resetTo2Deck: "AB", highlightCleared: true, focusStillReset: "AB", offDoesNothing: true, settingsUnchecked: true,
    };
    for (const [name, want] of Object.entries(kbExpect)) if (kb[name] !== want) errors.push("keyboard " + name + ": got " + JSON.stringify(kb[name]) + ", want " + JSON.stringify(want));
    if (!(kb.overlayRows >= 50)) errors.push("shortcuts overlay rows: " + kb.overlayRows);
    if (!String(kb.overlayHeads2).includes("Left Virtual Deck · A") || !String(kb.overlayHeads4).includes("Left Virtual Deck · C")) errors.push("overlay deck letters: " + kb.overlayHeads2 + " / " + kb.overlayHeads4);
    probe.keyboard = kb;
    // Picture of the shortcuts screen in 4-deck mode with C focused, for a human look.
    await win.webContents.executeJavaScript(\`(() => { const f = document.getElementById('fourDeckToggle'); if (f.getAttribute('aria-pressed') !== 'true') f.click(); document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'F1', key: 'F1', bubbles: true })); document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Slash', key: '?', shiftKey: true, bubbles: true })); })()\`, true);
    await new Promise((r) => setTimeout(r, 400));
    const shot = await win.webContents.capturePage();
    require("node:fs").writeFileSync(path.join(__dirname, "shortcuts-overlay.png"), shot.toPNG());
    await win.webContents.executeJavaScript(\`document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))\`, true);
    await new Promise((r) => setTimeout(r, 200));
    const shot2 = await win.webContents.capturePage();
    require("node:fs").writeFileSync(path.join(__dirname, "decks-focus.png"), shot2.toPNG());
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

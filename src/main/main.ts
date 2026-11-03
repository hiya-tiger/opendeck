import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  isSeratoRunning,
  undoLastSeratoWrite,
  writeSeratoLibraryExport,
  writeSeratoSqliteColumns,
  writeSeratoTags,
  type SeratoLibraryExportRequest,
  type SeratoSqliteColumnsRequest,
  type SeratoWriteRequest,
} from "./serato-files.ts";
import { MODEL, contentCacheRoot, findCache, installModel, loadManifestAt, modelInfo, pickCacheDir, readCache, type SeparateRequest } from "./separation.ts";
import { ContentCache, type CachedAnalysis } from "./cache/content-cache.ts";
import { SessionFile, SettingsStore, cacheLimitChoices, type AppSettings } from "./app-settings.ts";
import { readTrackFile, resolveTrackFile, MEDIA_FILE_RE } from "./session-files.ts";
import { CLOSE_DIALOG, resolveClose } from "./background/close-policy.ts";
import { TrayController } from "./background/tray-controller.ts";
import { StemHost, defaultSpawner } from "./stems/host.ts";
import { createLinkNode } from "./link.ts";
import { createAbletonLinkNode } from "./ableton-link/node.ts";
import { LinkManager, normalizeLinkSettings, type LinkSettings } from "./link-manager.ts";
import { setupStreaming } from "./streaming.ts";
import { setupDetectedMedia } from "./prolink/ipc.ts";
import type { MediaManager } from "./prolink/manager.ts";

const root = (): string => app.getAppPath();


let mainWindow: BrowserWindow | null = null;
let videoOutputWindow: BrowserWindow | null = null;
let rtmp: ChildProcessWithoutNullStreams | null = null;
let rtmpKey = "";
let detectedMedia: MediaManager | null = null;

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    title: "OpenDecks",
    backgroundColor: "#f4f6fd",
    webPreferences: {
      preload: path.join(root(), "dist", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true,
    },
  });
  // Embedded official players (D42) sometimes try to open their own pages.
  // Never spawn app windows for them: https links go to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("file:")) return { action: "allow" }; // the app's own video output page
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadFile(path.join(root(), "renderer", "index.html"));
  // Closing while stems are queued or running asks first (D45).
  mainWindow.on("close", (event) => {
    if (quitConfirmed || !stemHost.busy) return;
    event.preventDefault();
    requestClose();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

// Streaming sources (partner keys, OAuth, decodable audio) live in ./streaming.ts.
// No provider windows, no cookie sniffing, no licence-server proxy (D42).

ipcMain.handle("media:fetch", async (_event, url: string) => {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return { ok: false, error: "only http(s) URLs" };
  }
  try {
    const response = await session.defaultSession.fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) return { ok: false, error: "HTTP " + response.status };
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 500 * 1024 * 1024) return { ok: false, error: "file larger than 500 MB" };
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { ok: true, bytes, type: response.headers.get("content-type") ?? "" };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
});

ipcMain.handle("recording:save", async (_event, name: string, bytes: Uint8Array) => {
  const saveOpts: Electron.SaveDialogOptions = {
    title: "Save mix",
    defaultPath: path.join(app.getPath("music"), name),
    filters: [
      { name: "WebM audio", extensions: ["webm"] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, saveOpts)
    : await dialog.showSaveDialog(saveOpts);
  if (result.canceled || !result.filePath) return { ok: false };
  await fs.writeFile(result.filePath, Buffer.from(bytes));
  return { ok: true, path: result.filePath };
});

ipcMain.handle("rtmp:available", async () => {
  return await new Promise<boolean>((resolve) => {
    try {
      const probe = spawn("ffmpeg", ["-version"]);
      probe.on("error", () => resolve(false));
      probe.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
});

ipcMain.handle("rtmp:start", async (_event, endpoint: string, key: string) => {
  if (rtmp) return { ok: false, detail: "already streaming" };
  if (!/^rtmps?:\/\//.test(endpoint)) return { ok: false, detail: "endpoint must be rtmp:// or rtmps://" };
  rtmpKey = key;
  const url = key ? `${endpoint.replace(/\/$/, "")}/${key}` : endpoint;
  const child = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    "pipe:0",
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-f",
    "flv",
    url,
  ]);
  rtmp = child;
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().replaceAll(key, "***");
    mainWindow?.webContents.send("rtmp:log", text.slice(0, 400));
    void rtmpKey;
  });
  child.on("exit", (code) => {
    rtmp = null;
    rtmpKey = "";
    mainWindow?.webContents.send("rtmp:exit", { code });
  });
  child.on("error", (error) => {
    rtmp = null;
    mainWindow?.webContents.send("rtmp:exit", { code: -1, error: error.message });
  });
  return { ok: true };
});

ipcMain.handle("rtmp:chunk", (_event, chunk: Uint8Array) => {
  if (!rtmp || !rtmp.stdin.writable) return { ok: false };
  rtmp.stdin.write(Buffer.from(chunk));
  return { ok: true };
});

ipcMain.handle("rtmp:stop", async () => {
  if (!rtmp) return { ok: true };
  rtmp.stdin.end();
  const child = rtmp;
  setTimeout(() => {
    if (!child.killed) child.kill();
  }, 1500);
  rtmp = null;
  return { ok: true };
});

const stemModelPath = (): string => process.env.OPENDECK_STEM_MODEL || path.join(app.getPath("userData"), "models", MODEL.filename);

ipcMain.handle("separation:status", async () => {
  const info = await modelInfo(stemModelPath());
  return { ...info, model: MODEL, env: Boolean(process.env.OPENDECK_STEM_MODEL) };
});

ipcMain.handle("separation:install", async (event) => {
  const target = stemModelPath();
  if (process.env.OPENDECK_STEM_MODEL) return modelInfo(target);
  await installModel(target, (progress) => event.sender.send("separation:progress", progress));
  return modelInfo(target);
});

ipcMain.handle("separation:cache", async (_event, request: { hash: string; trackPath?: string | null }) => {
  const manifest = await findCache(request.trackPath, request.hash, app.getPath("userData"));
  const dir = (manifest as { dir?: string } | null)?.dir;
  if (dir && dir.startsWith(contentCache.root)) void contentCache.touch(dir); // a hit is a use (LRU)
  return manifest ? { found: true, manifest } : { found: false };
});

// Inference runs in a utilityProcess (dist/separation-worker.cjs): onnxruntime-node's
// session.run is synchronous and used to freeze this process for seconds per chunk.
const stemHost = new StemHost(defaultSpawner(path.join(__dirname, "separation-worker.cjs")), {
  modelPath: stemModelPath,
  statePath: path.join(app.getPath("userData"), "stems-providers.json"),
});

/* ---------------------------------------------- session resume + cache (D45) */

const userDataDir = (): string => app.getPath("userData");
const contentCache = new ContentCache({ root: contentCacheRoot(userDataDir()) });
const settingsStore = new SettingsStore(userDataDir());
const sessionFile = new SessionFile(userDataDir());
/** Hashes on the decks in the last saved session: never evicted or cleared. */
let sessionHashes: string[] = [];

const pinnedHashes = (): string[] => [...new Set([...sessionHashes, ...stemHost.activeHashes])];
const hashesOf = (snapshot: unknown): string[] => {
  const decksList = (snapshot as { decks?: Array<{ hash?: unknown }> } | null)?.decks;
  return Array.isArray(decksList) ? decksList.map((deck) => String(deck?.hash ?? "")).filter((hash) => /^[a-f0-9]{16,128}$/i.test(hash)) : [];
};
let evicting: Promise<unknown> | null = null;
const evictSoon = (): void => {
  if (evicting) return;
  evicting = contentCache
    .evict(pinnedHashes())
    .catch((error) => console.warn("cache eviction failed", error))
    .finally(() => {
      evicting = null;
    });
};

ipcMain.handle("settings:get", async () => ({ settings: await settingsStore.get(), cacheLimitChoices: cacheLimitChoices() }));
ipcMain.handle("settings:set", async (_event, patch: Partial<AppSettings>) => {
  const settings = await settingsStore.update(patch ?? {});
  contentCache.setLimit(settings.cacheLimitBytes);
  evictSoon();
  return { settings, cacheLimitChoices: cacheLimitChoices() };
});

ipcMain.handle("session:get", async () => {
  const snapshot = await sessionFile.read();
  sessionHashes = hashesOf(snapshot);
  return { session: snapshot, settings: await settingsStore.get() };
});
ipcMain.handle("session:save", async (_event, snapshot: unknown) => {
  sessionHashes = hashesOf(snapshot);
  return { ok: await sessionFile.write(snapshot).catch(() => false) };
});
// beforeunload: synchronous, so the last state is on disk before the window goes.
ipcMain.on("session:save-sync", (event, text: string) => {
  try {
    if (typeof text === "string" && text.length < 512 * 1024) {
      const file = path.join(userDataDir(), "last-session.json");
      mkdirSync(userDataDir(), { recursive: true });
      writeFileSync(`${file}.tmp`, text);
      renameSync(`${file}.tmp`, file);
      sessionHashes = hashesOf(JSON.parse(text));
    }
    event.returnValue = true;
  } catch {
    event.returnValue = false;
  }
});
ipcMain.handle("session:clear", async () => {
  await sessionFile.clear();
  sessionHashes = [];
  return { ok: true };
});
ipcMain.handle("session:open-file", async (_event, request: { path: string; hash?: string }) => {
  const resolved = await resolveTrackFile({ path: String(request?.path ?? ""), hash: request?.hash ?? null }, contentCache);
  if (resolved.status === "missing") return { ok: false, missing: true, path: resolved.from };
  const read = await readTrackFile(resolved.path);
  if (!read.ok) return { ok: false, missing: false, path: resolved.path, error: read.error };
  if (request?.hash) void contentCache.recordPath(request.hash, resolved.path);
  return { ...read, path: resolved.path, moved: resolved.status === "moved", from: resolved.status === "moved" ? resolved.from : null };
});
ipcMain.handle("session:locate", async (_event, name: string) => {
  const options: Electron.OpenDialogOptions = {
    title: `Locate ${String(name ?? "track")}`,
    properties: ["openFile"],
    filters: [{ name: "Audio and video", extensions: ["mp3", "wav", "ogg", "flac", "m4a", "aac", "aif", "aiff", "opus", "webm", "mp4", "m4v", "mov", "mkv"] }],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  const chosen = result.filePaths?.[0];
  if (result.canceled || !chosen || !MEDIA_FILE_RE.test(chosen)) return { ok: false };
  return { ...(await readTrackFile(chosen)), path: chosen };
});

ipcMain.handle("cache:record-path", async (_event, hash: string, filePath: string) => {
  await contentCache.recordPath(String(hash), String(filePath));
  return { ok: true };
});
ipcMain.handle("cache:get-analysis", async (_event, hash: string, version: string) => contentCache.getAnalysis(String(hash), String(version)));
ipcMain.handle("cache:put-analysis", async (_event, hash: string, version: string, result: CachedAnalysis) => {
  if (!/^[a-f0-9]{16,128}$/i.test(String(hash)) || !result?.peaks) return { ok: false };
  await contentCache.putAnalysis(String(hash), String(version), result);
  evictSoon();
  return { ok: true };
});
ipcMain.handle("cache:usage", async () => contentCache.usage());
ipcMain.handle("cache:clear", async () => {
  const result = await contentCache.clear(pinnedHashes());
  return { ...result, usage: await contentCache.usage() };
});

/* ------------------------------------------- close while separating (D45) */

let quitConfirmed = false;
let closing: Promise<void> | null = null;
const trayController = new TrayController({
  host: stemHost,
  window: () => mainWindow,
  quit: () => {
    quitConfirmed = true;
    app.quit();
  },
});

const askKeepGoing = async (): Promise<{ response: number; checkboxChecked: boolean }> => {
  const options: Electron.MessageBoxOptions = {
    type: "question",
    title: CLOSE_DIALOG.title,
    message: CLOSE_DIALOG.message,
    detail: "Separation keeps running at low priority from the tray. Finished parts are saved, so the next launch picks them up either way.",
    buttons: [...CLOSE_DIALOG.buttons],
    defaultId: CLOSE_DIALOG.defaultId,
    cancelId: CLOSE_DIALOG.cancelId,
    checkboxLabel: CLOSE_DIALOG.checkboxLabel,
    checkboxChecked: false,
    noLink: true,
  };
  const win = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null;
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
};

function requestClose(): void {
  if (closing) return;
  closing = (async () => {
    const settings = await settingsStore.get();
    const { result, savePreference } = await resolveClose(
      { busy: stemHost.busy, preference: settings.closeWhileSeparating, quitConfirmed },
      askKeepGoing,
    );
    if (savePreference) await settingsStore.update({ closeWhileSeparating: savePreference });
    if (result.action === "tray") {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app:background", { on: true });
      trayController.enter();
      return;
    }
    quitConfirmed = true;
    app.quit();
  })()
    .catch((error) => {
      console.error("close handling failed", error);
      quitConfirmed = true;
      app.quit();
    })
    .finally(() => {
      closing = null;
    });
}

ipcMain.handle("separation:run", async (event, request: SeparateRequest) => {
  const target = stemModelPath();
  const info = await modelInfo(target);
  if (!info.ready) throw new Error("Stem model is not installed");
  const deck = String(request.deck ?? `sender-${event.sender.id}`);
  const cacheDir = await pickCacheDir(request.trackPath, request.hash, app.getPath("userData"));
  const sender = event.sender;
  try {
    const manifest = await stemHost.run(
      {
        hash: request.hash,
        sampleRate: request.sampleRate,
        left: request.left,
        right: request.right,
        focusFrame: request.focusFrame ?? 0,
        cacheDir,
        title: typeof request.title === "string" ? request.title.slice(0, 200) : undefined,
      },
      {
        deck,
        onRegion: (region) => {
          if (!sender.isDestroyed()) sender.send("separation:region", { ...region, deck });
        },
        onProgress: (progress) => {
          if (!sender.isDestroyed()) sender.send("separation:progress", { ...progress, deck });
        },
      },
    );
    void contentCache.touch(cacheDir, { kind: "stems", hash: request.hash, model: MODEL.id, version: MODEL.version }).then(evictSoon);
    return { ...manifest, provider: stemHost.stats?.provider ?? stemHost.activeProvider, stats: stemHost.stats };
  } catch (error) {
    if ((error as Error).message === "cancelled") return { cancelled: true, hash: request.hash };
    throw error;
  }
});

ipcMain.handle("separation:cancel", (_event, deck: string) => {
  stemHost.release(String(deck));
  return { ok: true };
});

ipcMain.handle("separation:focus", (_event, request: { deck: string; hash: string; frame: number }) => {
  stemHost.focus(String(request.deck), String(request.hash), Number(request.frame) || 0);
  return { ok: true };
});

ipcMain.handle("separation:read", async (_event, dir: string, targetRate?: number) => {
  const manifest = await loadManifestAt(dir);
  if (!manifest) throw new Error("Stem cache is missing or incomplete");
  const rate = Number(targetRate) > 0 ? Number(targetRate) : manifest.sampleRate;
  const result = await readCache(manifest, rate);
  return { manifest, sampleRate: result.sampleRate, frames: result.frames, parts: result.parts };
});

ipcMain.handle("serato:running", () => isSeratoRunning());

ipcMain.handle("serato:write-tags", async (_event, request: SeratoWriteRequest) => {
  if (!request || !Array.isArray(request.tracks)) {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "Invalid tag write request." };
  }
  let rootDir = typeof request.root === "string" ? request.root : null;
  if (!rootDir && request.tracks.some((track) => !path.isAbsolute(track.path))) {
    const openOpts: Electron.OpenDialogOptions = {
      title: "Choose the music folder that contains these tracks",
      properties: ["openDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, written: 0, skipped: 0, undoId: null, detail: "Tag write cancelled." };
    }
    rootDir = result.filePaths[0];
  }
  return writeSeratoTags({ root: rootDir, tracks: request.tracks.slice(0, 5000) });
});

const handleExportLibrary = async (
  _event: unknown,
  request: Partial<SeratoLibraryExportRequest>,
) => {
  if (!request || !request.files) {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "Invalid library export request." };
  }
  let rootDir = typeof request.rootDir === "string" ? request.rootDir : "";
  if (!rootDir) {
    const openOpts: Electron.OpenDialogOptions = {
      title: "Choose folder for _Serato_ library export",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, written: 0, skipped: 0, undoId: null, detail: "Library export cancelled." };
    }
    rootDir = result.filePaths[0];
  }
  return writeSeratoLibraryExport({ rootDir, files: request.files });
};

ipcMain.handle("serato:export-library", handleExportLibrary);
ipcMain.handle("serato:write-library", handleExportLibrary);

const handleSqliteColumns = async (
  _event: unknown,
  request: Partial<SeratoSqliteColumnsRequest>,
) => {
  if (!request || !Array.isArray(request.columns)) {
    return { ok: false, written: 0, skipped: 0, undoId: null, detail: "Invalid SQLite column request." };
  }
  let sqlitePath = typeof request.sqlitePath === "string" ? request.sqlitePath : "";
  if (!sqlitePath) {
    const openOpts: Electron.OpenDialogOptions = {
      title: "Choose Serato master.sqlite / Serato Library.sqlite database",
      properties: ["openFile"],
      filters: [
        { name: "SQLite database", extensions: ["sqlite", "db", "*"] },
      ],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openOpts)
      : await dialog.showOpenDialog(openOpts);
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, written: 0, skipped: 0, undoId: null, detail: "SQLite column sync cancelled." };
    }
    sqlitePath = result.filePaths[0];
  }
  return writeSeratoSqliteColumns({
    sqlitePath,
    columns: request.columns,
    usage: request.usage,
  });
};

ipcMain.handle("serato:apply-crate-columns", handleSqliteColumns);
ipcMain.handle("serato:sqlite-columns", handleSqliteColumns);

ipcMain.handle("serato:undo", () => undoLastSeratoWrite());
ipcMain.handle("serato:undo-library", () => undoLastSeratoWrite());

ipcMain.handle("video:open-output", async (_event, opts?: { fullscreen?: boolean }) => {
  if (!videoOutputWindow || videoOutputWindow.isDestroyed()) {
    videoOutputWindow = new BrowserWindow({
      width: 1280,
      height: 720,
      minWidth: 640,
      minHeight: 360,
      title: "OpenDecks · Video Output",
      backgroundColor: "#000000",
      autoHideMenuBar: true,
      fullscreen: Boolean(opts?.fullscreen),
      webPreferences: {
        preload: path.join(root(), "dist", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    videoOutputWindow.on("closed", () => {
      videoOutputWindow = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("video:output-closed", { open: false, fullscreen: false });
      }
    });
    await videoOutputWindow.loadFile(path.join(root(), "renderer", "video-output.html"));
  } else {
    if (typeof opts?.fullscreen === "boolean") {
      videoOutputWindow.setFullScreen(opts.fullscreen);
    }
    videoOutputWindow.focus();
  }
  return {
    open: Boolean(videoOutputWindow && !videoOutputWindow.isDestroyed()),
    fullscreen: Boolean(videoOutputWindow && !videoOutputWindow.isDestroyed() && videoOutputWindow.isFullScreen()),
  };
});

ipcMain.handle("video:close-output", () => {
  if (videoOutputWindow && !videoOutputWindow.isDestroyed()) {
    videoOutputWindow.close();
    videoOutputWindow = null;
  }
  return { open: false, fullscreen: false };
});

ipcMain.handle("video:fullscreen-output", (_event, fullscreen?: boolean) => {
  if (!videoOutputWindow || videoOutputWindow.isDestroyed()) {
    return { open: false, fullscreen: false };
  }
  const next = typeof fullscreen === "boolean" ? fullscreen : !videoOutputWindow.isFullScreen();
  videoOutputWindow.setFullScreen(next);
  return { open: true, fullscreen: videoOutputWindow.isFullScreen() };
});

ipcMain.handle("video:status-output", () => ({
  open: Boolean(videoOutputWindow && !videoOutputWindow.isDestroyed()),
  fullscreen: Boolean(videoOutputWindow && !videoOutputWindow.isDestroyed() && videoOutputWindow.isFullScreen()),
}));

ipcMain.handle("video:sync-output", (_event, state: unknown) => {
  if (videoOutputWindow && !videoOutputWindow.isDestroyed()) {
    videoOutputWindow.webContents.send("video:output-state", state);
    return { ok: true };
  }
  return { ok: false };
});

// Session tempo transport. Default-off: nothing opens a socket until the
// renderer asks. Backend chosen by setting (D43): "ableton" = clean-room
// Ableton Link (docs/link-cleanroom.md), "opendeck" = opendeck-link/1 fallback
// (docs/mobile/ADR-D34.md).
const linkSettingsFile = (): string => path.join(app.getPath("userData"), "link-settings.json");
let linkManager: LinkManager | null = null;
const requireLinkManager = async (): Promise<LinkManager> => {
  if (linkManager) return linkManager;
  let stored: LinkSettings = normalizeLinkSettings(null);
  try {
    stored = normalizeLinkSettings(JSON.parse(await fs.readFile(linkSettingsFile(), "utf8")));
  } catch {
    /* first run: defaults */
  }
  linkManager ??= new LinkManager({
    settings: stored,
    create: (protocol) => (protocol === "ableton" ? createAbletonLinkNode() : createLinkNode()),
    save: (settings) => fs.writeFile(linkSettingsFile(), JSON.stringify(settings, null, 2)),
  });
  return linkManager;
};

ipcMain.handle("link:status", async () => (await requireLinkManager()).status());
ipcMain.handle("link:enable", async () => (await requireLinkManager()).enable());
ipcMain.handle("link:disable", async () => (await requireLinkManager()).disable());
ipcMain.handle("link:set-tempo", async (_event, bpm: number) => (await requireLinkManager()).setLocalTempo(Number(bpm)));
ipcMain.handle("link:set-playing", async (_event, playing: boolean) => (await requireLinkManager()).setPlaying(Boolean(playing)));
ipcMain.handle("link:settings", async (_event, patch: Partial<LinkSettings>) => (await requireLinkManager()).updateSettings(patch ?? {}));


app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// One instance: launching again while separation runs in the tray brings the
// window back instead of starting a second app (and a second worker).
if (!process.env.OPENDECK_ALLOW_MULTI && !app.requestSingleInstanceLock()) {
  quitConfirmed = true;
  app.quit();
}
app.on("second-instance", () => {
  if (trayController.inBackground) trayController.open();
  else if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("before-quit", (event) => {
  if (quitConfirmed || !stemHost.busy) {
    quitConfirmed = true;
    return;
  }
  // Cmd+Q / taskbar Quit / tray-less quit while separating: same question.
  event.preventDefault();
  requestClose();
});

app.whenReady().then(() => {
  void settingsStore.get().then((settings) => {
    contentCache.setLimit(settings.cacheLimitBytes);
    setTimeout(evictSoon, 15_000);
  });
  const allowMedia = (permission: string): boolean =>
    permission === "media" ||
    permission === "audioCapture" ||
    permission === "display-capture" ||
    permission === "speaker-selection" ||
    // EME for the official players embedded in a deck (D42). Only has an effect
    // on a Widevine-enabled (castlabs ECS) build; stock Electron has no CDM.
    permission === "mediaKeySystem";

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowMedia(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowMedia(permission));

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const { desktopCapturer } = await import("electron");
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    if (!sources.length) {
      callback({});
      return;
    }
    callback({ video: sources[0], audio: "loopback" });
  });

  setupStreaming();
  createWindow();
  // CDJ (Pro DJ Link) and local USB drive detection. Nothing is imported
  // until the user answers the in-app prompt.
  setupDetectedMedia(() => mainWindow)
    .then((manager) => {
      detectedMedia = manager;
    })
    .catch((error) => console.error("detected media setup failed", error));
  app.on("activate", () => {
    if (trayController.inBackground) trayController.open();
    else if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // Build the stem session in the background once the window is up, so the
  // first separation does not pay for it. The worker runs at low priority.
  if (!process.env.OPENDECK_NO_STEM_PREWARM) {
    setTimeout(() => {
      modelInfo(stemModelPath())
        .then((info) => {
          if (info.ready) stemHost.prewarm();
        })
        .catch(() => undefined);
    }, 4000);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  trayController.destroy();
  stemHost.dispose();
  rtmp?.kill();
  void linkManager?.shutdown();
  void detectedMedia?.stop();
});

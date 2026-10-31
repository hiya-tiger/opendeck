import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
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
import { MODEL, findCache, installModel, loadManifestAt, modelInfo, readCache, separateToCache, type SeparateRequest } from "./separation.ts";
import { createLinkNode } from "./link.ts";

const root = (): string => app.getAppPath();

const ALLOWED_HOSTS = [
  "accounts.google.com",
  "music.youtube.com",
  "youtube.com",
  "www.youtube.com",
  "accounts.spotify.com",
  "open.spotify.com",
  "api.spotify.com",
  "gew1-spclient.spotify.com",
  "secure.soundcloud.com",
  "soundcloud.com",
  "api.soundcloud.com",
  "api-v2.soundcloud.com",
  "w.soundcloud.com",
  "login.tidal.com",
  "listen.tidal.com",
  "api.tidal.com",
  "embed.tidal.com",
  "www.deezer.com",
  "api.deezer.com",
  "media.deezer.com",
  "widget.deezer.com",
  "music.apple.com",
  "amp-api.music.apple.com",
  "embed.music.apple.com",
  "play.itunes.apple.com",
  "www.beatport.com",
  "api.beatport.com",
  "embed.beatport.com",
  "www.beatsource.com",
  "api.beatsource.com",
  "embed.beatsource.com",
];

let mainWindow: BrowserWindow | null = null;
let videoOutputWindow: BrowserWindow | null = null;
const providerWindows = new Map<string, BrowserWindow>();
let rtmp: ChildProcessWithoutNullStreams | null = null;
let rtmpKey = "";

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
  mainWindow.loadFile(path.join(root(), "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

const partitionFor = (provider: string): string => `persist:provider-${provider.replace(/[^a-z0-9-]/gi, "")}`;

const sessionFor = (provider: string): Electron.Session => session.fromPartition(partitionFor(provider));

const providerLoginStatus = async (provider: string, hints: string[]): Promise<boolean> => {
  const cookies = await sessionFor(provider).cookies.get({});
  const names = new Set(cookies.map((cookie) => cookie.name));
  return hints.some((hint) => names.has(hint));
};

const openProviderWindow = async (
  provider: string,
  url: string,
  hints: string[],
  purpose: "login" | "player",
): Promise<{ ok: boolean; loggedIn: boolean }> => {
  if (!ALLOWED_HOSTS.includes(new URL(url).host)) {
    return { ok: false, loggedIn: false };
  }
  const existing = providerWindows.get(provider);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    if (purpose === "player") existing.loadURL(url);
    return { ok: true, loggedIn: await providerLoginStatus(provider, hints) };
  }

  const window = new BrowserWindow({
    width: purpose === "login" ? 1120 : 900,
    height: 820,
    title: purpose === "login" ? `Sign in to ${provider}` : "OpenDecks player",
    parent: mainWindow ?? undefined,
    autoHideMenuBar: true,
    webPreferences: {
      partition: partitionFor(provider),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  providerWindows.set(provider, window);
  window.on("closed", () => providerWindows.delete(provider));
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (ALLOWED_HOSTS.includes(new URL(target).host)) return { action: "allow" };
    void shell.openExternal(target);
    return { action: "deny" };
  });
  await window.loadURL(url);

  if (purpose === "login") {
    const deadline = Date.now() + 15 * 60 * 1000;
    const timer = setInterval(async () => {
      if (window.isDestroyed() || Date.now() > deadline) {
        clearInterval(timer);
        return;
      }
      if (await providerLoginStatus(provider, hints)) {
        clearInterval(timer);
        mainWindow?.webContents.send("streaming:login", { provider, loggedIn: true });
      }
    }, 1500);
    window.on("closed", () => clearInterval(timer));
  }
  return { ok: true, loggedIn: await providerLoginStatus(provider, hints) };
};

ipcMain.handle("streaming:login", async (_event, provider: string, url: string, hints: string[]) =>
  openProviderWindow(provider, url, hints, "login"),
);

ipcMain.handle("streaming:open", async (_event, provider: string, url: string, hints: string[]) =>
  openProviderWindow(provider, url, hints, "player"),
);

ipcMain.handle("streaming:status", async (_event, provider: string, hints: string[]) => ({
  loggedIn: await providerLoginStatus(provider, hints),
}));

ipcMain.handle("streaming:logout", async (_event, provider: string) => {
  await sessionFor(provider).clearStorageData();
  providerWindows.get(provider)?.close();
  return { ok: true };
});

ipcMain.handle("streaming:search", async (_event, provider: string, url: string, token?: string) => {
  const target = new URL(url);
  if (!ALLOWED_HOSTS.includes(target.host)) throw new Error("provider host not allowed");
  if (!/^[a-z0-9-]+$/.test(provider)) throw new Error("bad provider id");
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (token && token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  const response = await sessionFor(provider).fetch(url, { headers });
  return { status: response.status, body: await response.text() };
});

ipcMain.handle(
  "streaming:license",
  async (
    _event,
    provider: string,
    licenseUrl: string,
    challenge: Uint8Array,
    token?: string,
  ) => {
    const target = new URL(licenseUrl);
    if (!ALLOWED_HOSTS.includes(target.host)) throw new Error("license host not allowed");
    if (!/^[a-z0-9-]+$/.test(provider)) throw new Error("bad provider id");
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };
    if (token && token.trim()) {
      headers.Authorization = `Bearer ${token.trim()}`;
    }
    const response = await sessionFor(provider).fetch(licenseUrl, {
      method: "POST",
      headers,
      body: Buffer.from(challenge),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { ok: response.ok, status: response.status, license: bytes };
  },
);

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
  return manifest ? { found: true, manifest } : { found: false };
});

ipcMain.handle("separation:run", async (event, request: SeparateRequest) => {
  const target = stemModelPath();
  const info = await modelInfo(target);
  if (!info.ready) throw new Error("Stem model is not installed");
  return separateToCache(request, target, app.getPath("userData"), (progress) => {
    event.sender.send("separation:progress", { ...progress, hash: request.hash });
  });
});

ipcMain.handle("separation:read", async (_event, dir: string) => {
  const manifest = await loadManifestAt(dir);
  if (!manifest) throw new Error("Stem cache is missing or incomplete");
  return { manifest, parts: await readCache(manifest) };
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

// Session tempo transport (opendeck-link/1). Default-off: nothing is created
// until the renderer asks. Not Ableton Link — see docs/mobile/ADR-D34.md.
let linkNode: ReturnType<typeof createLinkNode> | null = null;
const requireLinkNode = (): ReturnType<typeof createLinkNode> => {
  if (!linkNode) linkNode = createLinkNode();
  return linkNode;
};

ipcMain.handle("link:status", () => requireLinkNode().status());
ipcMain.handle("link:enable", async () => requireLinkNode().enable());
ipcMain.handle("link:disable", async () => requireLinkNode().disable());
ipcMain.handle("link:set-tempo", (_event, bpm: number) => requireLinkNode().setLocalTempo(Number(bpm)));


app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(() => {
  const allowMedia = (permission: string): boolean =>
    permission === "media" ||
    permission === "audioCapture" ||
    permission === "display-capture" ||
    permission === "speaker-selection";

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

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  rtmp?.kill();
  void linkNode?.disable();
});

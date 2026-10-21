import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";

const root = (): string => app.getAppPath();



const ALLOWED_HOSTS = [
  "music.youtube.com",
  "youtube.com",
  "www.youtube.com",
  "open.spotify.com",
  "soundcloud.com",
  "listen.tidal.com",
  "www.deezer.com",
  "music.apple.com",
];

let mainWindow: BrowserWindow | null = null;
const providerWindows = new Map<string, BrowserWindow>();
let rtmp: ChildProcessWithoutNullStreams | null = null;
let rtmpKey = "";

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    title: "OpenDeck",
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
    title: purpose === "login" ? `Sign in to ${provider}` : "OpenDeck player",
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

ipcMain.handle("streaming:search", async (_event, provider: string, url: string) => {
  const target = new URL(url);
  if (!ALLOWED_HOSTS.includes(target.host)) throw new Error("provider host not allowed");
  if (!/^[a-z0-9-]+$/.test(provider)) throw new Error("bad provider id");
  const response = await sessionFor(provider).fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  return { status: response.status, body: await response.text() };
});

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
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: "Save mix",
    defaultPath: path.join(app.getPath("music"), name),
    filters: [
      { name: "WebM audio", extensions: ["webm"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
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
});


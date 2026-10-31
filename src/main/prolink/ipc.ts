// Electron glue for detected media (Pro DJ Link + USB drives on this computer).
// Only plain data crosses IPC; track bytes are served by (sourceId, trackId)
// from an imported library, never by a path the renderer supplies.
import { app, ipcMain, type BrowserWindow } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MediaManager } from "./manager.ts";
import { forgetChoice } from "./prompt.ts";
import { DEFAULT_PROLINK_SETTINGS, type ProlinkSettings } from "./types.ts";

const settingsFile = (): string => path.join(app.getPath("userData"), "prolink.json");

async function loadSettings(): Promise<ProlinkSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile(), "utf8")) as Partial<ProlinkSettings>;
    return sanitize(raw, DEFAULT_PROLINK_SETTINGS);
  } catch {
    return { ...DEFAULT_PROLINK_SETTINGS, remembered: {} };
  }
}

function sanitize(raw: Partial<ProlinkSettings>, base: ProlinkSettings): ProlinkSettings {
  const remembered: Record<string, "add" | "ignore"> = {};
  for (const [k, v] of Object.entries(raw.remembered ?? base.remembered ?? {})) {
    if (typeof k === "string" && k.length < 512 && (v === "add" || v === "ignore")) remembered[k] = v;
  }
  const dn = raw.deviceNumber;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
    interface: typeof raw.interface === "string" && raw.interface.length < 128 ? raw.interface : base.interface,
    deviceNumber: dn === "auto" || (Number.isInteger(dn) && (dn as number) >= 1 && (dn as number) <= 32) ? (dn as number | "auto") : base.deviceNumber,
    localDrives: typeof raw.localDrives === "boolean" ? raw.localDrives : base.localDrives,
    remembered,
  };
}

export async function setupDetectedMedia(getWindow: () => BrowserWindow | null): Promise<MediaManager> {
  const manager = new MediaManager({
    settings: await loadSettings(),
    saveSettings: (s) => fs.writeFile(settingsFile(), JSON.stringify(s, null, 2)),
    cacheDir: path.join(app.getPath("userData"), "cdj-cache"),
  });
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  let statusTimer: NodeJS.Timeout | null = null;
  manager.on("change", () => {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      send("djmedia:status", manager.snapshot());
    }, 250);
  });
  manager.on("prompt", (p) => send("djmedia:prompt", p));
  manager.on("prompt-cleared", (id) => send("djmedia:prompt-cleared", id));
  manager.on("library", (lib) => send("djmedia:library", lib));
  manager.on("removed", (id) => send("djmedia:removed", id));

  ipcMain.handle("djmedia:state", () => ({ snapshot: manager.snapshot(), libraries: manager.libraries() }));
  ipcMain.handle("djmedia:settings", async (_e, patch: Partial<ProlinkSettings>) => {
    const safe = sanitize({ ...manager.settings, ...(patch && typeof patch === "object" ? patch : {}), remembered: manager.settings.remembered }, manager.settings);
    await manager.applySettings(safe);
    return manager.snapshot();
  });
  ipcMain.handle("djmedia:forget", async (_e, mediaKey: unknown) => {
    if (typeof mediaKey === "string") await manager.applySettings({ remembered: forgetChoice(manager.settings, mediaKey).remembered });
    else await manager.applySettings({ remembered: {} });
    return manager.snapshot();
  });
  ipcMain.handle("djmedia:respond", (_e, sourceId: unknown, action: unknown, always: unknown) => {
    if (typeof sourceId !== "string" || (action !== "add" && action !== "ignore")) return { ok: false, error: "bad request" };
    return manager.respond(sourceId, action, always === true);
  });
  ipcMain.handle("djmedia:load-track", (event, sourceId: unknown, trackId: unknown) => {
    if (typeof sourceId !== "string" || typeof trackId !== "string") return { ok: false, error: "bad request" };
    let last = 0;
    return manager.loadTrack(sourceId, trackId, (p) => {
      const now = Date.now();
      if (now - last < 100 && p.done < p.total) return;
      last = now;
      if (!event.sender.isDestroyed()) event.sender.send("djmedia:progress", p);
    });
  });
  await manager.start();
  return manager;
}

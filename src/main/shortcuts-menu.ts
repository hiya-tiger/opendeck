/**
 * Main-process side of the Serato keyboard shortcuts (D45):
 *  - an application menu whose accelerators no longer steal Serato's keys
 *    (Ctrl+R reload, Ctrl+0/+/- zoom, Cmd+A/Z on macOS). Those items keep
 *    their label but `registerAccelerator: false`, so the page gets the key;
 *  - Help > Keyboard shortcuts;
 *  - shell helpers for Reveal / Open / Trash and a quit the renderer can ask for
 *    after its own confirmation;
 *  - F10 forwarded to the page on Windows/Linux, where it would otherwise
 *    activate the (hidden) menu bar instead of reaching the page.
 * Menu labels carry no "&" mnemonics, so Alt+letter chords stay with the page.
 */
import { app, BrowserWindow, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

const AUDIO_OR_VIDEO = /\.(mp3|wav|ogg|oga|flac|m4a|aac|aif|aiff|opus|webm|mp4|m4v|mov|mkv|ogv|alac|wma)$/i;

async function isPlainFile(target: unknown): Promise<target is string> {
  if (typeof target !== "string" || !path.isAbsolute(target)) return false;
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

export function installShortcutIpc(): void {
  ipcMain.handle("shell:reveal", async (_event, target: unknown) => {
    if (!(await isPlainFile(target))) return { ok: false, error: "not a file" };
    shell.showItemInFolder(target);
    return { ok: true };
  });
  ipcMain.handle("shell:open", async (_event, target: unknown) => {
    if (!(await isPlainFile(target))) return { ok: false, error: "not a file" };
    const error = await shell.openPath(target);
    return { ok: !error, error: error || undefined };
  });
  // Only media files, and only after the renderer's confirm dialog.
  ipcMain.handle("shell:trash", async (_event, target: unknown) => {
    if (!(await isPlainFile(target)) || !AUDIO_OR_VIDEO.test(target)) return { ok: false, error: "not a media file" };
    try {
      await shell.trashItem(target);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  ipcMain.handle("app:quit", () => {
    app.quit();
    return { ok: true };
  });
  ipcMain.handle("app:zoom", (event, direction: unknown) => {
    const contents = event.sender;
    const level = contents.getZoomLevel();
    contents.setZoomLevel(direction === "in" ? level + 0.5 : direction === "out" ? level - 0.5 : 0);
    return { level: contents.getZoomLevel() };
  });
}

export function buildShortcutMenu(getWindow: () => BrowserWindow | null): Menu {
  const isMac = process.platform === "darwin";
  const send = (channel: string): void => getWindow()?.webContents.send(channel);
  // Shown in the menu for reference, but the page handles the key. macOS
  // ignores registerAccelerator, so there the item gets no accelerator at all
  // (the renderer does Cmd+A / Cmd+Z inside text fields itself).
  const pageKey = (accelerator: string): Partial<MenuItemConstructorOptions> =>
    isMac ? {} : { accelerator, registerAccelerator: false };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { label: "Quit", accelerator: "Ctrl+Q", click: () => app.quit() }],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", ...pageKey("CmdOrCtrl+Z"), click: () => getWindow()?.webContents.undo() },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { label: "Select All", ...pageKey("CmdOrCtrl+A"), click: () => getWindow()?.webContents.selectAll() },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+Alt+R", click: () => getWindow()?.webContents.reload() },
        { label: "Force Reload", click: () => getWindow()?.webContents.reloadIgnoringCache() },
        { role: "toggleDevTools" },
        { type: "separator" },
        { label: "Actual Size", ...pageKey("CmdOrCtrl+Alt+0"), click: () => getWindow()?.webContents.setZoomLevel(0) },
        { label: "Zoom In", ...pageKey("CmdOrCtrl+Alt+="), click: () => { const c = getWindow()?.webContents; c?.setZoomLevel(c.getZoomLevel() + 0.5); } },
        { label: "Zoom Out", ...pageKey("CmdOrCtrl+Alt+-"), click: () => { const c = getWindow()?.webContents; c?.setZoomLevel(c.getZoomLevel() - 0.5); } },
        { type: "separator" },
        { label: "Toggle Full Screen", ...pageKey("F11"), click: () => { const w = getWindow(); w?.setFullScreen(!w.isFullScreen()); } },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, ...(isMac ? [{ role: "zoom" as const }, { role: "front" as const }] : [])],
    },
    {
      label: "Help",
      role: "help",
      submenu: [{ label: "Keyboard Shortcuts", ...pageKey("Shift+/"), click: () => send("shortcuts:show") }],
    },
  ];
  return Menu.buildFromTemplate(template);
}

/** F10 belongs to Serato's right-deck keylock; on Windows/Linux it would open the menu bar. */
export function forwardReservedKeys(win: BrowserWindow): void {
  if (process.platform === "darwin") return;
  win.webContents.on("before-input-event", (event, input) => {
    if (input.code !== "F10" || (input.type !== "keyDown" && input.type !== "keyUp")) return;
    event.preventDefault();
    win.webContents.send("shortcuts:key", {
      type: input.type,
      code: input.code,
      key: input.key,
      control: input.control,
      meta: input.meta,
      shift: input.shift,
      alt: input.alt,
      isAutoRepeat: input.isAutoRepeat,
    });
  });
}

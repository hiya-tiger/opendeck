/**
 * Electron side of "Keep going in tray" (D45): hides the window to the system
 * tray (macOS: menu bar extra, and the dock icon stays), lowers the stem
 * worker's priority and threads, shows progress with Open / Pause / Quit, and
 * notifies when the queue is done. The decisions themselves live in
 * close-policy.ts (unit-tested); this file only drives Electron.
 */
import { Menu, Notification, Tray, nativeImage, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import os from "node:os";
import type { StemActivity, StemHost } from "../stems/host.ts";
import { backgroundThreads, doneNotice, trayMenuModel, trayStatus } from "./close-policy.ts";

/** Two-ring brand mark drawn into a BGRA bitmap, so no icon file has to ship. */
const drawIcon = (size: number, template: boolean): Electron.NativeImage => {
  const data = Buffer.alloc(size * size * 4);
  const rings = [
    { cx: size * 0.36, cy: size * 0.5, alpha: 255 },
    { cx: size * 0.64, cy: size * 0.5, alpha: 150 },
  ];
  const radius = size * 0.26;
  const width = Math.max(1.2, size / 11);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let a = 0;
      for (const ring of rings) {
        const d = Math.abs(Math.hypot(x + 0.5 - ring.cx, y + 0.5 - ring.cy) - radius);
        const cover = Math.max(0, Math.min(1, width / 2 + 0.5 - d));
        a = Math.max(a, cover * ring.alpha);
      }
      const i = (y * size + x) * 4;
      // BGRA. Template images are black + alpha (macOS tints them).
      const [r, g, b] = template ? [0, 0, 0] : [0x4f, 0x6b, 0xff];
      data[i] = b;
      data[i + 1] = g;
      data[i + 2] = r;
      data[i + 3] = Math.round(a);
    }
  }
  return nativeImage.createFromBitmap(data, { width: size, height: size });
};

const trayIcon = (): Electron.NativeImage => {
  const mac = process.platform === "darwin";
  const image = drawIcon(mac ? 18 : 16, mac);
  const hi = drawIcon(mac ? 36 : 32, mac);
  image.addRepresentation({ scaleFactor: 2, width: hi.getSize().width, height: hi.getSize().height, buffer: hi.toBitmap() });
  if (mac) image.setTemplateImage(true);
  return image;
};

export interface TrayControllerOptions {
  host: StemHost;
  window: () => BrowserWindow | null;
  /** Called by tray "Quit" and the auto-quit after a finished background queue. */
  quit: () => void;
  /** Seconds after the "Stems ready" notification before the app quits by itself. */
  autoQuitSeconds?: number;
}

export class TrayController {
  private tray: Tray | null = null;
  private active = false;
  private finished: Array<{ title: string; ok: boolean }> = [];
  private autoQuit: ReturnType<typeof setTimeout> | null = null;
  private lastMenuKey = "";
  private readonly options: TrayControllerOptions;

  constructor(options: TrayControllerOptions) {
    this.options = options;
    options.host.onActivity((activity) => this.render(activity));
    options.host.onJobDone((job) => {
      if (!this.active) return;
      this.finished.push({ title: job.title, ok: job.ok });
      if (!options.host.busy) this.queueDone();
    });
  }

  get inBackground(): boolean {
    return this.active;
  }

  /** "Keep going in tray". */
  enter(): void {
    const { host } = this.options;
    this.active = true;
    this.finished = [];
    const win = this.options.window();
    win?.hide();
    const cores = os.availableParallelism?.() ?? os.cpus().length;
    host.setBackground(true, backgroundThreads(cores));
    // Windows: the process priority class covers every thread at once.
    const pid = host.workerPid;
    if (pid) {
      try {
        os.setPriority(pid, os.constants.priority.PRIORITY_LOW);
      } catch {
        // not permitted
      }
    }
    if (!this.tray) {
      this.tray = new Tray(trayIcon());
      this.tray.on("click", () => {
        if (process.platform !== "darwin") this.open();
      });
    }
    this.render(host.activity());
    if (!host.busy) this.queueDone();
  }

  /** Window back: foreground priority, tray removed. */
  open(): void {
    const { host } = this.options;
    if (this.autoQuit) clearTimeout(this.autoQuit);
    this.autoQuit = null;
    this.active = false;
    host.setBackground(false);
    const pid = host.workerPid;
    if (pid) {
      try {
        os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // raising priority back may need privileges (Linux/macOS); the worker keeps LOW
      }
    }
    const win = this.options.window();
    if (win) {
      win.show();
      win.focus();
    }
    this.destroy();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
    this.lastMenuKey = "";
  }

  private render(activity: StemActivity): void {
    if (!this.tray || !this.active) return;
    const model = trayMenuModel(activity);
    const key = JSON.stringify(model);
    if (key === this.lastMenuKey) return;
    this.lastMenuKey = key;
    const { host } = this.options;
    const template: MenuItemConstructorOptions[] = model.map((item) => {
      if (item.id === "separator") return { type: "separator" };
      const click =
        item.id === "open"
          ? () => this.open()
          : item.id === "pause"
            ? () => host.setPaused(!host.isPaused)
            : item.id === "quit"
              ? () => this.options.quit()
              : undefined;
      return { label: item.label, enabled: item.enabled, click };
    });
    this.tray.setToolTip(`OpenDecks · ${trayStatus(activity)}`);
    if (process.platform === "darwin") this.tray.setTitle(activity.jobs.length ? `${Math.round(activity.jobs.reduce((s, j) => s + j.percent, 0) / activity.jobs.length)}%` : "");
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  private queueDone(): void {
    const notice = doneNotice(this.finished.length ? this.finished : [{ title: "Your tracks", ok: true }]);
    if (Notification.isSupported()) {
      const note = new Notification({ title: notice.title, body: notice.body, silent: false });
      note.on("click", () => this.open());
      note.show();
    }
    this.render(this.options.host.activity());
    // The user chose to close the app: once the work is done, finish closing,
    // unless they open the window again first.
    if (this.autoQuit) clearTimeout(this.autoQuit);
    this.autoQuit = setTimeout(() => {
      if (this.active) this.options.quit();
    }, (this.options.autoQuitSeconds ?? 20) * 1000);
  }
}

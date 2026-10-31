// Watches for removable drives plugged into this computer.
//   Windows: cheap drive-letter poll; when the set changes, PowerShell (or
//            wmic as a fallback) classifies letters as USB / removable.
//   macOS:   /Volumes (fs.watch + poll), skipping the boot-volume symlink and
//            anything diskutil does not report as external / removable / USB.
//   Linux:   /media/$USER, /run/media/$USER and /media/<label> mount points.
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LocalVolume {
  /** Mount root; also the identity of this mount while plugged in. */
  root: string;
  label: string;
  serial?: string;
  totalBytes?: number;
}

export interface VolumeScanner {
  scan(): Promise<LocalVolume[]>;
}

export function diffVolumes(prev: Map<string, LocalVolume>, next: LocalVolume[]): { added: LocalVolume[]; removed: LocalVolume[] } {
  const nextRoots = new Set(next.map((v) => v.root));
  const added = next.filter((v) => !prev.has(v.root));
  const removed = [...prev.values()].filter((v) => !nextRoots.has(v.root));
  return { added, removed };
}

const run = (cmd: string, args: string[], timeout = 8000): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });

async function totalBytes(root: string): Promise<number | undefined> {
  try {
    const st = await (fs as unknown as { statfs?: (p: string) => Promise<{ bsize: number; blocks: number }> }).statfs?.(root);
    return st ? st.bsize * st.blocks : undefined;
  } catch {
    return undefined;
  }
}

export class WindowsScanner implements VolumeScanner {
  private lastLetters = "";
  private lastResult: LocalVolume[] = [];

  async scan(): Promise<LocalVolume[]> {
    const letters: string[] = [];
    for (let c = 68; c <= 90; c++) {
      // D: .. Z: (A/B are floppies, C is the system drive)
      const letter = String.fromCharCode(c);
      try {
        await fs.access(`${letter}:\\`);
        letters.push(letter);
      } catch {
        // not present
      }
    }
    const sig = letters.join("");
    if (sig === this.lastLetters) return this.lastResult;
    this.lastLetters = sig;
    this.lastResult = letters.length ? await this.classify(new Set(letters)) : [];
    return this.lastResult;
  }

  private async classify(present: Set<string>): Promise<LocalVolume[]> {
    const ps =
      "$ErrorActionPreference='SilentlyContinue';" +
      "Get-Partition | Where-Object DriveLetter | ForEach-Object {" +
      "$d = Get-Disk -Number $_.DiskNumber; $v = Get-Volume -Partition $_;" +
      "[pscustomobject]@{Letter=[string]$_.DriveLetter; Bus=[string]$d.BusType; Type=[string]$v.DriveType; Label=[string]$v.FileSystemLabel; Size=[double]$v.Size; Serial=[string]$d.SerialNumber}" +
      "} | ConvertTo-Json -Compress";
    try {
      const raw = (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps])).trim();
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { Letter: string; Bus: string; Type: string; Label: string; Size: number; Serial: string }[];
        return rows
          .filter((r) => present.has(r.Letter) && (r.Bus === "USB" || r.Type === "Removable"))
          .map((r) => ({ root: `${r.Letter}:\\`, label: r.Label || `${r.Letter}:`, serial: r.Serial?.trim() || undefined, totalBytes: r.Size || undefined }));
      }
    } catch {
      // fall through to wmic
    }
    try {
      const raw = await run("wmic", ["logicaldisk", "where", "drivetype=2", "get", "deviceid,volumename,size,volumeserialnumber", "/format:csv"]);
      const out: LocalVolume[] = [];
      for (const line of raw.split(/\r?\n/)) {
        const cols = line.split(",");
        if (cols.length < 5 || cols[1] === "DeviceID") continue;
        const [, deviceId, size, label, serial] = cols;
        const letter = deviceId.replace(":", "");
        if (!present.has(letter)) continue;
        out.push({ root: `${letter}:\\`, label: label?.trim() || deviceId, serial: serial?.trim() || undefined, totalBytes: Number(size) || undefined });
      }
      return out;
    } catch {
      return [];
    }
  }
}

export class MacScanner implements VolumeScanner {
  private known = new Map<string, boolean>();
  readonly base: string;
  constructor(base = "/Volumes") {
    this.base = base;
  }

  async scan(): Promise<LocalVolume[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.base);
    } catch {
      return [];
    }
    const out: LocalVolume[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const root = path.join(this.base, name);
      try {
        const st = await fs.lstat(root);
        if (st.isSymbolicLink() || !st.isDirectory()) continue; // the boot volume is a symlink to /
      } catch {
        continue;
      }
      if (!this.known.has(root)) this.known.set(root, await this.isRemovable(root));
      if (!this.known.get(root)) continue;
      out.push({ root, label: name, totalBytes: await totalBytes(root) });
    }
    for (const root of [...this.known.keys()]) if (!out.some((v) => v.root === root) && !names.includes(path.basename(root))) this.known.delete(root);
    return out;
  }

  private async isRemovable(root: string): Promise<boolean> {
    try {
      const info = await run("diskutil", ["info", root]);
      if (/Protocol:\s+(Disk Image|SMB|AFP|NFS)/i.test(info)) return false;
      return /Protocol:\s+USB/i.test(info) || /Removable Media:\s+Removable/i.test(info) || /Device Location:\s+External/i.test(info);
    } catch {
      return true;
    }
  }
}

export class LinuxScanner implements VolumeScanner {
  readonly bases: string[];
  constructor(bases?: string[]) {
    const user = os.userInfo().username;
    this.bases = bases ?? [`/media/${user}`, `/run/media/${user}`, "/media"];
  }

  async scan(): Promise<LocalVolume[]> {
    const out = new Map<string, LocalVolume>();
    for (const base of this.bases) {
      let names: string[];
      let baseDev: number;
      try {
        names = await fs.readdir(base);
        baseDev = (await fs.stat(base)).dev;
      } catch {
        continue;
      }
      for (const name of names) {
        const root = path.join(base, name);
        try {
          const st = await fs.stat(root);
          if (!st.isDirectory() || st.dev === baseDev) continue; // not a mount point
        } catch {
          continue;
        }
        if (!out.has(root)) out.set(root, { root, label: name, totalBytes: await totalBytes(root) });
      }
    }
    return [...out.values()];
  }
}

export function defaultScanner(): VolumeScanner | null {
  if (process.platform === "win32") return new WindowsScanner();
  if (process.platform === "darwin") return new MacScanner();
  if (process.platform === "linux") return new LinuxScanner();
  return null;
}

export class VolumeWatcher extends EventEmitter {
  private current = new Map<string, LocalVolume>();
  private timer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private scanning = false;
  private pendingRescan = false;
  readonly scanner: VolumeScanner;
  readonly intervalMs: number;

  constructor(scanner: VolumeScanner, intervalMs = 2500) {
    super();
    this.scanner = scanner;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    void this.rescan();
    this.timer = setInterval(() => void this.rescan(), this.intervalMs);
    if (this.scanner instanceof MacScanner) {
      try {
        this.watcher = watch(this.scanner.base, () => void this.rescan());
      } catch {
        // polling still covers it
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
    for (const v of this.current.values()) this.emit("removed", v);
    this.current.clear();
  }

  list(): LocalVolume[] {
    return [...this.current.values()];
  }

  async rescan(): Promise<void> {
    if (this.scanning) {
      this.pendingRescan = true;
      return;
    }
    this.scanning = true;
    try {
      const next = await this.scanner.scan();
      const { added, removed } = diffVolumes(this.current, next);
      for (const v of removed) {
        this.current.delete(v.root);
        this.emit("removed", v);
      }
      for (const v of added) {
        this.current.set(v.root, v);
        this.emit("added", v);
      }
    } catch (error) {
      this.emit("error", error);
    } finally {
      this.scanning = false;
      if (this.pendingRescan) {
        this.pendingRescan = false;
        void this.rescan();
      }
    }
  }
}

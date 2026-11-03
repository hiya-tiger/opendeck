/**
 * Session/cache/close settings and the saved session file (D45). Plain JSON in
 * userData; every read is normalised so a hand-edited or older file never
 * breaks start-up.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { CACHE_LIMIT_CHOICES, ContentCache, DEFAULT_CACHE_LIMIT } from "./cache/content-cache.ts";
import type { ClosePreference } from "./background/close-policy.ts";

export interface AppSettings {
  /** Restore the last session on launch without asking. */
  alwaysResume: boolean;
  /** What closing does while stems are separating ("ask" shows the dialog). */
  closeWhileSeparating: ClosePreference;
  /** Content cache size limit in bytes. */
  cacheLimitBytes: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  alwaysResume: false,
  closeWhileSeparating: "ask",
  cacheLimitBytes: DEFAULT_CACHE_LIMIT,
};

export const normalizeSettings = (raw: unknown): AppSettings => {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<AppSettings>;
  const close = value.closeWhileSeparating;
  return {
    alwaysResume: value.alwaysResume === true,
    closeWhileSeparating: close === "tray" || close === "quit" ? close : "ask",
    cacheLimitBytes: ContentCache.clampLimit(Number(value.cacheLimitBytes) || DEFAULT_CACHE_LIMIT),
  };
};

export const cacheLimitChoices = (): number[] => [...CACHE_LIMIT_CHOICES];

/** Largest saved session we accept (decks + mixer + library view is a few KB). */
export const MAX_SESSION_BYTES = 512 * 1024;

export class SettingsStore {
  private readonly file: string;
  private current: AppSettings | null = null;

  constructor(dir: string) {
    this.file = path.join(dir, "opendecks-settings.json");
  }

  async get(): Promise<AppSettings> {
    if (this.current) return this.current;
    try {
      this.current = normalizeSettings(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch {
      this.current = { ...DEFAULT_SETTINGS };
    }
    return this.current;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = normalizeSettings({ ...(await this.get()), ...(patch ?? {}) });
    this.current = next;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(next, null, 2));
    return next;
  }
}

export class SessionFile {
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "last-session.json");
  }

  async read(): Promise<unknown | null> {
    try {
      const text = await fs.readFile(this.file, "utf8");
      if (text.length > MAX_SESSION_BYTES) return null;
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  /** Atomic write (temp + rename), so a crash mid-save keeps the previous session. */
  async write(session: unknown): Promise<boolean> {
    const text = JSON.stringify(session ?? null);
    if (text.length > MAX_SESSION_BYTES) return false;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, text);
    await fs.rename(temp, this.file);
    return true;
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

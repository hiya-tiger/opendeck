// Decision logic for detected media: never import silently unless the user
// chose "Always do this for this drive" for that drive's mediaKey.
import type { MediaOrigin, MediaPrompt, ProlinkSettings } from "./types.ts";

export type MediaDecision = "import" | "ignore" | "prompt";

export function decideMediaAction(mediaKey: string, settings: Pick<ProlinkSettings, "remembered">): MediaDecision {
  const remembered = settings.remembered?.[mediaKey];
  if (remembered === "add") return "import";
  if (remembered === "ignore") return "ignore";
  return "prompt";
}

/** Returns new settings with the choice remembered (always) or unchanged. */
export function rememberChoice<T extends Pick<ProlinkSettings, "remembered">>(settings: T, mediaKey: string, action: "add" | "ignore", always: boolean): T {
  if (!always || !mediaKey) return settings;
  return { ...settings, remembered: { ...(settings.remembered ?? {}), [mediaKey]: action } };
}

export function forgetChoice<T extends Pick<ProlinkSettings, "remembered">>(settings: T, mediaKey: string): T {
  const next = { ...(settings.remembered ?? {}) };
  delete next[mediaKey];
  return { ...settings, remembered: next };
}

const clean = (s: string): string => s.replace(/[\u0000-\u001f]/g, "").trim();

/** Stable identity for media in a CDJ slot (same stick in another player matches). */
export function cdjMediaKey(d: { name: string; created?: string; totalBytes?: number; trackCount?: number }): string {
  return `cdj:${clean(d.name).toLowerCase()}|${clean(d.created ?? "")}|${d.totalBytes ?? 0}|${d.trackCount ?? 0}`;
}

/** Stable identity for a drive on this computer. */
export function localMediaKey(d: { label: string; serial?: string; totalBytes?: number }): string {
  if (d.serial) return `local:serial:${clean(d.serial).toLowerCase()}`;
  return `local:${clean(d.label).toLowerCase()}|${d.totalBytes ?? 0}`;
}

export function promptMessage(p: { origin: MediaOrigin; mediaName: string; where: string; trackCount: number | null; slot?: "usb" | "sd" }): string {
  const what = p.slot === "sd" ? "SD card" : "USB drive";
  const name = p.mediaName ? `'${p.mediaName}'` : "(unnamed)";
  const count = p.trackCount === null ? "" : ` (${p.trackCount} track${p.trackCount === 1 ? "" : "s"})`;
  return `${what} ${name} found on ${p.where}${count}. Add it to your library?`;
}

export function buildPrompt(p: Omit<MediaPrompt, "message">): MediaPrompt {
  return { ...p, message: promptMessage(p) };
}

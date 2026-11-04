// Session permission policy (D46).
//
// Electron grants every permission when a session has no handler, and denies
// whatever a custom handler does not allow. The app used to install a handler
// that only allowed audio/video capture, so Web MIDI ("midi" / "midiSysex")
// and WebUSB / WebHID / Web Serial were refused in the Electron build.
//
// Policy:
// - Capture permissions keep the old behaviour (allowed).
// - Device permissions (MIDI, USB, HID, serial) are granted only to the app's
//   own pages (file:// with no host), from the top frame of a window that
//   itself shows an app page. Streaming iframes and provider windows (remote
//   https origins) never get them.
// - Provider sessions (persist:provider-*) keep Electron's default for
//   everything else but are refused device permissions.
//
// Nothing here touches USB *drive* import: that runs in the main process
// (prolink/volumes.ts) and still always asks before importing a drive.
import type { Session, WebContents } from "electron";

export const DEVICE_PERMISSIONS: ReadonlySet<string> = new Set(["midi", "midiSysex", "usb", "hid", "serial"]);
export const CAPTURE_PERMISSIONS: ReadonlySet<string> = new Set(["media", "audioCapture", "display-capture", "speaker-selection"]);
export const DEVICE_TYPES: ReadonlySet<string> = new Set(["usb", "hid", "serial"]);

/** True for a page the app ships: a local file:// URL (or the bare file origin). */
export function isAppUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  // Chromium reports the opaque file origin as "file://" or "file:///".
  if (url === "file://" || url === "file:///") return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // A host means a UNC / network share, which is not the installed app.
  return parsed.protocol === "file:" && parsed.host === "";
}

export interface PermissionContext {
  permission: string;
  /** URL (or origin) of the frame asking. */
  requestingUrl?: string | null;
  /** False when an iframe asks. Unknown is treated as top frame only if every URL is the app's. */
  isMainFrame?: boolean;
  /** Origin of the top-level page embedding the requester, when Chromium gives one. */
  embeddingOrigin?: string | null;
  /** URL of the window (webContents) the request came from. */
  webContentsUrl?: string | null;
}

export function allowPermission(ctx: PermissionContext, alsoAllow: readonly string[] = []): boolean {
  if (CAPTURE_PERMISSIONS.has(ctx.permission)) return true;
  if (alsoAllow.includes(ctx.permission) && !DEVICE_PERMISSIONS.has(ctx.permission)) return true;
  if (!DEVICE_PERMISSIONS.has(ctx.permission)) return false;
  if (ctx.isMainFrame === false) return false;
  if (!isAppUrl(ctx.requestingUrl)) return false;
  if (ctx.embeddingOrigin && !isAppUrl(ctx.embeddingOrigin)) return false;
  if (ctx.webContentsUrl && !isAppUrl(ctx.webContentsUrl)) return false;
  return true;
}

/** Provider (remote site) sessions: Electron's default, minus device access. */
export function allowRemotePermission(permission: string): boolean {
  return !DEVICE_PERMISSIONS.has(permission);
}

export function allowDevice(deviceType: string, origin: string | null | undefined): boolean {
  return DEVICE_TYPES.has(deviceType) && isAppUrl(origin);
}

/**
 * Device chooser for navigator.usb/hid/serial.requestDevice. Chromium has
 * already applied the page's filters, and the app has no chooser UI, so an
 * app page gets the first match; anything else gets none.
 */
export function chooseDevice<T>(items: readonly T[], requesterUrl: string | null | undefined, idOf: (item: T) => string): string {
  if (!isAppUrl(requesterUrl) || !items.length) return "";
  return idOf(items[0]) || "";
}

const urlOf = (contents: WebContents | null | undefined): string | null => {
  try {
    return contents && !contents.isDestroyed() ? contents.getURL() : null;
  } catch {
    return null;
  }
};

type FrameLike = { url?: string } | null | undefined;
const frameUrl = (frame: FrameLike, fallback: string | null): string | null => {
  try {
    return frame?.url || fallback;
  } catch {
    return fallback;
  }
};

/**
 * The app's own session (defaultSession): main window and video output.
 * `alsoAllow` lists extra non-device permissions granted to any origin, as
 * before D46 (feat/in-player-streaming passes "mediaKeySystem" for D42).
 */
export function installAppPermissions(ses: Session, alsoAllow: readonly string[] = []): void {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const d = (details ?? {}) as { requestingUrl?: string; isMainFrame?: boolean };
    callback(
      allowPermission({
        permission,
        requestingUrl: d.requestingUrl,
        isMainFrame: d.isMainFrame,
        webContentsUrl: urlOf(contents),
      }, alsoAllow),
    );
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const d = (details ?? {}) as { requestingUrl?: string; isMainFrame?: boolean; embeddingOrigin?: string };
    return allowPermission({
      permission,
      requestingUrl: d.requestingUrl || requestingOrigin,
      isMainFrame: d.isMainFrame,
      embeddingOrigin: d.embeddingOrigin,
      webContentsUrl: urlOf(contents),
    }, alsoAllow);
  });
  ses.setDevicePermissionHandler((details) => allowDevice(details.deviceType, details.origin));

  ses.on("select-usb-device", (event, details, callback) => {
    event.preventDefault();
    callback(chooseDevice(details.deviceList, frameUrl(details.frame as FrameLike, null), (d) => d.deviceId));
  });
  ses.on("select-hid-device", (event, details, callback) => {
    event.preventDefault();
    callback(chooseDevice(details.deviceList, frameUrl(details.frame as FrameLike, null), (d) => d.deviceId));
  });
  ses.on("select-serial-port", (event, portList, contents, callback) => {
    event.preventDefault();
    callback(chooseDevice(portList, urlOf(contents), (p) => p.portId));
  });
}

/** Sessions that load remote sites (provider sign-in / player windows). */
export function installRemotePermissions(ses: Session): void {
  ses.setPermissionRequestHandler((_contents, permission, callback) => callback(allowRemotePermission(permission)));
  ses.setPermissionCheckHandler((_contents, permission) => allowRemotePermission(permission));
  ses.setDevicePermissionHandler(() => false);
}

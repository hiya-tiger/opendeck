import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  allowDevice,
  allowPermission,
  allowRemotePermission,
  chooseDevice,
  installAppPermissions,
  installRemotePermissions,
  isAppUrl,
} from "../src/main/permissions.ts";
import { driveAccessError } from "../src/main/prolink/volumes.ts";

const APP = "file:///C:/Program%20Files/OpenDecks/resources/app/renderer/index.html";
const MAC_APP = "file:///Applications/OpenDecks.app/Contents/Resources/app/renderer/index.html";
const EMBED = "https://w.soundcloud.com/player/?url=x";

describe("isAppUrl", () => {
  test("local file pages and the bare file origin are the app", () => {
    assert.equal(isAppUrl(APP), true);
    assert.equal(isAppUrl(MAC_APP), true);
    assert.equal(isAppUrl("file://"), true);
    assert.equal(isAppUrl("file:///"), true);
  });
  test("remote, UNC, empty and junk are not", () => {
    for (const url of [EMBED, "https://open.spotify.com/", "http://localhost:5173/", "file://server/share/index.html", "", null, undefined, "not a url", "data:text/html,x", "about:blank"]) {
      assert.equal(isAppUrl(url as string), false, String(url));
    }
  });
});

describe("allowPermission", () => {
  test("Web MIDI (with and without sysex) is granted to the app's top frame", () => {
    for (const permission of ["midi", "midiSysex"]) {
      assert.equal(allowPermission({ permission, requestingUrl: APP, isMainFrame: true, webContentsUrl: APP }), true, permission);
      assert.equal(allowPermission({ permission, requestingUrl: "file:///", webContentsUrl: MAC_APP }), true, permission + " via origin");
    }
  });
  test("WebUSB / WebHID / Web Serial are granted to the app only", () => {
    for (const permission of ["usb", "hid", "serial"]) {
      assert.equal(allowPermission({ permission, requestingUrl: APP, isMainFrame: true }), true);
      assert.equal(allowPermission({ permission, requestingUrl: EMBED, isMainFrame: true }), false);
    }
  });
  test("a streaming iframe inside the app window is refused", () => {
    assert.equal(allowPermission({ permission: "midiSysex", requestingUrl: EMBED, isMainFrame: false, webContentsUrl: APP }), false);
    assert.equal(allowPermission({ permission: "midi", requestingUrl: EMBED, embeddingOrigin: "file://", webContentsUrl: APP }), false);
    // Even if the iframe were a file:// page, a sub-frame does not get devices.
    assert.equal(allowPermission({ permission: "midi", requestingUrl: APP, isMainFrame: false, webContentsUrl: APP }), false);
  });
  test("an app URL embedded in a remote page, or a remote window, is refused", () => {
    assert.equal(allowPermission({ permission: "midi", requestingUrl: APP, embeddingOrigin: "https://evil.example" }), false);
    assert.equal(allowPermission({ permission: "midi", requestingUrl: APP, webContentsUrl: "https://open.spotify.com/" }), false);
  });
  test("capture permissions keep the old behaviour; everything else stays denied", () => {
    for (const permission of ["media", "audioCapture", "display-capture", "speaker-selection"]) {
      assert.equal(allowPermission({ permission, requestingUrl: APP }), true, permission);
    }
    for (const permission of ["geolocation", "notifications", "openExternal", "clipboard-read", "unknown"]) {
      assert.equal(allowPermission({ permission, requestingUrl: APP, isMainFrame: true }), false, permission);
    }
  });
});

describe("extra permissions (D42 mediaKeySystem)", () => {
  test("alsoAllow grants a non-device permission, never a device one", () => {
    assert.equal(allowPermission({ permission: "mediaKeySystem", requestingUrl: EMBED, isMainFrame: false }), false);
    assert.equal(allowPermission({ permission: "mediaKeySystem", requestingUrl: EMBED, isMainFrame: false }, ["mediaKeySystem"]), true);
    assert.equal(allowPermission({ permission: "midi", requestingUrl: EMBED, isMainFrame: false }, ["mediaKeySystem"]), false);
    assert.equal(allowPermission({ permission: "midi", requestingUrl: EMBED, isMainFrame: false }, ["midi"]), false);
  });
});

describe("devices and remote sessions", () => {
  test("device permission handler only trusts the app origin", () => {
    assert.equal(allowDevice("usb", "file://"), true);
    assert.equal(allowDevice("hid", "file:///"), true);
    assert.equal(allowDevice("serial", "https://www.beatport.com"), false);
    assert.equal(allowDevice("bluetooth", "file://"), false);
  });
  test("device chooser picks the first filtered match for the app, none otherwise", () => {
    const list = [{ deviceId: "a" }, { deviceId: "b" }];
    assert.equal(chooseDevice(list, APP, (d) => d.deviceId), "a");
    assert.equal(chooseDevice(list, EMBED, (d) => d.deviceId), "");
    assert.equal(chooseDevice([], APP, (d: { deviceId: string }) => d.deviceId), "");
  });
  test("provider sessions keep the defaults but never get devices", () => {
    for (const p of ["midi", "midiSysex", "usb", "hid", "serial"]) assert.equal(allowRemotePermission(p), false, p);
    for (const p of ["mediaKeySystem", "media", "fullscreen"]) assert.equal(allowRemotePermission(p), true, p);
  });
});

/** Minimal stand-in for an Electron Session, recording the handlers set on it. */
function fakeSession() {
  const h: Record<string, any> = {};
  const listeners: Record<string, any> = {};
  return {
    h,
    listeners,
    setPermissionRequestHandler: (fn: any) => (h.request = fn),
    setPermissionCheckHandler: (fn: any) => (h.check = fn),
    setDevicePermissionHandler: (fn: any) => (h.device = fn),
    on: (name: string, fn: any) => (listeners[name] = fn),
  };
}
const contents = (url: string) => ({ isDestroyed: () => false, getURL: () => url });

describe("installAppPermissions wiring", () => {
  test("the request handler answers MIDI for the app and refuses an embed", async () => {
    const ses = fakeSession();
    installAppPermissions(ses as any);
    const ask = (permission: string, details: object, url = APP) =>
      new Promise<boolean>((resolve) => ses.h.request(contents(url), permission, resolve, details));
    assert.equal(await ask("midiSysex", { requestingUrl: APP, isMainFrame: true }), true);
    assert.equal(await ask("midi", { requestingUrl: EMBED, isMainFrame: false }), false);
    assert.equal(await ask("media", { requestingUrl: APP, isMainFrame: true }), true);
  });
  test("the check handler uses requestingOrigin when no URL is given", () => {
    const ses = fakeSession();
    installAppPermissions(ses as any);
    assert.equal(ses.h.check(contents(APP), "midi", "file:///", { isMainFrame: true }), true);
    assert.equal(ses.h.check(contents(APP), "midi", "https://w.soundcloud.com", { isMainFrame: false }), false);
    assert.equal(ses.h.check(null, "usb", "file:///", {}), true);
  });
  test("device and chooser handlers are installed", () => {
    const ses = fakeSession();
    installAppPermissions(ses as any);
    assert.equal(ses.h.device({ deviceType: "usb", origin: "file://" }), true);
    assert.equal(ses.h.device({ deviceType: "usb", origin: "https://x.example" }), false);
    let prevented = false;
    let picked = "?";
    ses.listeners["select-usb-device"]({ preventDefault: () => (prevented = true) }, { deviceList: [{ deviceId: "u1" }], frame: { url: APP } }, (id: string) => (picked = id));
    assert.equal(prevented, true);
    assert.equal(picked, "u1");
    ses.listeners["select-hid-device"]({ preventDefault() {} }, { deviceList: [{ deviceId: "h1" }], frame: { url: EMBED } }, (id: string) => (picked = id));
    assert.equal(picked, "");
    ses.listeners["select-serial-port"]({ preventDefault() {} }, [{ portId: "s1" }], contents(APP), (id: string) => (picked = id));
    assert.equal(picked, "s1");
  });
  test("remote sessions refuse devices outright", async () => {
    const ses = fakeSession();
    installRemotePermissions(ses as any);
    const ask = (p: string) => new Promise<boolean>((resolve) => ses.h.request(contents(EMBED), p, resolve, {}));
    assert.equal(await ask("midi"), false);
    assert.equal(await ask("mediaKeySystem"), true);
    assert.equal(ses.h.device({ deviceType: "usb", origin: "file://" }), false);
  });
});

describe("driveAccessError", () => {
  const eperm = Object.assign(new Error("EPERM: operation not permitted, open '/Volumes/X/PIONEER'"), { code: "EPERM" });
  test("explains the macOS Removable Volumes permission", () => {
    assert.match(driveAccessError(eperm, "darwin"), /Removable Volumes/);
  });
  test("explains Windows refusals", () => {
    assert.match(driveAccessError(Object.assign(new Error("x"), { code: "EACCES" }), "win32"), /BitLocker/);
  });
  test("other errors pass through", () => {
    assert.equal(driveAccessError(new Error("bad pdb"), "darwin"), "bad pdb");
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { XdrReader, XdrWriter } from "../src/main/prolink/xdr.ts";
import { authUnix, decodeCall, decodeReply, encodeAcceptedReply, encodeCall, encodeDeniedReply, AUTH_UNIX } from "../src/main/prolink/rpc.ts";
import {
  buildCdjStatus,
  buildConflict,
  buildKeepalive,
  buildMediaQuery,
  buildMediaResponse,
  exportPathFor,
  parseAnnounce,
  parseCdjStatus,
  parseMediaQuery,
  parseMediaResponse,
  KIND_KEEPALIVE,
  KIND_CONFLICT,
  SLOT_USB,
} from "../src/main/prolink/packets.ts";
import { DeviceTracker, MountTracker, pickDeviceNumber, claimsNumber } from "../src/main/prolink/devices.ts";
import { broadcastAddress, interfaceForPeer, sameSubnet } from "../src/main/prolink/interfaces.ts";

test("XDR round-trips integers, opaque data and padding", () => {
  const w = new XdrWriter().uint(0xdeadbeef).int(-5).bool(true).opaque(Buffer.from("abcde")).fixedOpaque(Buffer.from([1, 2, 3])).string("hi");
  const buf = w.bytes();
  assert.equal(buf.length, 4 + 4 + 4 + (4 + 8) + 4 + (4 + 4));
  const r = new XdrReader(buf);
  assert.equal(r.uint(), 0xdeadbeef);
  assert.equal(r.int(), -5);
  assert.equal(r.bool(), true);
  assert.equal(r.opaque().toString(), "abcde");
  assert.deepEqual([...r.fixedOpaque(3)], [1, 2, 3]);
  assert.equal(r.opaque().toString(), "hi");
  assert.equal(r.remaining, 0);
  assert.throws(() => r.uint(), /underflow/);
});

test("RPC call and reply encode/decode per RFC 1057", () => {
  const call = encodeCall({ xid: 42, prog: 100003, vers: 2, proc: 4, cred: authUnix({ machine: "od", uid: 0, gid: 0 }), args: Buffer.from([0, 0, 0, 7]) });
  // xid, CALL, rpcvers 2, prog, vers, proc
  assert.deepEqual([...call.subarray(0, 24)], [0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0x86, 0xa3, 0, 0, 0, 2, 0, 0, 0, 4]);
  const decoded = decodeCall(call);
  assert.equal(decoded.cred.flavor, AUTH_UNIX);
  assert.deepEqual([...decoded.args], [0, 0, 0, 7]);
  const reply = decodeReply(encodeAcceptedReply(42, Buffer.from([0, 0, 0, 9])));
  assert.equal(reply.kind, "accepted");
  if (reply.kind === "accepted") {
    assert.equal(reply.acceptStat, 0);
    assert.equal(new XdrReader(reply.results).uint(), 9);
  }
  const denied = decodeReply(encodeDeniedReply(43, 1));
  assert.equal(denied.kind, "denied");
  if (denied.kind === "denied") assert.equal(denied.authStat, 1);
});

test("keep-alive packets round-trip through the parser", () => {
  const pkt = buildKeepalive({ name: "OpenDecks", deviceNumber: 3, mac: "aa:bb:cc:dd:ee:ff", ip: "169.254.1.20", peers: 3 });
  assert.equal(pkt.length, 0x36);
  assert.equal(pkt.toString("latin1", 0, 10), "Qspt1WmJOL");
  assert.equal(pkt[0x35], 0x64);
  const parsed = parseAnnounce(pkt)!;
  assert.equal(parsed.kind, KIND_KEEPALIVE);
  assert.equal(parsed.name, "OpenDecks");
  assert.equal(parsed.deviceNumber, 3);
  assert.equal(parsed.ip, "169.254.1.20");
  assert.equal(parsed.mac, "aa:bb:cc:dd:ee:ff");
  assert.equal(parsed.peers, 3);
  assert.equal(parsed.deviceType, 1);
  assert.equal(parseAnnounce(Buffer.from("not a dj link packet at all, really not")), null);
  const conflict = parseAnnounce(buildConflict("CDJ-3000", 3, "169.254.1.2"))!;
  assert.equal(conflict.kind, KIND_CONFLICT);
  assert.equal(conflict.deviceNumber, 3);
  assert.equal(conflict.ip, "169.254.1.2");
});

test("CDJ status parsing reads the USB and SD local-media bytes", () => {
  const mounted = parseCdjStatus(buildCdjStatus({ name: "CDJ-2000NXS2", deviceNumber: 2, usb: 0x00, sd: 0x04 }))!;
  assert.equal(mounted.deviceNumber, 2);
  assert.equal(mounted.name, "CDJ-2000NXS2");
  assert.equal(mounted.usb, "mounted");
  assert.equal(mounted.sd, "empty");
  assert.equal(parseCdjStatus(buildCdjStatus({ name: "x", deviceNumber: 2, usb: 0x02 }))!.usb, "unmounting");
  assert.equal(parseCdjStatus(buildCdjStatus({ name: "x", deviceNumber: 2 }).subarray(0, 0x40)), null);
});

test("media query and response layouts", () => {
  const q = buildMediaQuery({ name: "OpenDecks", deviceNumber: 1, ip: "10.0.0.5", targetDevice: 2, slot: SLOT_USB });
  assert.equal(q.length, 0x30);
  assert.equal(q.readUInt16BE(0x22), 0x0c);
  assert.deepEqual(parseMediaQuery(q), { deviceNumber: 1, ip: "10.0.0.5", targetDevice: 2, slot: SLOT_USB });
  const resp = buildMediaResponse({ playerName: "CDJ", deviceNumber: 2, slot: SLOT_USB, name: "DJ STICK", created: "2026-10-01", trackCount: 412, trackType: 1, playlistCount: 7, totalBytes: 64e9, freeBytes: 1e9 });
  assert.equal(resp.length, 0xc0);
  const d = parseMediaResponse(resp)!;
  assert.equal(d.name, "DJ STICK");
  assert.equal(d.created, "2026-10-01");
  assert.equal(d.trackCount, 412);
  assert.equal(d.playlistCount, 7);
  assert.equal(d.trackType, 1);
  assert.equal(d.totalBytes, 64e9);
  assert.equal(d.slot, SLOT_USB);
});

test("export paths follow the analysis: /C/ is USB, /B/ is SD", () => {
  assert.equal(exportPathFor("usb"), "/C/");
  assert.equal(exportPathFor("sd"), "/B/");
});

test("device tracker adds, refreshes and expires devices after ~5 s of silence", () => {
  const t = new DeviceTracker(5000);
  const ka = parseAnnounce(buildKeepalive({ name: "CDJ-3000", deviceNumber: 2, mac: "01:02:03:04:05:06", ip: "169.254.0.2" }))!;
  assert.ok(t.update(ka, "169.254.0.2", 0));
  assert.equal(t.update(ka, "169.254.0.2", 2000), null);
  assert.deepEqual(t.expire(6000).map((d) => d.deviceNumber), []);
  assert.deepEqual(t.expire(7100).map((d) => d.deviceNumber), [2]);
  assert.equal(t.list().length, 0);
});

test("virtual player number selection", () => {
  assert.equal(pickDeviceNumber([2, 3]), 1);
  assert.equal(pickDeviceNumber([1, 2, 3]), 4);
  assert.equal(pickDeviceNumber([1, 2, 3, 4]), 5);
  assert.equal(pickDeviceNumber([1, 2, 3, 4, 5]), 6);
  assert.equal(pickDeviceNumber([1, 2, 3, 4], 7), 7);
  assert.equal(pickDeviceNumber([2], "auto", [1]), 3);
  const claim = parseAnnounce(buildKeepalive({ name: "CDJ", deviceNumber: 1, mac: "0:0:0:0:0:0", ip: "1.2.3.4" }))!;
  assert.equal(claimsNumber(claim, 1), true);
  assert.equal(claimsNumber(claim, 2), false);
});

test("mount tracker emits mount/unmount transitions per player and slot", () => {
  const m = new MountTracker();
  const status = (usb: number, sd = 0x04) => parseCdjStatus(buildCdjStatus({ name: "CDJ", deviceNumber: 2, usb, sd }))!;
  assert.deepEqual(m.update(status(0x04)), []);
  assert.deepEqual(m.update(status(0x00)), [{ type: "mount", deviceNumber: 2, slot: "usb" }]);
  assert.deepEqual(m.update(status(0x00)), []);
  assert.deepEqual(m.update(status(0x00, 0x00)), [{ type: "mount", deviceNumber: 2, slot: "sd" }]);
  assert.deepEqual(m.update(status(0x03, 0x00)), [{ type: "unmount", deviceNumber: 2, slot: "usb" }]);
  assert.deepEqual(m.update(status(0x04, 0x00)), []);
  assert.deepEqual(m.dropDevice(2), [{ type: "unmount", deviceNumber: 2, slot: "sd" }]);
});

test("interface helpers pick the subnet the CDJs are on", () => {
  assert.equal(broadcastAddress("169.254.12.7", "255.255.0.0"), "169.254.255.255");
  assert.equal(sameSubnet("192.168.1.4", "192.168.1.200", "255.255.255.0"), true);
  const ifaces = [
    { name: "wifi", address: "192.168.1.4", netmask: "255.255.255.0", mac: "" },
    { name: "eth", address: "169.254.3.3", netmask: "255.255.0.0", mac: "" },
  ];
  assert.equal(interfaceForPeer(ifaces, "169.254.9.9")?.name, "eth");
  assert.equal(interfaceForPeer(ifaces, "10.0.0.1"), null);
});

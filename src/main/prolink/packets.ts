// Pro DJ Link packet layouts, written from the prose and byte-field diagrams in
// Deep Symmetry's "DJ Link Ecosystem Analysis" (startup.html, vcdj.html,
// media.html). No code from any existing implementation was consulted.
//
// Port 50000 packets carry the device name at 0x0c; port 50002 packets carry
// it at 0x0b. All multi-byte numbers are big-endian.

export const MAGIC = Buffer.from("Qspt1WmJOL", "ascii");
export const PORT_ANNOUNCE = 50000;
export const PORT_BEAT = 50001;
export const PORT_STATUS = 50002;

/** Slot numbers as used in status packets and media queries (vcdj.html table 1). */
export const SLOT_SD = 2;
export const SLOT_USB = 3;
export type SlotName = "usb" | "sd";
export const slotNumber = (slot: SlotName): number => (slot === "usb" ? SLOT_USB : SLOT_SD);
export const slotName = (n: number): SlotName | null => (n === SLOT_USB ? "usb" : n === SLOT_SD ? "sd" : null);
/**
 * NFS export path for each slot. Per the rekordbox export analysis
 * (exports.html): "/B/" is the SD slot and "/C/" is the USB slot.
 */
export const exportPathFor = (slot: SlotName): string => (slot === "usb" ? "/C/" : "/B/");

// Port 50000 packet kinds (byte 0x0a).
export const KIND_CLAIM_1 = 0x00;
export const KIND_ASSIGN_INTENT = 0x01;
export const KIND_CLAIM_2 = 0x02;
export const KIND_ASSIGN = 0x03;
export const KIND_CLAIM_FINAL = 0x04;
export const KIND_ASSIGN_DONE = 0x05;
export const KIND_KEEPALIVE = 0x06;
export const KIND_CONFLICT = 0x08;
export const KIND_ANNOUNCE = 0x0a;

// Port 50002 packet kinds.
export const KIND_MEDIA_QUERY = 0x05;
export const KIND_MEDIA_RESPONSE = 0x06;
export const KIND_CDJ_STATUS = 0x0a;
export const KIND_MIXER_STATUS = 0x29;

export const hasMagic = (buf: Uint8Array): boolean =>
  buf.length >= 11 && Buffer.from(buf.buffer, buf.byteOffset, 10).equals(MAGIC);

const asBuffer = (buf: Uint8Array): Buffer => (Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));

const readName = (buf: Buffer, at: number): string => {
  const raw = buf.subarray(at, at + 20);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("latin1").trim();
};

const writeName = (buf: Buffer, at: number, name: string): void => {
  Buffer.from(name.slice(0, 19), "latin1").copy(buf, at);
};

export const formatMac = (b: Buffer): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join(":");
export const formatIp = (b: Buffer): string => [...b].join(".");
export const ipBytes = (ip: string): Buffer => Buffer.from(ip.split(".").map((p) => Number(p) & 255));
export const macBytes = (mac: string): Buffer => {
  const parts = mac.split(/[:-]/).map((p) => parseInt(p, 16) & 255);
  while (parts.length < 6) parts.push(0);
  return Buffer.from(parts.slice(0, 6));
};

export interface AnnouncePacket {
  kind: number;
  name: string;
  deviceNumber: number | null;
  /** 1 = player, 2 = mixer, other values are other software (rekordbox etc). */
  deviceType: number | null;
  mac: string | null;
  ip: string | null;
  peers: number | null;
}

/** Parse anything received on port 50000. Returns null for non DJ Link data. */
export function parseAnnounce(input: Uint8Array): AnnouncePacket | null {
  const buf = asBuffer(input);
  if (!hasMagic(buf) || buf.length < 0x24) return null;
  const kind = buf[0x0a];
  const name = readName(buf, 0x0c);
  const base: AnnouncePacket = { kind, name, deviceNumber: null, deviceType: null, mac: null, ip: null, peers: null };
  switch (kind) {
    case KIND_KEEPALIVE:
      if (buf.length < 0x36) return base;
      return {
        ...base,
        deviceNumber: buf[0x24],
        mac: formatMac(buf.subarray(0x26, 0x2c)),
        ip: formatIp(buf.subarray(0x2c, 0x30)),
        peers: buf[0x30],
        deviceType: buf[0x34],
      };
    case KIND_CLAIM_2:
      if (buf.length < 0x32) return base;
      return { ...base, ip: formatIp(buf.subarray(0x24, 0x28)), mac: formatMac(buf.subarray(0x28, 0x2e)), deviceNumber: buf[0x2e] };
    case KIND_CLAIM_FINAL:
      return { ...base, deviceNumber: buf.length > 0x24 ? buf[0x24] : null };
    case KIND_CONFLICT:
      if (buf.length < 0x29) return base;
      return { ...base, deviceNumber: buf[0x24], ip: formatIp(buf.subarray(0x25, 0x29)) };
    case KIND_CLAIM_1:
      if (buf.length < 0x2c) return base;
      return { ...base, mac: formatMac(buf.subarray(0x26, 0x2c)) };
    default:
      return base;
  }
}

export interface KeepaliveOptions {
  name: string;
  deviceNumber: number;
  mac: string;
  ip: string;
  peers?: number;
}

/**
 * CDJ keep-alive (0x36 bytes). Uses the CDJ-3000 compatible variant
 * (byte 0x35 = 0x64), which the analysis says keeps players 5/6 happy.
 */
export function buildKeepalive(opts: KeepaliveOptions): Buffer {
  const buf = Buffer.alloc(0x36);
  MAGIC.copy(buf, 0);
  buf[0x0a] = KIND_KEEPALIVE;
  buf[0x0b] = 0x00;
  writeName(buf, 0x0c, opts.name);
  buf[0x20] = 0x01;
  buf[0x21] = 0x02;
  buf.writeUInt16BE(0x36, 0x22);
  buf[0x24] = opts.deviceNumber & 0xff;
  buf[0x25] = 0x01;
  macBytes(opts.mac).copy(buf, 0x26);
  ipBytes(opts.ip).copy(buf, 0x2c);
  buf[0x30] = Math.max(1, Math.min(255, opts.peers ?? 1));
  buf[0x34] = 0x01;
  buf[0x35] = 0x64;
  return buf;
}

/** Channel-conflict packet (0x29 bytes) — used only by tests to simulate a defending player. */
export function buildConflict(name: string, deviceNumber: number, ip: string): Buffer {
  const buf = Buffer.alloc(0x29);
  MAGIC.copy(buf, 0);
  buf[0x0a] = KIND_CONFLICT;
  writeName(buf, 0x0c, name);
  buf[0x20] = 0x01;
  buf[0x21] = 0x02;
  buf.writeUInt16BE(0x29, 0x22);
  buf[0x24] = deviceNumber;
  ipBytes(ip).copy(buf, 0x25);
  return buf;
}

/** Local media state codes from bytes 0x6f (USB) and 0x73 (SD). */
export type LocalMediaState = "mounted" | "empty" | "unmounting" | "unknown";
export const decodeLocalMedia = (value: number): LocalMediaState =>
  value === 0x00 ? "mounted" : value === 0x04 ? "empty" : value === 0x02 || value === 0x03 ? "unmounting" : "unknown";

export interface CdjStatus {
  name: string;
  deviceNumber: number;
  /** 1 while playing / searching / loading. */
  active: boolean;
  trackDevice: number;
  trackSlot: number;
  trackType: number;
  rekordboxId: number;
  usb: LocalMediaState;
  sd: LocalMediaState;
  usbActivity: boolean;
  sdActivity: boolean;
  linkAvailable: boolean;
  length: number;
}

export function parseCdjStatus(input: Uint8Array): CdjStatus | null {
  const buf = asBuffer(input);
  if (!hasMagic(buf) || buf[0x0a] !== KIND_CDJ_STATUS || buf.length < 0x76) return null;
  return {
    name: readName(buf, 0x0b),
    deviceNumber: buf[0x21],
    active: buf[0x27] !== 0,
    trackDevice: buf[0x28],
    trackSlot: buf[0x29],
    trackType: buf[0x2a],
    rekordboxId: buf.readUInt32BE(0x2c),
    usbActivity: buf[0x6a] === 0x06,
    sdActivity: buf[0x6b] === 0x06,
    usb: decodeLocalMedia(buf[0x6f]),
    sd: decodeLocalMedia(buf[0x73]),
    linkAvailable: buf[0x75] === 0x01,
    length: buf.length,
  };
}

/** Builds a minimal 0xd4-byte CDJ status packet. Only for tests and simulators. */
export function buildCdjStatus(opts: { name: string; deviceNumber: number; usb?: number; sd?: number }): Buffer {
  const buf = Buffer.alloc(0xd4);
  MAGIC.copy(buf, 0);
  buf[0x0a] = KIND_CDJ_STATUS;
  writeName(buf, 0x0b, opts.name);
  buf[0x1f] = 0x01;
  buf[0x20] = 0x03;
  buf[0x21] = opts.deviceNumber;
  buf.writeUInt16BE(0xd4 - 0x24, 0x22);
  buf[0x24] = opts.deviceNumber;
  buf[0x26] = 0x01;
  buf[0x6f] = opts.usb ?? 0x04;
  buf[0x73] = opts.sd ?? 0x04;
  return buf;
}

export function buildMediaQuery(opts: { name: string; deviceNumber: number; ip: string; targetDevice: number; slot: number }): Buffer {
  const buf = Buffer.alloc(0x30);
  MAGIC.copy(buf, 0);
  buf[0x0a] = KIND_MEDIA_QUERY;
  writeName(buf, 0x0b, opts.name);
  buf[0x1f] = 0x01;
  buf[0x20] = 0x00;
  buf[0x21] = opts.deviceNumber;
  buf.writeUInt16BE(0x0c, 0x22);
  ipBytes(opts.ip).copy(buf, 0x24);
  buf.writeUInt32BE(opts.targetDevice, 0x28);
  buf.writeUInt32BE(opts.slot, 0x2c);
  return buf;
}

export interface MediaQuery {
  deviceNumber: number;
  ip: string;
  targetDevice: number;
  slot: number;
}

export function parseMediaQuery(input: Uint8Array): MediaQuery | null {
  const buf = asBuffer(input);
  if (!hasMagic(buf) || buf[0x0a] !== KIND_MEDIA_QUERY || buf.length < 0x30) return null;
  return { deviceNumber: buf[0x21], ip: formatIp(buf.subarray(0x24, 0x28)), targetDevice: buf.readUInt32BE(0x28), slot: buf.readUInt32BE(0x2c) };
}

export interface MediaDetails {
  deviceNumber: number;
  slot: number;
  name: string;
  created: string;
  trackCount: number;
  color: number;
  /** 1 = rekordbox database present, 2 = plain files. */
  trackType: number;
  hasSettings: boolean;
  playlistCount: number;
  totalBytes: number;
  freeBytes: number;
}

const utf16be = (buf: Buffer): string => {
  const swapped = Buffer.from(buf);
  swapped.swap16();
  let s = swapped.toString("utf16le");
  const nul = s.indexOf("\u0000");
  if (nul !== -1) s = s.slice(0, nul);
  return s.trim();
};

export function parseMediaResponse(input: Uint8Array): MediaDetails | null {
  const buf = asBuffer(input);
  if (!hasMagic(buf) || buf[0x0a] !== KIND_MEDIA_RESPONSE || buf.length < 0xc0) return null;
  return {
    deviceNumber: buf.readUInt32BE(0x24) & 0xff,
    slot: buf.readUInt32BE(0x28),
    name: utf16be(buf.subarray(0x2c, 0x6c)),
    created: utf16be(buf.subarray(0x6c, 0x88)),
    trackCount: buf.readUInt16BE(0xa6),
    color: buf[0xa8],
    trackType: buf[0xaa],
    hasSettings: buf[0xab] !== 0,
    playlistCount: buf.readUInt16BE(0xae),
    totalBytes: Number(buf.readBigUInt64BE(0xb0)),
    freeBytes: Number(buf.readBigUInt64BE(0xb8)),
  };
}

const writeUtf16be = (buf: Buffer, at: number, max: number, s: string): void => {
  const b = Buffer.from(s, "utf16le");
  b.swap16();
  b.subarray(0, max - 2).copy(buf, at);
};

/** Builds a media response packet. Only for tests and simulators. */
export function buildMediaResponse(d: Omit<MediaDetails, "created" | "hasSettings" | "color" | "totalBytes" | "freeBytes"> & Partial<MediaDetails> & { playerName: string }): Buffer {
  const buf = Buffer.alloc(0xc0);
  MAGIC.copy(buf, 0);
  buf[0x0a] = KIND_MEDIA_RESPONSE;
  writeName(buf, 0x0b, d.playerName);
  buf[0x1f] = 0x01;
  buf[0x20] = 0x00;
  buf[0x21] = d.deviceNumber;
  buf.writeUInt16BE(0x9c, 0x22);
  buf.writeUInt32BE(d.deviceNumber, 0x24);
  buf.writeUInt32BE(d.slot, 0x28);
  writeUtf16be(buf, 0x2c, 0x40, d.name);
  writeUtf16be(buf, 0x6c, 0x1c, d.created ?? "");
  buf.writeUInt16BE(d.trackCount, 0xa6);
  buf[0xa8] = d.color ?? 0;
  buf[0xaa] = d.trackType;
  buf[0xab] = d.hasSettings ? 1 : 0;
  buf.writeUInt16BE(d.playlistCount, 0xae);
  buf.writeBigUInt64BE(BigInt(d.totalBytes ?? 0), 0xb0);
  buf.writeBigUInt64BE(BigInt(d.freeBytes ?? 0), 0xb8);
  return buf;
}

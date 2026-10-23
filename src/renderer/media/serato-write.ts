import { readId3, writeSeratoGeoB } from "./serato-id3.ts";
import { writeSeratoExtraTags } from "./serato-extra.ts";
import { detectRiffKind, readRiffId3, writeRiffId3, type RiffKind } from "./serato-riff.ts";
import {
  encodeBeatGrid,
  encodeMarkers2,
  encodeMarkers_,
  encodeMarkers_Mp4,
  type BeatGridMarker,
  type SeratoMarkers,
} from "./serato-tags.ts";

export type SeratoContainer = "mp3" | "wav" | "aiff" | "flac" | "mp4";

export interface SeratoTagUpdate {
  description: string;
  data: Uint8Array;
}

export function seratoContainer(name: string): SeratoContainer | null {
  if (/\.mp3$/i.test(name)) return "mp3";
  if (/\.wav$/i.test(name)) return "wav";
  if (/\.aiff?$/i.test(name)) return "aiff";
  if (/\.flac$/i.test(name)) return "flac";
  if (/\.(m4a|mp4|aac)$/i.test(name)) return "mp4";
  return null;
}

export function seratoTagUpdates(
  markers: SeratoMarkers,
  beatgrid: BeatGridMarker[] | null,
  container?: SeratoContainer,
): SeratoTagUpdate[] {
  const updates: SeratoTagUpdate[] = [
    { description: "Serato Markers2", data: encodeMarkers2(markers) },
    {
      description: "Serato Markers_",
      data: container === "mp4" ? encodeMarkers_Mp4(markers) : encodeMarkers_(markers),
    },
  ];
  if (beatgrid && beatgrid.length > 0) {
    updates.push({ description: "Serato BeatGrid", data: encodeBeatGrid(beatgrid) });
  }
  return updates;
}

function id3TagFrom(existing: Uint8Array | null, updates: SeratoTagUpdate[]): Uint8Array {
  const merged = writeSeratoGeoB(existing ?? new Uint8Array(0), updates);
  const tag = readId3(merged);
  if (!tag) throw new Error("could not build an ID3 tag");
  return merged.subarray(0, tag.audioOffset);
}

export function rewriteSeratoTags(
  bytes: Uint8Array,
  container: SeratoContainer,
  updates: SeratoTagUpdate[],
): Uint8Array {
  if (container === "mp3") return writeSeratoGeoB(bytes, updates);
  if (container === "wav" || container === "aiff") {
    const kind: RiffKind = container;
    const tag = id3TagFrom(readRiffId3(bytes, kind), updates);
    return writeRiffId3(bytes, kind, tag);
  }
  if (container === "flac" || container === "mp4") {
    return writeSeratoExtraTags(bytes, container, new Map(updates.map((update) => [update.description, update.data])));
  }
  throw new Error(`${container} tag writing is not wired yet`);
}

function riffPayload(bytes: Uint8Array, kind: RiffKind): Uint8Array {
  const little = kind === "wav";
  const parts: Uint8Array[] = [];
  let total = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4);
    const size = view.getUint32(0, little);
    const end = offset + 8 + size + (size & 1);
    if (offset + 8 + size > bytes.length) break;
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    if (!/^id3 $/i.test(id)) {
      parts.push(bytes.subarray(offset, Math.min(end, bytes.length)));
      total += Math.min(end, bytes.length) - offset;
    }
    offset = end;
  }
  const out = new Uint8Array(total);
  let write = 0;
  for (const part of parts) {
    out.set(part, write);
    write += part.length;
  }
  return out;
}

function flacPayload(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 8 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "fLaC") return bytes;
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const last = (bytes[offset] & 0x80) !== 0;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 4 + length;
    if (last) return bytes.subarray(offset);
  }
  return bytes;
}

function readU64(bytes: Uint8Array, offset: number): number {
  const high = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
  const low = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0);
  return high * 2 ** 32 + low;
}

function mp4Payload(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    let size = view.getUint32(0);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) break;
      size = readU64(bytes, offset + 8);
      header = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < header || offset + size > bytes.length) break;
    if (type === "mdat") {
      const payload = bytes.subarray(offset + header, offset + size);
      parts.push(payload);
      total += payload.length;
    }
    offset += size;
  }
  if (parts.length === 0) return bytes;
  const out = new Uint8Array(total);
  let write = 0;
  for (const part of parts) {
    out.set(part, write);
    write += part.length;
  }
  return out;
}

export function seratoAudioPayload(bytes: Uint8Array, container: SeratoContainer): Uint8Array {
  if (container === "mp3") {
    const tag = readId3(bytes);
    return bytes.subarray(tag ? tag.audioOffset : 0);
  }
  if (container === "wav" || container === "aiff") return riffPayload(bytes, container);
  if (container === "flac") return flacPayload(bytes);
  if (container === "mp4") return mp4Payload(bytes);
  const detected = detectRiffKind(bytes);
  if (detected) return riffPayload(bytes, detected);
  return bytes;
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

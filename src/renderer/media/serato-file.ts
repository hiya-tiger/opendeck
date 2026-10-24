import { readId3TextMeta, readSeratoGeoB } from "./serato-id3.ts";
import { detectRiffKind, readRiffId3, type RiffKind } from "./serato-riff.ts";
import { readSeratoExtraMeta, readSeratoExtraTags, type SeratoExtraKind } from "./serato-extra.ts";
import {
  decodeBeatGrid,
  decodeMarkers2,
  decodeMarkers_,
  decodeMarkers_Mp4,
  nearestCueColor,
  type BeatGridMarker,
  type SeratoMarkers,
} from "./serato-tags.ts";
import type { SeratoContainer } from "./serato-write.ts";

export interface SeratoFileTags {
  markers: SeratoMarkers | null;
  beatgrid: BeatGridMarker[] | null;
  bpm?: number;
  key?: string;
}

function hasId3(bytes: Uint8Array): boolean {
  return bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
}

function tagSize(bytes: Uint8Array): number {
  return (
    10 +
    ((bytes[6] & 0x7f) << 21) +
    ((bytes[7] & 0x7f) << 14) +
    ((bytes[8] & 0x7f) << 7) +
    (bytes[9] & 0x7f)
  );
}

function parseTagMap(
  tags: Map<string, Uint8Array>,
  mp4Legacy = false,
  meta?: { bpm?: number; key?: string },
): SeratoFileTags {
  let markers: SeratoMarkers | null = null;
  const legacy = tags.get("Serato Markers_");
  const current = tags.get("Serato Markers2");
  if (legacy) markers = mp4Legacy ? decodeMarkers_Mp4(legacy) : decodeMarkers_(legacy);
  if (current) {
    const decoded = decodeMarkers2(current);
    if (!markers) {
      markers = decoded;
    } else {
      for (const cue of decoded.cues) {
        const existing = markers.cues.find((marker) => marker.index === cue.index);
        if (existing) existing.name = cue.name;
        else markers.cues.push(cue);
      }
      markers.loops = decoded.loops;
      markers.bpmLocked = decoded.bpmLocked;
    }
  }
  if (markers) {
    markers.cues = markers.cues.map((cue) => ({ ...cue, color: nearestCueColor(cue.color) }));
  }
  const grid = tags.get("Serato BeatGrid");
  const out: SeratoFileTags = { markers, beatgrid: grid ? decodeBeatGrid(grid) : null };
  if (meta?.bpm !== undefined) out.bpm = meta.bpm;
  if (meta?.key !== undefined) out.key = meta.key;
  return out;
}

function parseTags(bytes: Uint8Array): SeratoFileTags {
  const frames = readSeratoGeoB(bytes);
  const meta = readId3TextMeta(bytes);
  return parseTagMap(new Map([...frames].map(([name, frame]) => [name, frame.data])), false, meta);
}

export function readSeratoTagsFromBytes(bytes: Uint8Array, container: SeratoContainer): SeratoFileTags {
  if (container === "flac" || container === "mp4") {
    const tags = readSeratoExtraTags(bytes, container);
    const meta = readSeratoExtraMeta(bytes, container);
    return parseTagMap(tags, container === "mp4", meta);
  }
  if (container === "wav" || container === "aiff") {
    const id3 = readRiffId3(bytes, container);
    return id3 ? parseTags(id3) : { markers: null, beatgrid: null };
  }
  return parseTags(bytes);
}

async function readRiffTagChunk(file: File, kind: RiffKind): Promise<Uint8Array | null> {
  const little = kind === "wav";
  let offset = 12;
  while (offset + 8 <= file.size) {
    const header = new Uint8Array(await file.slice(offset, offset + 8).arrayBuffer());
    if (header.length < 8) return null;
    const id = String.fromCharCode(header[0], header[1], header[2], header[3]);
    const size = new DataView(header.buffer, header.byteOffset + 4, 4).getUint32(0, little);
    if (/^id3 $/i.test(id)) {
      return new Uint8Array(await file.slice(offset + 8, offset + 8 + size).arrayBuffer());
    }
    offset += 8 + size + (size & 1);
  }
  return null;
}

export async function readSeratoTagsFromFile(file: File): Promise<SeratoFileTags | null> {
  const wav = /\.wav$/i.test(file.name);
  const aiff = /\.aiff?$/i.test(file.name);
  const flac = /\.flac$/i.test(file.name);
  const mp4 = /\.(m4a|mp4|aac)$/i.test(file.name);
  if (!/\.mp3$/i.test(file.name) && !wav && !aiff && !flac && !mp4) return null;
  try {
    if (flac || mp4) {
      const kind: SeratoExtraKind = flac ? "flac" : "mp4";
      const bytes = new Uint8Array(await file.arrayBuffer());
      const meta = readSeratoExtraMeta(bytes, kind);
      return parseTagMap(readSeratoExtraTags(bytes, kind), kind === "mp4", meta);
    }
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 12)).arrayBuffer());
    if (hasId3(head)) {
      const size = Math.min(file.size, tagSize(head));
      return parseTags(new Uint8Array(await file.slice(0, size).arrayBuffer()));
    }
    const kind = detectRiffKind(head);
    if (!kind) return null;
    const id3 = await readRiffTagChunk(file, kind);
    return id3 ? parseTags(id3) : null;
  } catch {
    return null;
  }
}

import { readSeratoGeoB } from "./serato-id3.ts";
import {
  decodeBeatGrid,
  decodeMarkers2,
  decodeMarkers_,
  nearestCueColor,
  type BeatGridMarker,
  type SeratoMarkers,
} from "./serato-tags.ts";

export interface SeratoFileTags {
  markers: SeratoMarkers | null;
  beatgrid: BeatGridMarker[] | null;
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

export async function readSeratoTagsFromFile(file: File): Promise<SeratoFileTags | null> {
  if (!/\.mp3$/i.test(file.name)) return null;
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (!hasId3(head)) return null;
    const size = Math.min(file.size, tagSize(head));
    const bytes = new Uint8Array(await file.slice(0, size).arrayBuffer());
    const tags = readSeratoGeoB(bytes);
    let markers: SeratoMarkers | null = null;
    const legacy = tags.get("Serato Markers_");
    const current = tags.get("Serato Markers2");
    if (legacy) markers = decodeMarkers_(legacy.data);
    if (current) {
      const decoded = decodeMarkers2(current.data);
      if (!markers) {
        markers = decoded;
      } else {
        for (const cue of decoded.cues) {
          if (!markers.cues.some((existing) => existing.index === cue.index)) markers.cues.push(cue);
        }
        markers.loops = decoded.loops;
        markers.bpmLocked = decoded.bpmLocked;
      }
    }
    if (markers) {
      markers.cues = markers.cues.map((cue) => ({ ...cue, color: nearestCueColor(cue.color) }));
    }
    const grid = tags.get("Serato BeatGrid");
    return { markers, beatgrid: grid ? decodeBeatGrid(grid.data) : null };
  } catch {
    return null;
  }
}

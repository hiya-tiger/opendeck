import { encodeCrate, encodeDatabase, encodeNeworder, seratoType, type SeratoDbTrack } from "./serato-codec.ts";

export interface SeratoExportTrack {
  path: string;
  crate?: string;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  comment?: string;
  bpm?: number;
  key?: string;
  duration?: number;
}

export interface SeratoExport {
  files: Map<string, Uint8Array>;
  crates: string[];
  trackCount: number;
  skipped: number;
}

const ROOT = "_Serato_";

function posix(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function stripRoot(path: string): string {
  return path.replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "");
}

function commonRoot(paths: string[]): string {
  if (paths.length === 0) return "";
  const split = paths.map((path) => posix(path).split("/"));
  const first = split[0];
  let depth = first.length - 1;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < depth && i < parts.length - 1 && parts[i] === first[i]) i += 1;
    depth = i;
  }
  return first.slice(0, depth).join("/");
}

function safeCrateName(name: string): string {
  return name.replace(/\.crate$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
}

export function buildSeratoExport(tracks: SeratoExportTrack[]): SeratoExport {
  const usable = tracks.filter((track) => Boolean(track.path) && !/^(https?|data):/i.test(track.path));
  const paths = usable.map((track) => posix(track.path));
  const root = commonRoot(paths);
  const relative = (path: string): string => {
    const clean = posix(path);
    if (root && clean.startsWith(`${root}/`)) return stripRoot(clean.slice(root.length + 1));
    return stripRoot(clean);
  };

  const dbTracks: SeratoDbTrack[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const track of usable) {
    const path = posix(track.path);
    const key = path.toLowerCase();
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    dbTracks.push({
      path,
      type: seratoType(path),
      title: track.title,
      artist: track.artist,
      album: track.album,
      genre: track.genre,
      comment: track.comment,
      bpm: track.bpm && track.bpm > 0 ? track.bpm.toFixed(2) : undefined,
      key: track.key && track.key !== "--" ? track.key : undefined,
      length: track.duration && track.duration > 0 ? `${Math.floor(track.duration / 60)}:${String(Math.floor(track.duration % 60)).padStart(2, "0")}` : undefined,
    });
  }

  const groups = new Map<string, string[]>();
  for (const track of usable) {
    const crate = safeCrateName(track.crate ?? "");
    if (!crate) continue;
    const list = groups.get(crate) ?? [];
    const rel = relative(track.path);
    if (!list.includes(rel)) list.push(rel);
    groups.set(crate, list);
  }

  const crates = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const files = new Map<string, Uint8Array>();
  files.set(`${ROOT}/database V2`, encodeDatabase(dbTracks));
  files.set(`${ROOT}/neworder.pref`, encodeNeworder(crates));
  for (const crate of crates) {
    files.set(`${ROOT}/Subcrates/${crate}.crate`, encodeCrate(groups.get(crate)!));
  }

  return { files, crates, trackCount: dbTracks.length, skipped };
}

import {
  decodeCrate,
  decodeDatabaseTracks,
  decodeNeworder,
  encodeCrate,
  encodeDatabase,
  encodeNeworder,
  seratoType,
  type SeratoChunk,
  type SeratoDbTrack,
} from "./serato-codec.ts";

export interface SeratoExportTrack {
  path: string;
  crate?: string;
  crates?: string[];
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  comment?: string;
  grouping?: string;
  remixer?: string;
  bpm?: number;
  key?: string;
  duration?: number;
  color?: string;
  playCount?: number;
  played?: boolean;
  beatgridLocked?: boolean;
  extraChunks?: SeratoChunk[];
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
      grouping: track.grouping,
      remixer: track.remixer,
      bpm: track.bpm && track.bpm > 0 ? track.bpm.toFixed(2) : undefined,
      key: track.key && track.key !== "--" ? track.key : undefined,
      length: track.duration && track.duration > 0 ? `${Math.floor(track.duration / 60)}:${String(Math.floor(track.duration % 60)).padStart(2, "0")}` : undefined,
      color: track.color,
      utpc: track.playCount,
      playCount: track.playCount,
      played: track.played ?? (track.playCount ?? 0) > 0,
      beatgridLocked: track.beatgridLocked,
      extraChunks: track.extraChunks,
    });
  }

  const groups = new Map<string, string[]>();
  for (const track of usable) {
    const crateNames = new Set<string>();
    if (track.crate) crateNames.add(track.crate);
    if (track.crates) {
      for (const c of track.crates) crateNames.add(c);
    }
    for (const rawCrate of crateNames) {
      const crate = safeCrateName(rawCrate);
      if (!crate) continue;
      const list = groups.get(crate) ?? [];
      const rel = relative(track.path);
      if (!list.includes(rel)) list.push(rel);
      groups.set(crate, list);
    }
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

function parseLengthSeconds(length?: string): number | undefined {
  if (!length) return undefined;
  const parts = length.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

export function importSeratoExport(
  files: Map<string, Uint8Array> | Record<string, Uint8Array>,
): { tracks: SeratoExportTrack[]; crates: string[]; cratePaths: Map<string, string[]> } {
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
  const fileMap = new Map(entries.map(([k, v]) => [posix(k), v]));

  const neworderBytes = fileMap.get(`${ROOT}/neworder.pref`) ?? fileMap.get("neworder.pref");
  const orderedCrates = neworderBytes ? decodeNeworder(neworderBytes) : [];
  const cratePaths = new Map<string, string[]>();

  for (const [key, bytes] of fileMap.entries()) {
    const match = /(?:^|\/)Subcrates\/(.+)\.crate$/i.exec(key);
    if (!match) continue;
    const crateName = match[1];
    const decoded = decodeCrate(bytes);
    cratePaths.set(crateName, decoded.paths);
  }

  const crates = [
    ...orderedCrates.filter((c) => cratePaths.has(c)),
    ...[...cratePaths.keys()].filter((c) => !orderedCrates.includes(c)),
  ];

  const dbBytes = fileMap.get(`${ROOT}/database V2`) ?? fileMap.get("database V2");
  const dbDecoded = dbBytes ? decodeDatabaseTracks(dbBytes).tracks : [];

  const tracksByTail = new Map<string, string[]>();
  for (const [crateName, paths] of cratePaths.entries()) {
    for (const relPath of paths) {
      const cleanRel = stripRoot(posix(relPath)).toLowerCase();
      const list = tracksByTail.get(cleanRel) ?? [];
      if (!list.includes(crateName)) list.push(crateName);
      tracksByTail.set(cleanRel, list);
    }
  }

  const tracks: SeratoExportTrack[] = dbDecoded.map((dbTrack) => {
    const cleanPath = stripRoot(posix(dbTrack.path)).toLowerCase();
    const matchedCrates: string[] = [];
    for (const [relTail, crateList] of tracksByTail.entries()) {
      if (cleanPath === relTail || cleanPath.endsWith(`/${relTail}`)) {
        for (const c of crateList) {
          if (!matchedCrates.includes(c)) matchedCrates.push(c);
        }
      }
    }
    const bpmNum = dbTrack.bpm ? Number.parseFloat(dbTrack.bpm) : undefined;
    return {
      path: dbTrack.path,
      crate: matchedCrates[0],
      crates: matchedCrates.length > 0 ? matchedCrates : undefined,
      title: dbTrack.title,
      artist: dbTrack.artist,
      album: dbTrack.album,
      genre: dbTrack.genre,
      comment: dbTrack.comment,
      grouping: dbTrack.grouping,
      remixer: dbTrack.remixer,
      bpm: bpmNum && Number.isFinite(bpmNum) ? bpmNum : undefined,
      key: dbTrack.key,
      duration: parseLengthSeconds(dbTrack.length),
      color: dbTrack.color,
      playCount: dbTrack.playCount ?? dbTrack.utpc,
      played: dbTrack.played,
      beatgridLocked: dbTrack.beatgridLocked,
      extraChunks: dbTrack.extraChunks,
    };
  });

  return { tracks, crates, cratePaths };
}

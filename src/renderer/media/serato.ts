const decoders: Record<string, TextDecoder> = {
  le: new TextDecoder("utf-16le"),
  be: new TextDecoder("utf-16be"),
};

const PATH_TAGS = new Set(["ptrk", "pfil"]);

function utf16Order(bytes: Uint8Array, start: number, end: number): "le" | "be" {
  const limit = Math.min(end, start + 64);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = start; i < limit; i += 1) {
    if (bytes[i] !== 0) continue;
    if ((i - start) % 2 === 0) evenZeros += 1;
    else oddZeros += 1;
  }
  if (evenZeros === oddZeros) return "le";
  return evenZeros > oddZeros ? "be" : "le";
}

function tagAt(bytes: Uint8Array, offset: number): string | null {
  if (offset + 4 > bytes.length) return null;
  let tag = "";
  for (let i = 0; i < 4; i += 1) {
    const code = bytes[offset + i];
    if (code < 0x20 || code > 0x7e) return null;
    tag += String.fromCharCode(code);
  }
  return tag;
}

interface Block {
  tag: string;
  start: number;
  end: number;
}

function readBlocks(bytes: Uint8Array, start: number, end: number): Block[] {
  const blocks: Block[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const tag = tagAt(bytes, offset);
    if (!tag) break;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const length = view.getUint32(4, false);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > end || payloadEnd < payloadStart) break;
    blocks.push({ tag, start: payloadStart, end: payloadEnd });
    offset = payloadEnd;
  }
  return blocks;
}

function looksLikeBlocks(bytes: Uint8Array, start: number, end: number): boolean {
  if (end - start < 8) return false;
  const tag = tagAt(bytes, start);
  if (!tag || !/^[a-z0-9]{4}$/.test(tag)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, 8);
  const length = view.getUint32(4, false);
  return length <= end - start - 8;
}

function decodePath(bytes: Uint8Array, start: number, end: number): string {
  if (end - start < 2) return "";
  const text = decoders[utf16Order(bytes, start, end)].decode(bytes.subarray(start, end));
  return text.replace(/\0+$/, "").trim();
}

function collectPaths(bytes: Uint8Array, blocks: Block[], out: string[]): void {
  for (const block of blocks) {
    if (PATH_TAGS.has(block.tag)) {
      const value = decodePath(bytes, block.start, block.end);
      if (value) out.push(value);
      continue;
    }
    if (looksLikeBlocks(bytes, block.start, block.end)) {
      collectPaths(bytes, readBlocks(bytes, block.start, block.end), out);
    }
  }
}

export function normalizePath(path: string): string {
  return path
    .replace(/^file:\/\/localhost\//i, "")
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/");
}

export function baseName(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normalizePath(path);
}

export interface CrateEntry {
  path: string;
  name: string;
}

export interface ParsedCrate {
  version: string;
  tracks: CrateEntry[];
  tags: string[];
}

export function isSerato(input: ArrayBuffer | Uint8Array): boolean {
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return bytes.length >= 12 && tagAt(bytes, 0) === "vrsn";
  } catch {
    return false;
  }
}

export function parseCrate(input: ArrayBuffer | Uint8Array): ParsedCrate {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const blocks = readBlocks(bytes, 0, bytes.length);
  let version = "";
  for (const block of blocks) {
    if (block.tag === "vrsn") version = decodePath(bytes, block.start, block.end);
  }

  const raw: string[] = [];
  collectPaths(bytes, blocks, raw);

  const seen = new Set<string>();
  const tracks: CrateEntry[] = [];
  for (const path of raw) {
    const key = normalizePath(path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({ path: normalizePath(path), name: baseName(path) });
  }

  const tags = new Set<string>();
  const walk = (list: Block[]): void => {
    for (const block of list) {
      tags.add(block.tag);
      if (looksLikeBlocks(bytes, block.start, block.end)) walk(readBlocks(bytes, block.start, block.end));
    }
  };
  walk(blocks);
  return { version, tracks, tags: Array.from(tags).sort() };
}

export type RiffKind = "wav" | "aiff";

interface Chunk {
  id: string;
  start: number;
  dataStart: number;
  size: number;
  end: number;
}

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function readSize(bytes: Uint8Array, offset: number, little: boolean): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getUint32(0, little);
}

function writeSize(bytes: Uint8Array, offset: number, value: number, little: boolean): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  view.setUint32(0, value >>> 0, little);
}

export function detectRiffKind(bytes: Uint8Array): RiffKind | null {
  if (bytes.length < 12) return null;
  const magic = fourcc(bytes, 0);
  if (magic !== "RIFF" && magic !== "FORM") return null;
  const form = fourcc(bytes, 8);
  if (magic === "RIFF" && form === "WAVE") return "wav";
  if (magic === "FORM" && (form === "AIFF" || form === "AIFC")) return "aiff";
  return null;
}

function chunks(bytes: Uint8Array, kind: RiffKind): Chunk[] {
  const little = kind === "wav";
  const found: Chunk[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = readSize(bytes, offset + 4, little);
    const dataStart = offset + 8;
    const end = Math.min(bytes.length, dataStart + size + (size & 1));
    if (dataStart + size > bytes.length) break;
    found.push({ id: fourcc(bytes, offset), start: offset, dataStart, size, end });
    offset = end;
  }
  return found;
}

function isId3Chunk(id: string): boolean {
  return /^id3 $/i.test(id);
}

export function readRiffId3(bytes: Uint8Array, kind = detectRiffKind(bytes)): Uint8Array | null {
  if (!kind) return null;
  for (const chunk of chunks(bytes, kind)) {
    if (!isId3Chunk(chunk.id)) continue;
    return bytes.subarray(chunk.dataStart, chunk.dataStart + chunk.size);
  }
  return null;
}

export function writeRiffId3(bytes: Uint8Array, kind: RiffKind, id3: Uint8Array): Uint8Array {
  const little = kind === "wav";
  const header = bytes.subarray(0, 12);
  const old = chunks(bytes, kind);
  const id = kind === "wav" ? "id3 " : "ID3 ";
  const padding = id3.length & 1;
  let payloadSize = 12;
  for (const chunk of old) {
    if (isId3Chunk(chunk.id)) continue;
    payloadSize += chunk.end - chunk.start;
  }
  payloadSize += 8 + id3.length + padding;

  const out = new Uint8Array(payloadSize);
  out.set(header, 0);
  let offset = 12;
  for (const chunk of old) {
    if (isId3Chunk(chunk.id)) continue;
    const length = chunk.end - chunk.start;
    out.set(bytes.subarray(chunk.start, chunk.end), offset);
    offset += length;
  }
  for (let i = 0; i < 4; i += 1) out[offset + i] = id.charCodeAt(i);
  writeSize(out, offset + 4, id3.length, little);
  out.set(id3, offset + 8);
  offset += 8 + id3.length;
  if (padding) out[offset] = 0;
  writeSize(out, 4, payloadSize - 8, little);
  return out;
}

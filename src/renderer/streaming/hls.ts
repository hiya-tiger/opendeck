// Minimal HLS reader for *unencrypted* audio playlists, so a provider that
// hands out plain HLS (SoundCloud hls_mp3_128, TIDAL manifests without drmData)
// can be decoded once to PCM like a local file (D17).
//
// It deliberately does not decrypt anything: a playlist with EXT-X-KEY other
// than METHOD=NONE, or with EXT-X-SESSION-KEY, is refused with
// "encrypted" so the caller falls back to the official player (monitor-only).

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  codecs?: string;
}

export interface HlsMediaPlaylist {
  initUri: string | null;
  segments: string[];
  encrypted: boolean;
  endList: boolean;
}

export class HlsError extends Error {
  readonly code: "encrypted" | "not-hls" | "empty" | "live" | "fetch" | "too-large";

  constructor(code: HlsError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "HlsError";
  }
}

function resolveUri(base: string, ref: string): string {
  return new URL(ref, base).toString();
}

function attr(line: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[:,])${name}=("([^"]*)"|[^,]*)`).exec(line);
  if (!match) return undefined;
  return match[2] ?? match[1];
}

export function isMasterPlaylist(text: string): boolean {
  return /#EXT-X-STREAM-INF/.test(text);
}

export function parseMasterPlaylist(text: string, baseUrl: string): HlsVariant[] {
  if (!text.trimStart().startsWith("#EXTM3U")) throw new HlsError("not-hls", "not an HLS playlist");
  if (/#EXT-X-SESSION-KEY/.test(text)) throw new HlsError("encrypted", "playlist is encrypted (session key)");
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
    if (!uri) continue;
    variants.push({
      uri: resolveUri(baseUrl, uri),
      bandwidth: Number(attr(lines[i], "BANDWIDTH") ?? 0),
      codecs: attr(lines[i], "CODECS"),
    });
  }
  return variants;
}

export function parseMediaPlaylist(text: string, baseUrl: string): HlsMediaPlaylist {
  if (!text.trimStart().startsWith("#EXTM3U")) throw new HlsError("not-hls", "not an HLS playlist");
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let encrypted = false;
  let initUri: string | null = null;
  const segments: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#EXT-X-KEY")) {
      const method = (attr(line, "METHOD") ?? "").toUpperCase();
      if (method && method !== "NONE") encrypted = true;
    } else if (line.startsWith("#EXT-X-MAP")) {
      const uri = attr(line, "URI");
      if (uri) initUri = resolveUri(baseUrl, uri);
    } else if (!line.startsWith("#")) {
      segments.push(resolveUri(baseUrl, line));
    }
  }
  return { initUri, segments, encrypted, endList: lines.includes("#EXT-X-ENDLIST") };
}

export type FetchBytes = (url: string) => Promise<{ status: number; bytes: Uint8Array; text?: string }>;

const MAX_BYTES = 400 * 1024 * 1024;

/** Fetch a whole (finite, unencrypted) HLS audio stream as one byte buffer. */
export async function fetchHlsAudio(url: string, fetchBytes: FetchBytes): Promise<Uint8Array> {
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
  const first = await fetchBytes(url);
  if (first.status < 200 || first.status >= 300) throw new HlsError("fetch", `playlist HTTP ${first.status}`);
  let playlistUrl = url;
  let text = decode(first.bytes);
  if (isMasterPlaylist(text)) {
    const variants = parseMasterPlaylist(text, url);
    if (!variants.length) throw new HlsError("empty", "master playlist has no variants");
    // Highest bandwidth audio variant; these are single-rendition audio streams.
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    playlistUrl = variants[0].uri;
    const media = await fetchBytes(playlistUrl);
    if (media.status < 200 || media.status >= 300) throw new HlsError("fetch", `variant HTTP ${media.status}`);
    text = decode(media.bytes);
  }
  const playlist = parseMediaPlaylist(text, playlistUrl);
  if (playlist.encrypted) throw new HlsError("encrypted", "stream is encrypted; only the service's own player may play it");
  if (!playlist.endList) throw new HlsError("live", "live/unfinished stream; cannot decode once");
  if (!playlist.segments.length) throw new HlsError("empty", "playlist has no segments");
  const parts: Uint8Array[] = [];
  let total = 0;
  const urls = playlist.initUri ? [playlist.initUri, ...playlist.segments] : playlist.segments;
  for (const segmentUrl of urls) {
    const seg = await fetchBytes(segmentUrl);
    if (seg.status < 200 || seg.status >= 300) throw new HlsError("fetch", `segment HTTP ${seg.status}`);
    total += seg.bytes.byteLength;
    if (total > MAX_BYTES) throw new HlsError("too-large", "stream larger than 400 MB");
    parts.push(seg.bytes);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

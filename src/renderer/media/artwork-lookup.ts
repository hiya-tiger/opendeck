import type { Artwork } from "./artwork.ts";

export interface LookupFetcher {
  text: (url: string) => Promise<string | null>;
  bytes: (url: string) => Promise<Uint8Array | null>;
}

export interface LookupResult extends Artwork {
  source: string;
}

export function parseItunesArtwork(json: string | null): string | null {
  if (!json) return null;
  try {
    const payload = JSON.parse(json) as { results?: Array<Record<string, unknown>> };
    if (!Array.isArray(payload.results)) return null;
    for (const result of payload.results) {
      const url = result.artworkUrl100 ?? result.artworkUrl60 ?? result.artworkUrl30;
      if (typeof url === "string" && url.startsWith("https://")) {
        return url.replace(/\/\d+x\d+bb\./, "/600x600bb.");
      }
    }
  } catch {
    return null;
  }
  return null;
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function artworkUrl(result: Record<string, unknown>): string | null {
  const url = result.artworkUrl100 ?? result.artworkUrl60 ?? result.artworkUrl30;
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  return url.replace(/\/\d+x\d+bb\./, "/600x600bb.");
}

export function pickItunesArtwork(json: string | null, query: string): string | null {
  if (!json) return null;
  let results: Array<Record<string, unknown>>;
  try {
    const payload = JSON.parse(json) as { results?: Array<Record<string, unknown>> };
    if (!Array.isArray(payload.results)) return null;
    results = payload.results;
  } catch {
    return null;
  }
  const wanted = normalise(query);
  const tokens = wanted.split(" ").filter((token) => token.length > 1);
  let best: Record<string, unknown> | null = null;
  let bestScore = 0;
  for (const result of results) {
    const title = typeof result.trackName === "string" ? normalise(result.trackName) : "";
    const artist = typeof result.artistName === "string" ? normalise(result.artistName) : "";
    const album = typeof result.collectionName === "string" ? normalise(result.collectionName) : "";
    if (!title && !artist && !album) {
      if (!best) best = result;
      continue;
    }
    let score = 0;
    if (title && title === wanted) score += 6;
    else if (title && (title.includes(wanted) || wanted.includes(title))) score += 3;
    if (artist && wanted.includes(artist)) score += 3;
    const haystack = `${title} ${artist} ${album}`;
    for (const token of tokens) if (haystack.includes(token)) score += 1;
    if (score > bestScore) {
      best = result;
      bestScore = score;
    }
  }
  if (!best) return null;
  if (bestScore === 0 && tokens.length > 0) {
    const legacy = best;
    const hasMetadata = ["trackName", "artistName", "collectionName"].some((key) => typeof legacy[key] === "string");
    if (hasMetadata) return null;
  }
  return artworkUrl(best);
}

export function mimeFor(data: Uint8Array): string {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && String.fromCharCode(data[0], data[1], data[2]) === "GIF") return "image/gif";
  return "image/jpeg";
}

export function artworkQuery(
  tags: { artist?: string; title?: string; album?: string } | null,
  trackName: string,
): string {
  const artist = tags?.artist?.trim();
  const title = tags?.title?.trim();
  const album = tags?.album?.trim();
  if (artist && title) return `${artist} ${title}`;
  if (artist && album) return `${artist} ${album}`;
  const cleaned = trackName
    .replace(/[_]+/g, " ")
    .replace(/^\s*\d{1,3}\s*[-.)]?\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

export async function lookupCoverArt(query: string, fetcher: LookupFetcher): Promise<LookupResult | null> {
  const term = query.trim();
  if (!term) return null;
  const endpoint = `https://itunes.apple.com/search?media=music&entity=song&limit=5&term=${encodeURIComponent(term)}`;
  const json = await fetcher.text(endpoint);
  const imageUrl = pickItunesArtwork(json, term);
  if (!imageUrl) return null;
  const data = await fetcher.bytes(imageUrl);
  if (!data || data.length < 256) return null;
  return { data, mime: mimeFor(data), source: "itunes" };
}

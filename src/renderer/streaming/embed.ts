// Official embeddable players, shown inside the deck panel (no separate
// window). Their audio is cross-origin and, for Widevine services, decrypted
// inside the CDM, so it can never feed Web Audio: these decks are
// preview/monitor-only. Bring them into the mix with system audio capture.
//
// Widevine playback inside Electron needs a Widevine-enabled build (castlabs
// "Electron for Content Security"); stock Electron has no CDM, so DRM players
// only play their non-DRM previews there. See docs/streaming-setup.md.

export type EmbedService = "youtube" | "spotify" | "apple-music" | "deezer" | "tidal" | "soundcloud" | "beatport";

export interface EmbedInfo {
  service: EmbedService;
  name: string;
  embedUrl: string;
  /** Full tracks in the player need Widevine/FairPlay (EME). */
  needsWidevine: boolean;
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

export function videoIdFromTrackUrl(url: string, fallbackId = ""): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be") {
      const id = parsed.pathname.slice(1);
      if (YT_ID.test(id)) return id;
    }
    const id = parsed.searchParams.get("v") ?? "";
    if (YT_ID.test(id)) return id;
  } catch {
    // not an absolute URL
  }
  return YT_ID.test(fallbackId) ? fallbackId : "";
}

export function youtubeEmbedUrl(videoId: string): string {
  if (!YT_ID.test(videoId)) return "";
  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1`;
}

const NAMES: Record<EmbedService, string> = {
  youtube: "YouTube",
  spotify: "Spotify",
  "apple-music": "Apple Music",
  deezer: "Deezer",
  tidal: "TIDAL",
  soundcloud: "SoundCloud",
  beatport: "Beatport",
};

const WIDEVINE: Record<EmbedService, boolean> = {
  youtube: false,
  spotify: true,
  "apple-music": true,
  deezer: true,
  tidal: true,
  soundcloud: false,
  beatport: false,
};

function info(service: EmbedService, embedUrl: string): EmbedInfo | null {
  return embedUrl ? { service, name: NAMES[service], embedUrl, needsWidevine: WIDEVINE[service] } : null;
}

/** Official embed URL for a track link the user pasted, or null if unsupported. */
export function officialEmbed(link: string): EmbedInfo | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtube.com" || host === "music.youtube.com" || host === "youtu.be" || host === "m.youtube.com") {
    return info("youtube", youtubeEmbedUrl(videoIdFromTrackUrl(url.toString())));
  }
  if (host === "open.spotify.com") {
    const m = /\/(track|album|playlist|episode)\/([A-Za-z0-9]+)/.exec(url.pathname);
    return m ? info("spotify", `https://open.spotify.com/embed/${m[1]}/${m[2]}`) : null;
  }
  if (host === "music.apple.com") {
    return /^\/[a-z]{2}\/(album|song|playlist)\//.test(url.pathname)
      ? info("apple-music", `https://embed.music.apple.com${url.pathname}${url.search}`)
      : null;
  }
  if (host === "deezer.com") {
    const m = /\/track\/(\d+)/.exec(url.pathname);
    return m ? info("deezer", `https://widget.deezer.com/widget/dark/track/${m[1]}`) : null;
  }
  if (host === "tidal.com" || host === "listen.tidal.com") {
    const m = /\/track\/(\d+)/.exec(url.pathname);
    return m ? info("tidal", tidalEmbedUrl(m[1])) : null;
  }
  if (host === "soundcloud.com" || host === "m.soundcloud.com") {
    return url.pathname.split("/").filter(Boolean).length >= 2 ? info("soundcloud", soundcloudWidgetUrl(`https://soundcloud.com${url.pathname}`)) : null;
  }
  if (host === "beatport.com") {
    // Beatport's public embed player (sample clips). Beatsource has no
    // documented embed, so Beatsource links are not embedded.
    const m = /\/track\/[^/]+\/(\d+)/.exec(url.pathname);
    return m ? info("beatport", `https://embed.beatport.com/?id=${m[1]}&type=track`) : null;
  }
  return null;
}

export function tidalEmbedUrl(trackId: string): string {
  return /^\d+$/.test(trackId) ? `https://embed.tidal.com/tracks/${trackId}` : "";
}

export function soundcloudWidgetUrl(permalink: string): string {
  return `https://w.soundcloud.com/player/?url=${encodeURIComponent(permalink)}&auto_play=true&visual=false`;
}

/** The label every monitor-only deck carries. */
export function monitorOnlyLabel(name: string, needsWidevine: boolean, widevineAvailable: boolean): string {
  const base = `${name} official player: preview/monitor only. Its audio can't reach the deck's EQ, FX, waveform or analysis; mix it in with System audio capture (AUX).`;
  if (needsWidevine && !widevineAvailable) {
    return `${base} Full tracks need Widevine, which this build doesn't include (needs a castlabs ECS Electron build), so expect previews only.`;
  }
  return base;
}

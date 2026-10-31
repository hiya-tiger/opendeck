import { providerEmbedUrl, type DrmScheme } from "./drm.ts";

export interface MusicProvider {
  id: string;
  name: string;
  loginUrl: string;
  homeUrl: string;
  searchUrl: (query: string) => string;
  apiSearchUrl?: (query: string) => string;
  trackUrl: (id: string) => string;
  embedUrl?: (trackUrl: string, id?: string) => string;
  cookieHints: string[];
  supportsSearch: boolean;
  drmSchemes: DrmScheme[];
  licenseUrl: string;
  note: string;
}

const q = (value: string): string => encodeURIComponent(value);

export const PROVIDERS: MusicProvider[] = [
  {
    id: "youtube-music",
    name: "YouTube Music",
    loginUrl: "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F",
    homeUrl: "https://music.youtube.com/",
    searchUrl: (query) => `https://music.youtube.com/search?q=${q(query)}`,
    apiSearchUrl: (query) => `https://music.youtube.com/search?q=${q(query)}`,
    trackUrl: (id) => `https://music.youtube.com/watch?v=${q(id)}`,
    embedUrl: (url, id) => providerEmbedUrl("youtube-music", url, id),
    cookieHints: ["SAPISID", "__Secure-3PSID", "SID"],
    supportsSearch: true,
    drmSchemes: ["widevine", "clearkey"],
    licenseUrl: "https://music.youtube.com/youtubei/v1/player/get_drm_license",
    note: "Direct EME Widevine / embedded deck player across Decks A–D, plus signed-in catalog search.",
  },
  {
    id: "spotify",
    name: "Spotify",
    loginUrl: "https://accounts.spotify.com/login",
    homeUrl: "https://open.spotify.com/",
    searchUrl: (query) => `https://open.spotify.com/search/${q(query)}`,
    apiSearchUrl: (query) => `https://api.spotify.com/v1/search?type=track&limit=20&q=${q(query)}`,
    trackUrl: (id) => `https://open.spotify.com/track/${q(id)}`,
    embedUrl: (url, id) => providerEmbedUrl("spotify", url, id),
    cookieHints: ["sp_dc", "sp_key"],
    supportsSearch: true,
    drmSchemes: ["widevine", "playready", "clearkey"],
    licenseUrl: "https://gew1-spclient.spotify.com/widevine-license/v1/audio/license",
    note: "Direct Spotify Web Playback SDK (Widevine EME) & OAuth PKCE catalog search across Decks A–D.",
  },
  {
    id: "soundcloud",
    name: "SoundCloud",
    loginUrl: "https://secure.soundcloud.com/sign-in",
    homeUrl: "https://soundcloud.com/",
    searchUrl: (query) => `https://soundcloud.com/search?q=${q(query)}`,
    apiSearchUrl: (query) => `https://api-v2.soundcloud.com/search/tracks?q=${q(query)}&limit=20`,
    trackUrl: (id) => `https://soundcloud.com/${id}`,
    embedUrl: (url, id) => providerEmbedUrl("soundcloud", url, id),
    cookieHints: ["oauth_token", "sc_anonymous_id"],
    supportsSearch: true,
    drmSchemes: ["widevine", "clearkey"],
    licenseUrl: "https://api-v2.soundcloud.com/drm/widevine/license",
    note: "SoundCloud Go+ HLS/EME DRM & direct deck player across Decks A–D with API v2 catalog search.",
  },
  {
    id: "tidal",
    name: "TIDAL",
    loginUrl: "https://login.tidal.com/",
    homeUrl: "https://listen.tidal.com/",
    searchUrl: (query) => `https://listen.tidal.com/search?q=${q(query)}`,
    apiSearchUrl: (query) => `https://api.tidal.com/v1/search/tracks?query=${q(query)}&limit=20&countryCode=US`,
    trackUrl: (id) => `https://listen.tidal.com/track/${q(id)}`,
    embedUrl: (url, id) => providerEmbedUrl("tidal", url, id),
    cookieHints: ["session_id", "tidal_web"],
    supportsSearch: true,
    drmSchemes: ["widevine", "fairplay", "clearkey"],
    licenseUrl: "https://api.tidal.com/v1/drm/licenses/widevine",
    note: "TIDAL DJ Extension (HiRes FLAC / AAC Widevine & FairPlay EME DRM) with direct Decks A–D playback.",
  },
  {
    id: "deezer",
    name: "Deezer",
    loginUrl: "https://www.deezer.com/login",
    homeUrl: "https://www.deezer.com/",
    searchUrl: (query) => `https://www.deezer.com/search/${q(query)}`,
    apiSearchUrl: (query) => `https://api.deezer.com/search/track?q=${q(query)}&limit=20`,
    trackUrl: (id) => `https://www.deezer.com/track/${q(id)}`,
    embedUrl: (url, id) => providerEmbedUrl("deezer", url, id),
    cookieHints: ["arl"],
    supportsSearch: true,
    drmSchemes: ["widevine", "clearkey"],
    licenseUrl: "https://media.deezer.com/v1/get_url",
    note: "Deezer Widevine EME & widget deck player with direct public/authenticated catalog search.",
  },
  {
    id: "apple-music",
    name: "Apple Music",
    loginUrl: "https://music.apple.com/login",
    homeUrl: "https://music.apple.com/",
    searchUrl: (query) => `https://music.apple.com/search?term=${q(query)}`,
    apiSearchUrl: (query) => `https://amp-api.music.apple.com/v1/catalog/us/search?types=songs&limit=20&term=${q(query)}`,
    trackUrl: (id) => `https://music.apple.com/song/${q(id)}`,
    embedUrl: (url, id) => providerEmbedUrl("apple-music", url, id),
    cookieHints: ["itspod", "dsid", "media-user-token"],
    supportsSearch: true,
    drmSchemes: ["fairplay", "widevine", "clearkey"],
    licenseUrl: "https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/fpsRequest",
    note: "MusicKit JS v3 (FairPlay / Widevine EME DRM) with developer token & direct Decks A–D playback.",
  },
  {
    id: "beatport",
    name: "Beatport",
    loginUrl: "https://www.beatport.com/login",
    homeUrl: "https://www.beatport.com/",
    searchUrl: (query) => `https://www.beatport.com/search?q=${q(query)}`,
    apiSearchUrl: (query) => `https://api.beatport.com/v4/catalog/search/?q=${q(query)}&type=tracks&per_page=20`,
    trackUrl: (id) => `https://www.beatport.com/track/-/${q(id)}`,
    embedUrl: (url, id) => providerEmbedUrl("beatport", url, id),
    cookieHints: ["cf_clearance", "session", "bp_access_token"],
    supportsSearch: true,
    drmSchemes: ["widevine", "clearkey"],
    licenseUrl: "https://api.beatport.com/v4/streaming/drm/widevine",
    note: "Beatport Streaming / LINK (Widevine EME CENC) with v4 catalog search and Decks A–D loading.",
  },
  {
    id: "beatsource",
    name: "Beatsource",
    loginUrl: "https://www.beatsource.com/login",
    homeUrl: "https://www.beatsource.com/",
    searchUrl: (query) => `https://www.beatsource.com/search?q=${q(query)}`,
    apiSearchUrl: (query) => `https://api.beatsource.com/v4/catalog/search/?q=${q(query)}&type=tracks&per_page=20`,
    trackUrl: (id) => `https://www.beatsource.com/track/-/${q(id)}`,
    embedUrl: (url, id) => providerEmbedUrl("beatsource", url, id),
    cookieHints: ["cf_clearance", "session", "bs_access_token"],
    supportsSearch: true,
    drmSchemes: ["widevine", "clearkey"],
    licenseUrl: "https://api.beatsource.com/v4/streaming/drm/widevine",
    note: "Beatsource Streaming / LINK open-format catalog (Widevine EME CENC) with Decks A–D loading.",
  },
];

export function findProvider(id: string): MusicProvider | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export const DIRECT_STREAM_NOTE =
  "Direct URL, EME DRM-licensed streams, and radio sources play inside OpenDecks across Decks A–D.";

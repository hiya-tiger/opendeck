export interface MusicProvider {
  id: string;
  name: string;
  loginUrl: string;
  homeUrl: string;
  searchUrl: (query: string) => string;
  trackUrl: (id: string) => string;
  cookieHints: string[];
  supportsSearch: boolean;
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
    trackUrl: (id) => `https://music.youtube.com/watch?v=${q(id)}`,
    cookieHints: ["SAPISID", "__Secure-3PSID", "SID"],
    supportsSearch: true,
    note: "Searches the signed-in account. Play on deck A or B uses YouTube's embedded player; mix it with system capture.",
  },
  {
    id: "spotify",
    name: "Spotify",
    loginUrl: "https://accounts.spotify.com/login",
    homeUrl: "https://open.spotify.com/",
    searchUrl: (query) => `https://open.spotify.com/search/${q(query)}`,
    trackUrl: (id) => `https://open.spotify.com/track/${q(id)}`,
    cookieHints: ["sp_dc", "sp_key"],
    supportsSearch: false,
    note: "In-app playback needs Spotify Premium plus a developer app (PKCE client ID). Until connected, OpenDeck opens the track in Spotify. Setup: docs/streaming-setup.md.",
  },
  {
    id: "soundcloud",
    name: "SoundCloud",
    loginUrl: "https://secure.soundcloud.com/sign-in",
    homeUrl: "https://soundcloud.com/",
    searchUrl: (query) => `https://soundcloud.com/search?q=${q(query)}`,
    trackUrl: (id) => `https://soundcloud.com/${id}`,
    cookieHints: ["oauth_token", "sc_anonymous_id"],
    supportsSearch: false,
    note: "Public tracks can play through the SoundCloud widget; search needs an API client ID. Until connected, OpenDeck opens the track in SoundCloud. Setup: docs/streaming-setup.md.",
  },
  {
    id: "tidal",
    name: "TIDAL",
    loginUrl: "https://login.tidal.com/",
    homeUrl: "https://listen.tidal.com/",
    searchUrl: (query) => `https://listen.tidal.com/search?q=${q(query)}`,
    trackUrl: (id) => `https://listen.tidal.com/track/${q(id)}`,
    cookieHints: ["session_id", "tidal_web"],
    supportsSearch: false,
    note: "TIDAL has no public playback SDK and its API is partner-only, so DRM playback stays in TIDAL. Setup: docs/streaming-setup.md.",
  },
  {
    id: "deezer",
    name: "Deezer",
    loginUrl: "https://www.deezer.com/login",
    homeUrl: "https://www.deezer.com/",
    searchUrl: (query) => `https://www.deezer.com/search/${q(query)}`,
    trackUrl: (id) => `https://www.deezer.com/track/${q(id)}`,
    cookieHints: ["arl"],
    supportsSearch: false,
    note: "Opens the track in Deezer; use system capture to mix it.",
  },
  {
    id: "apple-music",
    name: "Apple Music",
    loginUrl: "https://music.apple.com/login",
    homeUrl: "https://music.apple.com/",
    searchUrl: (query) => `https://music.apple.com/search?term=${q(query)}`,
    trackUrl: (id) => `https://music.apple.com/song/${q(id)}`,
    cookieHints: ["itspod", "dsid"],
    supportsSearch: false,
    note: "In-app playback needs a MusicKit developer token and an Apple Music subscription. Until connected, OpenDeck opens the track in Apple Music. Setup: docs/streaming-setup.md.",
  },
  {
    id: "beatport",
    name: "Beatport",
    loginUrl: "https://www.beatport.com/login",
    homeUrl: "https://www.beatport.com/",
    searchUrl: (query) => `https://www.beatport.com/search?q=${q(query)}`,
    trackUrl: (id) => `https://www.beatport.com/track/-/${q(id)}`,
    cookieHints: ["cf_clearance", "session"],
    supportsSearch: false,
    note: "Beatport streaming is partner-only (Beatport LINK), so OpenDeck opens the track in Beatport. Setup: docs/streaming-setup.md.",
  },
  {
    id: "beatsource",
    name: "Beatsource",
    loginUrl: "https://www.beatsource.com/login",
    homeUrl: "https://www.beatsource.com/",
    searchUrl: (query) => `https://www.beatsource.com/search?q=${q(query)}`,
    trackUrl: (id) => `https://www.beatsource.com/track/-/${q(id)}`,
    cookieHints: ["cf_clearance", "session"],
    supportsSearch: false,
    note: "Beatsource streaming is partner-only (Beatsource LINK), so OpenDeck opens the track in Beatsource. Setup: docs/streaming-setup.md.",
  },
];

export function findProvider(id: string): MusicProvider | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export const DIRECT_STREAM_NOTE =
  "Direct URL and radio sources play inside OpenDeck with full mixing, sync and recording.";

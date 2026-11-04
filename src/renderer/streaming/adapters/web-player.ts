// "Web players": paste a track link from a service that only allows its own
// player (Spotify, Apple Music, Deezer, YouTube, TIDAL, SoundCloud, Beatport
// clips). The deck embeds that service's official player. No search, no
// scraping, no keys: the link is the whole input. Always monitor-only.

import type { BrowseResult, PlaybackPlan, SourceCapabilities, StreamHttp, StreamSource, StreamTrack } from "../source.ts";
import { officialEmbed } from "../embed.ts";

const CAPS: SourceCapabilities = {
  search: true,
  browse: false,
  decodable: false,
  embed: true,
  userAuth: false,
  userAuthRequired: false,
};

export function createWebPlayerSource(_http?: StreamHttp): StreamSource {
  return {
    id: "web-player",
    name: "Web players (paste a link)",
    capabilities: CAPS,
    oauth: null,
    apiHosts: [],
    audioHostSuffixes: [],
    keyHelp: "",
    authStatus: () => ({ state: "app-only", message: "No key needed. Paste a track link; it plays in the service's own player, monitor only." }),

    async search(query: string): Promise<StreamTrack[]> {
      const embed = officialEmbed(query);
      if (!embed) return [];
      return [
        {
          source: "web-player",
          id: query.trim(),
          title: `${embed.name} link`,
          artist: embed.name,
          durationSec: 0,
          permalink: query.trim(),
          access: "preview",
        },
      ];
    },

    async browse(): Promise<BrowseResult> {
      return { nodes: [], tracks: [], note: "Paste a Spotify, Apple Music, Deezer, YouTube, TIDAL, SoundCloud or Beatport track link." };
    },

    async metadata(id: string): Promise<StreamTrack> {
      const [track] = await this.search(id);
      if (!track) throw new Error("Not a supported track link");
      return track;
    },

    async resolve(track: StreamTrack): Promise<PlaybackPlan> {
      const embed = officialEmbed(track.permalink ?? track.id);
      if (!embed) return { kind: "unavailable", source: "web-player", reason: "Not a supported track link." };
      return {
        kind: "monitor-only",
        source: "web-player",
        embedUrl: embed.embedUrl,
        reason: embed.needsWidevine ? "widevine" : "widget",
        note: `${embed.name}'s official player.`,
      };
    },
  };
}

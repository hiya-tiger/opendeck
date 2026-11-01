// The stream sources the app ships, in the order the Stream tab lists them.
import { StreamSourceRegistry, type StreamHttp, type StreamSourceId } from "./source.ts";
import { createBeatportSource } from "./adapters/beatport.ts";
import { createSoundcloudSource } from "./adapters/soundcloud.ts";
import { createTidalSource } from "./adapters/tidal.ts";
import { createWebPlayerSource } from "./adapters/web-player.ts";

/** `http` is one transport for all sources, or a factory giving each source its own. */
export function createDefaultSources(
  http: StreamHttp | ((id: StreamSourceId) => StreamHttp),
  opts: { tidalCountry?: string } = {},
): StreamSourceRegistry {
  const httpFor = (id: StreamSourceId): StreamHttp => (typeof http === "function" ? http(id) : http);
  const registry = new StreamSourceRegistry();
  registry.register(createBeatportSource("beatport", httpFor("beatport")));
  registry.register(createBeatportSource("beatsource", httpFor("beatsource")));
  registry.register(createTidalSource(httpFor("tidal"), opts.tidalCountry));
  registry.register(createSoundcloudSource(httpFor("soundcloud")));
  registry.register(createWebPlayerSource(httpFor("web-player")));
  return registry;
}

/** A transport that refuses everything: used where only static source info is needed. */
export const NO_HTTP: StreamHttp = {
  request: async () => ({ status: 0, body: "", error: "network", detail: "no transport" }),
};

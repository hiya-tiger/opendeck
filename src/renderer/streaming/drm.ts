// EME capability probe. OpenDecks never acquires DRM licences itself and never
// talks to a service's licence server: Widevine/FairPlay content plays only
// inside that service's official player (see embed.ts, docs/decisions.md D42).
// This module only answers "can an embedded official player use Widevine here?"
// so the deck can say so honestly.

export type DrmScheme = "widevine" | "fairplay" | "playready" | "clearkey";

export const DRM_KEY_SYSTEMS: Record<DrmScheme, string> = {
  widevine: "com.widevine.alpha",
  fairplay: "com.apple.fps.1_0",
  playready: "com.microsoft.playready",
  clearkey: "org.w3.clearkey",
};

export interface DrmCapabilitiesReport {
  supportedSchemes: DrmScheme[];
  keySystems: Record<DrmScheme, boolean>;
  activeScheme: DrmScheme | null;
}

export function defaultMediaKeySystemConfig(): MediaKeySystemConfiguration[] {
  return [
    {
      initDataTypes: ["cenc", "cbcs", "webm", "keyids"],
      audioCapabilities: [
        { contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: "SW_SECURE_CRYPTO" },
        { contentType: 'audio/mp4; codecs="flac"', robustness: "SW_SECURE_CRYPTO" },
        { contentType: 'audio/webm; codecs="opus"', robustness: "" },
      ],
      distinctiveIdentifier: "optional",
      persistentState: "optional",
      sessionTypes: ["temporary"],
    },
  ];
}

export type RequestMediaKeySystemAccessFn = (
  keySystem: string,
  supportedConfigurations: MediaKeySystemConfiguration[],
) => Promise<MediaKeySystemAccess>;

export async function probeKeySystems(requestAccess?: RequestMediaKeySystemAccessFn): Promise<DrmCapabilitiesReport> {
  const fn =
    requestAccess ??
    (typeof navigator !== "undefined" && typeof navigator.requestMediaKeySystemAccess === "function"
      ? navigator.requestMediaKeySystemAccess.bind(navigator)
      : undefined);
  const keySystems: Record<DrmScheme, boolean> = { widevine: false, fairplay: false, playready: false, clearkey: false };
  const supportedSchemes: DrmScheme[] = [];
  if (!fn) return { supportedSchemes, keySystems, activeScheme: null };
  const configs = defaultMediaKeySystemConfig();
  for (const scheme of ["widevine", "playready", "fairplay", "clearkey"] as DrmScheme[]) {
    try {
      await fn(DRM_KEY_SYSTEMS[scheme], configs);
      keySystems[scheme] = true;
      supportedSchemes.push(scheme);
    } catch {
      keySystems[scheme] = false;
    }
  }
  return { supportedSchemes, keySystems, activeScheme: supportedSchemes[0] ?? null };
}

/** One line for the Stream tab about embedded DRM players in this build. */
export function widevineStatusText(report: DrmCapabilitiesReport): string {
  if (report.keySystems.widevine) {
    return "Widevine available: official players can play full DRM tracks here (monitor only; DRM audio never reaches the decks).";
  }
  return "No Widevine in this build: DRM players show previews only. Full tracks need a Widevine-enabled Electron (castlabs ECS).";
}

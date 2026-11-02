/**
 * LinkManager — picks and owns the session tempo backend (D43).
 *
 * Setting "protocol": "ableton" (default; clean-room Ableton Link, interoperates
 * with Link apps) or "opendeck" (opendeck-link/1, OpenDecks-only fallback).
 * Switching while enabled disables the old backend (sending a bye-bye where the
 * protocol has one) and enables the new one carrying the current tempo.
 */

import type { LinkBackend, LinkProtocolChoice, LinkStatus } from "./link-backend.ts";
import { isLinkProtocolChoice } from "./link-backend.ts";

export interface LinkSettings {
  protocol: LinkProtocolChoice;
  startStopSync: boolean;
}

export const DEFAULT_LINK_SETTINGS: LinkSettings = { protocol: "ableton", startStopSync: false };

export interface LinkManagerOptions {
  create: (protocol: LinkProtocolChoice) => LinkBackend;
  settings?: Partial<LinkSettings>;
  save?: (settings: LinkSettings) => void | Promise<void>;
}

export const normalizeLinkSettings = (raw: unknown): LinkSettings => {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    protocol: isLinkProtocolChoice(r.protocol) ? r.protocol : DEFAULT_LINK_SETTINGS.protocol,
    startStopSync: typeof r.startStopSync === "boolean" ? r.startStopSync : DEFAULT_LINK_SETTINGS.startStopSync,
  };
};

export type LinkManagerStatus = LinkStatus & { settings: LinkSettings };

export class LinkManager {
  private readonly create: (protocol: LinkProtocolChoice) => LinkBackend;
  private readonly save: ((settings: LinkSettings) => void | Promise<void>) | undefined;
  private settingsValue: LinkSettings;
  private node: LinkBackend | null = null;

  constructor(options: LinkManagerOptions) {
    this.create = options.create;
    this.save = options.save;
    this.settingsValue = normalizeLinkSettings({ ...DEFAULT_LINK_SETTINGS, ...options.settings });
  }

  get settings(): LinkSettings {
    return { ...this.settingsValue };
  }

  get backend(): LinkBackend {
    if (!this.node) {
      this.node = this.create(this.settingsValue.protocol);
      this.node.setStartStopSync?.(this.settingsValue.startStopSync);
    }
    return this.node;
  }

  private wrap(status: LinkStatus): LinkManagerStatus {
    return { ...status, settings: this.settings };
  }

  status(): LinkManagerStatus {
    return this.wrap(this.backend.status());
  }

  async enable(): Promise<LinkManagerStatus> {
    return this.wrap(await this.backend.enable());
  }

  async disable(): Promise<LinkManagerStatus> {
    return this.wrap(await this.backend.disable());
  }

  setLocalTempo(bpm: number): LinkManagerStatus {
    return this.wrap(this.backend.setLocalTempo(bpm));
  }

  setPlaying(playing: boolean): LinkManagerStatus {
    return this.wrap(this.backend.setPlaying ? this.backend.setPlaying(playing) : this.backend.status());
  }

  async updateSettings(patch: Partial<LinkSettings>): Promise<LinkManagerStatus> {
    const next = normalizeLinkSettings({ ...this.settingsValue, ...patch });
    const protocolChanged = next.protocol !== this.settingsValue.protocol;
    this.settingsValue = next;
    if (protocolChanged && this.node) {
      const old = this.node;
      const wasEnabled = old.status().enabled;
      const bpm = old.status().localBpm;
      await old.disable();
      this.node = null;
      const fresh = this.backend;
      fresh.setLocalTempo(bpm);
      if (wasEnabled) await fresh.enable();
    } else {
      this.node?.setStartStopSync?.(next.startStopSync);
    }
    await this.save?.(next);
    return this.status();
  }

  async shutdown(): Promise<void> {
    await this.node?.disable();
  }
}

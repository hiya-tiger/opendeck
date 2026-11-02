/**
 * Turns key events into keymap actions (D45). No DOM access beyond the event
 * objects it is handed, so the guard, holds and the enable switch are unit
 * tested in Node with plain objects.
 */
import { isTextInputTarget, matchEvent, type KeyEventLike, type Match, type Platform, type TargetLike } from "./serato-keymap.ts";

export type Phase = "down" | "up";

export interface ShortcutEvent extends KeyEventLike {
  target?: (TargetLike & { classList?: { contains(name: string): boolean } }) | null;
  preventDefault?: () => void;
}

export interface ControllerHost {
  /** Run one action. Return false when it did nothing, so the key falls through. */
  run(match: Match, phase: Phase): boolean;
  /** A modal (confirm, overlay) wants every key; it returns true when it used one. */
  modalKey?(event: ShortcutEvent): boolean;
}

export class KeyboardController {
  enabled = true;
  private readonly held = new Map<string, Match>();
  private readonly host: ControllerHost;
  private readonly platform: Platform;

  constructor(host: ControllerHost, platform: Platform) {
    this.host = host;
    this.platform = platform;
  }

  /** keydown: returns true when the event was used (and prevented). */
  keydown(event: ShortcutEvent): boolean {
    if (this.host.modalKey?.(event)) {
      event.preventDefault?.();
      return true;
    }
    if (!this.enabled) return false;
    const target = event.target ?? null;
    const inBpmEditor = Boolean(target?.classList?.contains("bpm-edit"));
    const match = matchEvent(event, this.platform, { inTextInput: isTextInputTarget(target), inBpmEditor });
    if (!match) {
      // An auto-repeat of a held key is still ours: swallow it so it does not type.
      if (event.repeat && this.held.has(event.code)) {
        event.preventDefault?.();
        return true;
      }
      return false;
    }
    if (match.binding.hold && this.held.has(event.code)) {
      event.preventDefault?.();
      return true;
    }
    const used = this.host.run(match, "down");
    if (!used) return false;
    if (match.binding.hold) this.held.set(event.code, match);
    event.preventDefault?.();
    return true;
  }

  /** keyup: ends a hold started by the same physical key, whatever the modifiers are now. */
  keyup(event: ShortcutEvent): boolean {
    const match = this.held.get(event.code);
    if (!match) return false;
    this.held.delete(event.code);
    this.host.run(match, "up");
    event.preventDefault?.();
    return true;
  }

  /** Window blur / shortcuts switched off: let go of everything still held. */
  releaseAll(): void {
    for (const [code, match] of [...this.held]) {
      this.held.delete(code);
      this.host.run(match, "up");
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  get holding(): number {
    return this.held.size;
  }
}

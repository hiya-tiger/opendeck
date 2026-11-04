/**
 * Keyboard shortcuts screen (laid out like Serato DJ's), the confirm dialog
 * the destructive shortcuts use, and the Settings popover with the on/off
 * switch (D45).
 */
import { SERATO_KEYMAP, displayFor, type Binding, type DeckFocus, type Platform } from "./serato-keymap.ts";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export const SHORTCUTS_STORAGE_KEY = "opendeck.shortcuts.enabled";

export function storedShortcutsEnabled(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(SHORTCUTS_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function storeShortcutsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SHORTCUTS_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // storage unavailable
  }
}

function keyText(binding: Binding, platform: Platform, right: boolean): string {
  const text = right ? binding.rightDisplay ?? "" : binding.display;
  return displayFor(text, platform);
}

export interface OverlayOptions {
  platform: Platform;
  focus: () => { focus: DeckFocus; fourDeck: boolean };
  enabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
}

export class ShortcutsOverlay {
  readonly root: HTMLElement;
  private readonly leftHead: HTMLElement;
  private readonly rightHead: HTMLElement;
  private readonly toggle: HTMLInputElement;
  private readonly options: OverlayOptions;

  constructor(options: OverlayOptions) {
    this.options = options;
    const root = el("div", "kb-overlay hidden");
    root.id = "shortcutsOverlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Keyboard shortcuts");
    const panel = el("div", "kb-panel");
    const close = el("button", "kb-close", "✕");
    close.type = "button";
    close.title = "Close (Escape)";
    close.addEventListener("click", () => this.hide());
    panel.append(close);

    const p = options.platform;
    const playback = el("section", "kb-section");
    playback.append(el("h2", "kb-title", "Playback Shortcuts"));
    const table = el("div", "kb-grid kb-grid-3");
    this.leftHead = el("div", "kb-head", "Left Virtual Deck");
    this.rightHead = el("div", "kb-head", "Right Virtual Deck");
    table.append(el("div", "kb-head", "Action"), this.leftHead, this.rightHead);
    for (const binding of SERATO_KEYMAP.filter((b) => b.section === "playback")) {
      const label = el("div", "kb-action", binding.label);
      if (binding.status === "noop") label.append(el("span", "kb-na", " (not available yet)"));
      label.dataset.binding = binding.id;
      table.append(label, el("div", "kb-key", keyText(binding, p, false)), el("div", "kb-key", keyText(binding, p, true) || "—"));
    }
    playback.append(table);

    const lib = el("section", "kb-section");
    lib.append(el("h2", "kb-title", "Library Shortcuts"));
    const libTable = el("div", "kb-grid kb-grid-2");
    for (const binding of SERATO_KEYMAP.filter((b) => b.section === "library")) {
      const label = el("div", "kb-action", binding.label);
      label.dataset.binding = binding.id;
      libTable.append(label, el("div", "kb-key", keyText(binding, p, false)));
    }
    lib.append(libTable);

    const extra = el("section", "kb-section");
    extra.append(el("h2", "kb-title", "OpenDecks"));
    const extraTable = el("div", "kb-grid kb-grid-2");
    for (const binding of SERATO_KEYMAP.filter((b) => b.section === "opendecks")) {
      const label = el("div", "kb-action", binding.label);
      label.dataset.binding = binding.id;
      const keys = binding.right ? `${keyText(binding, p, false)} | ${keyText(binding, p, true)}` : keyText(binding, p, false);
      extraTable.append(label, el("div", "kb-key", keys));
    }
    extra.append(extraTable);

    const foot = el("label", "kb-foot");
    this.toggle = el("input");
    this.toggle.type = "checkbox";
    this.toggle.id = "shortcutsOverlayToggle";
    this.toggle.addEventListener("change", () => options.setEnabled(this.toggle.checked));
    foot.append(this.toggle, document.createTextNode(" Keyboard shortcuts on (also in Settings)"));

    panel.append(playback, lib, extra, foot);
    root.append(panel);
    root.addEventListener("click", (event) => {
      if (event.target === root) this.hide();
    });
    this.root = root;
    document.body.append(root);
  }

  get open(): boolean {
    return !this.root.classList.contains("hidden");
  }

  refresh(): void {
    const { focus, fourDeck } = this.options.focus();
    const left = fourDeck ? focus.left : "A";
    const right = fourDeck ? focus.right : "B";
    this.leftHead.textContent = `Left Virtual Deck · ${left}`;
    this.rightHead.textContent = `Right Virtual Deck · ${right}`;
    this.toggle.checked = this.options.enabled();
  }

  show(): void {
    this.refresh();
    this.root.classList.remove("hidden");
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  toggleOpen(): void {
    if (this.open) this.hide();
    else this.show();
  }
}

/** A small in-app confirm (window.confirm would block the audio thread's UI and the smoke harness). */
export class ConfirmDialog {
  readonly root: HTMLElement;
  private readonly text: HTMLElement;
  private readonly okBtn: HTMLButtonElement;
  private resolver: ((ok: boolean) => void) | null = null;

  constructor() {
    const root = el("div", "kb-confirm hidden");
    root.id = "shortcutConfirm";
    root.setAttribute("role", "alertdialog");
    const box = el("div", "kb-confirm-box");
    this.text = el("p", "kb-confirm-text");
    const row = el("div", "kb-confirm-row");
    const cancel = el("button", "ghost small", "Cancel");
    cancel.type = "button";
    cancel.dataset.answer = "cancel";
    this.okBtn = el("button", "primary small", "OK");
    this.okBtn.type = "button";
    this.okBtn.dataset.answer = "ok";
    cancel.addEventListener("click", () => this.answer(false));
    this.okBtn.addEventListener("click", () => this.answer(true));
    row.append(cancel, this.okBtn);
    box.append(this.text, row);
    root.append(box);
    this.root = root;
    document.body.append(root);
  }

  get open(): boolean {
    return this.resolver !== null;
  }

  ask(message: string, okLabel = "OK"): Promise<boolean> {
    if (this.resolver) this.answer(false);
    this.text.textContent = message;
    this.okBtn.textContent = okLabel;
    this.root.classList.remove("hidden");
    this.okBtn.focus();
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  /** Enter confirms, Escape cancels, everything else is swallowed while open. */
  key(event: { code: string; key?: string }): boolean {
    if (!this.resolver) return false;
    if (event.code === "Escape") this.answer(false);
    else if (event.code === "Enter" || event.code === "NumpadEnter") this.answer(true);
    return true;
  }

  answer(ok: boolean): void {
    const resolve = this.resolver;
    this.resolver = null;
    this.root.classList.add("hidden");
    resolve?.(ok);
  }
}

/** The Settings popover in the top bar; for now it holds the shortcuts switch. */
export class SettingsPopover {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  private readonly checkbox: HTMLInputElement;

  constructor(host: HTMLElement | null, options: { enabled: () => boolean; setEnabled: (on: boolean) => void; showShortcuts: () => void }) {
    this.button = el("button", "pill-btn", "Settings");
    this.button.id = "settingsBtn";
    this.button.type = "button";
    this.button.setAttribute("aria-expanded", "false");
    this.panel = el("div", "settings-panel hidden");
    this.panel.id = "settingsPanel";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Settings");
    const label = el("label", "micro");
    this.checkbox = el("input");
    this.checkbox.type = "checkbox";
    this.checkbox.id = "shortcutsEnabled";
    this.checkbox.addEventListener("change", () => options.setEnabled(this.checkbox.checked));
    label.append(this.checkbox, document.createTextNode(" Keyboard shortcuts (Serato layout)"));
    const show = el("button", "ghost small", "Show shortcuts (?)");
    show.type = "button";
    show.addEventListener("click", () => {
      this.close();
      options.showShortcuts();
    });
    this.panel.append(el("strong", undefined, "Settings"), label, show);
    this.button.addEventListener("click", () => {
      if (this.panel.classList.contains("hidden")) {
        this.checkbox.checked = options.enabled();
        this.panel.classList.remove("hidden");
        this.button.setAttribute("aria-expanded", "true");
      } else this.close();
    });
    const wrap = el("span", "settings-wrap");
    wrap.append(this.button, this.panel);
    (host ?? document.body).append(wrap);
  }

  sync(enabled: boolean): void {
    this.checkbox.checked = enabled;
  }

  close(): void {
    this.panel.classList.add("hidden");
    this.button.setAttribute("aria-expanded", "false");
  }
}

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_FOCUS,
  LoadHistory,
  MOVED_BINDINGS,
  SERATO_KEYMAP,
  chordFromEvent,
  compiledKeymap,
  deckForSide,
  displayFor,
  firstFreeCue,
  focusForMode,
  isTextInputTarget,
  isZoomIn,
  matchEvent,
  moveCursor,
  neighbourTrack,
  nextSpan,
  nextTextScale,
  otherSide,
  parseChord,
  platformFrom,
  toggleFocus,
  type KeyEventLike,
  type Platform,
} from "../src/renderer/keyboard/serato-keymap.ts";
import { KeyboardController, type ShortcutEvent } from "../src/renderer/keyboard/controller.ts";

/** A key event for a table chord, with Ctrl as Cmd and Alt as Option on a Mac. */
function eventFor(chord: string, platform: Platform, extra: Partial<KeyEventLike> = {}): KeyEventLike {
  const c = parseChord(chord);
  return {
    code: c.code,
    ctrlKey: platform === "mac" ? false : c.ctrl,
    metaKey: platform === "mac" ? c.ctrl : false,
    shiftKey: c.shift,
    altKey: c.alt,
    repeat: false,
    ...extra,
  };
}

const NO_INPUT = { inTextInput: false };
const PLATFORMS: Platform[] = ["other", "mac"];

// Every row of Serato's screen (Donovan's photo, notes/serato-shortcuts.md).
const SERATO_PLAYBACK_ROWS: Record<string, [string[], string[] | null]> = {
  "load-selected": [["Shift+ArrowLeft"], ["Shift+ArrowRight"]],
  "double-track": [["Ctrl+Shift+ArrowRight"], ["Ctrl+Shift+ArrowLeft"]],
  eject: [["Shift+Alt+ArrowLeft"], ["Shift+Alt+ArrowRight"]],
  "play-pause": [["KeyW"], ["KeyS"]],
  reverse: [["KeyQ"], ["KeyA"]],
  "set-cue": [["Ctrl+Digit1", "Ctrl+Digit2", "Ctrl+Digit3", "Ctrl+Digit4", "Ctrl+Digit5"], ["Ctrl+Digit6", "Ctrl+Digit7", "Ctrl+Digit8", "Ctrl+Digit9", "Ctrl+Digit0"]],
  cue: [["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"], ["Digit6", "Digit7", "Digit8", "Digit9", "Digit0"]],
  "add-next-cue": [["Alt+Backquote"], ["Alt+Minus"]],
  "temp-cue": [["KeyI"], ["KeyK"]],
  "load-next": [["Alt+KeyW"], ["Alt+KeyS"]],
  "load-prev": [["Alt+KeyQ"], ["Alt+KeyA"]],
  rewind: [["Alt+KeyE"], ["Alt+KeyD"]],
  "fast-forward": [["Alt+KeyR"], ["Alt+KeyF"]],
  "tempo-down": [["KeyE"], ["KeyD"]],
  "tempo-up": [["KeyR"], ["KeyF"]],
  censor: [["KeyU"], ["KeyJ"]],
  keylock: [["F5"], ["F10"]],
  "flip-record": [["Backslash"], null],
};
const SERATO_LIBRARY_ROWS: Record<string, string[]> = {
  "library-move": ["ArrowUp", "ArrowDown"],
  "crate-move": ["Ctrl+Shift+ArrowUp", "Ctrl+Shift+ArrowDown"],
  "shift-focus": ["Tab"],
  search: ["Ctrl+KeyF"],
  "crate-search": ["Ctrl+Shift+KeyF"],
  reveal: ["Ctrl+KeyR"],
  "show-in-crates": ["Ctrl+Shift+KeyR"],
  "locate-loaded": ["Ctrl+KeyL"],
  "select-all": ["Ctrl+KeyA"],
  "undo-load": ["Ctrl+KeyZ"],
  "delete-track": ["Ctrl+Delete"],
  "trash-file": ["Ctrl+Shift+Delete"],
  prepare: ["Ctrl+KeyP"],
  "wave-zoom": ["Shift+Equal", "Minus"],
  "text-zoom": ["Ctrl+Shift+Equal", "Ctrl+Minus"],
  "new-recording": ["Ctrl+KeyN"],
  "open-default": ["Ctrl+KeyO"],
  "bpm-scale": ["Alt+ArrowUp", "Alt+ArrowDown"],
  "beatgrid-edit": ["Alt+Space"],
  "am-hide": ["Alt+Slash"],
  escape: ["Escape"],
};

describe("Serato keymap table", () => {
  test("compiles without two actions on one chord", () => {
    const map = compiledKeymap();
    const total = SERATO_KEYMAP.reduce((n, b) => n + b.keys.length + (b.right?.length ?? 0), 0);
    assert.equal(map.size, total);
  });

  test("every row of Serato's screen is in the table with Serato's keys", () => {
    for (const [id, [left, right]] of Object.entries(SERATO_PLAYBACK_ROWS)) {
      const binding = SERATO_KEYMAP.find((b) => b.id === id);
      assert.ok(binding, `missing ${id}`);
      assert.equal(binding.section, "playback", id);
      for (const chord of left) assert.ok(binding.keys.includes(chord), `${id} left ${chord}`);
      if (right) for (const chord of right) assert.ok(binding.right?.includes(chord), `${id} right ${chord}`);
    }
    for (const [id, chords] of Object.entries(SERATO_LIBRARY_ROWS)) {
      const binding = SERATO_KEYMAP.find((b) => b.id === id);
      assert.ok(binding, `missing ${id}`);
      for (const chord of chords) assert.ok(binding.keys.includes(chord), `${id} ${chord}`);
    }
    assert.equal(SERATO_KEYMAP.filter((b) => b.section === "playback").length, Object.keys(SERATO_PLAYBACK_ROWS).length);
    assert.equal(SERATO_KEYMAP.filter((b) => b.section === "library").length, Object.keys(SERATO_LIBRARY_ROWS).length);
  });

  test("the transcription notes list the same playback actions", () => {
    const notes = readFileSync(new URL("../docs/keyboard-shortcuts.md", import.meta.url), "utf8");
    for (const binding of SERATO_KEYMAP) assert.ok(notes.includes(binding.label), `docs miss "${binding.label}"`);
  });

  for (const platform of PLATFORMS) {
    test(`every chord of every binding matches its own action (${platform})`, () => {
      let checked = 0;
      for (const binding of SERATO_KEYMAP) {
        const sides: ["left" | "right", string[]][] = [["left", binding.keys]];
        if (binding.right) sides.push(["right", binding.right]);
        for (const [side, chords] of sides) {
          chords.forEach((chord, i) => {
            const match = matchEvent(eventFor(chord, platform), platform, NO_INPUT);
            assert.ok(match, `${binding.id} ${chord} unmatched`);
            assert.equal(match.binding.id, binding.id, chord);
            assert.equal(match.side, side, chord);
            assert.equal(match.chord, chord);
            const indexes = side === "left" ? binding.index : binding.rightIndex;
            assert.equal(match.index, indexes?.[i], chord);
            checked += 1;
          });
        }
      }
      assert.equal(checked, compiledKeymap().size);
    });
  }

  test("digit cue rows number cues 1-5 on both sides", () => {
    assert.equal(matchEvent(eventFor("Digit0", "other"), "other", NO_INPUT)?.index, 5);
    assert.equal(matchEvent(eventFor("Digit6", "other"), "other", NO_INPUT)?.index, 1);
    assert.equal(matchEvent(eventFor("Ctrl+Digit3", "other"), "other", NO_INPUT)?.index, 3);
  });

  test("unbound chords match nothing", () => {
    for (const chord of ["KeyX", "Ctrl+KeyX", "Shift+KeyW", "Ctrl+KeyW", "Alt+KeyX", "F2", "Ctrl+Alt+ArrowLeft"]) {
      assert.equal(matchEvent(eventFor(chord, "other"), "other", NO_INPUT), null, chord);
    }
  });
});

describe("macOS modifier swap", () => {
  test("Cmd plays Ctrl's part and Option plays Alt's on a Mac", () => {
    const cmdF = { code: "KeyF", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false };
    assert.equal(matchEvent(cmdF, "mac", NO_INPUT)?.binding.id, "search");
    const optW = { code: "KeyW", key: "∑", ctrlKey: false, metaKey: false, shiftKey: false, altKey: true };
    assert.equal(matchEvent(optW, "mac", NO_INPUT)?.binding.id, "load-next");
    const cmdShiftOptLeft = { code: "ArrowLeft", ctrlKey: false, metaKey: true, shiftKey: true, altKey: true };
    assert.equal(matchEvent(cmdShiftOptLeft, "mac", NO_INPUT)?.binding.id, "load-c");
  });

  test("a Mac's Control key and Windows' Win key match nothing", () => {
    const ctrlF = { code: "KeyF", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    assert.equal(matchEvent(ctrlF, "mac", NO_INPUT), null);
    assert.equal(chordFromEvent(ctrlF, "mac"), null);
    const winF = { code: "KeyF", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false };
    assert.equal(matchEvent(winF, "other", NO_INPUT), null);
    assert.equal(matchEvent(ctrlF, "other", NO_INPUT)?.binding.id, "search");
  });

  test("overlay wording turns control into cmd and alt into option", () => {
    assert.equal(displayFor("control + shift + alt + left arrow", "mac"), "cmd + shift + option + left arrow");
    assert.equal(displayFor("control + shift + alt + left arrow", "other"), "control + shift + alt + left arrow");
    assert.equal(displayFor("alt + spacebar", "mac"), "option + spacebar");
  });

  test("platform detection", () => {
    assert.equal(platformFrom("darwin"), "mac");
    assert.equal(platformFrom("MacIntel"), "mac");
    assert.equal(platformFrom("win32"), "other");
    assert.equal(platformFrom("linux"), "other");
    assert.equal(platformFrom(undefined), "other");
  });
});

describe("input-focus guard", () => {
  test("text fields are recognised, buttons and sliders are not", () => {
    assert.ok(isTextInputTarget({ tagName: "INPUT", type: "search" }));
    assert.ok(isTextInputTarget({ tagName: "INPUT", type: "text" }));
    assert.ok(isTextInputTarget({ tagName: "INPUT" }));
    assert.ok(isTextInputTarget({ tagName: "TEXTAREA" }));
    assert.ok(isTextInputTarget({ tagName: "SELECT" }));
    assert.ok(isTextInputTarget({ tagName: "DIV", isContentEditable: true }));
    assert.ok(!isTextInputTarget({ tagName: "INPUT", type: "range" }));
    assert.ok(!isTextInputTarget({ tagName: "INPUT", type: "checkbox" }));
    assert.ok(!isTextInputTarget({ tagName: "BUTTON" }));
    assert.ok(!isTextInputTarget(null));
  });

  for (const platform of PLATFORMS) {
    test(`no binding fires while typing except Escape and BPM Alt+Up/Down (${platform})`, () => {
      for (const binding of SERATO_KEYMAP) {
        for (const chord of [...binding.keys, ...(binding.right ?? [])]) {
          const typing = matchEvent(eventFor(chord, platform), platform, { inTextInput: true });
          const inBpm = matchEvent(eventFor(chord, platform), platform, { inTextInput: true, inBpmEditor: true });
          if (binding.id === "escape") {
            assert.equal(typing?.binding.id, "escape");
            assert.equal(inBpm?.binding.id, "escape");
          } else if (binding.id === "bpm-scale") {
            assert.equal(typing, null, chord);
            assert.equal(inBpm?.binding.id, "bpm-scale", chord);
          } else {
            assert.equal(typing, null, `${binding.id} ${chord} fired in a text field`);
            assert.equal(inBpm, null, `${binding.id} ${chord} fired in the BPM editor`);
          }
        }
      }
    });
  }

  test("auto-repeat fires only repeatable actions", () => {
    assert.equal(matchEvent(eventFor("KeyW", "other", { repeat: true }), "other", NO_INPUT), null);
    assert.equal(matchEvent(eventFor("KeyR", "other", { repeat: true }), "other", NO_INPUT)?.binding.id, "tempo-up");
    assert.equal(matchEvent(eventFor("ArrowDown", "other", { repeat: true }), "other", NO_INPUT)?.binding.id, "library-move");
  });
});

describe("4-deck focus and C/D keys", () => {
  test("2-deck mode always targets A and B", () => {
    const focus = { left: "C", right: "D" } as const;
    assert.equal(deckForSide("left", focus, false), "A");
    assert.equal(deckForSide("right", focus, false), "B");
  });

  test("F1 toggles the left side A<->C and F6 the right side B<->D", () => {
    assert.equal(matchEvent(eventFor("F1", "other"), "other", NO_INPUT)?.binding.id, "focus-left");
    assert.equal(matchEvent(eventFor("F6", "other"), "other", NO_INPUT)?.binding.id, "focus-right");
    let focus = { ...DEFAULT_FOCUS };
    focus = toggleFocus(focus, "left", true);
    assert.deepEqual(focus, { left: "C", right: "B" });
    assert.equal(deckForSide("left", focus, true), "C");
    assert.equal(deckForSide("right", focus, true), "B");
    focus = toggleFocus(focus, "right", true);
    assert.deepEqual(focus, { left: "C", right: "D" });
    focus = toggleFocus(focus, "left", true);
    assert.deepEqual(focus, { left: "A", right: "D" });
    assert.deepEqual(toggleFocus(focus, "left", false), DEFAULT_FOCUS);
  });

  test("every left/right deck key follows its side's focus", () => {
    const focus = { left: "C", right: "D" } as const;
    for (const binding of SERATO_KEYMAP.filter((b) => b.right && !b.deck)) {
      const left = matchEvent(eventFor(binding.keys[0]!, "other"), "other", NO_INPUT)!;
      const right = matchEvent(eventFor(binding.right![0]!, "other"), "other", NO_INPUT)!;
      assert.equal(deckForSide(left.side, focus, true), "C", binding.id);
      assert.equal(deckForSide(right.side, focus, true), "D", binding.id);
      assert.equal(deckForSide(left.side, DEFAULT_FOCUS, true), "A", binding.id);
      assert.equal(deckForSide(right.side, DEFAULT_FOCUS, true), "B", binding.id);
    }
  });

  test("leaving 4-deck mode resets the focus to A/B", () => {
    assert.deepEqual(focusForMode({ left: "C", right: "D" }, false), DEFAULT_FOCUS);
    assert.deepEqual(focusForMode({ left: "C", right: "D" }, true), { left: "C", right: "D" });
  });

  test("Ctrl+Shift+Alt+Left/Right load straight into C and D", () => {
    for (const platform of PLATFORMS) {
      assert.equal(matchEvent(eventFor("Ctrl+Shift+Alt+ArrowLeft", platform), platform, NO_INPUT)?.binding.deck, "C");
      assert.equal(matchEvent(eventFor("Ctrl+Shift+Alt+ArrowRight", platform), platform, NO_INPUT)?.binding.deck, "D");
    }
    // And they do not collide with Double (Ctrl+Shift) or Eject (Shift+Alt).
    assert.equal(matchEvent(eventFor("Ctrl+Shift+ArrowLeft", "other"), "other", NO_INPUT)?.binding.id, "double-track");
    assert.equal(matchEvent(eventFor("Shift+Alt+ArrowLeft", "other"), "other", NO_INPUT)?.binding.id, "eject");
  });

  test("Double copies from the opposite side", () => {
    assert.equal(otherSide("left"), "right");
    assert.equal(otherSide("right"), "left");
  });
});

describe("library and deck helpers", () => {
  test("cursor moves clamp to the ends", () => {
    const ids = ["a", "b", "c"];
    assert.equal(moveCursor(ids, null, 1), "a");
    assert.equal(moveCursor(ids, null, -1), "c");
    assert.equal(moveCursor(ids, "a", -1), "a");
    assert.equal(moveCursor(ids, "b", 1), "c");
    assert.equal(moveCursor(ids, "c", 1), "c");
    assert.equal(moveCursor([], "a", 1), null);
  });

  test("load next / previous walk the view from the deck's track", () => {
    const ids = ["a", "b", "c"];
    assert.equal(neighbourTrack(ids, "a", 1), "b");
    assert.equal(neighbourTrack(ids, "a", -1), null);
    assert.equal(neighbourTrack(ids, "c", 1), null);
    assert.equal(neighbourTrack(ids, "zz", 1), "a");
    assert.equal(neighbourTrack(ids, null, -1), "c");
  });

  test("add next cue takes the first free slot", () => {
    assert.equal(firstFreeCue([1, null, 3]), 1);
    assert.equal(firstFreeCue([]), 0);
    assert.equal(firstFreeCue([1, 2, 3, 4, 5, 6, 7, 8]), -1);
  });

  test("waveform and text zoom step and clamp", () => {
    assert.equal(nextSpan(8, true), 6);
    assert.equal(nextSpan(8, false), 12);
    assert.equal(nextSpan(2, true), 2);
    assert.equal(nextSpan(32, false), 32);
    assert.equal(nextTextScale(1, true), 1.1);
    assert.equal(nextTextScale(1.8, true), 1.8);
    assert.equal(nextTextScale(0.7, false), 0.7);
    assert.ok(isZoomIn("Equal") && isZoomIn("NumpadAdd") && !isZoomIn("Minus") && !isZoomIn("NumpadSubtract"));
  });

  test("undo load and locate-last-loaded history", () => {
    const history = new LoadHistory();
    assert.equal(history.undo(), null);
    assert.equal(history.locate(), null);
    history.record("A", null, 0, "t1");
    history.record("B", null, 0, "t2");
    history.record("A", "t1", 42, "t3");
    assert.deepEqual(history.locate(), { deck: "A", trackId: "t3" });
    assert.deepEqual(history.locate(), { deck: "B", trackId: "t2" });
    assert.deepEqual(history.locate(), { deck: "A", trackId: "t3" });
    assert.deepEqual(history.undo(), { deck: "A", previousTrackId: "t1", previousPosition: 42 });
    assert.deepEqual(history.undo(), { deck: "B", previousTrackId: null, previousPosition: 0 });
  });

  test("moved bindings are documented and their new keys exist", () => {
    assert.ok(MOVED_BINDINGS.length >= 5);
    for (const chord of ["KeyT", "KeyG", "Alt+ArrowLeft", "Alt+Digit1", "Space", "Ctrl+Alt+KeyR", "Ctrl+Alt+Equal"]) {
      assert.ok(matchEvent(eventFor(chord, "other"), "other", NO_INPUT), chord);
    }
  });
});

describe("KeyboardController", () => {
  const ev = (chord: string, extra: Partial<ShortcutEvent> = {}): ShortcutEvent & { prevented: boolean } => {
    const event = { ...eventFor(chord, "other"), target: { tagName: "BODY" }, prevented: false, ...extra } as ShortcutEvent & { prevented: boolean };
    event.preventDefault = () => {
      event.prevented = true;
    };
    return event;
  };

  test("hold actions run on keydown and again on keyup", () => {
    const calls: string[] = [];
    const c = new KeyboardController({ run: (m, phase) => (calls.push(`${m.binding.id}:${m.side}:${phase}`), true) }, "other");
    const down = ev("Alt+KeyE");
    assert.ok(c.keydown(down));
    assert.ok(down.prevented);
    // Auto-repeat while held does not restart it, and is swallowed.
    assert.ok(c.keydown(ev("Alt+KeyE", { repeat: true })));
    // Alt released first: the keyup still ends the hold by physical key.
    assert.ok(c.keyup(ev("KeyE")));
    assert.deepEqual(calls, ["rewind:left:down", "rewind:left:up"]);
    c.keydown(ev("KeyJ"));
    assert.equal(c.holding, 1);
    c.releaseAll();
    assert.equal(c.holding, 0);
    assert.deepEqual(calls.slice(2), ["censor:right:down", "censor:right:up"]);
  });

  test("one-shot actions do not get a keyup", () => {
    const calls: string[] = [];
    const c = new KeyboardController({ run: (m, phase) => (calls.push(`${m.binding.id}:${phase}`), true) }, "other");
    c.keydown(ev("KeyW"));
    assert.equal(c.keyup(ev("KeyW")), false);
    assert.deepEqual(calls, ["play-pause:down"]);
  });

  test("typing in the search field does not trigger shortcuts", () => {
    const calls: string[] = [];
    const c = new KeyboardController({ run: (m) => (calls.push(m.binding.id), true) }, "other");
    const typed = ev("KeyW", { target: { tagName: "INPUT", type: "search" } });
    assert.equal(c.keydown(typed), false);
    assert.equal(typed.prevented, false);
    assert.ok(c.keydown(ev("Escape", { target: { tagName: "INPUT", type: "search" } })));
    const bpmTarget = { tagName: "INPUT", type: "text", classList: { contains: (n: string) => n === "bpm-edit" } };
    assert.ok(c.keydown(ev("Alt+ArrowUp", { target: bpmTarget })));
    assert.equal(c.keydown(ev("Alt+ArrowUp", { target: { tagName: "INPUT", type: "search" } })), false);
    assert.deepEqual(calls, ["escape", "bpm-scale"]);
  });

  test("the Settings switch turns every shortcut off and releases holds", () => {
    const calls: string[] = [];
    const c = new KeyboardController({ run: (m, phase) => (calls.push(`${m.binding.id}:${phase}`), true) }, "other");
    c.keydown(ev("KeyU"));
    c.setEnabled(false);
    assert.deepEqual(calls, ["censor:down", "censor:up"]);
    for (const chord of ["KeyW", "Escape", "F1", "Shift+Slash"]) assert.equal(c.keydown(ev(chord)), false, chord);
    c.setEnabled(true);
    assert.ok(c.keydown(ev("KeyW")));
  });

  test("a handler that declines lets the key fall through", () => {
    const c = new KeyboardController({ run: () => false }, "other");
    const tab = ev("Tab");
    assert.equal(c.keydown(tab), false);
    assert.equal(tab.prevented, false);
  });

  test("an open modal gets keys first", () => {
    const calls: string[] = [];
    const c = new KeyboardController({ run: (m) => (calls.push(m.binding.id), true), modalKey: (e) => e.code === "Enter" }, "other");
    assert.ok(c.keydown(ev("Enter")));
    c.keydown(ev("KeyW"));
    assert.deepEqual(calls, ["play-pause"]);
  });

  test("mac: Cmd+Delete asks through the delete binding, plain Delete does nothing", () => {
    const calls: string[] = [];
    const c = new KeyboardController({ run: (m) => (calls.push(m.binding.id), true) }, "mac");
    const cmdDelete = { code: "Delete", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false, target: null } as ShortcutEvent;
    assert.ok(c.keydown(cmdDelete));
    assert.equal(c.keydown({ code: "Delete", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: null }), false);
    // A Mac keyboard's "delete" key is Backspace.
    assert.ok(c.keydown({ code: "Backspace", ctrlKey: false, metaKey: true, shiftKey: true, altKey: false, target: null }));
    assert.deepEqual(calls, ["delete-track", "trash-file"]);
    assert.ok(SERATO_KEYMAP.find((b) => b.id === "delete-track")?.confirm);
    assert.ok(SERATO_KEYMAP.find((b) => b.id === "trash-file")?.confirm);
    assert.ok(SERATO_KEYMAP.find((b) => b.id === "escape")?.confirm);
  });
});

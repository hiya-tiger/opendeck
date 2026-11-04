# Keyboard shortcuts (Serato DJ layout)

OpenDecks uses Serato DJ's keyboard map (decision D45). Every row of Serato's
own *Playback Shortcuts* / *Library Shortcuts* screen is bound; the table lives
in one place, `src/renderer/keyboard/serato-keymap.ts`, and this page, the
in-app screen and the unit tests all read from it.

- **See them in the app:** press `?` (Shift+/), or *Help → Keyboard Shortcuts*,
  or *Settings → Show shortcuts*. The screen is laid out like Serato's and its
  column headers name the deck each side's keys act on right now.
- **Turn them off:** *Settings → Keyboard shortcuts* (top bar), or the switch at
  the bottom of the shortcuts screen. Stored as `opendeck.shortcuts.enabled`.
  Off means every key below is off (the menu items still work).
- **macOS:** Serato's Mac convention: *control* is **Cmd** and *alt* is
  **Option**. The physical Control key does nothing. A Mac keyboard's *delete*
  key (Backspace) works for Cmd+Delete / Cmd+Shift+Delete. On Mac laptops the
  F-keys need *fn* (or "Use F1, F2… as standard function keys"), and macOS
  takes F11 for *Show Desktop* unless that is turned off.
- **Typing is safe:** no shortcut fires while a text field has focus (library
  search, BPM editor, stream search, any input, text area or drop-down), except
  **Escape** and, in the BPM editor, **Alt+Up/Down**.
- **Hold keys** (rewind, fast forward, censor, cue keys) act while held and stop
  on release, even if the modifier is let go first. Leaving the window releases
  them too.
- **Asks first:** Ctrl+Delete, Ctrl+Shift+Delete and quitting with Escape show a
  confirm dialog (Enter = OK, Escape = Cancel).

## Decks C and D (4-deck mode)

Serato's map has a left and a right deck. In 4-deck mode:

- every **left-deck key acts on the left side's focused deck (A or C)** and
  every **right-deck key on the right side's focused deck (B or D)**;
- **F1** toggles the left side A ↔ C, **F6** toggles the right side B ↔ D
  (neither key was used by OpenDecks or Electron, so no substitutes were needed);
  clicking into a deck also gives its side the focus;
- the targeted decks get a blue outline and a **KEYS** tag on the deck header,
  and the shortcuts screen shows the letters (*Left Virtual Deck · C*);
- **Ctrl+Shift+Alt+Left** loads the selected track straight into **C** and
  **Ctrl+Shift+Alt+Right** into **D** (Cmd+Shift+Option on macOS), no toggle
  needed; in 2-deck mode they switch 4-deck mode on first;
- switching back to 2-deck mode resets the focus to A/B, and in 2-deck mode the
  left keys always mean A and the right keys B.

Rows with a fixed deck (Space = A, P/L = B, Alt+1…8 = A, Shift+1…8 = B) keep
their deck whatever the focus.

## Library selection

Up/Down (or a click) moves the library cursor, the outlined row; Ctrl/Cmd+click
and Ctrl+A select several. Load keys use the cursor row; Delete, Trash,
Prepare (Ctrl+P) and Reveal use the selection (or the cursor when nothing else
is selected). Tab moves the highlight between the track list and the crate
picker; Up/Down then move in the highlighted one.

## Playback (Serato's screen)

| Action | Left deck (A, or C) | Right deck (B, or D) | macOS | Works | Notes |
|---|---|---|---|---|---|
| Load selected track | shift + left arrow | shift + right arrow | shift + left arrow / shift + right arrow | yes |  |
| Double loaded track | control + shift + right arrow | control + shift + left arrow | cmd + shift + right arrow / cmd + shift + left arrow | yes | Copies the other side's track and playhead onto this deck (Instant Double). |
| Eject Virtual Deck | shift + alt + left arrow | shift + alt + right arrow | shift + option + left arrow / shift + option + right arrow | yes |  |
| Play/Pause | W | S | W / S | yes |  |
| Reverse play direction | Q | A | Q / A | yes | Toggles reverse; press again to play forward. |
| Set Cue Point | control + 1 2 3 4 5 | control + 6 7 8 9 0 | cmd + 1 2 3 4 5 / cmd + 6 7 8 9 0 | yes |  |
| Set/Jump to Cue Point | 1 2 3 4 5 | 6 7 8 9 0 | 1 2 3 4 5 / 6 7 8 9 0 | yes, hold | Sets the cue when empty, jumps when set. With SLIP on, releasing the key returns to the timeline. |
| Add next Cue Point | alt + \` | alt + - | option + \` / option + - | yes | Sets the first free hot cue (of 8) at the playhead. |
| Jump to temporary Cue Point | I | K | I / K | yes | Jumps to the deck's main (CUE button) cue point. |
| Load next track | alt + W | alt + S | option + W / option + S | yes | Next track in the current library view after the one on the deck. |
| Load previous track | alt + Q | alt + A | option + Q / option + A | yes |  |
| Rewind | alt + E | alt + D | option + E / option + D | yes, hold | Scans backwards while held. |
| Fast forward | alt + R | alt + F | option + R / option + F | yes, hold | Scans forwards while held. |
| Tempo Adjust down | E | D | E / D | yes | 0.1% per press; holding repeats. |
| Tempo Adjust up | R | F | R / F | yes |  |
| Censor | U | J | U / J | yes, hold | Plays backwards while held, then continues where the track would have been. |
| Keylock | F5 | F10 | F5 / F10 | yes |  |
| Arm/Disarm/Stop Flip Record | \ | — | \ | **not yet** (toast) | OpenDecks has no Flip recorder yet. |

## Library (Serato's screen)

| Action | Keys | macOS | Works | Notes |
|---|---|---|---|---|
| Move up/down through tracks | up/down arrow | up/down arrow | yes |  |
| Move up/down through crates | control + shift + up/down arrow | cmd + shift + up/down arrow | yes | Steps through All tracks, playlists, Smart Crates and crates. |
| Shift highlight focus | tab | tab | yes | Switches the highlight between the track list and the crate picker; up/down then move in the highlighted one. |
| Search | control + F | cmd + F | yes |  |
| Crate Search | control + shift + F | cmd + shift + F | partial | Focuses the crate picker, where typing jumps to a crate by name. |
| Reveal track in Explorer (PC) or Finder (Mac) | control + R | cmd + R | yes | Desktop app only; needs a track with a file on disk. |
| Show track in Crates | control + shift + R | cmd + shift + R | yes | Lists the crates/playlists holding the track and opens the first. |
| Locate last loaded track (Press again for other Deck) | control + L | cmd + L | yes |  |
| Select all | control + A | cmd + A | yes |  |
| Undo track load | control + Z | cmd + Z | yes | Puts back the track (and position) the last load replaced. |
| Delete track/crate | control + delete | cmd + delete | yes, asks first | A Mac's delete key (Backspace) works too. Removes from the library only, never from disk. With the crate picker highlighted it deletes that playlist or Smart Crate. |
| Send file to trash | control + shift + delete | cmd + shift + delete | yes, asks first | Desktop app only; moves the file to the system trash and removes it from the library. |
| Add track(s) to prepare panel | control + P | cmd + P | partial | OpenDecks' Scratchpad is the prepare list: the tracks are starred there. |
| Zoom main waveform display | + or - | + or - | yes |  |
| Zoom library text size | control and + or - | cmd and + or - | yes |  |
| Start new recording (mic, aux, or mix) | control + N | cmd + N | yes | Starts recording the mix; when one is running it says so instead of cutting it. |
| Open track in default media player | control + O | cmd + O | yes | Desktop app only. |
| (While editing BPM) Double/Halve BPM | alt + up/down arrow | option + up/down arrow | yes | Double-click a deck's BPM to edit it. |
| Enter Beatgrid Edit Mode | alt + spacebar (repeat to toggle between decks) | option + spacebar (repeat to toggle between decks) | yes | Left/right arrows slide the grid while in the mode; Escape leaves it. |
| Enter Hide Track/Artist ( AM Mode ) | alt + / | option + / | yes | Masks titles in the library and on the decks. |
| Exit current track search / Exit OpenDecks | escape | escape | yes, asks first | Closes what is open first (dialog, BPM edit, grid edit, search); with nothing left it asks before quitting. |

## OpenDecks extras (4-deck keys and older OpenDecks bindings)

| Action | Keys | macOS | Notes |
|---|---|---|---|
| 4-deck: left keys target A ↔ C | F1 | F1 |  |
| 4-deck: right keys target B ↔ D | F6 | F6 |  |
| Load selected track into deck C | control + shift + alt + left arrow | cmd + shift + option + left arrow |  |
| Load selected track into deck D | control + shift + alt + right arrow | cmd + shift + option + right arrow |  |
| Show this screen | ? | ? |  |
| Play/Pause deck A | spacebar | spacebar |  |
| Play/Pause deck B | P | P |  |
| Jump to cue, deck B | L | L |  |
| Sync | T \| G | T \| G | Moved from S / D (Serato uses those). |
| Crossfader nudge | left/right arrow | left/right arrow |  |
| Crossfader big step | alt + left/right arrow | option + left/right arrow | Moved from Shift+left/right (Serato's load keys). |
| Hot cues 1-8, deck A | alt + 1 … 8 | option + 1 … 8 | Moved from plain 1-8 (Serato's cue keys). |
| Hot cues 1-8, deck B | shift + 1 … 8 | shift + 1 … 8 |  |
| Sampler pads 1-8 (current bank) | numpad 1 … 8 | numpad 1 … 8 |  |
| Fullscreen | F11 | F11 |  |
| Window zoom in / out / reset | control + alt + = / - / 0 | cmd + option + = / - / 0 | Moved from Ctrl+= / Ctrl+- / Ctrl+0 (library text size and cue 5 in Serato's map). |
| Reload window (debug) | control + alt + R | cmd + option + R | Moved from Ctrl+R (Reveal in Explorer/Finder). |

## Moved bindings

| Action | Before | Now |
|---|---|---|
| Play/pause deck A | Q | W (Serato; follows A/C focus), Space still plays deck A |
| Jump to cue, deck A | A | I (Serato temporary cue; follows A/C focus) |
| Sync deck A / deck B | S / D | T / G (follow the side focus) |
| Crossfader big step | Shift+Left / Shift+Right | Alt+Left / Alt+Right |
| Hot cues 1-8, deck A | 1-8 | Alt+1…8 (plain 1-5 / 6-0 are Serato's left/right cues) |
| Electron menu: Reload | Ctrl+R | Ctrl+Alt+R |
| Electron menu: Force reload | Ctrl+Shift+R | View menu only |
| Electron menu: Zoom in / out / actual size | Ctrl+= / Ctrl+- / Ctrl+0 | Ctrl+Alt+= / Ctrl+Alt+- / Ctrl+Alt+0 |

Electron's default menu used to own Ctrl+R, Ctrl+Shift+R, Ctrl+0 and Ctrl+=/-.
OpenDecks now sets its own menu (`src/main/shortcuts-menu.ts`): those items are
still in the View menu, and their keys go to the page (Windows/Linux:
`registerAccelerator: false`; macOS: no accelerator, because macOS ignores that
flag; the renderer does Cmd+A / Cmd+Z inside text fields itself). Menu labels
have no `&` mnemonics, so Alt+letter reaches the page. On Windows/Linux the
main process forwards F10 to the page (it would otherwise open the menu bar).

## Gaps and approximations

- **Arm/Disarm/Stop Flip Record (`\`)**: OpenDecks has no Flip recorder; the key
  shows "Flip recording is not available yet."
- **Add track(s) to prepare panel (Ctrl+P)**: there is no separate prepare
  panel; the tracks are added to OpenDecks' Scratchpad, which plays that role.
- **Crate Search (Ctrl+Shift+F)**: focuses the crate picker, where typing jumps
  to a crate by name; there is no separate crate search box.
- **Reveal / Open in default player / Send to trash** need the desktop app and a
  track with a file on disk (not a stream or an unlinked crate entry).
- **Start new recording (Ctrl+N)** starts recording the mix; if a recording is
  already running it says so rather than cutting it.
- **Escape → exit** asks first (Serato quits straight away).
- **Reverse (Q/A) and Censor (U/J)** need the decoded (PCM) engine. Right
  after a load, while a track is still decoding, or for a video on the media
  element, the key says so instead of acting: on the media element engine a
  negative rate just stops the deck (an existing engine limit, not new).
- Not tested on real Windows or macOS hardware: the F10 forwarding, the menu
  accelerators and Option/Cmd chords were checked in code and in the Linux
  Electron smoke test only.

## Tests

- `test/serato-keymap.test.ts`: every chord of every binding on Windows/Linux
  and macOS, no two actions on one chord, every Serato row present, the
  input-focus guard for every binding, the Mac modifier swap, the 4-deck focus
  toggles, per-side routing and the direct C/D loads, holds, repeat, the on/off
  switch, and this page listing every action.
- `npm run smoke:ui`: drives the real renderer with key events (overlay, play,
  hot cue, typing guard, confirm on delete and exit, F1/F6 routing to C/D,
  Ctrl+Shift+Alt+arrow loads, 2-deck reset, the Settings switch).

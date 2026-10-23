# OpenDeck parity report

Updated after the P5 source-separation work.

## Phases

- **P0:** scope documents updated in earlier work: video/source-separation/pad
  modes are no longer listed as non-goals.
- **P1:** complete. PCM engine, reverse, key lock, ten-minute loop test, DVS
  transport handoff and diagnostics are in place.
- **P2:** complete and verified. Cue/loop/beat-grid frames round-trip for MP3,
  WAV, AIFF, FLAC and MP4/M4A. MP4 `Markers_` uses 19-byte slots. Real Serato
  DJ Pro 2.3.7 tags were read from an MP3 and an M4A; an M4A write kept the
  audio payload byte-identical.
- **P3:** partial. Library UX, scratchpad, played log and CSV export are done in
  pure logic plus UI. Playlists, beat-grid editor, four decks, deck clone,
  preview, display modes and several mixer items remain open.
- **P4:** implemented and wired, not hardware-verified. Ten pad modes are
  reachable on each deck: Hot Cue, Cue Loop, Loop Roll, Slicer, Beat Jump,
  Transport, Pitch Play, Scratch, Sequence and Part FX. Sequence records pad
  press/release actions and loops them until stopped. Scratch pads load the
  current local track with Shift+click. Part FX now filters or mutes the four
  separated source parts. The sampler has 32 slots across four banks.
- **P5:** implemented and wired, not hardware-verified. Local tracks separate
  offline into drums, bass, other and vocals with an MIT-licensed htDemucs ONNX
  model in the Electron main process. Results are cached beside the track as
  `.opendeck-stems/<content-hash>-<model-version>/` (user-data fallback) and
  loaded into four `PcmSource` voices. The UI has a Parts row, vocals-only and instrumental,
  part gain/mute/solo/filter, part roll, part scratch return-mode and a true
  part pad mode. The old four-band row is now labelled Bands.
- **P6/P7:** not started. Video remains the only droppable phase.

No phase was reverted.

## Tests added

- `test/parts.test.ts` (11 tests): four-part catalogue, part mix mute/solo,
  vocals-only mix, model constants, chunk planning, overlap windows, Int16
  conversion, cache directory naming and labels.
- `test/pad-modes.test.ts` (9 tests): ten-mode catalogue, clamp behaviour,
  slicer ranges, cue-loop length, rolling release position, sequence timestamps
  and cap, sequence pad actions/phases/loop duration, four filters and four
  mutes, and four sampler banks / 32 slots.
- Both files are in the `npm test` command. Suite total is now 163 passing.

## Verification

- `npm test`: 163 pass, 0 fail.
- `npx tsc --noEmit`: clean.
- `npm run build`: clean.
- `npm run smoke:audio`: passed. Deck engine `pcm`, latency **0.008 s**, loop
  wrap `0.500 s` with `looped: true`, reverse `true`, pitch hold `true`.
  The same smoke now loads four synthetic stem buffers, asserts four parts,
  vocals-only output, a running stem position and part-scratch begin/end.
- P2 round-trip: checked earlier against real Serato metadata and a real M4A
  payload; not repeated in this P4 run.
- P4 UI: built app launched with remote debugging. Both decks show all ten
  modes; Sequence recorded one cue action, stopped at `SEQ 1`, played as
  `SEQ PLAY` and stopped cleanly; Part FX rendered four filter and four mute
  pads and toggled state; Scratch rendered `S1`-`S8` load slots; Loop Roll
  pressed and released without a runtime exception. Banks A-D render `A1`-`D8`.
  No physical controller or real loaded-track scratch was exercised.

## Definition-of-done checklist

- [x] Key lock ON runs on the PCM engine; local files use PCM.
- [x] Reverse playback works in the PCM path.
- [x] Ten-minute offline loop test is green (sample-exact loop logic).
- [x] Reported latency is under 10 ms (8 ms smoke) and underruns are visible.
- [ ] Four decks with 1/3 and 2/4 switching.
- [x] Eight named, colourable cue slots per deck.
- [x] Eight saved loops per deck, persisted and reloaded.
- [ ] Beat-grid editor with a working lock flag.
- [x] Cue-and-loop trigger.
- [x] Rolling loop (functional approximation).
- [ ] Return-mode and reverse-on-hold.
- [x] All P4 performance pad modes present and reachable.
- [x] 32 sampler slots across four banks.
- [ ] Full effect set plus user-created savable chains.
- [ ] Tempo-independent pitch shift.
- [x] Real four-part source separation with part controls.
- [ ] Full target round trip with zero loss both directions.
- [ ] Undo for every file and library write.
- [ ] Complete playlist/set-prep/played-log/search/sort/colour/count wall.
- [ ] Live playlists.
- [ ] Offline mode confirmed with no hardware.
- [ ] Timecode calibration and drift correction.
- [x] Test, typecheck, build and audio smoke are green.
- [x] `docs/decisions.md` records the P4 and P5 assumptions.

The single most valuable next step is a manual pass on the built app with a real
track: install the model, separate a long track, verify part controls and part
scratch, then confirm the cache reuses without inference.

## P4 assumptions

- Sequence events store mode, pad index, phase and milliseconds, capped at 128,
  and loop until the user stops them.
- Loop Roll and Slicer release to `position + elapsed × rate`.
- Pitch Play temporarily disables key lock, then restores rate and key lock.
- Part FX filters or mutes the existing four filter bands, not separated stems.
- Scratch pads hold a copy of the current local track, loaded with Shift+click.
- Sampler slots are generated drum voices, not imported user samples.


## P5 assumptions

- The model is downloaded on demand, not bundled. The download is 166 MB and
  checked against SHA-256 before use.
- CPU inference is offline and serial per request; a 7.8 s model chunk took
  roughly 8 s on the test machine, so long tracks take minutes.
- Cache lives beside the source file when writable, otherwise in app user data,
  and is keyed by file SHA-256 plus model version.
- Part scratch pauses one part voice and scratches it through a dedicated
  `ScratchVoice`; the other parts keep playing and the scratched part returns
  to the transport position on release.
- The tests and smoke use synthetic stems and a direct inference run, not a real
  commercial track or a packaged installer.

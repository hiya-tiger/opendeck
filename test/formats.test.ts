import test from "node:test";
import assert from "node:assert/strict";
import { isAudioFile } from "../src/renderer/media/library.ts";

test("accepts AAC, M4A and WebM audio files", () => {
  for (const name of ["track.aac", "track.m4a", "track.webm", "TRACK.WEBM", "track.opus"]) {
    assert.equal(isAudioFile(name), true, name);
  }
});

test("accepts the existing local audio formats", () => {
  for (const name of ["track.mp3", "track.wav", "track.flac", "track.ogg", "track.aiff", "track.aif"]) {
    assert.equal(isAudioFile(name), true, name);
  }
});

test("rejects non-audio files", () => {
  for (const name of ["cover.jpg", "crate.crate", "notes.txt", "track.aac.txt", "track.webm.part"]) {
    assert.equal(isAudioFile(name), false, name);
  }
});

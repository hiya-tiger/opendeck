import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  VideoMixer,
  computeAspectRect,
  computeVideoCrossfaderWeights,
  computeVideoSyncTarget,
  formatVideoCssFilter,
  isVideoFile,
  shouldResyncVideoElement,
} from "../src/renderer/engine/video-mixer.ts";

describe("Phase 7: Video Mixing engine & transport lock", () => {
  it("recognizes video file extensions and MIME types", () => {
    assert.equal(isVideoFile("visuals/clip.mp4"), true);
    assert.equal(isVideoFile("set_loop.webm"), true);
    assert.equal(isVideoFile({ name: "stage.mov" }), true);
    assert.equal(isVideoFile({ name: "stream", type: "video/mp4" }), true);
    assert.equal(isVideoFile("track.mp3"), false);
    assert.equal(isVideoFile(null), false);
  });

  it("locks video position to deck transport across play, pause, seek, reverse, and scratch", () => {
    const vm = new VideoMixer();
    vm.loadVideo("A", "blob:video-a", "club_loop.mp4", 10);

    // Forward play
    const fwd = vm.syncDeck("A", { currentTime: 3.25, duration: 120, playing: true, rate: 1.05 });
    assert.equal(fwd.currentTime, 3.25);
    assert.equal(fwd.playing, true);
    assert.equal(fwd.reversed, false);
    const fwdSync = shouldResyncVideoElement(3.24, fwd.currentTime, fwd.playing, fwd.rate, fwd.reversed, fwd.scratching);
    assert.equal(fwdSync.shouldPlay, true);
    assert.equal(fwdSync.seek, false);
    assert.equal(fwdSync.playbackRate, 1.05);

    // Seek jump beyond tolerance triggers immediate video seek
    const jumped = vm.syncDeck("A", { currentTime: 14.5, duration: 120, playing: true, rate: 1 });
    assert.equal(jumped.currentTime, 4.5); // wrapped around 10s video loop
    const jumpSync = shouldResyncVideoElement(3.25, jumped.currentTime, jumped.playing, jumped.rate, jumped.reversed, jumped.scratching);
    assert.equal(jumpSync.seek, true);
    assert.equal(jumpSync.target, 4.5);

    // Reverse playback forces direct frame stepping (since HTMLVideoElement lacks negative playbackRate)
    const rev = vm.syncDeck("A", { currentTime: 4.1, duration: 120, playing: true, rate: -1, reversed: true });
    assert.equal(rev.reversed, true);
    const revSync = shouldResyncVideoElement(4.5, rev.currentTime, rev.playing, rev.rate, rev.reversed, rev.scratching);
    assert.equal(revSync.shouldPlay, false);
    assert.equal(revSync.seek, true);
    assert.equal(revSync.target, 4.1);

    // Active platter/DVS scratch steps currentTime directly
    const scratch = vm.syncDeck("A", { currentTime: 2.75, duration: 120, playing: true, rate: 1.8, scratching: true });
    assert.equal(scratch.scratching, true);
    const scratchSync = shouldResyncVideoElement(2.8, scratch.currentTime, scratch.playing, scratch.rate, scratch.reversed, scratch.scratching);
    assert.equal(scratchSync.shouldPlay, false);
    assert.equal(scratchSync.seek, true);
    assert.equal(scratchSync.target, 2.75);
  });

  it("operates video crossfader independently of audio crossfader unless linked", () => {
    const vm = new VideoMixer();
    vm.setCrossfader(-0.5);
    // Audio crossfader moves to full right (1.0), but video crossfader stays at -0.5 when unlinked
    vm.setAudioCrossfader(1.0);
    assert.equal(vm.crossfader, -0.5);
    assert.deepEqual(vm.weights(), { left: 0.75, right: 0.25 });

    // Link to audio crossfader
    vm.setLinkToAudioCrossfader(true, 1.0);
    assert.equal(vm.crossfader, 1.0);
    assert.deepEqual(vm.weights(), { left: 0, right: 1 });

    // Cut, Add, and Luma blend modes
    assert.deepEqual(computeVideoCrossfaderWeights(-0.2, "cut"), { left: 1, right: 0 });
    assert.deepEqual(computeVideoCrossfaderWeights(0.2, "cut"), { left: 0, right: 1 });
    assert.deepEqual(computeVideoCrossfaderWeights(0, "add"), { left: 1, right: 1 });
    const lumaMid = computeVideoCrossfaderWeights(0, "luma");
    assert.ok(Math.abs(lumaMid.left - 0.7071) < 0.001);
    assert.ok(Math.abs(lumaMid.right - 0.7071) < 0.001);
  });

  it("computes fit (letterbox/pillarbox) and fill (crop) scaling rectangles and FX filters", () => {
    // 4:3 source into 16:9 (1600x900) destination
    const fitRect = computeAspectRect(800, 600, 1600, 900, "fit");
    assert.equal(fitRect.height, 900);
    assert.equal(fitRect.width, 1200);
    assert.equal(fitRect.x, 200);
    assert.equal(fitRect.y, 0);

    const fillRect = computeAspectRect(800, 600, 1600, 900, "fill");
    assert.equal(fillRect.width, 1600);
    assert.equal(fillRect.height, 1200);
    assert.equal(fillRect.x, 0);
    assert.equal(fillRect.y, -150);

    const css = formatVideoCssFilter({ brightness: 1.2, contrast: 1.5, saturation: 0.8, monochrome: true, invert: true });
    assert.equal(css, "brightness(1.20) contrast(1.50) saturate(0.80) grayscale(1) invert(1)");

    const vm = new VideoMixer();
    vm.setScaleMode("fill");
    vm.setLeftDeck("C");
    vm.setRightDeck("D");
    vm.setOutputWindowState(true, true);
    const snap = vm.getSnapshot();
    assert.equal(snap.scaleMode, "fill");
    assert.equal(snap.leftDeck, "C");
    assert.equal(snap.rightDeck, "D");
    assert.equal(snap.outputOpen, true);
    assert.equal(snap.outputFullscreen, true);
    assert.equal(computeVideoSyncTarget(12, 10, 0.5, false), 10);
  });
});

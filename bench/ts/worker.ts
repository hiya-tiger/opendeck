// Analysis worker for bench/ts/bench.ts: the same analyzeBuffer() the app's
// renderer/analysis-worker.js runs, on a worker_thread.
import { parentPort } from "node:worker_threads";
import { analyzeBuffer } from "../../src/renderer/engine/analyze.ts";

parentPort!.on("message", (msg: { ping?: boolean; sampleRate: number; length: number; channels: Float32Array[] }) => {
  if (msg.ping) { parentPort!.postMessage("pong"); return; }
  const buffer = {
    sampleRate: msg.sampleRate,
    length: msg.length,
    numberOfChannels: msg.channels.length,
    duration: msg.length / msg.sampleRate,
    getChannelData: (c: number) => msg.channels[c],
  };
  const r = analyzeBuffer(buffer, 2000);
  parentPort!.postMessage({
    bpm: r.bpm, confidence: r.confidence, beatPhase: r.beatPhase,
    key: r.key.key, camelot: r.key.camelot, keyConfidence: r.key.confidence, duration: r.duration,
    peaks: Array.from(r.peaks), low: Array.from(r.bands.low), mid: Array.from(r.bands.mid), high: Array.from(r.bands.high),
  });
});

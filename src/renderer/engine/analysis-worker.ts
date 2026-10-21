import { analyzeBuffer, type AnalysisResult, type AudioLike } from "./analyze.ts";

interface AnalysisRequest {
  id: number;
  sampleRate: number;
  length: number;
  duration: number;
  channels: Float32Array[];
}

self.addEventListener("message", (event: MessageEvent<AnalysisRequest>) => {
  const { id, sampleRate, length, duration, channels } = event.data;
  const buffer: AudioLike = {
    sampleRate,
    length,
    numberOfChannels: channels.length,
    duration,
    getChannelData: (channel) => channels[channel],
  };
  const result: AnalysisResult = analyzeBuffer(buffer, 2000);
  self.postMessage({ id, result });
});

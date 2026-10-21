(function () {
  const DJ = (window.DJ = window.DJ || {});

  async function decode(ctx, file) {
    const data = await file.arrayBuffer();
    return ctx.decodeAudioData(data);
  }

  function peaks(buffer, buckets) {
    const channelCount = buffer.numberOfChannels;
    const length = buffer.length;
    const block = Math.max(1, Math.floor(length / buckets));
    const channels = [];
    for (let c = 0; c < channelCount; c++) channels.push(buffer.getChannelData(c));
    const out = new Float32Array(buckets);
    for (let i = 0; i < buckets; i++) {
      const start = i * block;
      const end = Math.min(length, start + block);
      let max = 0;
      for (let s = start; s < end; s += 2) {
        let sum = 0;
        for (let c = 0; c < channelCount; c++) sum += channels[c][s];
        const v = Math.abs(sum / channelCount);
        if (v > max) max = v;
      }
      out[i] = max;
    }
    return out;
  }

  function monoEnvelope(buffer, windowSize) {
    const data = buffer.getChannelData(0);
    const frames = Math.floor(data.length / windowSize);
    const env = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      const start = i * windowSize;
      for (let s = start; s < start + windowSize; s += 4) {
        const v = data[s];
        sum += v * v;
      }
      env[i] = Math.sqrt(sum / (windowSize / 4));
    }
    return env;
  }

  function detectBpm(buffer, opts) {
    const options = opts || {};
    const minBpm = options.minBpm || 70;
    const maxBpm = options.maxBpm || 190;
    const windowSize = 512;
    const env = monoEnvelope(buffer, windowSize);
    const frameRate = buffer.sampleRate / windowSize;

    const flux = new Float32Array(env.length);
    for (let i = 1; i < env.length; i++) {
      flux[i] = Math.max(0, env[i] - env[i - 1]);
    }

    let peak = 0;
    for (let i = 0; i < flux.length; i++) if (flux[i] > peak) peak = flux[i];
    if (peak <= 1e-6) return { bpm: 0, confidence: 0 };
    for (let i = 0; i < flux.length; i++) flux[i] /= peak;

    const minLag = Math.floor((60 / maxBpm) * frameRate);
    const maxLag = Math.ceil((60 / minBpm) * frameRate);
    if (maxLag >= flux.length) return { bpm: 0, confidence: 0 };

    const scores = new Float32Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = lag; i < flux.length; i++) sum += flux[i] * flux[i - lag];
      scores[lag] = sum / (flux.length - lag);
    }

    let bestLag = minLag;
    let bestScore = -1;
    let total = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      total += scores[lag];
      if (scores[lag] > bestScore) {
        bestScore = scores[lag];
        bestLag = lag;
      }
    }
    const mean = total / (maxLag - minLag + 1);
    const confidence = mean > 0 ? Math.min(1, (bestScore - mean) / (bestScore + mean)) : 0;

    let refined = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
      const a = scores[bestLag - 1];
      const b = scores[bestLag];
      const c = scores[bestLag + 1];
      const denom = a - 2 * b + c;
      if (Math.abs(denom) > 1e-9) refined = bestLag + (0.5 * (a - c)) / denom;
    }

    let bpm = (60 * frameRate) / refined;
    while (bpm < minBpm * 1.25) bpm *= 2;
    while (bpm > maxBpm) bpm /= 2;

    return { bpm: Math.round(bpm * 10) / 10, confidence };
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  DJ.analysis = { decode, peaks, detectBpm, formatTime };
})();

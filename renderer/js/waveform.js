(function () {
  const DJ = (window.DJ = window.DJ || {});

  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h, dpr, cssW: rect.width, cssH: rect.height };
  }

  class Waveform {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.peaks = null;
      this.duration = 0;
      this.progress = 0;
      this.cue = 0;
      this.loop = null;
      this.bindSeek();
    }

    bindSeek() {
      this.seekHandler = null;
      const jump = (event) => {
        if (!this.peaks || !this.seekHandler) return;
        const rect = this.canvas.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        this.seekHandler(ratio * this.duration);
      };
      this.canvas.addEventListener("pointerdown", jump);
      this.canvas.style.cursor = "pointer";
    }

    onSeek(fn) {
      this.seekHandler = fn;
    }

    setPeaks(peaks, duration) {
      this.peaks = peaks;
      this.duration = duration;
      this.draw();
    }

    setProgress(seconds) {
      this.progress = seconds;
      this.draw();
    }

    setCue(seconds) {
      this.cue = seconds;
      this.draw();
    }

    setLoop(loop) {
      this.loop = loop;
      this.draw();
    }

    clear() {
      this.peaks = null;
      this.duration = 0;
      this.progress = 0;
      this.cue = 0;
      this.loop = null;
      this.draw();
    }

    draw() {
      const { w, h, dpr } = fit(this.canvas);
      const c = this.ctx;
      c.clearRect(0, 0, w, h);
      c.fillStyle = "#0a0d11";
      c.fillRect(0, 0, w, h);

      if (!this.peaks || !this.duration) {
        c.fillStyle = "#2a323c";
        c.font = `${12 * dpr}px "Segoe UI", sans-serif`;
        c.textAlign = "center";
        c.fillText("Load a track", w / 2, h / 2 + 4 * dpr);
        return;
      }

      const mid = h / 2;
      const pxPerPeak = w / this.peaks.length;
      const barWidth = Math.max(1, pxPerPeak * 0.8);

      if (this.loop) {
        const x1 = (this.loop.start / this.duration) * w;
        const x2 = (this.loop.end / this.duration) * w;
        c.fillStyle = "rgba(255, 209, 102, 0.12)";
        c.fillRect(x1, 0, Math.max(1, x2 - x1), h);
      }

      const playedX = (this.progress / this.duration) * w;

      for (let i = 0; i < this.peaks.length; i++) {
        const x = i * pxPerPeak;
        const amp = Math.max(0.5, this.peaks[i]) * (h * 0.44);
        c.fillStyle = x < playedX ? "#4ee0a8" : "#3d4b5a";
        c.fillRect(x, mid - amp, barWidth, amp * 2);
      }

      if (this.cue > 0) {
        const cx = (this.cue / this.duration) * w;
        c.fillStyle = "#59a6ff";
        c.fillRect(cx, 0, Math.max(1, 2 * dpr), h);
      }

      c.fillStyle = "#ffffff";
      c.fillRect(playedX, 0, Math.max(1, 2 * dpr), h);
    }
  }

  class ZoomWaveform {
    constructor(canvas, spanSeconds) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.span = spanSeconds || 8;
      this.peaks = null;
      this.duration = 0;
      this.progress = 0;
      this.bpm = 0;
      this.cue = 0;
      this.loop = null;
    }

    setPeaks(peaks, duration) {
      this.peaks = peaks;
      this.duration = duration;
    }

    setBpm(bpm) {
      this.bpm = bpm;
    }

    setCue(seconds) {
      this.cue = seconds;
    }

    setLoop(loop) {
      this.loop = loop;
    }

    update(progress) {
      this.progress = progress;
      this.draw();
    }

    draw() {
      const { w, h, dpr } = fit(this.canvas);
      const c = this.ctx;
      c.clearRect(0, 0, w, h);
      c.fillStyle = "#0a0d11";
      c.fillRect(0, 0, w, h);

      if (!this.peaks || !this.duration) return;

      const start = Math.max(0, this.progress - this.span / 2);
      const end = Math.min(this.duration, start + this.span);
      const from = start / this.duration;
      const to = end / this.duration;
      const i0 = Math.floor(from * this.peaks.length);
      const i1 = Math.ceil(to * this.peaks.length);
      const count = Math.max(1, i1 - i0);
      const mid = h / 2;
      const barWidth = Math.max(1, (w / count) * 0.7);

      for (let i = i0; i < i1; i++) {
        const x = ((i - i0) / count) * w;
        const amp = Math.max(0.5, this.peaks[i] || 0) * (h * 0.45);
        c.fillStyle = "#4a5a6b";
        c.fillRect(x, mid - amp, barWidth, amp * 2);
      }

      if (this.bpm > 0) {
        const beat = 60 / this.bpm;
        c.fillStyle = "rgba(89, 166, 255, 0.35)";
        for (let t = Math.ceil(start / beat) * beat; t < end; t += beat) {
          const x = ((t - start) / this.span) * w;
          c.fillRect(x, 0, 1, h);
        }
      }

      c.fillStyle = "rgba(255, 255, 255, 0.85)";
      c.fillRect(w / 2 - dpr, 0, 2 * dpr, h);

      if (this.loop) {
        const x1 = ((this.loop.start - start) / this.span) * w;
        const x2 = ((this.loop.end - start) / this.span) * w;
        c.strokeStyle = "rgba(255, 209, 102, 0.8)";
        c.lineWidth = dpr;
        c.beginPath();
        c.moveTo(x1, 0);
        c.lineTo(x1, h);
        c.moveTo(x2, 0);
        c.lineTo(x2, h);
        c.stroke();
      }
    }
  }

  DJ.Waveform = Waveform;
  DJ.ZoomWaveform = ZoomWaveform;
})();

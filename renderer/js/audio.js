(function () {
  const DJ = (window.DJ = window.DJ || {});

  const EQ_RANGE = { high: 6000, mid: 1200, low: 180 };

  class Deck {
    constructor(mixer, id) {
      this.id = id;
      this.mixer = mixer;
      this.ctx = mixer.ctx;

      this.el = new Audio();
      this.el.preload = "auto";
      this.el.crossOrigin = "anonymous";

      this.source = this.ctx.createMediaElementSource(this.el);

      this.low = this.ctx.createBiquadFilter();
      this.low.type = "lowshelf";
      this.low.frequency.value = EQ_RANGE.low;

      this.mid = this.ctx.createBiquadFilter();
      this.mid.type = "peaking";
      this.mid.frequency.value = EQ_RANGE.mid;
      this.mid.Q.value = 0.9;

      this.high = this.ctx.createBiquadFilter();
      this.high.type = "highshelf";
      this.high.frequency.value = EQ_RANGE.high;

      this.trim = this.ctx.createGain();
      this.trim.gain.value = 1;

      this.channel = this.ctx.createGain();
      this.channel.gain.value = 0.8;

      this.cross = this.ctx.createGain();
      this.cross.gain.value = Math.SQRT1_2;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.6;

      this.source.connect(this.low);
      this.low.connect(this.mid);
      this.mid.connect(this.high);
      this.high.connect(this.trim);
      this.trim.connect(this.channel);
      this.channel.connect(this.cross);
      this.cross.connect(this.analyser);
      this.cross.connect(mixer.master);

      this.cuePoint = 0;
      this.loop = null;
      this.looping = false;
      this.rate = 1;

      this.el.addEventListener("ended", () => {
        if (this.onStateChange) this.onStateChange();
      });
    }

    async load(file) {
      this.stop();
      this.el.src = URL.createObjectURL(file);
      this.el.load();
      await new Promise((resolve, reject) => {
        const ok = () => {
          cleanup();
          resolve();
        };
        const bad = () => {
          cleanup();
          reject(new Error("Could not decode " + file.name));
        };
        const cleanup = () => {
          this.el.removeEventListener("loadedmetadata", ok);
          this.el.removeEventListener("error", bad);
        };
        this.el.addEventListener("loadedmetadata", ok);
        this.el.addEventListener("error", bad);
      });
      this.cuePoint = 0;
      this.loop = null;
      this.looping = false;
      this.setRate(this.rate);
      return this;
    }

    get duration() {
      return Number.isFinite(this.el.duration) ? this.el.duration : 0;
    }

    get currentTime() {
      return this.el.currentTime;
    }

    get playing() {
      return !this.el.paused && !this.el.ended;
    }

    async play() {
      if (!this.el.src) return;
      if (this.ctx.state === "suspended") await this.ctx.resume();
      await this.el.play();
    }

    pause() {
      this.el.pause();
    }

    toggle() {
      if (this.playing) this.pause();
      else this.play();
    }

    stop() {
      this.el.pause();
      if (this.el.src) this.el.currentTime = 0;
    }

    seek(t) {
      const d = this.duration;
      this.el.currentTime = Math.max(0, Math.min(t, d ? d - 0.02 : 0));
    }

    nudge(seconds) {
      this.seek(this.currentTime + seconds);
    }

    setRate(rate) {
      this.rate = rate;
      this.el.preservesPitch = false;
      this.el.mozPreservesPitch = false;
      this.el.webkitPreservesPitch = false;
      this.el.playbackRate = rate;
    }

    setTempoPercent(percent) {
      this.setRate(1 + percent / 100);
    }

    setEq(band, db) {
      if (!this[band]) return;
      this[band].gain.value = db;
    }

    setTrim(value) {
      this.trim.gain.value = value;
    }

    setChannelGain(value) {
      this.channel.gain.value = value;
    }

    setCrossGain(value) {
      this.cross.gain.value = value;
    }

    setCue(t) {
      this.cuePoint = t == null ? this.currentTime : t;
    }

    jumpToCue() {
      if (this.playing) this.seek(this.cuePoint);
      else this.seek(this.cuePoint);
    }

    setLoop(start, length, enabled) {
      this.loop = { start, end: start + length };
      this.looping = enabled !== false;
    }

    clearLoop() {
      this.loop = null;
      this.looping = false;
    }

    tick() {
      if (this.looping && this.loop && this.playing) {
        if (this.currentTime >= this.loop.end) {
          this.el.currentTime = this.loop.start;
        }
      }
    }

    level() {
      const data = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / data.length);
    }
  }

  class Mixer {
    constructor() {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -3;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.25;
      this.streamDest = this.ctx.createMediaStreamDestination();
      this.master.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);
      this.limiter.connect(this.streamDest);
      this.decks = {};
    }

    deck(id) {
      if (!this.decks[id]) this.decks[id] = new Deck(this, id);
      return this.decks[id];
    }

    setCrossfader(value) {
      const x = Math.max(0, Math.min(1, value));
      const a = Math.cos((x * Math.PI) / 2);
      const b = Math.sin((x * Math.PI) / 2);
      if (this.decks.A) this.decks.A.setCrossGain(a);
      if (this.decks.B) this.decks.B.setCrossGain(b);
    }

    setMaster(value) {
      this.master.gain.value = value;
    }

    getStream() {
      return this.streamDest.stream;
    }

    async resume() {
      if (this.ctx.state === "suspended") await this.ctx.resume();
    }
  }

  DJ.Deck = Deck;
  DJ.Mixer = Mixer;
})();

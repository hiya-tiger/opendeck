(function () {
  const DJ = window.DJ;
  const { formatTime } = DJ.analysis;

  const $ = (id) => document.getElementById(id);

  const mixer = new DJ.Mixer();
  const decks = { A: mixer.deck("A"), B: mixer.deck("B") };
  const waves = {};
  const zooms = {};
  const ui = {};
  const meta = { A: null, B: null };
  const analysisQueue = [];
  let analyzing = false;

  let recording = null;
  let recordChunks = [];
  let recordStart = 0;
  let recordTimer = 0;

  function buildDeck(deckId) {
    const template = $("deckTemplate");
    const node = template.content.firstElementChild.cloneNode(true);
    const slot = $("deckSlot" + deckId);
    slot.appendChild(node);

    node.querySelector(".deck-letter").textContent = deckId;

    const refs = {
      root: node,
      title: node.querySelector(".deck-title"),
      bpm: node.querySelector(".deck-bpm"),
      time: node.querySelector(".deck-time"),
      overview: node.querySelector(".wf-overview"),
      zoom: node.querySelector(".wf-zoom"),
      play: node.querySelector(".play"),
      cue: node.querySelector(".cue"),
      sync: node.querySelector(".sync"),
      loop: node.querySelector(".loop"),
      loopSet: node.querySelector(".loopSet"),
      pitch: node.querySelector(".pitch"),
      pitchVal: node.querySelector(".pitch-val"),
      eqHigh: node.querySelector(".eq-high"),
      eqMid: node.querySelector(".eq-mid"),
      eqLow: node.querySelector(".eq-low"),
      trim: node.querySelector(".trim"),
    };
    ui[deckId] = refs;

    const deck = decks[deckId];
    const wave = new DJ.Waveform(refs.overview);
    const zoom = new DJ.ZoomWaveform(refs.zoom, 8);
    waves[deckId] = wave;
    zooms[deckId] = zoom;

    wave.onSeek((seconds) => {
      deck.seek(seconds);
      updateDeck(deckId);
    });

    refs.play.addEventListener("click", () => {
      mixer.resume();
      deck.toggle();
    });

    refs.cue.addEventListener("click", () => {
      mixer.resume();
      if (deck.playing) deck.seek(deck.cuePoint);
      else {
        deck.setCue(deck.currentTime);
        deck.seek(deck.cuePoint);
        wave.setCue(deck.cuePoint);
      }
    });

    refs.sync.addEventListener("click", () => {
      const other = deckId === "A" ? "B" : "A";
      const otherMeta = meta[other];
      const thisMeta = meta[deckId];
      if (!otherMeta || !thisMeta || !otherMeta.bpm || !thisMeta.bpm) return;
      const ratio = otherMeta.bpm / thisMeta.bpm;
      const percent = Math.max(-50, Math.min(50, (ratio - 1) * 100));
      refs.pitch.value = percent.toFixed(1);
      applyTempo(deckId, percent);
    });

    refs.loop.addEventListener("click", () => {
      if (!deck.loop) {
        applyLoop(deckId);
        return;
      }
      deck.looping = !deck.looping;
      refs.loop.classList.toggle("active", deck.looping);
      wave.setLoop(deck.looping ? deck.loop : null);
      zoom.setLoop(deck.looping ? deck.loop : null);
    });

    refs.loopSet.addEventListener("click", () => applyLoop(deckId));

    refs.pitch.addEventListener("input", () => {
      applyTempo(deckId, Number(refs.pitch.value));
    });

    refs.eqHigh.addEventListener("input", () => deck.setEq("high", Number(refs.eqHigh.value)));
    refs.eqMid.addEventListener("input", () => deck.setEq("mid", Number(refs.eqMid.value)));
    refs.eqLow.addEventListener("input", () => deck.setEq("low", Number(refs.eqLow.value)));
    refs.trim.addEventListener("input", () => deck.setTrim(Number(refs.trim.value)));

    deck.onStateChange = () => {
      refs.play.classList.toggle("active", deck.playing);
      refs.play.textContent = deck.playing ? "PAUSE" : "PLAY";
    };

    return refs;
  }

  function applyTempo(deckId, percent) {
    const deck = decks[deckId];
    const refs = ui[deckId];
    refs.pitchVal.textContent = (percent >= 0 ? "+" : "") + percent.toFixed(1) + "%";
    deck.setTempoPercent(percent);
    updateDeck(deckId);
  }

  function applyLoop(deckId) {
    const deck = decks[deckId];
    const refs = ui[deckId];
    const bpm = (meta[deckId] && meta[deckId].bpm) || 120;
    const beat = 60 / bpm;
    const length = beat * 4;
    deck.setLoop(deck.currentTime, length, true);
    refs.loop.classList.add("active");
    waves[deckId].setLoop(deck.loop);
    zooms[deckId].setLoop(deck.loop);
  }

  function updateDeck(deckId) {
    const deck = decks[deckId];
    const refs = ui[deckId];
    const duration = deck.duration;
    refs.time.textContent =
      formatTime(deck.currentTime) + " / " + formatTime(duration);
    waves[deckId].setProgress(deck.currentTime);
    zooms[deckId].update(deck.currentTime);
  }

  function loadTrack(track, deckId) {
    if (!track.file) return;
    const deck = decks[deckId];
    const refs = ui[deckId];
    deck.load(track.file).then(() => {
      meta[deckId] = track;
      refs.title.textContent = track.name;
      refs.title.title = track.name;
      refs.bpm.textContent = track.bpm ? track.bpm.toFixed(1) + " BPM" : "analysing…";
      refs.play.classList.remove("active");
      refs.play.textContent = "PLAY";
      refs.loop.classList.remove("active");
      waves[deckId].setCue(0);
      waves[deckId].setLoop(null);
      zooms[deckId].setLoop(null);
      zooms[deckId].setBpm(track.bpm || 0);
      updateDeck(deckId);
      if (track.analyzed) applyAnalysis(track, deckId);
      else enqueueAnalysis(track);
    });
  }

  function applyAnalysis(track, deckId) {
    const refs = ui[deckId];
    if (meta[deckId] !== track) return;
    waves[deckId].setPeaks(track.peaks, track.duration);
    zooms[deckId].setPeaks(track.peaks, track.duration);
    zooms[deckId].setBpm(track.bpm);
    refs.bpm.textContent = track.bpm ? track.bpm.toFixed(1) + " BPM" : "no BPM";
  }

  function enqueueAnalysis(track) {
    if (track.queued) return;
    track.queued = true;
    analysisQueue.push(track);
    pump();
  }

  async function pump() {
    if (analyzing) return;
    const track = analysisQueue.shift();
    if (!track) return;
    analyzing = true;
    try {
      const buffer = await DJ.analysis.decode(mixer.ctx, track.file);
      const peaks = DJ.analysis.peaks(buffer, 1600);
      const result = DJ.analysis.detectBpm(buffer);
      track.peaks = peaks;
      track.duration = buffer.duration;
      track.bpm = result.bpm;
      track.confidence = result.confidence;
      const targetA = meta.A === track ? "A" : null;
      const targetB = meta.B === track ? "B" : null;
      library.setMeta(track, {});
      if (targetA) applyAnalysis(track, "A");
      if (targetB) applyAnalysis(track, "B");
    } catch (error) {
      console.warn("analysis failed", track.name, error);
      track.bpm = 0;
      library.setMeta(track, {});
    } finally {
      analyzing = false;
      if (analysisQueue.length) pump();
    }
  }

  const library = new DJ.Library($("trackList"), $("libCount"), (track, deckId) => {
    loadTrack(track, deckId);
  });

  const crateNote = $("crateNote");
  const linkBtn = $("linkBtn");

  function setNote(text, warn) {
    crateNote.textContent = text;
    crateNote.classList.toggle("hidden", !text);
    crateNote.classList.toggle("warn", Boolean(warn));
  }

  function refreshLinkButton() {
    linkBtn.classList.toggle("hidden", library.missingCount === 0);
  }

  async function importCrate(name, buffer) {
    if (!DJ.serato.isSerato(buffer)) {
      setNote(`${name} is not a Serato crate or database file.`, true);
      return { tracks: [], missing: 0 };
    }
    const parsed = DJ.serato.parse(buffer);
    const added = library.addCrate(name.replace(/\.crate$/i, ""), parsed.tracks);
    refreshLinkButton();
    setNote(
      `Imported ${name}: ${parsed.tracks.length} tracks, ${added.length} new.` +
        (library.missingCount ? " Link the music folder to load them." : ""),
      library.missingCount > 0
    );
    return { tracks: parsed.tracks, missing: library.missingCount };
  }

  async function collectAudio(dir, depth) {
    const found = [];
    for await (const entry of dir.values()) {
      if (entry.kind === "file") {
        const file = await entry.getFile();
        if (/\.(mp3|wav|ogg|flac|m4a|aac|aiff?|opus)$/i.test(file.name)) found.push(file);
      } else if (entry.kind === "directory" && depth > 0) {
        found.push(...(await collectAudio(entry, depth - 1)));
      }
    }
    return found;
  }

  async function linkFolder() {
    if (!window.showDirectoryPicker) {
      setNote("Folder linking needs a Chromium browser (Chrome, Edge, Vivaldi). Drag the crate into the library instead.", true);
      return;
    }
    let dir;
    try {
      dir = await window.showDirectoryPicker({ id: "opendeck-music", mode: "read" });
    } catch {
      return;
    }
    setNote("Scanning " + dir.name + "…");
    const files = await collectAudio(dir, 6);
    const linked = library.resolve(files);
    for (const track of linked) enqueueAnalysis(track);
    refreshLinkButton();
    setNote(
      `Linked ${linked.length} crate track${linked.length === 1 ? "" : "s"} from ${dir.name}.` +
        (library.missingCount ? ` ${library.missingCount} still missing.` : ""),
      linked.length === 0
    );
  }

  $("crateBtn").addEventListener("click", () => $("crateInput").click());
  $("crateInput").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (file) await importCrate(file.name, await file.arrayBuffer());
    event.target.value = "";
  });
  linkBtn.addEventListener("click", linkFolder);

  function addFiles(files) {
    const tracks = library.add(files);
    for (const track of tracks) enqueueAnalysis(track);
    if (tracks.length) mixer.resume();
  }

  $("fileInput").addEventListener("change", (event) => {
    addFiles(event.target.files);
    event.target.value = "";
  });

  const drop = $("dropZone");
  ["dragenter", "dragover"].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add("over");
    })
  );
  ["dragleave", "drop"].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.remove("over");
    })
  );
  drop.addEventListener("drop", (event) => {
    if (event.dataTransfer && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  $("search").addEventListener("input", (event) => library.setFilter(event.target.value));

  $("crossfader").addEventListener("input", (event) => mixer.setCrossfader(Number(event.target.value)));
  $("chA").addEventListener("input", (event) => decks.A.setChannelGain(Number(event.target.value)));
  $("chB").addEventListener("input", (event) => decks.B.setChannelGain(Number(event.target.value)));
  $("master").addEventListener("input", (event) => mixer.setMaster(Number(event.target.value)));

  function startRecording() {
    mixer.resume();
    recordChunks = [];
    const stream = mixer.getStream();
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((type) =>
      window.MediaRecorder && MediaRecorder.isTypeSupported(type)
    );
    recording = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recording.ondataavailable = (event) => {
      if (event.data.size) recordChunks.push(event.data);
    };
    recording.onstop = () => {
      const blob = new Blob(recordChunks, { type: recording.mimeType || "audio/webm" });
      const link = $("saveMix");
      if (link.href.startsWith("blob:")) URL.revokeObjectURL(link.href);
      link.href = URL.createObjectURL(blob);
      link.classList.remove("hidden");
      recording = null;
    };
    recording.start(500);
    recordStart = performance.now();
    $("recBtn").setAttribute("aria-pressed", "true");
    $("recBtn").textContent = "Stop";
  }

  function stopRecording() {
    if (recording && recording.state !== "inactive") recording.stop();
    $("recBtn").setAttribute("aria-pressed", "false");
    $("recBtn").textContent = "Record";
    $("recTime").textContent = "00:00";
    clearInterval(recordTimer);
  }

  $("recBtn").addEventListener("click", () => {
    if (recording) stopRecording();
    else startRecording();
    if (recording) {
      clearInterval(recordTimer);
      recordTimer = setInterval(() => {
        const elapsed = (performance.now() - recordStart) / 1000;
        $("recTime").textContent = formatTime(elapsed);
      }, 500);
    }
  });

  function drawMeter(canvas, level) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0a0d11";
    ctx.fillRect(0, 0, w, h);
    const scaled = Math.min(1, level * 2.2);
    const bars = 24;
    for (let i = 0; i < bars; i++) {
      const lit = i / bars < scaled;
      const y = h - ((i + 1) * h) / bars;
      ctx.fillStyle = lit ? (i > bars * 0.85 ? "#ff5f6d" : i > bars * 0.65 ? "#ffd166" : "#4ee0a8") : "#1b2129";
      ctx.fillRect(2, y + 2, w - 4, h / bars - 3);
    }
  }

  function keyHandler(event) {
    if (event.target.matches("input, textarea, select")) return;
    const key = event.key.toLowerCase();
    if (key === "q") decks.A.toggle();
    else if (key === "p") decks.B.toggle();
    else if (key === "a") decks.A.seek(decks.A.cuePoint);
    else if (key === "l") decks.B.seek(decks.B.cuePoint);
    else if (key === "arrowleft" || key === "arrowright") {
      const xf = $("crossfader");
      const step = event.shiftKey ? 0.1 : 0.02;
      xf.value = String(Math.max(0, Math.min(1, Number(xf.value) + (key === "arrowright" ? step : -step))));
      mixer.setCrossfader(Number(xf.value));
    } else return;
    event.preventDefault();
  }

  function frame() {
    decks.A.tick();
    decks.B.tick();
    updateDeck("A");
    updateDeck("B");
    drawMeter($("meterA"), decks.A.level());
    drawMeter($("meterB"), decks.B.level());
    requestAnimationFrame(frame);
  }

  buildDeck("A");
  buildDeck("B");
  ui.A.pitch.value = "0";
  ui.B.pitch.value = "0";
  applyTempo("A", 0);
  applyTempo("B", 0);
  mixer.setCrossfader(0.5);
  mixer.setMaster(0.8);
  waves.A.draw();
  waves.B.draw();

  document.addEventListener("keydown", keyHandler);
  requestAnimationFrame(frame);

  window.openDeck = { mixer, decks, waves, zooms, library, loadTrack, addFiles, importCrate, linkFolder };
})();

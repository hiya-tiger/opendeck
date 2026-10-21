(function () {
  const DJ = (window.DJ = window.DJ || {});

  const AUDIO_RE = /\.(mp3|wav|ogg|flac|m4a|aac|aiff?|opus|webm)$/i;

  function baseName(path) {
    const parts = String(path || "").split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  class Library {
    constructor(listEl, countEl, onLoad) {
      this.listEl = listEl;
      this.countEl = countEl;
      this.onLoad = onLoad;
      this.tracks = [];
      this.filter = "";
      this.crateName = "";
      this.lastCrate = null;
    }

    add(files) {
      const added = [];
      for (const file of files) {
        if (!file.type.startsWith("audio/") && !AUDIO_RE.test(file.name)) continue;
        const track = {
          file,
          name: file.name.replace(/\.[^.]+$/, ""),
          path: file.webkitRelativePath || file.name,
          bpm: 0,
          duration: 0,
          peaks: null,
          analyzed: false,
          missing: false,
        };
        this.tracks.push(track);
        added.push(track);
      }
      this.render();
      return added;
    }

    addCrate(crateName, entries) {
      const existing = new Set(this.tracks.map((t) => baseName(t.path).toLowerCase()));
      const added = [];
      for (const entry of entries) {
        const key = baseName(entry.name).toLowerCase();
        if (existing.has(key)) continue;
        const track = {
          file: null,
          name: entry.name.replace(/\.[^.]+$/, ""),
          path: entry.path,
          bpm: 0,
          duration: 0,
          peaks: null,
          analyzed: false,
          missing: true,
          crate: crateName,
        };
        existing.add(key);
        this.tracks.push(track);
        added.push(track);
      }
      this.crateName = crateName;
      this.lastCrate = added;
      this.render();
      return added;
    }

    resolve(files) {
      const byName = new Map();
      for (const file of files) {
        const key = baseName(file.name).toLowerCase();
        if (!byName.has(key)) byName.set(key, file);
      }

      const linked = [];
      for (const track of this.tracks) {
        if (!track.missing) continue;
        const match = byName.get(baseName(track.path).toLowerCase());
        if (!match) continue;
        track.file = match;
        track.missing = false;
        linked.push(track);
      }
      this.render();
      return linked;
    }

    setMeta(track, meta) {
      Object.assign(track, meta, { analyzed: true });
      this.render();
    }

    setFilter(value) {
      this.filter = value.trim().toLowerCase();
      this.render();
    }

    get missingCount() {
      return this.tracks.filter((track) => track.missing).length;
    }

    render() {
      const visible = this.tracks.filter(
        (t) => !this.filter || t.name.toLowerCase().includes(this.filter) || t.path.toLowerCase().includes(this.filter)
      );
      const frag = document.createDocumentFragment();
      this.listEl.textContent = "";

      visible.forEach((track) => {
        const tr = document.createElement("tr");
        if (track.missing) tr.className = "missing";

        const num = document.createElement("td");
        num.className = "num";
        num.textContent = String(this.tracks.indexOf(track) + 1);
        tr.appendChild(num);

        const title = document.createElement("td");
        title.className = "title-cell";
        title.textContent = track.name;
        title.title = track.path || track.name;
        tr.appendChild(title);

        const bpm = document.createElement("td");
        bpm.className = "mono";
        bpm.textContent = track.bpm ? track.bpm.toFixed(1) : "--";
        tr.appendChild(bpm);

        const len = document.createElement("td");
        len.className = "mono";
        len.textContent = track.duration ? DJ.analysis.formatTime(track.duration) : "--:--";
        tr.appendChild(len);

        const actions = document.createElement("td");
        actions.className = "load-btns";
        for (const deckId of ["A", "B"]) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = deckId;
          btn.title = track.missing ? "File not linked: link the music folder first" : "Load into deck " + deckId;
          btn.disabled = Boolean(track.missing);
          btn.addEventListener("click", () => {
            if (!track.missing) this.onLoad(track, deckId);
          });
          actions.appendChild(btn);
        }
        tr.appendChild(actions);

        tr.addEventListener("dblclick", () => {
          if (!track.missing) this.onLoad(track, "A");
        });

        frag.appendChild(tr);
      });

      this.listEl.appendChild(frag);

      const parts = [`${this.tracks.length} track${this.tracks.length === 1 ? "" : "s"}`];
      if (this.crateName) parts.push(this.crateName);
      if (this.missingCount) parts.push(`${this.missingCount} unlinked`);
      this.countEl.textContent = parts.join(" · ");
    }
  }

  Library.baseName = baseName;
  DJ.Library = Library;
})();

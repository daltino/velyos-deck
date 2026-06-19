// app.js — main wiring
class DJApp {
  constructor() {
    this.engine = new AudioEngine();
    this.engineReady = false;
    this.decks = [new Deck(0, this.engine), new Deck(1, this.engine)];
    this.waves = [];
    this.midi = null;
    this.library = null;
    this.coach = null;
    this.automix = null;
    this.generative = null;
    this.visualizer = null;
    this._rafToken = 0;
    this.keyboardEnabled = false;
    this.sessionEvents = [];
    this.recordingEventStart = 0;
    this.padModes = ["hotCue", "hotCue"];
  }

  async start() {
    await this.engine.init();
    this.decks.forEach((d) => d.attach());
    this.engineReady = true;
    this._setAudioStatus(true);
    this.coach = new MixCoach(this.decks, this.engine);
    this.automix = new AutoMixer(this);
    this.generative = new GenerativeDeck(this, this.engine);
    this.generative.attach();
    this.visualizer = new Visualizer(this.engine);

    this._wireDeckUI(0);
    this._wireDeckUI(1);
    this._wireMixer();
    this._wireDragDrop();
    this._wireTopbar();
    this._wireAutoMix();
    this._wireGenerative();
    this._wireKeyboard();
    this._wireAudioWake();

    for (let i = 0; i < 2; i++) {
      const root = document.querySelector(`.deck[data-deck="${i}"]`);
      this.waves.push(new Waveform(
        this.decks[i],
        root.querySelector('canvas[data-canvas="overview"]'),
        root.querySelector('canvas[data-canvas="zoom"]'),
      ));
      this.decks[i].onChange = () => this.refreshDeck(i);
      this.decks[i].onEnded = (deck) => this.automix?.handleEnded(deck);
    }

    this.library = new Library(
      document.getElementById("libBody"),
      document.getElementById("libStats"),
      document.getElementById("librarySearch"),
      this,
    );
    await this.library.load();

    this.midi = new MidiBridge(this, document.getElementById("midiStatus"));
    await this.midi.connect();

    this.setStartedAt = Date.now();
    this._tick();
  }

  _setAudioStatus(ok) {
    const el = document.getElementById("audioStatus");
    const route = this.engine.useMediaOutput ? "MEDIA" : "AUDIO";
    el.textContent = ok ? `${route} ${Math.round(this.engine.ctx.sampleRate / 1000)}K` : "AUDIO OFF";
    el.classList.toggle("badge-on", ok);
    el.classList.toggle("badge-off", !ok);
  }

  _setKeyboardStatus(ok) {
    const el = document.getElementById("kbdStatus");
    if (!el) return;
    el.textContent = ok ? "KEYS ON" : "KEYS OFF";
    el.classList.toggle("badge-on", ok);
    el.classList.toggle("badge-off", !ok);
  }

  _wireAudioWake() {
    const wake = () => {
      this.engine.ensureRunning?.();
    };
    for (const eventName of ["pointerdown", "touchend", "click", "keydown"]) {
      document.addEventListener(eventName, wake, { passive: true });
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) wake();
    });
  }

  _wireTopbar() {
    document.getElementById("recBtn").addEventListener("click", () => this._toggleRecord());
    document.getElementById("vizBtn").addEventListener("click", () => {
      this.visualizer.openFullscreen();
    });
    document.getElementById("cueDeviceBtn").addEventListener("click", () => this._openCueDeviceDialog());
    document.getElementById("cueDeviceCancel").addEventListener("click",
      () => document.getElementById("cueDeviceDialog").close());
    document.getElementById("cueDeviceOk").addEventListener("click", async () => {
      const sel = document.getElementById("cueDeviceSelect");
      const id = sel.value;
      const dlg = document.getElementById("cueDeviceDialog");
      if (id) await this.engine.setCueOutputDevice(id);
      dlg.close();
    });
  }

  async _openCueDeviceDialog() {
    const dlg = document.getElementById("cueDeviceDialog");
    const sel = document.getElementById("cueDeviceSelect");
    sel.innerHTML = "";
    const devs = await this.engine.listOutputDevices();
    if (!devs.length) {
      const opt = document.createElement("option");
      opt.disabled = true; opt.textContent = "Žádná zařízení (povolit v System Settings → Privacy)";
      sel.appendChild(opt);
    }
    for (const d of devs) {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Device ${d.deviceId.slice(0, 8)}`;
      if (d.deviceId === this.engine.cueOutputDeviceId) opt.selected = true;
      sel.appendChild(opt);
    }
    dlg.showModal();
  }

  async _generateStems(idx) {
    const deck = this.decks[idx];
    if (!deck.track) {
      alert("Nejdřív naber track na deck.");
      return;
    }
    if (deck.hasStems()) {
      alert("Track už má stems.");
      return;
    }
    const root = document.querySelector(`.deck[data-deck="${idx}"]`);
    const btn = root.querySelector('button[data-control="genstems"]');
    btn.disabled = true;
    btn.textContent = "⚡ Generuju…";
    try {
      const r = await fetch(`/stems?id=${encodeURIComponent(deck.track.id)}`,
                           { method: "POST" });
      if (!r.ok) throw new Error(`server: ${r.status}`);
      // Poll status
      let elapsed = 0;
      const poll = async () => {
        const sr = await fetch(`/stems/status?id=${encodeURIComponent(deck.track.id)}`);
        const j = await sr.json();
        elapsed = j.elapsed || 0;
        btn.textContent = `⚡ ${Math.round(elapsed)}s…`;
        if (j.status === "done") {
          // reload library so we get stem URLs
          await this.library.load();
          const updated = this.library.findById(deck.track.id);
          if (updated && updated.stems) {
            await deck.loadStems(updated.stems);
          }
          btn.textContent = "⚡ STEMS ✓";
          btn.classList.add("is-active");
          this.refreshDeck(idx);
          return;
        }
        if (j.status === "error") {
          btn.textContent = "⚡ FAIL";
          alert("Stems generation failed: " + (j.error || "?"));
          btn.disabled = false;
          return;
        }
        setTimeout(poll, 2000);
      };
      poll();
    } catch (e) {
      btn.textContent = "⚡ STEMS";
      btn.disabled = false;
      alert("Failed: " + e.message);
    }
  }

  async _toggleRecord() {
    const btn = document.getElementById("recBtn");
    if (this.engine.isRecording()) {
      const r = await this.engine.stopRecording();
      btn.classList.remove("recording");
      btn.textContent = "REC";
      if (r && r.blob) {
        const url = URL.createObjectURL(r.blob);
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const a = document.createElement("a");
        a.href = url;
        a.download = `dj-mix-${ts}.webm`;
        a.click();
        const report = this._recordingReport(r, ts);
        this._downloadText(`dj-mix-${ts}-report.json`, JSON.stringify(report, null, 2), "application/json");
        this._downloadText(`dj-mix-${ts}-report.txt`, this._recordingReportText(report), "text/plain");
        const status = document.getElementById("recStatus");
        status.textContent = `SAVED ${fmtTime(r.durationSec)} ${a.download}`;
      }
    } else {
      this.recordingEventStart = this.sessionEvents.length;
      this.recordSessionEvent({ type: "recording_start" });
      this.engine.startRecording();
      btn.classList.add("recording");
      btn.textContent = "STOP";
      document.getElementById("recStatus").textContent = "REC 0:00";
    }
  }

  recordSessionEvent(event) {
    const setSec = Math.max(0, Math.floor((Date.now() - (this.setStartedAt || Date.now())) / 1000));
    this.sessionEvents.push({
      at: new Date().toISOString(),
      setSec,
      ...event,
    });
  }

  _recordingReport(recording, ts) {
    const events = this.sessionEvents.slice(this.recordingEventStart);
    return {
      createdAt: new Date().toISOString(),
      file: `dj-mix-${ts}.webm`,
      durationSec: recording?.durationSec || 0,
      events,
      creativeTransitions: events.filter((e) => e.type === "automix_transition" && e.mixType === "creative"),
    };
  }

  _recordingReportText(report) {
    const lines = [
      `Recording: ${report.file}`,
      `Duration: ${fmtTime(Math.floor(report.durationSec || 0))}`,
      `Events: ${report.events.length}`,
      "",
    ];
    for (const event of report.events) {
      if (event.type === "automix_transition") {
        lines.push(
          `${event.setSec}s ${event.mixType.toUpperCase()} ${event.recipe || "safe"}: ` +
          `${event.from?.title || "?"} -> ${event.to?.title || "?"} · ${event.reason || ""}`
        );
      } else {
        lines.push(`${event.setSec}s ${event.type}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  _downloadText(filename, text, type) {
    const blob = new Blob([text], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  _wireDeckUI(idx) {
    const root = document.querySelector(`.deck[data-deck="${idx}"]`);
    const deck = this.decks[idx];
    const q = (sel) => root.querySelector(sel);
    const qa = (sel) => root.querySelectorAll(sel);

    q('button[data-control="play"]').addEventListener("click", () => deck.togglePlay());
    q('button[data-control="cue"]').addEventListener("click", () => deck.cue());
    q('button[data-control="sync"]').addEventListener("click", () => {
      deck.syncTo(this.decks[1 - idx]);
      deck.phaseAlignTo(this.decks[1 - idx]);
    });
    q('input[data-control="pitch"]').addEventListener("input",
      (e) => deck.setPitchPercent(parseFloat(e.target.value)));
    q('input[data-control="volume"]').addEventListener("input",
      (e) => deck.setVolume(parseFloat(e.target.value)));
    q('input[data-control="filter"]').addEventListener("input",
      (e) => deck.setFilter(parseFloat(e.target.value)));
    q('input[data-control="filter"]').addEventListener("dblclick",
      (e) => { e.target.value = 0.5; deck.setFilter(0.5); });

    for (const band of ["High", "Mid", "Low"]) {
      const slider = q(`input[data-control="eq${band}"]`);
      slider.addEventListener("input", (e) =>
        deck.setEq(band.toLowerCase(), parseFloat(e.target.value)));
      slider.addEventListener("dblclick", () => {
        slider.value = 0; deck.setEq(band.toLowerCase(), 0);
      });
    }

    // Hot cue pads
    qa("button[data-cue]").forEach((btn) => {
      const slot = parseInt(btn.dataset.cue, 10);
      btn.addEventListener("click", (e) => {
        if (e.shiftKey) deck.clearCue(slot);
        else deck.hotCue(slot);
        btn.classList.add("flash");
        setTimeout(() => btn.classList.remove("flash"), 200);
      });
    });

    q('button[data-control="genstems"]').addEventListener("click",
      () => this._generateStems(idx));

    // EQ ↔ STEMS tabs
    qa(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        qa(".mode-btn").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        const mode = btn.dataset.modeBtn;
        q('div[data-pane="eq"]').hidden = mode !== "eq";
        q('div[data-pane="stems"]').hidden = mode !== "stems";
      });
    });

    // Stem sliders
    qa("input[data-stem]").forEach((slider) => {
      const stemIdx = parseInt(slider.dataset.stem, 10);
      slider.addEventListener("input", (e) =>
        deck.setStemGain(stemIdx, parseFloat(e.target.value)));
    });

    // FX
    qa("button[data-fx]").forEach((btn) => {
      const fx = btn.dataset.fx;
      btn.addEventListener("click", () => {
        const isOn = btn.classList.toggle("is-on");
        const slider = q(`input[data-fx-amount="${fx}"]`);
        if (isOn && parseFloat(slider.value) === 0) slider.value = 0.35;
        const v = isOn ? parseFloat(slider.value) : 0;
        this._applyFx(deck, fx, v);
        this.refreshDeck(idx);
      });
    });
    qa("input[data-fx-amount]").forEach((slider) => {
      const fx = slider.dataset.fxAmount;
      slider.addEventListener("input", (e) => {
        const btn = q(`button[data-fx="${fx}"]`);
        if (btn.classList.contains("is-on")) {
          this._applyFx(deck, fx, parseFloat(e.target.value));
          this.refreshDeck(idx);
        }
      });
    });

    // Loops
    qa("button[data-loop]").forEach((btn) => {
      const beats = parseFloat(btn.dataset.loop);
      btn.addEventListener("click", () => {
        deck.loops.loopN(beats);
        this._refreshLoopUI(idx);
      });
    });
    q('button[data-control="loopToggle"]').addEventListener("click", () => {
      deck.loops.exit();
      this._refreshLoopUI(idx);
    });
    q('input[data-control="slip"]').addEventListener("change",
      (e) => deck.loops.setSlip(e.target.checked));

    // Cue listen toggle
    q('[data-control="cueToggle"]').addEventListener("click", () => {
      deck.setCueListen(!deck.cueListening);
    });
  }

  setPadMode(deckIdx, mode) {
    this.padModes[deckIdx] = mode;
    const root = document.querySelector(`.deck[data-deck="${deckIdx}"]`);
    if (!root) return;
    root.dataset.padMode = mode;
    root.querySelectorAll(".cue-pad").forEach((btn) => {
      btn.title = `DDJ-SB3 ${mode}`;
    });
  }

  _wireKeyboard() {
    if (this.keyboardEnabled) return;
    this.keyboardEnabled = true;
    this._setKeyboardStatus(true);
    window.addEventListener("keydown", (e) => this._handleKeydown(e));
  }

  _handleKeydown(e) {
    if (!this.engineReady || e.repeat || this._isTypingTarget(e.target)) return;
    const key = e.key.toLowerCase();
    const actionMap = {
      z: () => this.decks[0].togglePlay(),
      x: () => this.decks[0].cue(),
      c: () => { this.decks[0].syncTo(this.decks[1]); this.decks[0].phaseAlignTo(this.decks[1]); },
      b: () => this.decks[1].togglePlay(),
      n: () => this.decks[1].cue(),
      m: () => { this.decks[1].syncTo(this.decks[0]); this.decks[1].phaseAlignTo(this.decks[0]); },
      f: () => this._setCrossfader(0.5),
      ",": () => this._setCrossfader(this.engine.crossfader - 0.05),
      ".": () => this._setCrossfader(this.engine.crossfader + 0.05),
      "[": () => this._seekRelative(0, -1),
      "]": () => this._seekRelative(0, 1),
      "-": () => this._seekRelative(1, -1),
      "=": () => this._seekRelative(1, 1),
    };
    if (/^[1-8]$/.test(key)) {
      e.preventDefault();
      const number = parseInt(key, 10);
      const deckIdx = number <= 4 ? 0 : 1;
      const slot = deckIdx === 0 ? number - 1 : number - 5;
      this._triggerHotCue(deckIdx, slot, e.shiftKey);
      return;
    }
    const action = actionMap[key];
    if (!action) return;
    e.preventDefault();
    action();
    this.refreshDeck(0);
    this.refreshDeck(1);
  }

  _isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
  }

  _triggerHotCue(deckIdx, slot, clear) {
    const deck = this.decks[deckIdx];
    if (clear) deck.clearCue(slot);
    else deck.hotCue(slot);
    const root = document.querySelector(`.deck[data-deck="${deckIdx}"]`);
    const btn = root?.querySelector(`button[data-cue="${slot}"]`);
    btn?.classList.add("flash");
    setTimeout(() => btn?.classList.remove("flash"), 180);
  }

  _seekRelative(deckIdx, seconds) {
    const deck = this.decks[deckIdx];
    if (!deck?.duration()) return;
    deck.seek(deck.position() + seconds);
  }

  _setCrossfader(value) {
    const v = Math.max(0, Math.min(1, value));
    this.engine.setCrossfader(v);
    const slider = document.getElementById("xfader");
    if (slider) slider.value = v;
    this._refreshMixerState();
  }

  _applyFx(deck, fx, amount) {
    if (fx === "echo")   deck.setEcho(amount);
    if (fx === "reverb") deck.setReverb(amount);
    if (fx === "gate") {
      // chop frequency tied to BPM (1/4 note)
      const beatHz = (deck.effectiveBpm() || 120) / 60 / 1;  // beats per second
      deck.setGate(amount, beatHz * 4);   // 1/16 chops
    }
  }

  _refreshLoopUI(idx) {
    const root = document.querySelector(`.deck[data-deck="${idx}"]`);
    const active = this.decks[idx].loops.active;
    const toggle = root.querySelector('button[data-control="loopToggle"]');
    toggle.classList.toggle("is-active", active);
    toggle.textContent = active ? "EXIT" : "LOOP";
    root.querySelectorAll("button[data-loop]").forEach((btn) => btn.classList.remove("is-active"));
    if (active) {
      const deck = this.decks[idx];
      const beatSec = 60 / (deck.effectiveBpm() || 120);
      const beats = (deck.loops.end - deck.loops.start) / beatSec;
      let best = null;
      let bestDelta = Infinity;
      root.querySelectorAll("button[data-loop]").forEach((btn) => {
        const delta = Math.abs(parseFloat(btn.dataset.loop) - beats);
        if (delta < bestDelta) {
          best = btn;
          bestDelta = delta;
        }
      });
      best?.classList.add("is-active");
    }
  }

  _wireMixer() {
    document.getElementById("xfader").addEventListener("input",
      (e) => {
        this.engine.setCrossfader(parseFloat(e.target.value));
        this._refreshMixerState();
      });
    document.getElementById("masterVol").addEventListener("input",
      (e) => {
        this.engine.setMasterVolume(parseFloat(e.target.value));
        this._refreshMixerState();
      });
  }

  _wireAutoMix() {
    const btn = document.getElementById("automixBtn");
    const skip = document.getElementById("automixSkipBtn");
    const modes = document.querySelectorAll("[data-automix-mode]");
    const dropGates = document.querySelectorAll("[data-automix-drop-gate]");
    const creativeToggle = document.getElementById("automixCreativeToggle");
    const intensities = document.querySelectorAll("[data-automix-intensity]");
    btn?.addEventListener("click", async () => {
      if (!this.automix) return;
      if (this.automix.active) this.automix.stop();
      else await this.automix.start();
    });
    skip?.addEventListener("click", async () => {
      await this.automix?.skip();
    });
    modes.forEach((modeBtn) => {
      modeBtn.addEventListener("click", async () => {
        modes.forEach((btn) => btn.classList.toggle("is-active", btn === modeBtn));
        await this.automix?.modeChanged();
      });
    });
    dropGates.forEach((gateBtn) => {
      gateBtn.addEventListener("click", async () => {
        dropGates.forEach((btn) => btn.classList.toggle("is-active", btn === gateBtn));
        await this.automix?.modeChanged();
      });
    });
    creativeToggle?.addEventListener("change", async () => {
      await this.automix?.modeChanged();
    });
    intensities.forEach((intensityBtn) => {
      intensityBtn.addEventListener("click", async () => {
        intensities.forEach((btn) => btn.classList.toggle("is-active", btn === intensityBtn));
        await this.automix?.modeChanged();
      });
    });
  }

  _wireGenerative() {
    const gen = this.generative;
    const onBtn = document.getElementById("genOnBtn");
    const drumsBtn = document.getElementById("genDrumsBtn");
    const bassBtn = document.getElementById("genBassBtn");
    const fillBtn = document.getElementById("genFillBtn");
    const intensity = document.getElementById("genIntensity");
    onBtn?.addEventListener("click", () => {
      gen.setEnabled(!gen.enabled);
      this._refreshGenerativeUI();
    });
    drumsBtn?.addEventListener("click", () => {
      gen.setDrums(!gen.drumsOn);
      this._refreshGenerativeUI();
    });
    bassBtn?.addEventListener("click", () => {
      gen.setBass(!gen.bassOn);
      this._refreshGenerativeUI();
    });
    fillBtn?.addEventListener("click", () => {
      const beatSec = 60 / (gen.bpm || 120);
      gen.triggerFill(beatSec * 16);
      this._refreshGenerativeUI();
    });
    intensity?.addEventListener("input", (e) => {
      gen.setIntensity(parseFloat(e.target.value));
      this._refreshGenerativeUI();
    });
    this._refreshGenerativeUI();
  }

  _wireDragDrop() {
    document.querySelectorAll(".deck").forEach((deckEl) => {
      const idx = parseInt(deckEl.dataset.deck, 10);
      deckEl.addEventListener("dragover", (e) => {
        if (e.dataTransfer.types.includes("text/track-id")) {
          e.preventDefault();
          deckEl.classList.add("drop-target");
        }
      });
      deckEl.addEventListener("dragleave", () => deckEl.classList.remove("drop-target"));
      deckEl.addEventListener("drop", (e) => {
        e.preventDefault();
        deckEl.classList.remove("drop-target");
        const id = e.dataTransfer.getData("text/track-id");
        const t = this.library.findById(id);
        if (t) this.loadTrackToDeck(t, idx);
      });
    });
  }

  async loadTrackToDeck(track, idx) {
    const deck = this.decks[idx];
    const wave = this.waves[idx];
    try {
      this._setBusy(idx, true);
      await deck.loadTrack(track);
      // Auto-load stems if present
      if (track.stems) {
        const ok = await deck.loadStems(track.stems);
        if (ok) console.log("stems loaded for deck", idx);
      }
      wave.computePeaks(deck.buffer);
      this.coach && this.coach.setProfile(idx, deck.buffer, deck.stems?.bass || null);
      this.refreshDeck(idx);
      this.library?.setReferenceBpm(this.decks[0].effectiveBpm());
      this.library?.markPlayed?.(track);
    } catch (e) {
      console.error(e);
      alert(`Načtení selhalo: ${e.message}`);
    } finally {
      this._setBusy(idx, false);
    }
  }

  findFreeDeck() {
    if (!this.decks[0].buffer) return 0;
    if (!this.decks[1].buffer) return 1;
    return this.decks[0].isPlaying ? 1 : 0;
  }

  refreshDeck(idx) {
    const root = document.querySelector(`.deck[data-deck="${idx}"]`);
    const deck = this.decks[idx];
    const set = (key, val) => {
      root.querySelectorAll(`[data-bind="${key}"]`).forEach((el) => el.textContent = val);
    };
    set("title", deck.track ? deck.track.title : "— vlož track —");
    set("artist", deck.track ? (deck.track.artist || "") : "");
    set("bpm", deck.bpm ? deck.effectiveBpm().toFixed(1) : "--.-");
    set("camelot", deck.track && deck.track.camelot ? deck.track.camelot : "--");
    set("pitch", `${deck.pitchPercent >= 0 ? "+" : ""}${deck.pitchPercent.toFixed(1)}%`);
    set("elapsed", fmtTime(deck.position()));
    const dur = deck.duration();
    set("remaining", "-" + fmtTime(Math.max(0, dur - deck.position())));
    set("cuePoint", fmtTime(deck.cuePoint));
    set("state", deck.isPlaying ? "PLAY" : (deck.buffer || deck.stems ? "CUE" : "STOP"));
    set("stemBadge", deck.hasStems() ? "STEMS" : "");

    root.querySelector(".ctrl.play").classList.toggle("is-active", deck.isPlaying);
    const state = root.querySelector('[data-bind="state"]');
    state?.classList.toggle("is-playing", deck.isPlaying);
    const cueButton = root.querySelector('[data-control="cueToggle"]');
    if (cueButton) cueButton.classList.toggle("is-on", deck.cueListening);

    const syncRange = (selector, value) => {
      const input = root.querySelector(selector);
      if (input && document.activeElement !== input) input.value = value;
    };
    syncRange('input[data-control="pitch"]', deck.pitchPercent);
    syncRange('input[data-control="volume"]', deck.volume);
    syncRange('input[data-control="filter"]', deck.filter);
    syncRange('input[data-control="eqHigh"]', deck.eq.high);
    syncRange('input[data-control="eqMid"]', deck.eq.mid);
    syncRange('input[data-control="eqLow"]', deck.eq.low);
    for (const fx of ["echo", "reverb", "gate"]) {
      const amount = deck.fx[fx] || 0;
      syncRange(`input[data-fx-amount="${fx}"]`, amount);
      const btn = root.querySelector(`button[data-fx="${fx}"]`);
      btn?.classList.toggle("is-on", amount > 0);
    }

    const slots = deck.cues.serialize();
    root.querySelectorAll("button[data-cue]").forEach((btn) => {
      const i = parseInt(btn.dataset.cue, 10);
      btn.classList.toggle("has-cue", slots[i] != null);
    });
    this.midi?.syncLeds?.();
  }

  _setBusy(idx, busy) {
    document.querySelector(`.deck[data-deck="${idx}"]`).style.opacity = busy ? "0.6" : "1";
  }

  _tick() {
    cancelAnimationFrame(this._rafToken);
    let coachTick = 0;
    const loop = (now) => {
      // Loop engines
      for (const d of this.decks) d.loops?.tick(now);
      for (let i = 0; i < this.waves.length; i++) {
        this.waves[i].draw();
        if (this.decks[i].isPlaying) this.refreshDeck(i);
      }
      this._drawVU();
      this._updateSetTimer();
      this._refreshMixerState();
      this.generative?.tick(now);
      this._refreshGenerativeUI();
      this.automix?.tick(now);
      if (this.coach && (++coachTick % 20 === 0)) this._updateCoach();
      this._rafToken = requestAnimationFrame(loop);
    };
    loop(0);
  }

  _updateCoach() {
    const adv = this.coach.current();
    const card = document.getElementById("coach");
    const msg = document.getElementById("coachMsg");
    msg.textContent = adv.msg;
    card.classList.remove("level-info", "level-prep", "level-act", "level-urgent");
    card.classList.add(`level-${adv.level}`);
  }

  _updateSetTimer() {
    const t = document.getElementById("setTimer");
    if (!t || !this.setStartedAt) return;
    const sec = Math.floor((Date.now() - this.setStartedAt) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    t.textContent = `⏱ ${m}:${String(s).padStart(2, "0")}`;
    if (this.engine.isRecording()) {
      t.classList.add("badge-on");
      t.style.color = "#ff5577";
      const rs = document.getElementById("recStatus");
      if (rs) {
        const recSec = Math.floor((Date.now() - (this.engine.recordingStarted || Date.now())) / 1000);
        const recMin = Math.floor(recSec / 60);
        const recRest = recSec - recMin * 60;
        rs.textContent = `REC ${recMin}:${String(recRest).padStart(2, "0")}`;
      }
    } else {
      t.classList.remove("badge-on");
      t.style.color = "";
    }
  }

  _refreshMixerState() {
    const el = document.getElementById("mixerState");
    if (!el || !this.engineReady) return;
    const x = this.engine.crossfader;
    const side = x < 0.42 ? "A" : (x > 0.58 ? "B" : "CENTER");
    const master = document.getElementById("masterVol")?.value || "1";
    el.textContent = `${side} M${Number(master).toFixed(2)}`;
  }

  _refreshGenerativeUI() {
    const gen = this.generative;
    if (!gen) return;
    const onBtn = document.getElementById("genOnBtn");
    const drumsBtn = document.getElementById("genDrumsBtn");
    const bassBtn = document.getElementById("genBassBtn");
    const fillBtn = document.getElementById("genFillBtn");
    const status = document.getElementById("genStatus");
    onBtn?.classList.toggle("is-active", gen.enabled);
    drumsBtn?.classList.toggle("is-active", gen.drumsOn);
    bassBtn?.classList.toggle("is-active", gen.bassOn && gen.isBassSafe());
    bassBtn?.classList.toggle("is-locked", gen.bassOn && !gen.isBassSafe());
    fillBtn?.classList.toggle("is-active", gen.isFillActive());
    if (status) status.textContent = gen.lastStatus;
  }

  _drawVU() {
    const c = document.querySelector('.vu-master canvas[data-canvas="vu"]');
    if (!c) return;
    const ctx = c.getContext("2d");
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const { rms, peak } = this.engine.getMasterLevels();
    const rmsH = Math.min(1, rms * 4) * h;
    const peakH = Math.min(1, peak * 2) * h;
    ctx.fillStyle = "#0a0d13"; ctx.fillRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0.0, "#4dffb1");
    grad.addColorStop(0.7, "#ffb84d");
    grad.addColorStop(1.0, "#ff5577");
    ctx.fillStyle = grad;
    ctx.fillRect(2, h - rmsH, w - 4, rmsH);
    ctx.fillStyle = "#fff";
    ctx.fillRect(2, h - peakH - 1, w - 4, 2);
  }
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec - m * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

window.djApp = new DJApp();
document.getElementById("connectBtn").addEventListener("click", async () => {
  const btn = document.getElementById("connectBtn");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    await window.djApp.start();
    btn.textContent = "Connected ✓";
    btn.classList.remove("primary");
  } catch (e) {
    console.error(e);
    btn.textContent = "Retry";
    btn.disabled = false;
  }
});

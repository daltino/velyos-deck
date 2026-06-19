// deck.js — Deck class: load track, play/pause/cue, EQ, vol, sync, FX, loops, stems
//
// Stem mode: when track has stems, we play 4 BufferSources simultaneously,
// each through its own Gain node (mute/solo) before the deck channel input.

class Deck {
  constructor(idx, engine) {
    this.idx = idx;
    this.engine = engine;
    this.channel = null;
    this.buffer = null;
    this.source = null;          // single-source mode
    this.stemSources = null;     // array of {src, gain} for stem mode
    this.isPlaying = false;
    this.startedAtCtx = 0;
    this.startedAtTrack = 0;
    this.cuePoint = 0;
    this.pitchPercent = 0;
    this.tempoRange = 50;
    this.keylock = false;
    this.vinylMode = true;
    this.track = null;
    this.cues = new HotCues(8);
    this.bpm = 0;
    this.cueListening = false;
    this.loops = null;           // attached after engine init
    this.stems = null;           // {vocals, drums, bass, other} buffers
    this.stemGains = [1, 1, 1, 1]; // per-stem gain levels
    this.beatOffset = 0;          // first downbeat in seconds (for grid alignment)
    this.volume = 1;
    this.trim = 1;
    this.filter = 0.5;
    this.eq = { low: 0, mid: 0, high: 0 };
    this.fx = { echo: 0, reverb: 0, gate: 0 };
    this.onChange = () => {};
    this.onEnded = () => {};
  }

  attach() {
    this.channel = this.engine.deckChannels[this.idx];
    this.loops = new LoopEngine(this);
  }

  // ----------------------------------------------------------------- LOAD
  async loadTrack(track) {
    this.stop(true);
    this.track = track;
    this.cues.clearAll();
    const other = window.djApp?.decks?.[1 - this.idx];
    const refBpm = other?.isPlaying ? other.effectiveBpm() : 0;
    this.bpm = window.DJUtils
      ? DJUtils.effectiveTrackBpm(track, refBpm)
      : (parseFloat(track.bpm) || 0);
    this.stems = null;
    this.beatOffset = 0;
    this.onChange();

    const resp = await fetch(track.url);
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    const arr = await resp.arrayBuffer();
    const buf = await this.engine.ctx.decodeAudioData(arr);
    this.buffer = buf;
    this.startedAtTrack = 0;
    this.cuePoint = 0;
    this._restoreCueMemory();
    this.onChange();
    return buf;
  }

  async loadStems(stemUrls) {
    if (!this.buffer) return false;
    const ctx = this.engine.ctx;
    try {
      const buffers = await Promise.all(
        ["vocals", "drums", "bass", "other"].map(async (name) => {
          const url = stemUrls[name];
          if (!url) throw new Error(`missing stem ${name}`);
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`fetch ${name}: ${resp.status}`);
          const arr = await resp.arrayBuffer();
          return [name, await ctx.decodeAudioData(arr)];
        })
      );
      this.stems = Object.fromEntries(buffers);
      return true;
    } catch (e) {
      console.error("loadStems:", e);
      return false;
    }
  }

  hasStems() { return !!this.stems; }

  setStemGain(stemIdx, value) {
    this.stemGains[stemIdx] = value;
    if (this.stemSources) {
      const ctx = this.engine.ctx;
      this.stemSources[stemIdx]?.gain.gain.setTargetAtTime(value, ctx.currentTime, 0.01);
    }
  }

  // ----------------------------------------------------------------- TRANSPORT
  play() {
    if (this.isPlaying) return;
    if (!this.buffer && !this.stems) return;
    const ctx = this.engine.ctx;

    if (this.stems) {
      // Stem mode — play 4 sources in sync
      const names = ["vocals", "drums", "bass", "other"];
      this.stemSources = names.map((name, i) => {
        const src = ctx.createBufferSource();
        src.buffer = this.stems[name];
        src.playbackRate.value = this._currentRate();
        const gain = ctx.createGain();
        gain.gain.value = this.stemGains[i];
        src.connect(gain);
        gain.connect(this.channel.input);
        src.start(0, this.startedAtTrack);
        return { src, gain };
      });
      this.stemSources[0].src.onended = () => {
        // any one ending = consider track ended (they're synced)
        if (this.stemSources && this.isPlaying) {
          this.isPlaying = false;
          this.startedAtTrack = this.duration();
          this.onChange();
          this.onEnded(this);
        }
      };
    } else {
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = this._currentRate();
      src.connect(this.channel.input);
      src.onended = () => {
        if (this.source === src && this.isPlaying) {
          this.isPlaying = false;
          this.startedAtTrack = this.buffer ? this.buffer.duration : 0;
          this.onChange();
          this.onEnded(this);
        }
      };
      src.start(0, this.startedAtTrack);
      this.source = src;
    }
    this.startedAtCtx = ctx.currentTime;
    this.isPlaying = true;
    this.onChange();
  }

  pause() {
    if (!this.isPlaying) return;
    const pos = this.position();
    this._stopSource();
    this.startedAtTrack = pos;
    this.isPlaying = false;
    this.onChange();
  }

  togglePlay() { this.isPlaying ? this.pause() : this.play(); }

  cue() {
    if (!this.buffer && !this.stems) return;
    if (this.isPlaying) {
      this._stopSource();
      this.startedAtTrack = this.cuePoint;
      this.isPlaying = false;
    } else {
      this.cuePoint = this.startedAtTrack;
      this._saveCueMemory();
    }
    this.onChange();
  }

  stop(resetCue = false) {
    this._stopSource();
    this.startedAtTrack = 0;
    this.isPlaying = false;
    if (resetCue) {
      this.cuePoint = 0;
    }
    this.onChange();
  }

  _stopSource() {
    if (this.source) {
      try { this.source.stop(); } catch (_) {}
      this.source.disconnect();
      this.source = null;
    }
    if (this.stemSources) {
      for (const s of this.stemSources) {
        try { s.src.stop(); } catch (_) {}
        s.src.disconnect();
        s.gain.disconnect();
      }
      this.stemSources = null;
    }
  }

  // ----------------------------------------------------------------- POSITION
  position() {
    if (!this.buffer && !this.stems) return 0;
    if (!this.isPlaying) return this.startedAtTrack;
    const elapsed = (this.engine.ctx.currentTime - this.startedAtCtx) * this._currentRate();
    return Math.min(this.duration(), this.startedAtTrack + elapsed);
  }

  duration() {
    if (this.stems) return this.stems.vocals.duration;
    return this.buffer ? this.buffer.duration : 0;
  }

  seek(seconds) {
    if (!this.buffer && !this.stems) return;
    const t = Math.max(0, Math.min(this.duration(), seconds));
    const wasPlaying = this.isPlaying;
    this._stopSource();
    this.startedAtTrack = t;
    this.isPlaying = false;
    if (wasPlaying) this.play();
    else this.onChange();
  }

  // ----------------------------------------------------------------- PITCH
  setPitchPercent(p) {
    this.pitchPercent = Math.max(-this.tempoRange, Math.min(this.tempoRange, p));
    const rate = this._currentRate();
    const t = this.engine.ctx.currentTime;
    if (this.source) this.source.playbackRate.setTargetAtTime(rate, t, 0.02);
    if (this.stemSources) for (const s of this.stemSources) {
      s.src.playbackRate.setTargetAtTime(rate, t, 0.02);
    }
    this.onChange();
  }

  _currentRate() { return 1 + this.pitchPercent / 100; }

  effectiveBpm() { return this.bpm * this._currentRate(); }

  cycleTempoRange() {
    const ranges = [8, 16, 50];
    const idx = ranges.indexOf(this.tempoRange);
    this.tempoRange = ranges[(idx + 1 + ranges.length) % ranges.length];
    this.setPitchPercent(this.pitchPercent);
  }

  // ----------------------------------------------------------------- SYNC
  syncTo(otherDeck, opts = {}) {
    if (!otherDeck.bpm || !this.bpm) return;
    const target = otherDeck.effectiveBpm();
    let pitch = ((target / this.bpm) - 1) * 100;
    if (opts.upOnly) pitch = Math.max(0, pitch);
    this.setPitchPercent(pitch);
  }

  // Phase nudge: try to align beat phase with otherDeck (assumes both BPMs match).
  // Uses beatOffset (first downbeat). If tracks have it, we can do better.
  phaseAlignTo(otherDeck) {
    if (!this.buffer || !otherDeck.buffer) return;
    const myBeatSec = 60 / this.effectiveBpm();
    const otherBeatSec = 60 / otherDeck.effectiveBpm();
    if (Math.abs(myBeatSec - otherBeatSec) > 0.005) return; // BPMs don't match
    // phase of other deck (relative to its first downbeat)
    const otherPhase = (otherDeck.position() - otherDeck.beatOffset) % otherBeatSec;
    const myPhase = (this.position() - this.beatOffset) % myBeatSec;
    const offset = otherPhase - myPhase;
    this.seek(this.position() + offset);
  }

  // ----------------------------------------------------------------- EQ / FILTER / VOL
  setEq(band, gainDb) {
    const ch = this.channel;
    const t = this.engine.ctx.currentTime;
    const filter = { low: ch.eqLow, mid: ch.eqMid, high: ch.eqHigh }[band];
    if (Object.prototype.hasOwnProperty.call(this.eq, band)) this.eq[band] = gainDb;
    if (filter) filter.gain.setTargetAtTime(gainDb, t, 0.005);
  }

  setFilter(value) {
    this.filter = Math.max(0, Math.min(1, value));
    this.engine.setDeckFilter(this.idx, value);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1.5, v));
    this.channel.vol.gain.setTargetAtTime(v, this.engine.ctx.currentTime, 0.005);
  }

  setTrim(v) {
    this.trim = Math.max(0, Math.min(2, v));
    this.channel.input.gain.setTargetAtTime(this.trim, this.engine.ctx.currentTime, 0.005);
  }

  jumpBeats(beats) {
    const bpm = this.effectiveBpm() || 120;
    this.seek(this.position() + beats * (60 / bpm));
  }

  // ----------------------------------------------------------------- FX
  setEcho(amount) {
    this.fx.echo = Math.max(0, Math.min(1, amount));
    this.engine.setEcho(this.idx, amount);
  }
  setReverb(amount) {
    this.fx.reverb = Math.max(0, Math.min(1, amount));
    this.engine.setReverb(this.idx, amount);
  }
  setGate(amount, hz) {
    this.fx.gate = Math.max(0, Math.min(1, amount));
    this.engine.setGate(this.idx, amount, hz);
  }

  // ----------------------------------------------------------------- CUE
  setCueListen(on) {
    this.cueListening = on;
    this.engine.setCue(this.idx, on);
    this.onChange();
  }

  // ----------------------------------------------------------------- HOT CUES
  hotCue(slot) {
    if (!this.buffer && !this.stems) return;
    const stored = this.cues.get(slot);
    if (stored == null) {
      this.cues.set(slot, this.position());
      this._saveCueMemory();
    } else {
      this.seek(stored);
      if (!this.isPlaying) this.play();
    }
    this.onChange();
  }
  clearCue(slot) {
    this.cues.clear(slot);
    this._saveCueMemory();
    this.onChange();
  }

  _storageKey() {
    if (!this.track?.id) return null;
    return `scdl.dj.cues.${this.track.id}`;
  }

  _restoreCueMemory() {
    const key = this._storageKey();
    if (!key) return;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const data = JSON.parse(raw);
      const duration = this.duration();
      if (Array.isArray(data.hotCues)) {
        this.cues.slots = data.hotCues.slice(0, 8).map((sec) => (
          Number.isFinite(sec) && sec >= 0 && sec <= duration ? sec : null
        ));
        while (this.cues.slots.length < 8) this.cues.slots.push(null);
      }
      if (Number.isFinite(data.cuePoint) && data.cuePoint >= 0 && data.cuePoint <= duration) {
        this.cuePoint = data.cuePoint;
        this.startedAtTrack = data.cuePoint;
      }
    } catch (e) {
      console.warn("Cue restore failed:", e);
    }
  }

  _saveCueMemory() {
    const key = this._storageKey();
    if (!key) return;
    try {
      window.localStorage.setItem(key, JSON.stringify({
        cuePoint: this.cuePoint,
        hotCues: this.cues.serialize(),
        updatedAt: Date.now(),
      }));
    } catch (e) {
      console.warn("Cue save failed:", e);
    }
  }
}

window.Deck = Deck;

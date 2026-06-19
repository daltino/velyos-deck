// generative.js — local Web Audio "third deck" inspired by Strudel-style patterns
class GenerativeDeck {
  constructor(app, engine) {
    this.app = app;
    this.engine = engine;
    this.channel = null;
    this.enabled = false;
    this.drumsOn = true;
    this.bassOn = false;
    this.intensity = 0.45;
    this.bpm = 120;
    this.syncedDeckIdx = null;
    this.nextStepTime = 0;
    this.nextStep = 0;
    this.scheduleAhead = 0.12;
    this.fillStartTime = 0;
    this.fillUntil = 0;
    this.fillRiserSource = null;
    this.noiseBuffer = null;
    this.lastStatus = "GEN idle";
  }

  attach() {
    this.channel = this.engine.createGenerativeChannel();
    this.noiseBuffer = this._makeNoiseBuffer(2);
    this.engine.setGenerativeGain(this._targetGain());
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.enabled) this._quantizeScheduler();
    else this._resetScheduler();
  }

  setDrums(on) {
    this.drumsOn = !!on;
  }

  setBass(on) {
    this.bassOn = !!on;
  }

  setIntensity(value) {
    this.intensity = Math.max(0, Math.min(1, value));
    this.engine.setGenerativeGain(this._targetGain());
  }

  triggerFill(durationSec = 8) {
    if (!this.channel) return;
    this._updateSync();
    const start = this._nextBeatTime();
    const duration = Math.max(1.5, Math.min(16, durationSec));
    this.fillStartTime = start;
    this.fillUntil = start + duration;
    this._scheduleRiser(start, duration);
  }

  stopFill() {
    this.fillStartTime = 0;
    this.fillUntil = 0;
    if (this.fillRiserSource) {
      try { this.fillRiserSource.stop(this.engine.ctx.currentTime + 0.02); } catch (_) {}
      this.fillRiserSource = null;
    }
    this.engine.resetGenerativeChannel();
    this.engine.setGenerativeGain(this._targetGain());
  }

  tick() {
    if (!this.channel) return;
    this._updateSync();
    const ctx = this.engine.ctx;
    const audible = this.enabled || this.isFillActive();
    if (!audible) {
      this.lastStatus = "GEN idle";
      return;
    }
    if (!this.nextStepTime || this.nextStepTime < ctx.currentTime - 0.05) {
      this._quantizeScheduler();
    }

    const stepSec = this._stepSec();
    while (this.nextStepTime < ctx.currentTime + this.scheduleAhead) {
      this._scheduleStep(this.nextStep, this.nextStepTime);
      this.nextStep = (this.nextStep + 1) % 16;
      this.nextStepTime += stepSec;
    }
    this.lastStatus = this._statusText();
  }

  isFillActive() {
    return this.engine.ctx && this.fillUntil > this.engine.ctx.currentTime;
  }

  isBassSafe() {
    const automix = this.app.automix;
    if (!automix?.active || automix.stage !== "mixing" || !automix.mix) return true;
    const out = this.app.decks[automix.mix.from];
    const incoming = this.app.decks[automix.mix.to];
    const outLowKilled = (out?.eq?.low ?? 0) <= -18;
    const inLowKilled = (incoming?.eq?.low ?? 0) <= -18;
    return outLowKilled || inLowKilled;
  }

  dominantDeck() {
    const [a, b] = this.app.decks;
    if (a?.isPlaying && !b?.isPlaying) return { deck: a, idx: 0 };
    if (b?.isPlaying && !a?.isPlaying) return { deck: b, idx: 1 };
    const idx = this.engine.crossfader < 0.5 ? 0 : 1;
    const deck = this.app.decks[idx]?.isPlaying ? this.app.decks[idx] : (a?.isPlaying ? a : b);
    return deck ? { deck, idx: deck.idx } : { deck: null, idx: null };
  }

  _scheduleStep(step, time) {
    const fill = this.fillStartTime > 0 && time >= this.fillStartTime && this.fillUntil > time;
    if (this.enabled && this.drumsOn) this._scheduleDrums(step, time, fill);
    if (this.enabled && this.bassOn && this.isBassSafe()) this._scheduleBass(step, time);
    if (fill) this._scheduleFillHits(step, time);
  }

  _scheduleDrums(step, time, fill) {
    const kickSteps = fill ? [0, 7, 10, 15] : [0, 10];
    const snareSteps = [4, 12];
    if (kickSteps.includes(step)) this._kick(time, step === 0 ? 1 : 0.72);
    if (snareSteps.includes(step)) this._snare(time, 0.75);
    if (step % 2 === 0 || Math.random() < this.intensity * 0.35) {
      this._hat(time, step % 2 === 0 ? 0.42 : 0.22);
    }
  }

  _scheduleBass(step, time) {
    const pattern = [0, null, 0, null, 3, null, 5, null, 0, null, 7, null, 5, null, 3, null];
    const note = pattern[step];
    if (note == null) return;
    const root = this._rootMidi();
    const freq = GenerativeDeck._midiToFreq(root + note);
    this._bass(time, freq, step % 8 === 0 ? 0.88 : 0.64);
  }

  _scheduleFillHits(step, time) {
    const remaining = Math.max(0, this.fillUntil - time);
    if (remaining < this._beatSec() * 4 && step % 2 === 1) this._snare(time, 0.35 + this.intensity * 0.3);
    if (remaining < this._beatSec() * 2) this._hat(time, 0.55);
  }

  _kick(time, velocity) {
    const ctx = this.engine.ctx;
    const out = ctx.createGain();
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(125, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.11);
    out.gain.setValueAtTime(0.0001, time);
    out.gain.exponentialRampToValueAtTime(0.86 * velocity, time + 0.008);
    out.gain.exponentialRampToValueAtTime(0.0001, time + 0.24);
    osc.connect(out);
    out.connect(this.channel.input);
    osc.start(time);
    osc.stop(time + 0.26);
  }

  _snare(time, velocity) {
    const ctx = this.engine.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 850;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.38 * velocity, time + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);
    noise.connect(hp);
    hp.connect(gain);
    gain.connect(this.channel.input);
    noise.start(time);
    noise.stop(time + 0.18);

    const tone = ctx.createOscillator();
    const toneGain = ctx.createGain();
    tone.type = "triangle";
    tone.frequency.value = 188;
    toneGain.gain.setValueAtTime(0.0001, time);
    toneGain.gain.exponentialRampToValueAtTime(0.18 * velocity, time + 0.006);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.09);
    tone.connect(toneGain);
    toneGain.connect(this.channel.input);
    tone.start(time);
    tone.stop(time + 0.1);
  }

  _hat(time, velocity) {
    const ctx = this.engine.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7200;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.15 * velocity, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
    noise.connect(hp);
    hp.connect(gain);
    gain.connect(this.channel.input);
    noise.start(time);
    noise.stop(time + 0.055);
  }

  _bass(time, freq, velocity) {
    const ctx = this.engine.ctx;
    const saw = ctx.createOscillator();
    const sub = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    saw.type = "sawtooth";
    sub.type = "sine";
    saw.frequency.value = freq;
    sub.frequency.value = freq * 0.5;
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(180 + this.intensity * 420, time);
    filter.Q.value = 0.8;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(0.2 * velocity, time + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + this._stepSec() * 1.7);
    saw.connect(filter);
    sub.connect(filter);
    filter.connect(gain);
    gain.connect(this.channel.input);
    saw.start(time);
    sub.start(time);
    saw.stop(time + this._stepSec() * 1.9);
    sub.stop(time + this._stepSec() * 1.9);
  }

  _scheduleRiser(start, duration) {
    this.stopFill();
    const ctx = this.engine.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(600, start);
    filter.frequency.exponentialRampToValueAtTime(8500, start + duration);
    filter.Q.setValueAtTime(0.8, start);
    filter.Q.linearRampToValueAtTime(4.5, start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.2 + this.intensity * 0.12, start + duration * 0.82);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.channel.input);
    noise.start(start);
    noise.stop(start + duration + 0.02);
    this.fillRiserSource = noise;
    this.fillStartTime = start;
    this.fillUntil = start + duration;
  }

  _quantizeScheduler() {
    this._updateSync();
    const start = this._nextBeatTime();
    const stepSec = this._stepSec();
    this.nextStepTime = start;
    this.nextStep = this._deckStepAtTime(start);
    if (!Number.isFinite(this.nextStep) || this.nextStep < 0) this.nextStep = 0;
    this.nextStep = Math.floor(this.nextStep) % 16;
    if (stepSec <= 0) this.nextStepTime = this.engine.ctx.currentTime;
  }

  _resetScheduler() {
    this.nextStepTime = 0;
    this.nextStep = 0;
  }

  _nextBeatTime() {
    const ctx = this.engine.ctx;
    const ref = this.dominantDeck();
    const deck = ref.deck;
    const beatSec = this._beatSec();
    if (!deck?.isPlaying || !beatSec) return ctx.currentTime + 0.04;
    const pos = deck.position();
    const phase = ((pos - (deck.beatOffset || 0)) % beatSec + beatSec) % beatSec;
    const untilBeat = phase < 0.02 ? 0 : beatSec - phase;
    return ctx.currentTime + untilBeat;
  }

  _deckStepAtTime(ctxTime) {
    const ref = this.dominantDeck();
    const deck = ref.deck;
    if (!deck?.isPlaying) return 0;
    const projected = deck.position() + Math.max(0, ctxTime - this.engine.ctx.currentTime);
    const step = Math.floor((projected - (deck.beatOffset || 0)) / this._stepSec());
    return ((step % 16) + 16) % 16;
  }

  _updateSync() {
    const ref = this.dominantDeck();
    this.syncedDeckIdx = ref.idx;
    const bpm = ref.deck?.effectiveBpm?.() || ref.deck?.bpm || this.bpm || 120;
    if (Number.isFinite(bpm) && bpm > 40 && bpm < 240) this.bpm = bpm;
  }

  _rootMidi() {
    const ref = this.dominantDeck();
    const camelot = ref.deck?.track?.camelot || "";
    const semitone = GenerativeDeck.CAMELOT_ROOTS[camelot.toUpperCase()] ?? 0;
    return 36 + semitone;
  }

  _targetGain() {
    return 0.12 + this.intensity * 0.24;
  }

  _beatSec() {
    return 60 / (this.bpm || 120);
  }

  _stepSec() {
    return this._beatSec() / 4;
  }

  _statusText() {
    const deck = this.syncedDeckIdx == null ? "--" : (this.syncedDeckIdx === 0 ? "A" : "B");
    if (this.isFillActive() && this.fillStartTime > this.engine.ctx.currentTime) {
      return `FILL armed ${Math.round(this.bpm)} BPM synced ${deck}`;
    }
    if (this.isFillActive()) return `FILL ${Math.round(this.bpm)} BPM synced ${deck}`;
    if (this.bassOn && !this.isBassSafe()) return `GEN ${Math.round(this.bpm)} BPM bass safe-off synced ${deck}`;
    return `GEN ${Math.round(this.bpm)} BPM synced ${deck}`;
  }

  _makeNoiseBuffer(durationSec) {
    const ctx = this.engine.ctx;
    const length = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  static _midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }
}

GenerativeDeck.CAMELOT_ROOTS = {
  "1A": 8, "2A": 3, "3A": 10, "4A": 5, "5A": 0, "6A": 7,
  "7A": 2, "8A": 9, "9A": 4, "10A": 11, "11A": 6, "12A": 1,
  "1B": 11, "2B": 6, "3B": 1, "4B": 8, "5B": 3, "6B": 10,
  "7B": 5, "8B": 0, "9B": 7, "10B": 2, "11B": 9, "12B": 4,
};

window.GenerativeDeck = GenerativeDeck;

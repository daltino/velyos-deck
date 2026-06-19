// audio.js — Web Audio mixer (master + crossfader + per-deck channels)
//
// Topology per deck:
//   sourceNode → vol → eqLow → eqMid → eqHigh → filter → fxIn → fxOut → xfaderGain → master
//                                                       ↓
//                                                 cueGain → cueDest (to second output)
// Master:
//   master → masterVol → recorderTap → analyser (VU) → masterGain → destination
//
// Cue (headphones) lives on a SECOND audio destination, picked via setSinkId
// on a MediaStreamAudioDestinationNode bridged to <audio> element.

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.masterVol = null;
    this.analyser = null;
    this.deckChannels = [];
    this.genChannel = null;
    this.crossfader = 0.5;
    this.useMediaOutput = AudioEngine._prefersMediaOutput();
    this.masterOutputDest = null;
    this.masterAudioEl = null;

    // Recording
    this.recorderTap = null;     // MediaStreamAudioDestinationNode
    this.recorder = null;
    this.recordedChunks = [];

    // Cue
    this.cueDest = null;         // MediaStreamAudioDestinationNode
    this.cueAudioEl = null;      // <audio> for setSinkId
    this.cueOutputDeviceId = null;
    this.headphoneVol = null;
    this.masterCueGain = null;
    this.masterCueOn = false;
  }

  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
      sampleRate: 48000,
    });
    if (this.ctx.state === "suspended") await this.ctx.resume();

    this.masterVol = this.ctx.createGain();
    this.masterVol.gain.value = 1.0;

    // Recorder tap (always recording route, recorder turns on/off)
    this.recorderTap = this.ctx.createMediaStreamDestination();

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.fft = this.ctx.createAnalyser();
    this.fft.fftSize = 2048;

    this.masterVol.connect(this.recorderTap);
    this.masterVol.connect(this.analyser);
    this.masterVol.connect(this.fft);
    this.analyser.connect(this.ctx.destination);
    if (this.useMediaOutput) {
      this.masterOutputDest = this.ctx.createMediaStreamDestination();
      this.masterAudioEl = new Audio();
      this.masterAudioEl.srcObject = this.masterOutputDest.stream;
      this.masterAudioEl.autoplay = true;
      this.masterAudioEl.playsInline = true;
      this.masterAudioEl.preload = "auto";
      this.analyser.connect(this.masterOutputDest);
    }

    this.master = this.masterVol;

    // Cue output (separate, NOT connected to main destination — only to its own MediaStream)
    this.cueDest = this.ctx.createMediaStreamDestination();
    this.headphoneVol = this.ctx.createGain();
    this.headphoneVol.gain.value = 1;
    this.masterCueGain = this.ctx.createGain();
    this.masterCueGain.gain.value = 0;
    this.masterVol.connect(this.masterCueGain);
    this.masterCueGain.connect(this.headphoneVol);
    this.headphoneVol.connect(this.cueDest);
    this.cueAudioEl = new Audio();
    this.cueAudioEl.srcObject = this.cueDest.stream;
    this.cueAudioEl.autoplay = true;
    this.cueAudioEl.playsInline = true;
    // Default: route to default device. setCueOutputDevice() can change this.

    // 2 decks
    for (let i = 0; i < 2; i++) {
      this.deckChannels.push(this._buildDeckChannel());
    }
    this._applyCrossfader();
    await this.ensureRunning();
  }

  async ensureRunning() {
    if (this.ctx?.state === "suspended") {
      await this.ctx.resume();
    }
    for (const el of [this.masterAudioEl, this.cueAudioEl]) {
      if (!el) continue;
      try {
        const p = el.play();
        if (p && typeof p.then === "function") await p;
      } catch (_) {
        // iOS may reject until the next direct user gesture; app.js retries on taps.
      }
    }
  }

  static _prefersMediaOutput() {
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    const touchMac = platform === "MacIntel" && navigator.maxTouchPoints > 1;
    return /iPad|iPhone|iPod/.test(ua) || touchMac;
  }

  _buildDeckChannel() {
    const c = this.ctx;
    const input = c.createGain();
    input.gain.value = 1;
    const vol = c.createGain();
    vol.gain.value = 1;

    const eqLow = c.createBiquadFilter();
    eqLow.type = "lowshelf"; eqLow.frequency.value = 320; eqLow.gain.value = 0;

    const eqMid = c.createBiquadFilter();
    eqMid.type = "peaking"; eqMid.frequency.value = 1000;
    eqMid.Q.value = 1.0; eqMid.gain.value = 0;

    const eqHigh = c.createBiquadFilter();
    eqHigh.type = "highshelf"; eqHigh.frequency.value = 3200; eqHigh.gain.value = 0;

    // Filter knob (LP/HP sweep). Two filters in series, mixed via gain.
    // Implementation: single filter that morphs between LP and HP.
    // We use a single biquad; type swaps based on slider sign.
    const filter = c.createBiquadFilter();
    filter.type = "allpass";   // = bypass when neutral
    filter.frequency.value = 350;
    filter.Q.value = 0.7;

    // FX send/insert: dry path + 2 wet returns (echo, reverb)
    const fxIn = c.createGain();
    const fxDry = c.createGain(); fxDry.gain.value = 1;
    const fxOut = c.createGain();

    // Echo (delay + feedback)
    const echo = this._makeEcho(c);
    const echoSend = c.createGain(); echoSend.gain.value = 0;

    // Reverb (convolver with synth IR)
    const reverb = this._makeReverb(c);
    const reverbSend = c.createGain(); reverbSend.gain.value = 0;

    // Gate (LFO-modulated gain) — used as beatmasher
    const gate = c.createGain(); gate.gain.value = 1;
    const gateLFO = c.createOscillator();
    const gateLFOgain = c.createGain(); gateLFOgain.gain.value = 0;
    gateLFO.frequency.value = 4;     // Hz
    gateLFO.connect(gateLFOgain);
    gateLFOgain.connect(gate.gain);
    gateLFO.start();

    // Crossfader
    const xfader = c.createGain(); xfader.gain.value = 1;

    // Cue tap
    const cueGain = c.createGain(); cueGain.gain.value = 0;

    // ---- WIRE ----
    input.connect(vol);
    vol.connect(eqLow);
    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(filter);
    filter.connect(fxIn);

    // FX parallel (dry + sends)
    fxIn.connect(fxDry); fxDry.connect(fxOut);
    fxIn.connect(echoSend); echoSend.connect(echo.input);
    echo.output.connect(fxOut);
    fxIn.connect(reverbSend); reverbSend.connect(reverb.input);
    reverb.output.connect(fxOut);

    // After FX: gate → xfader → master
    fxOut.connect(gate);
    gate.connect(xfader);
    xfader.connect(this.master);

    // Cue: tap from gate (post-EQ, post-FX) to cue output, independent of xfader
    gate.connect(cueGain);
    cueGain.connect(this.headphoneVol);

    return {
      input, vol, eqLow, eqMid, eqHigh, filter,
      fxIn, fxDry, fxOut, echo, echoSend, reverb, reverbSend,
      gate, gateLFO, gateLFOgain,
      xfader, cueGain,
    };
  }

  createGenerativeChannel() {
    if (this.genChannel) return this.genChannel;
    const c = this.ctx;
    const input = c.createGain();
    input.gain.value = 1;

    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 16000;
    filter.Q.value = 0.45;

    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -18;
    limiter.knee.value = 8;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.08;

    const gain = c.createGain();
    gain.gain.value = 0.16;

    input.connect(filter);
    filter.connect(limiter);
    limiter.connect(gain);
    gain.connect(this.master);

    this.genChannel = { input, filter, limiter, gain };
    return this.genChannel;
  }

  setGenerativeGain(value) {
    const ch = this.genChannel || this.createGenerativeChannel();
    const v = Math.max(0, Math.min(0.42, value));
    ch.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  resetGenerativeChannel() {
    if (!this.genChannel) return;
    const t = this.ctx.currentTime;
    this.genChannel.gain.gain.setTargetAtTime(0.16, t, 0.02);
    this.genChannel.filter.type = "lowpass";
    this.genChannel.filter.frequency.setTargetAtTime(16000, t, 0.02);
    this.genChannel.filter.Q.setTargetAtTime(0.45, t, 0.02);
  }

  // ---- FX helpers
  _makeEcho(c) {
    const input = c.createGain();
    const delay = c.createDelay(2.0);
    delay.delayTime.value = 0.375;          // 3/8 of beat at 120 BPM ≈ 0.375s
    const feedback = c.createGain(); feedback.gain.value = 0.4;
    const output = c.createGain();
    const wet = c.createGain(); wet.gain.value = 1;
    input.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(output);
    return { input, output, delay, feedback };
  }

  _makeReverb(c) {
    const input = c.createGain();
    const conv = c.createConvolver();
    conv.buffer = this._makeReverbIR(c, 2.5, 2.0);
    const output = c.createGain();
    const wet = c.createGain(); wet.gain.value = 1;
    input.connect(conv);
    conv.connect(wet);
    wet.connect(output);
    return { input, output, conv };
  }

  // synthesize an exponentially-decaying noise impulse response
  _makeReverbIR(c, durationSec, decay) {
    const sr = c.sampleRate;
    const length = Math.floor(sr * durationSec);
    const ir = c.createBuffer(2, length, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return ir;
  }

  // ---- Filter knob: 0..1, 0.5 = neutral, <0.5 = LP, >0.5 = HP
  setDeckFilter(deckIdx, value) {
    const ch = this.deckChannels[deckIdx];
    if (!ch) return;
    const t = this.ctx.currentTime;
    const v = Math.max(0, Math.min(1, value));
    if (Math.abs(v - 0.5) < 0.02) {
      ch.filter.type = "allpass";
      ch.filter.frequency.setTargetAtTime(350, t, 0.005);
    } else if (v < 0.5) {
      // LP: 20kHz at 0.48 → 60Hz at 0.0
      const norm = (0.5 - v) / 0.5;     // 0..1
      const freq = 20000 * Math.pow(0.003, norm);  // log curve to ~60Hz
      ch.filter.type = "lowpass";
      ch.filter.frequency.setTargetAtTime(freq, t, 0.005);
    } else {
      const norm = (v - 0.5) / 0.5;
      const freq = 30 * Math.pow(700, norm);  // 30Hz → 21kHz
      ch.filter.type = "highpass";
      ch.filter.frequency.setTargetAtTime(freq, t, 0.005);
    }
  }

  // ---- FX setters (per deck)
  setEcho(deckIdx, amount) {
    const ch = this.deckChannels[deckIdx];
    if (!ch) return;
    ch.echoSend.gain.setTargetAtTime(amount, this.ctx.currentTime, 0.01);
  }
  setReverb(deckIdx, amount) {
    const ch = this.deckChannels[deckIdx];
    if (!ch) return;
    ch.reverbSend.gain.setTargetAtTime(amount, this.ctx.currentTime, 0.01);
  }
  setGate(deckIdx, amount, hz) {
    // Beatmasher / chop. amount 0..1, hz = chop speed.
    const ch = this.deckChannels[deckIdx];
    if (!ch) return;
    ch.gateLFOgain.gain.setTargetAtTime(amount, this.ctx.currentTime, 0.01);
    if (hz != null) ch.gateLFO.frequency.setTargetAtTime(hz, this.ctx.currentTime, 0.01);
  }
  setEchoTime(seconds) {
    for (const ch of this.deckChannels) {
      ch.echo.delay.delayTime.setTargetAtTime(seconds, this.ctx.currentTime, 0.01);
    }
  }

  // ---- CUE
  setCue(deckIdx, on) {
    const ch = this.deckChannels[deckIdx];
    if (!ch) return;
    ch.cueGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  setHeadphoneVolume(v) {
    if (!this.headphoneVol) return;
    this.headphoneVol.gain.setTargetAtTime(Math.max(0, Math.min(1.5, v)), this.ctx.currentTime, 0.01);
  }

  setMasterCue(on) {
    this.masterCueOn = !!on;
    if (!this.masterCueGain) return;
    this.masterCueGain.gain.setTargetAtTime(this.masterCueOn ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  async setCueOutputDevice(deviceId) {
    if (!this.cueAudioEl || !this.cueAudioEl.setSinkId) return false;
    try {
      await this.cueAudioEl.setSinkId(deviceId);
      this.cueOutputDeviceId = deviceId;
      return true;
    } catch (e) {
      console.error("setSinkId failed:", e);
      return false;
    }
  }

  async listOutputDevices() {
    try {
      // Permission gating: enumerateDevices labels are masked until mic permission
      // — not always needed for playback devices but Chrome requires user gesture.
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === "audiooutput");
    } catch (e) {
      return [];
    }
  }

  // ---- Crossfader
  setCrossfader(v) {
    this.crossfader = Math.max(0, Math.min(1, v));
    this._applyCrossfader();
  }
  _applyCrossfader() {
    if (!this.deckChannels.length) return;
    const t = this.crossfader;
    const a = Math.cos(t * Math.PI / 2);
    const b = Math.sin(t * Math.PI / 2);
    this.deckChannels[0].xfader.gain.setTargetAtTime(a, this.ctx.currentTime, 0.005);
    this.deckChannels[1].xfader.gain.setTargetAtTime(b, this.ctx.currentTime, 0.005);
  }

  setMasterVolume(v) {
    this.masterVol.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  // ---- Master meters
  getMasterLevels() {
    if (!this.analyser) return { rms: 0, peak: 0 };
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0, peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]);
      sum += v * v;
      if (v > peak) peak = v;
    }
    return { rms: Math.sqrt(sum / buf.length), peak };
  }

  getFFT() {
    if (!this.fft) return null;
    const buf = new Uint8Array(this.fft.frequencyBinCount);
    this.fft.getByteFrequencyData(buf);
    return buf;
  }

  // ---- RECORDING
  startRecording() {
    if (this.recorder && this.recorder.state === "recording") return;
    this.recordedChunks = [];
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    this.recorder = new MediaRecorder(this.recorderTap.stream, {
      mimeType: mime, audioBitsPerSecond: 320000,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.recordedChunks.push(e.data);
    };
    this.recorder.start(1000);
    this.recordingStarted = Date.now();
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === "inactive") {
        resolve(null); return;
      }
      this.recorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: "audio/webm" });
        const dur = (Date.now() - this.recordingStarted) / 1000;
        resolve({ blob, durationSec: dur });
      };
      this.recorder.stop();
    });
  }

  isRecording() { return this.recorder && this.recorder.state === "recording"; }
}

window.AudioEngine = AudioEngine;

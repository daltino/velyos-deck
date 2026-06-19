// midi.js — native/WebMIDI bootstrap, dispatch DDJ-SB3 messages to app
class MidiBridge {
  constructor(app, statusEl) {
    this.app = app;
    this.statusEl = statusEl;
    this.access = null;
    this.input = null;
    this.output = null;
    this.ws = null;
    this.mode = "off";
    this.nativeSelected = null;
    this.state = { cc14: new CC14Reassembler() };
    this.lastLedState = "";
    this.lastLoad = { deck: -1, at: 0 };
    this.fxActive = [
      [false, false, false],
      [false, false, false],
    ];
    this.fxLevels = [
      [0.35, 0.35, 0.35],
      [0.35, 0.35, 0.35],
    ];
  }

  async connect() {
    const nativeStarted = await this._connectNative();
    if (nativeStarted) return true;
    return this._connectWebMidi();
  }

  async _connectNative() {
    let runtime = null;
    try {
      const resp = await fetch("/runtime.json", { cache: "no-store" });
      if (resp.ok) runtime = await resp.json();
    } catch (_) {
      return false;
    }
    if (!runtime?.midi_ws_url) {
      if (runtime?.native_midi_error) {
        console.info("Native MIDI helper unavailable:", runtime.native_midi_error);
      }
      return false;
    }

    try {
      const ws = new WebSocket(runtime.midi_ws_url);
      this.ws = ws;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native MIDI timeout")), 2000);
        ws.addEventListener("open", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("Native MIDI socket error"));
        }, { once: true });
      });
      this.mode = "native";
      ws.addEventListener("message", (ev) => this._onNativeMessage(ev));
      ws.addEventListener("close", () => {
        if (this.mode === "native") {
          this.mode = "off";
          this._setStatus("Native MIDI helper off", false);
          this._connectWebMidi();
        }
      });
      return true;
    } catch (e) {
      console.warn("Native MIDI bridge failed:", e);
      this.ws = null;
      this.mode = "off";
      return false;
    }
  }

  _onNativeMessage(ev) {
    let msg = null;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    if (msg.type === "ready") {
      this.nativeSelected = msg.selected;
      if (!msg.selected) {
        this._setStatus("DDJ-SB3 není v CoreMIDI", false);
      }
      return;
    }
    if (msg.type === "device") {
      if (msg.connected) {
        this.nativeSelected = { input: msg.input, output: msg.output };
        this._setStatus(`NATIVE ${msg.input}`, true);
        this.syncLeds();
      } else {
        this.nativeSelected = null;
        this._setStatus("DDJ-SB3 není v CoreMIDI", false);
      }
      return;
    }
    if (msg.type === "midi" && Array.isArray(msg.data)) {
      this._onBytes(msg.data);
    }
  }

  async _connectWebMidi() {
    if (!navigator.requestMIDIAccess) {
      this._setStatus("WebMIDI nepodporován v tomhle prohlížeči", false);
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this._setStatus("MIDI permission odmítnuto", false);
      return false;
    }
    this.mode = "webmidi";
    this._scanWebMidi();
    this.access.onstatechange = () => this._scanWebMidi();
    return true;
  }

  _scanWebMidi() {
    const foundInput = this._findSB3Port([...this.access.inputs.values()]);
    const foundOutput = this._findSB3Port([...this.access.outputs.values()]);
    if (this.input && this.input !== foundInput) {
      this.input.onmidimessage = null;
    }
    this.input = foundInput;
    this.output = foundOutput;
    if (this.input) {
      this.input.onmidimessage = (m) => this._onBytes([...m.data]);
      this._setStatus(`WEBMIDI ${this.input.name}`, true);
      this.syncLeds();
    } else {
      this._setStatus("No DDJ-SB3 controller", false);
    }
  }

  _findSB3Port(ports) {
    return ports.find((port) => {
      const name = (port.name || "").toLowerCase();
      return name.includes("ddj-sb3") ||
        name.includes("ddj sb3") ||
        name.includes("pioneer dj");
    }) || null;
  }

  _onBytes(bytes) {
    const actions = translateSB3(bytes, this.state);
    for (const a of actions) this._dispatch(a);
    if (actions.length) this.syncLeds();
  }

  _dispatch(a) {
    const app = this.app;
    if (!app || !app.engineReady) return;
    const deck = (a.deck != null) ? app.decks[a.deck] : null;
    switch (a.action) {
      case "play":          deck && deck.togglePlay(); break;
      case "cue":           if (a.pressed) deck && deck.cue(); break;
      case "sync":          if (deck) { deck.syncTo(app.decks[1 - a.deck]); deck.phaseAlignTo(app.decks[1 - a.deck]); } break;
      case "syncOff":       deck && deck.setPitchPercent(0); break;
      case "startStop":     if (deck) { deck.seek(0); deck.togglePlay(); } break;
      case "jumpStart":     deck && deck.seek(0); break;
      case "keylock":       deck && (deck.keylock = !deck.keylock); break;
      case "tempoRange":    deck && deck.cycleTempoRange?.(); break;
      case "vinyl":         deck && (deck.vinylMode = a.on); break;
      case "slip": {
        if (deck?.loops) deck.loops.setSlip(!deck.loops.slip);
        app.refreshDeck(a.deck);
        break;
      }
      case "tempo": {
        const range = deck?.tempoRange || 50;
        const pct = (a.value - 0.5) * range * 2;
        deck && deck.setPitchPercent(pct);
        app.refreshDeck(a.deck);
        break;
      }
      case "tempoFine": {
        const base = deck?.pitchPercent || 0;
        deck && deck.setPitchPercent(base + (a.value - 0.5) * 2);
        app.refreshDeck(a.deck);
        break;
      }
      case "volume": {
        deck && deck.setVolume(a.value * 1.5);
        app.refreshDeck(a.deck);
        break;
      }
      case "trim": {
        deck && deck.setTrim?.(a.value * 2);
        app.refreshDeck(a.deck);
        break;
      }
      case "filter": {
        deck && deck.setFilter(a.value);
        const root = document.querySelector(`.deck[data-deck="${a.deck}"]`);
        const sl = root?.querySelector('input[data-control="filter"]');
        if (sl) sl.value = a.value;
        break;
      }
      case "gain": {
        deck && deck.setVolume(0.25 + a.value * 1.5);
        break;
      }
      case "eqHigh":
      case "eqMid":
      case "eqLow": {
        const band = a.action.slice(2).toLowerCase();
        const dB = (a.value - 0.5) * 52;
        deck && deck.setEq(band, dB);
        app.refreshDeck(a.deck);
        break;
      }
      case "crossfader": {
        app.engine.setCrossfader(a.value);
        document.getElementById("xfader").value = a.value;
        app._refreshMixerState?.();
        break;
      }
      case "masterVolume": {
        app.engine.setMasterVolume(a.value * 1.5);
        const sl = document.getElementById("masterVol");
        if (sl) sl.value = a.value * 1.5;
        app._refreshMixerState?.();
        break;
      }
      case "headphonesVolume": {
        app.engine.setHeadphoneVolume?.(a.value * 1.5);
        break;
      }
      case "jog": {
        if (deck && (deck.buffer || deck.stems)) {
          const scale = a.mode === "search" ? 0.22 : (deck.vinylMode === false ? 0.025 : 0.01);
          deck.seek(deck.position() + a.delta * scale);
        }
        break;
      }
      case "jogTouch":
        break;
      case "cueListen": {
        deck && deck.setCueListen(!deck.cueListening);
        break;
      }
      case "cueListenOff": {
        deck && deck.setCueListen(false);
        break;
      }
      case "masterCue": {
        app.engine.setMasterCue?.(!app.engine.masterCueOn);
        break;
      }
      case "allCueOff": {
        app.decks.forEach((d) => d.setCueListen(false));
        app.engine.setMasterCue?.(false);
        break;
      }
      case "autoLoop": {
        deck?.loops?.loopN(4);
        app._refreshLoopUI?.(a.deck);
        break;
      }
      case "reloopExit": {
        if (deck?.loops?.active) deck.loops.exit();
        else deck?.loops?.toggle();
        app._refreshLoopUI?.(a.deck);
        break;
      }
      case "loopHalf": {
        deck?.loops?.halve();
        app._refreshLoopUI?.(a.deck);
        break;
      }
      case "loopDouble": {
        deck?.loops?.doubleLen();
        app._refreshLoopUI?.(a.deck);
        break;
      }
      case "loopIn": {
        deck?.loops?.setIn();
        app._refreshLoopUI?.(a.deck);
        break;
      }
      case "loopOut": {
        deck?.loops?.setOut();
        app._refreshLoopUI?.(a.deck);
        break;
      }
      case "padMode": {
        app.setPadMode?.(a.deck, a.mode);
        break;
      }
      case "pad": {
        this._dispatchPad(a);
        break;
      }
      case "fxButton":
      case "fxShiftButton":
      case "fxLevel":
      case "fxLevelAll": {
        this._dispatchFx(a);
        break;
      }
      case "browse": {
        app.library?.moveSelection(a.delta * (a.fast ? 5 : 1));
        break;
      }
      case "browserPress": {
        app.library?.cycleView(1);
        break;
      }
      case "browserBack": {
        app.library?.cycleView(-1);
        break;
      }
      case "loadSelected": {
        this._loadSelected(a.deck);
        break;
      }
      case "sortLibrary": {
        app.library?.sortBy(a.key);
        break;
      }
      case "deckLayerIgnored":
      case "shift":
        break;
    }
  }

  _loadSelected(deckIdx) {
    const app = this.app;
    const now = performance.now();
    const selected = app.library?.selectedTrack?.();
    if (!selected) return;
    if (this.lastLoad.deck === deckIdx && now - this.lastLoad.at < 500) {
      const other = app.decks[1 - deckIdx]?.track;
      if (other) app.loadTrackToDeck(other, deckIdx);
    } else {
      app.library.loadSelected(deckIdx);
    }
    this.lastLoad = { deck: deckIdx, at: now };
  }

  _dispatchPad(a) {
    const app = this.app;
    const deck = app.decks[a.deck];
    if (!deck) return;
    if (!a.pressed) {
      if (a.mode === "roll") {
        deck.loops?.exit();
        app._refreshLoopUI?.(a.deck);
      }
      return;
    }
    const jumps = [-16, -8, -4, -1, 1, 4, 8, 16];
    const rolls = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4];
    const scratch = [-4, -2, -1, -0.5, 0.5, 1, 2, 4];
    switch (a.mode) {
      case "hotCue":
        if (a.shifted) deck.clearCue(a.slot);
        else deck.hotCue(a.slot);
        break;
      case "beatJump":
        deck.jumpBeats?.(jumps[a.slot]);
        break;
      case "roll":
        deck.loops?.loopN(rolls[a.slot]);
        deck.loops?.setSlip(true);
        app._refreshLoopUI?.(a.deck);
        break;
      case "fxFade":
        this._runPadMacro(deck, a.deck, a.slot);
        break;
      case "padScratch":
        deck.seek(deck.position() + scratch[a.slot]);
        break;
      case "sampler":
        app.generative?.triggerPad?.(a.slot);
        break;
      case "slicer":
        deck.jumpBeats?.(a.slot - 3);
        break;
      case "trans":
        deck.setGate(a.slot % 2 ? 0.7 : 0.35, (deck.effectiveBpm() || 120) / 60 * (a.slot + 1));
        setTimeout(() => deck.setGate(0, 1), 180);
        break;
    }
    app.refreshDeck(a.deck);
  }

  _runPadMacro(deck, deckIdx, slot) {
    const app = this.app;
    const filters = [0.18, 0.28, 0.38, 0.48, 0.52, 0.62, 0.72, 0.82];
    deck.setFilter(filters[slot]);
    if (slot >= 4) deck.loops?.loopN([0.25, 0.5, 1, 2][slot - 4]);
    setTimeout(() => {
      deck.setFilter(0.5);
      if (slot >= 4) deck.loops?.exit();
      app.refreshDeck(deckIdx);
    }, 320);
  }

  _dispatchFx(a) {
    const app = this.app;
    const deck = app.decks[a.deck];
    if (!deck) return;
    const names = ["echo", "reverb", "gate"];
    if (a.action === "fxButton" && a.pressed) {
      this.fxActive[a.deck][a.fx] = !this.fxActive[a.deck][a.fx];
    }
    if (a.action === "fxShiftButton" && a.pressed) {
      this.fxActive[a.deck][a.fx] = false;
      this.fxLevels[a.deck][a.fx] = 0;
    }
    if (a.action === "fxLevel") {
      this.fxLevels[a.deck][a.fx] = a.value;
      this.fxActive[a.deck][a.fx] = a.value > 0.02;
    }
    if (a.action === "fxLevelAll") {
      for (let i = 0; i < 3; i++) this.fxLevels[a.deck][i] = a.value;
    }
    for (let i = 0; i < 3; i++) {
      const amount = this.fxActive[a.deck][i] ? this.fxLevels[a.deck][i] : 0;
      app._applyFx(deck, names[i], amount);
    }
    app.refreshDeck(a.deck);
  }

  syncLeds() {
    const app = this.app;
    if (!app?.engineReady) return;
    const messages = [];
    const ledState = [];
    for (let deckIdx = 0; deckIdx < 2; deckIdx++) {
      const deck = app.decks[deckIdx];
      const status = 0x90 + deckIdx;
      this._pushLed(messages, ledState, status, SB3.PLAY, deck.isPlaying);
      this._pushLed(messages, ledState, status, SB3.CUE, !!(deck.buffer || deck.stems));
      this._pushLed(messages, ledState, status, SB3.SYNC, !!deck.bpm);
      this._pushLed(messages, ledState, status, SB3.KEYLOCK, !!deck.keylock);
      this._pushLed(messages, ledState, status, SB3.VINYL, deck.vinylMode !== false);
      this._pushLed(messages, ledState, status, SB3.AUTO_LOOP, !!deck.loops?.active);
      this._pushLed(messages, ledState, status, SB3.CUE_HEADPHONE, !!deck.cueListening);

      const fxStatus = 0x94 + deckIdx;
      for (let i = 0; i < 3; i++) {
        this._pushLed(messages, ledState, fxStatus, SB3.FX_BUTTONS[i], this.fxActive[deckIdx][i]);
      }

      const padStatus = 0x97 + deckIdx;
      const slots = deck.cues.serialize();
      for (let slot = 0; slot < 8; slot++) {
        const mode = this.state.padModes?.[deckIdx] || "hotCue";
        const base = SB3.PAD_BASES[mode] ?? SB3.PAD_BASES.hotCue;
        const on = mode === "hotCue" ? slots[slot] != null : true;
        this._pushLed(messages, ledState, padStatus, base + slot, on);
      }
    }
    this._pushLed(messages, ledState, 0x96, SB3.LOAD_A, !!app.library?.selectedTrack?.());
    this._pushLed(messages, ledState, 0x96, SB3.LOAD_B, !!app.library?.selectedTrack?.());
    this._pushLed(messages, ledState, 0x96, SB3.MASTER_CUE, !!app.engine.masterCueOn);

    const stateKey = ledState.join("|");
    if (stateKey === this.lastLedState) return;
    this.lastLedState = stateKey;
    for (const msg of messages) this._sendMidi(msg);
  }

  _pushLed(messages, ledState, status, note, on) {
    const velocity = on ? 0x7F : 0x00;
    messages.push([status, note, velocity]);
    ledState.push(`${status}:${note}:${velocity}`);
  }

  _sendMidi(data) {
    if (this.mode === "native" && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "send", data }));
      return;
    }
    if (this.mode === "webmidi" && this.output) {
      this.output.send(data);
    }
  }

  _setStatus(text, ok) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("badge-on", !!ok);
    this.statusEl.classList.toggle("badge-off", !ok);
  }
}

window.MidiBridge = MidiBridge;

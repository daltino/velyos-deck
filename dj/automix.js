// automix.js — performance AutoMix for the PREP queue
class TransitionPlan {
  constructor({
    cfg,
    recipe,
    startAt,
    targetMoment = null,
    mixDuration,
    outIdx,
    inIdx,
    cueStart = 0,
    targetInSec = 0,
    anchor = "timed",
    fallback = false,
    status = "fallback: timed mix",
    autoPick = false,
    events = [],
    mixType = "safe",
    creativeScore = 0,
    layeringPlan = null,
    why = "",
    outGate = null,
  }) {
    this.cfg = cfg;
    this.recipe = recipe;
    this.startAt = startAt;
    this.targetMoment = targetMoment;
    this.mixDuration = mixDuration;
    this.outIdx = outIdx;
    this.inIdx = inIdx;
    this.cueStart = cueStart;
    this.targetInSec = targetInSec;
    this.anchor = anchor;
    this.fallback = fallback;
    this.status = status;
    this.autoPick = autoPick;
    this.events = events;
    this.mixType = mixType;
    this.creativeScore = creativeScore;
    this.layeringPlan = layeringPlan;
    this.why = why;
    this.outGate = outGate;
    this.flags = {
      cueSet: false,
      loop: false,
      roll: false,
      release: false,
      echo: false,
      gate: false,
      reverb: false,
    };
  }
}

class AutoMixer {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.queue = [];
    this.playedIds = new Set();
    this.playedHistory = [];
    this.skippedIds = new Set();
    this.stage = "idle";
    this.outIdx = 0;
    this.inIdx = 1;
    this.nextTrack = null;
    this.nextTrackAutoPick = false;
    this.busy = false;
    this.mix = null;
    this.plan = null;
    this.lastEnergyBoost = false;
    this.lastMessage = "";
    this.lastTickAt = 0;
    this.usingLibraryFallback = false;
    this.creativeCooldownRemaining = 0;
  }

  async start() {
    if (this.active || this.busy) return;
    this.queue = this._getCandidateTracks(null).tracks;
    this.skippedIds.clear();
    if (!this.queue.length) {
      this._status("Add tracks to the library first");
      this._clearTimeline();
      return;
    }

    this.active = true;
    this.stage = "prepare";
    this._setButton(true);

    const playingIdx = this._playingDeckIndex();
    if (playingIdx == null) {
      const firstPick = this._getCandidateTracks(null);
      const first = firstPick.tracks[0];
      this.nextTrackAutoPick = firstPick.autoPick;
      await this._loadToDeck(first, 0);
      this.outIdx = 0;
      this.inIdx = 1;
      this.app._setCrossfader(0);
      this.app.decks[0].setVolume(1);
      this.app.decks[0].play();
      this._rememberPlayed(first.id);
      this.app.library.removeFromPrepare(first.id);
    } else {
      this.outIdx = playingIdx;
      this.inIdx = 1 - playingIdx;
      const currentId = this.app.decks[playingIdx].track?.id;
      if (currentId) this._rememberPlayed(currentId);
      this.queue = this.queue.filter((t) => t.id !== currentId);
    }

    await this._prepareNext();
    this.stage = this.nextTrack ? "waiting" : "done";
    this._status(this.nextTrack ? this._waitingStatus() : "AutoMix queue done");
    this._renderTimeline();
  }

  stop() {
    this.active = false;
    this.busy = false;
    this.stage = "idle";
    this.mix = null;
    this.plan = null;
    this.nextTrack = null;
    this.nextTrackAutoPick = false;
    this._resetAllPerformance();
    this.app.generative?.stopFill();
    this._setButton(false);
    this._status("AutoMix off");
    this._clearTimeline();
  }

  async skip() {
    if (!this.active || this.busy) return;
    if (this.nextTrack?.id) this.skippedIds.add(this.nextTrack.id);
    this.nextTrack = null;
    this.nextTrackAutoPick = false;
    this.plan = null;
    await this._prepareNext(true);
    this.stage = this.nextTrack ? "waiting" : "done";
    this._status(this.nextTrack ? this._waitingStatus() : "AutoMix queue done");
    this._renderTimeline();
  }

  async modeChanged() {
    const cfg = this._modeConfig();
    if (!this.active || this.busy || this.stage === "mixing") {
      this._status(`Mode: ${cfg.label}`);
      if (!this.active) this._clearTimeline();
      return;
    }
    if (this.nextTrack && this.app.decks[this.inIdx]?.buffer) {
      this._recalculatePlan();
      this._prepareIncomingForPlan();
    } else {
      this.nextTrack = null;
      this.plan = null;
      await this._prepareNext(true);
    }
    this.stage = this.nextTrack ? "waiting" : "done";
    this._status(this.nextTrack ? this._waitingStatus() : "AutoMix queue done");
    this._renderTimeline();
  }

  tick(now = performance.now()) {
    if (!this.active || this.busy) return;
    if (now - this.lastTickAt < 120) return;
    this.lastTickAt = now;

    if (this.stage === "waiting") this._maybeStartMix();
    if (this.stage === "mixing") this._advanceMix();
    if (this.stage === "done") this._status("AutoMix queue done");
    this._renderTimeline();
  }

  async handleEnded(deck) {
    if (!this.active || this.busy) return;
    if (deck.idx === this.outIdx && this.nextTrack) {
      const incoming = this.app.decks[this.inIdx];
      if (!incoming.isPlaying && incoming.buffer) incoming.play();
      this._finishMix();
      return;
    }
    if (deck.idx === this.outIdx && !this.nextTrack) {
      this.stage = "done";
      this._status("AutoMix queue done");
      this._clearTimeline();
    }
  }

  _maybeStartMix() {
    const out = this.app.decks[this.outIdx];
    const incoming = this.app.decks[this.inIdx];
    if (!out?.isPlaying || !incoming?.buffer || !this.nextTrack) return;

    const duration = out.duration();
    if (!duration) return;
    if (!this.plan) this._recalculatePlan();
    const plan = this.plan;
    if (!plan) return;
    if (plan.bassUnsafe) {
      this._status(`WAIT: ${plan.bassUnsafeReason || "incoming cue is bass-heavy"}`);
      return;
    }
    const mixDuration = plan.mixDuration;
    const remaining = duration - out.position();

    this._status(this._waitingStatus());
    if (out.position() < plan.startAt && remaining > mixDuration + 1) return;
    this._startMix(plan);
  }

  _startMix(plan = this.plan) {
    if (!plan) {
      this._recalculatePlan();
      plan = this.plan;
    }
    if (!plan) return;
    const out = this.app.decks[this.outIdx];
    const incoming = this.app.decks[this.inIdx];
    const cfg = plan.cfg || this._modeConfig();
    this._prepareIncomingForPlan(plan);
    this.stage = "mixing";
    this.mix = {
      started: this.app.engine.ctx.currentTime,
      duration: plan.mixDuration,
      from: this.outIdx,
      to: this.inIdx,
      cfg,
      plan,
      flags: plan.flags,
    };

    incoming.setVolume(1);
    incoming.setEq("low", cfg.inLowStart);
    incoming.setEq("mid", 0);
    incoming.setEq("high", 0);
    incoming.setFilter(cfg.inFilterStart);
    if (!incoming.isPlaying) incoming.play();
    this.app.generative?.triggerFill(plan.mixDuration);
    this._recordTransition(plan, out, incoming);
    this._status(plan.status);
  }

  _advanceMix() {
    const m = this.mix;
    if (!m) return;
    const ctx = this.app.engine.ctx;
    const raw = Math.max(0, Math.min(1, (ctx.currentTime - m.started) / m.duration));
    const cfg = m.cfg || this._modeConfig();
    const out = this.app.decks[m.from];
    const incoming = this.app.decks[m.to];
    const progress = this._crossProgress(raw, cfg);
    const targetX = m.to === 1 ? progress : 1 - progress;

    this.app._setCrossfader(targetX);
    this._applyRecipe(m, out, incoming, raw, progress);

    if (raw >= 1) this._finishMix();
  }

  async _finishMix() {
    const m = this.mix;
    const oldIdx = m ? m.from : this.outIdx;
    const newIdx = m ? m.to : this.inIdx;
    const old = this.app.decks[oldIdx];
    const current = this.app.decks[newIdx];

    old.stop(true);
    this._resetDeckPerformance(old);
    this._resetDeckPerformance(current);
    if (!current.isPlaying && current.buffer) current.play();
    this.app._setCrossfader(newIdx === 0 ? 0 : 1);
    this.app.generative?.stopFill();
    this.app.refreshDeck(0);
    this.app.refreshDeck(1);

    if (this.nextTrack?.id) {
      this.lastEnergyBoost = this._isEnergyBoost(old, this.nextTrack);
      this._rememberPlayed(this.nextTrack.id);
      this.app.library.removeFromPrepare(this.nextTrack.id);
    }
    if (m?.plan?.mixType === "creative") {
      this.creativeCooldownRemaining = 2;
    } else if (this.creativeCooldownRemaining > 0) {
      this.creativeCooldownRemaining -= 1;
    }

    this.outIdx = newIdx;
    this.inIdx = oldIdx;
    this.mix = null;
    this.plan = null;
    this.nextTrack = null;
    this.nextTrackAutoPick = false;
    this.stage = "prepare";
    await this._prepareNext();
    this.stage = this.nextTrack ? "waiting" : "done";
    this._renderTimeline();
  }

  _getCandidateTracks(outDeck) {
    const prepTracks = this.app.library.getPrepareTracks();
    const prepFresh = this._filterCandidates(prepTracks, outDeck, true);
    if (prepFresh.length) {
      this.usingLibraryFallback = false;
      return { tracks: prepFresh, autoPick: false };
    }

    const prepRelaxed = this._filterCandidates(prepTracks, outDeck, false);
    if (prepRelaxed.length) {
      this.usingLibraryFallback = false;
      return { tracks: prepRelaxed, autoPick: false };
    }

    const allTracks = this.app.library?.tracks || [];
    const libraryFresh = this._filterCandidates(allTracks, outDeck, true);
    if (libraryFresh.length) {
      this.usingLibraryFallback = true;
      return { tracks: libraryFresh, autoPick: true };
    }

    const libraryRelaxed = this._filterCandidates(allTracks, outDeck, false);
    this.usingLibraryFallback = true;
    return { tracks: libraryRelaxed, autoPick: true };
  }

  _filterCandidates(tracks, outDeck, respectRecent) {
    const currentIds = new Set(
      this.app.decks
        .filter((deck) => deck.isPlaying)
        .map((deck) => deck.track?.id)
        .filter(Boolean)
    );
    if (outDeck?.track?.id) currentIds.add(outDeck.track.id);
    return tracks
      .filter(Boolean)
      .filter((track) => track.id && !currentIds.has(track.id))
      .filter((track) => !this.skippedIds.has(track.id))
      .filter((track) => !respectRecent || !this._isRecentlyPlayed(track.id));
  }

  _rememberPlayed(id) {
    if (!id) return;
    this.playedIds.add(id);
    this.playedHistory = [id, ...this.playedHistory.filter((trackId) => trackId !== id)]
      .slice(0, this._recentLimit());
  }

  _isRecentlyPlayed(id) {
    if (!id) return false;
    return this.playedHistory.slice(0, this._recentLimit()).includes(id);
  }

  _recentLimit() {
    return this._modeConfig().recentLimit || 24;
  }

  async _prepareNext(force = false) {
    if (!force && this.nextTrack) return;
    const candidates = this._getCandidateTracks(this.app.decks[this.outIdx]);
    this.queue = candidates.tracks;

    if (!this.queue.length) {
      this.nextTrack = null;
      this.nextTrackAutoPick = false;
      this.plan = null;
      this._clearTimeline();
      return;
    }

    const out = this.app.decks[this.outIdx];
    const cfg = this._modeConfig();
    const ranked = this._rankCandidates(out, this.queue);
    this.queue = ranked;
    this._preloadPrepCandidates(ranked.slice(0, 3));
    let loadedUnsafe = null;

    for (let i = 0; i < ranked.length; i++) {
      const track = ranked[i];
      this.nextTrack = track;
      this.nextTrackAutoPick = candidates.autoPick;
      await this._loadToDeck(track, this.inIdx);
      const plan = this._recalculatePlan();
      if (!plan?.bassUnsafe) {
        this._prepareIncomingForPlan(plan, cfg, out);
        return;
      }

      loadedUnsafe = { track, plan };
      const reason = plan.bassUnsafeReason || "incoming cue is bass-heavy";
      if (i < ranked.length - 1) {
        this._status(`WAIT: ${reason}, trying another`);
      }
    }

    if (loadedUnsafe) {
      this.nextTrack = loadedUnsafe.track;
      this.plan = loadedUnsafe.plan;
      this._prepareIncomingForPlan(this.plan, cfg, out);
      this._status(`WAIT: ${this.plan.bassUnsafeReason || "incoming cue is bass-heavy"}`);
    }
  }

  _recalculatePlan() {
    const out = this.app.decks[this.outIdx];
    const incoming = this.app.decks[this.inIdx];
    if (!out?.buffer || !incoming?.buffer) {
      this.plan = null;
      return null;
    }
    this.plan = this._buildTransitionPlan(out, incoming);
    return this.plan;
  }

  _buildTransitionPlan(out, incoming) {
    const cfg = this._modeConfig();
    const mixDuration = this._mixDuration(out, cfg);
    const outProfile = this.app.coach?.profiles?.[this.outIdx];
    const inProfile = this.app.coach?.profiles?.[this.inIdx];
    const outWindow = this._selectOutgoingWindow(out, outProfile, cfg, mixDuration);
    const inTarget = this._selectIncomingTarget(incoming, inProfile, cfg, mixDuration);
    const fallback = !(outWindow.profileAware && inTarget.profileAware);
    const targetMoment = !fallback && inTarget.profileAware
      ? { type: inTarget.type, at: inTarget.at }
      : null;
    const status = this._planStatus(cfg, outWindow, inTarget, fallback);

    const plan = new TransitionPlan({
      cfg,
      recipe: cfg.recipe,
      startAt: outWindow.startAt,
      targetMoment,
      mixDuration,
      outIdx: this.outIdx,
      inIdx: this.inIdx,
      cueStart: fallback ? 0 : inTarget.cueStart,
      targetInSec: fallback ? 0 : inTarget.targetInSec,
      anchor: outWindow.type,
      fallback,
      status,
      autoPick: this.nextTrackAutoPick,
      mixType: "safe",
      why: this._safeWhy(out, incoming, cfg, outWindow, inTarget, fallback),
      outGate: outWindow.dropGate || null,
    });
    plan.bassUnsafe = !!inTarget.bassUnsafe;
    plan.bassSafeCue = !!inTarget.bassSafeCue;
    plan.bassUnsafeReason = inTarget.bassUnsafeReason || "";
    this._applyCreativeLayering(plan, out, incoming, outProfile, inProfile, cfg, outWindow, inTarget);
    plan.events = this._buildPlanEvents(plan);
    return plan;
  }

  _applyCreativeLayering(plan, out, incoming, outProfile, inProfile, cfg, outWindow, inTarget) {
    const candidate = this._creativeLayeringCandidate(plan, out, incoming, outProfile, inProfile, cfg, outWindow, inTarget);
    if (!candidate) return;
    const creativeCfg = {
      ...cfg,
      label: "CREATIVE",
      move: candidate.recipeName,
      recipe: candidate.recipe,
      liveOverlapBeats: candidate.beats,
      minDuration: Math.min(cfg.minDuration, candidate.mixDuration),
      maxDuration: Math.max(cfg.maxDuration, candidate.mixDuration),
      inLowStart: candidate.inLowStart,
      inFilterStart: candidate.inFilterStart,
      bassSwapAt: candidate.bassSwapRatio,
      bassFadeWidth: candidate.bassFadeWidth,
      incomingLowFloor: -32,
      outgoingLowFloor: -32,
    };

    plan.cfg = creativeCfg;
    plan.recipe = candidate.recipe;
    plan.startAt = candidate.startAt;
    plan.mixDuration = candidate.mixDuration;
    plan.cueStart = candidate.cueStart;
    plan.targetInSec = candidate.targetInSec;
    plan.targetMoment = candidate.targetMoment;
    plan.fallback = false;
    plan.anchor = candidate.anchor;
    plan.mixType = "creative";
    plan.creativeScore = candidate.creativeScore;
    plan.layeringPlan = candidate;
    plan.bassUnsafe = false;
    plan.bassSafeCue = true;
    plan.bassUnsafeReason = "";
    plan.status = `Creative: ${candidate.recipeName.toLowerCase()} · ${candidate.camelotText} · bass-safe${this._dropGateStatusSuffix(plan.outGate)}`;
    plan.why = [candidate.reason, this._dropGateWhy(plan.outGate)].filter(Boolean).join(" · ");
  }

  _creativeLayeringCandidate(plan, out, incoming, outProfile, inProfile, cfg, outWindow, inTarget) {
    const settings = this._creativeSettings();
    if (!settings.enabled) return null;
    if (this.creativeCooldownRemaining > 0) return null;
    if (this._hasPerformanceWarning()) return null;
    if (!out?.track?.bpm || !incoming?.track?.bpm || !out?.track?.camelot || !incoming?.track?.camelot) return null;
    if (this._hasLowKeyConfidence(incoming.track)) return null;
    if (!this._tempoPilotAllowsUpOnly(out, incoming)) return null;

    const relation = AutoMixer.camelotRelation(out.track.camelot, incoming.track.camelot);
    if (!AutoMixer.CREATIVE_RELATIONS.has(relation)) return null;
    if (relation === "energy" && !cfg.allowEnergyBoost && settings.intensity !== "high") return null;
    if (!this._hasReliableOutgoingProfile(outProfile, out.duration()) || !this._hasReliableIncomingProfile(inProfile, incoming.duration())) return null;

    const outBassHeavy = outProfile?.isBassHeavy?.(plan.startAt, 0.30);
    const inBassHeavy = inProfile?.isBassHeavy?.(plan.cueStart, 0.30);
    if (outBassHeavy && inBassHeavy) return null;
    if (!this._hasAnyBassLightLayer(outProfile, inProfile, plan, incoming.duration())) return null;

    const recipe = this._chooseCreativeRecipe(out, incoming, outProfile, inProfile, cfg, outWindow, inTarget, relation, settings);
    if (!recipe) return null;
    const beatSec = 60 / (out.effectiveBpm() || out.bpm || 120);
    const desiredBeats = Math.max(recipe.minBeats, Math.min(settings.maxBeats, recipe.beats));
    const desiredDuration = Math.max(beatSec * desiredBeats, cfg.minDuration);
    const timing = this._creativeTiming(plan, out, incoming, inProfile, cfg, recipe, desiredDuration);
    if (!timing) return null;

    return {
      ...recipe,
      ...timing,
      layerStart: 0,
      layerEnd: timing.mixDuration,
      camelotText: `${out.track.camelot} -> ${incoming.track.camelot}`,
      creativeScore: recipe.score,
      eqAutomation: recipe.eqAutomation,
      filterAutomation: recipe.filterAutomation,
      fxAutomation: recipe.fxAutomation,
      reason: `${recipe.reason} · ${relation} · ${Math.round(timing.mixDuration / beatSec)} beats`,
    };
  }

  _chooseCreativeRecipe(out, incoming, outProfile, inProfile, cfg, outWindow, inTarget, relation, settings) {
    const outText = AutoMixer._trackText(out.track);
    const inText = AutoMixer._trackText(incoming.track);
    const outSection = outProfile?.sectionAt?.(out.position()) || "";
    const hasVocalIn = AutoMixer._hasTextSignal(inText, ["vocal", "vox", "acapella", "feat"]);
    const hasMelodyOut = AutoMixer._hasTextSignal(outText, ["melodic", "melody", "piano", "synth", "lead"]) ||
      outWindow.type === "breakdown" || outSection === "breakdown";
    const houseBed = AutoMixer._hasTextSignal(`${outText} ${inText}`, ["house", "tech", "club", "groove", "drum", "percussion"]);
    const incomingBassLight = inProfile?.hasBassLightWindow?.(0, this._beatsToSec(incoming, 16), 0.28) ||
      inProfile?.hasBassLightWindow?.(inTarget.cueStart || 0, this._beatsToSec(incoming, 16), 0.28);
    const outgoingGroove = outProfile?.energyAt?.(out.position()) >= 0.42 && outWindow.type !== "breakdown";
    const bothBreak = (outWindow.type === "breakdown" || outWindow.type === "build") &&
      (inTarget.type === "build" || inTarget.type === "drop");
    const candidates = [];

    if (hasMelodyOut && (hasVocalIn || incomingBassLight)) {
      candidates.push({
        recipe: "creative_melody_vocal",
        code: "melody_vocal",
        recipeName: "Melody Over Vocal",
        label: "MELODY BED",
        beats: settings.intensity === "high" ? 96 : 64,
        minBeats: 32,
        bassSwapRatio: 0.68,
        bassFadeWidth: 0.18,
        inLowStart: -32,
        inFilterStart: 0.56,
        score: 84 + (relation === "same" ? 8 : 0),
        reason: "melody bed over bass-light incoming",
        eqAutomation: ["out low down", "incoming low locked", "late bass handoff"],
        filterAutomation: ["incoming opens slowly", "outgoing neutral/high-pass late"],
        fxAutomation: ["light reverb tail near exit"],
      });
    }

    if (hasVocalIn && outgoingGroove) {
      candidates.push({
        recipe: "creative_vocal_groove",
        code: "vocal_groove",
        recipeName: "Vocal Over Groove",
        label: "LAYER VOCAL",
        beats: settings.intensity === "high" ? 96 : 64,
        minBeats: 32,
        bassSwapRatio: 0.72,
        bassFadeWidth: 0.16,
        inLowStart: -34,
        inFilterStart: 0.52,
        score: 80,
        reason: "incoming vocal rides outgoing groove",
        eqAutomation: ["outgoing bass stays", "incoming vocal mids lifted", "late low swap"],
        filterAutomation: ["incoming full-band except low"],
        fxAutomation: ["none"],
      });
    }

    if (houseBed && incomingBassLight && settings.intensity !== "low") {
      candidates.push({
        recipe: "creative_percussion_bed",
        code: "percussion_bed",
        recipeName: "Percussion Bed",
        label: "PERC BED",
        beats: settings.intensity === "high" ? 96 : 64,
        minBeats: 48,
        bassSwapRatio: 0.74,
        bassFadeWidth: 0.18,
        inLowStart: -34,
        inFilterStart: 0.58,
        score: 72,
        reason: "long intro/outro supports percussion layer",
        eqAutomation: ["one low end only", "percussion highs open"],
        filterAutomation: ["bed stays narrow until handoff"],
        fxAutomation: ["light echo on outgoing exit"],
      });
    }

    if (bothBreak && relation !== "energy") {
      candidates.push({
        recipe: "creative_breakdown_bridge",
        code: "breakdown_bridge",
        recipeName: "Breakdown Bridge",
        label: "BREAK BRIDGE",
        beats: settings.intensity === "high" ? 96 : 64,
        minBeats: 32,
        bassSwapRatio: 0.76,
        bassFadeWidth: 0.16,
        inLowStart: -34,
        inFilterStart: 0.54,
        score: 78,
        reason: "compatible breakdown/build sections align",
        eqAutomation: ["bass held back", "mid atmosphere layered"],
        filterAutomation: ["slow wash open"],
        fxAutomation: ["reverb wash before drop"],
      });
    }

    if (inTarget.bassSafeCue) {
      candidates.push({
        recipe: "creative_bass_handoff",
        code: "bass_handoff",
        recipeName: "Bass Handoff",
        label: "BASS HANDOFF",
        beats: settings.intensity === "low" ? 48 : 64,
        minBeats: 32,
        bassSwapRatio: 0.70,
        bassFadeWidth: 0.14,
        inLowStart: -34,
        inFilterStart: 0.60,
        score: 68,
        reason: "bass-light cue allows controlled low-end exchange",
        eqAutomation: ["mutex low EQ", "incoming low opens on phrase"],
        filterAutomation: ["incoming low-pass opens after swap"],
        fxAutomation: ["none"],
      });
    }

    if (relation === "energy" || cfg.recipe === "radio") {
      candidates.push({
        recipe: "creative_echo_tail",
        code: "echo_tail",
        recipeName: "Echo Tail",
        label: "ECHO TAIL",
        beats: 32,
        minBeats: 16,
        bassSwapRatio: 0.48,
        bassFadeWidth: 0.12,
        inLowStart: -24,
        inFilterStart: 0.50,
        score: 58,
        reason: "short FX handoff for less stable harmonic blend",
        eqAutomation: ["out low cut", "incoming low opens quickly"],
        filterAutomation: ["outgoing high-pass tail"],
        fxAutomation: ["echo tail", "reverb wash"],
      });
    }

    return candidates.sort((a, b) => b.score - a.score)[0] || null;
  }

  _creativeTiming(plan, out, incoming, inProfile, cfg, recipe, desiredDuration) {
    const pos = out.position();
    const duration = out.duration();
    const latestStart = Math.max(0, duration - desiredDuration - 0.5);
    const gateAt = plan.outGate?.active ? plan.outGate.at : null;
    if (latestStart <= pos + 0.5) return null;
    let startAt = Math.min(Math.max(plan.startAt, gateAt ?? 0), latestStart);
    if (cfg.snapPhrase) {
      startAt = gateAt != null
        ? this._snapToPhraseAfter(startAt, out, pos, latestStart, cfg.phraseBeats || 32, gateAt)
        : this._snapToPhrase(startAt, out, pos, latestStart, cfg.phraseBeats || 32, true);
    }
    if (gateAt != null && startAt < gateAt) return null;
    if (startAt <= pos + 0.5) return null;

    const mixDuration = Math.min(desiredDuration, Math.max(0, duration - startAt - 0.5));
    const beatSec = 60 / (out.effectiveBpm() || out.bpm || 120);
    if (mixDuration < beatSec * recipe.minBeats) return null;

    let targetMoment = plan.targetMoment;
    let cueStart = plan.cueStart;
    let targetInSec = plan.targetInSec;
    const targetRatio = recipe.bassSwapRatio || 0.70;
    if (targetMoment?.at != null) {
      targetInSec = mixDuration * targetRatio;
      cueStart = Math.max(0, targetMoment.at - targetInSec);
      targetInSec = Math.max(0, targetMoment.at - cueStart);
    }
    const checked = this._bassSafeIncomingTarget(incoming, inProfile, {
      type: targetMoment?.type || "creative",
      at: targetMoment?.at ?? (cueStart + targetInSec),
      cueStart,
      targetInSec,
      profileAware: true,
    }, mixDuration);
    if (checked.bassUnsafe) return null;
    return {
      startAt,
      mixDuration,
      cueStart: checked.cueStart || 0,
      targetInSec: checked.targetInSec || targetInSec,
      targetMoment: targetMoment || { type: "creative", at: checked.at || (checked.cueStart || 0) + (checked.targetInSec || 0) },
      anchor: "creative",
      bassSwapPoint: mixDuration * targetRatio,
      beats: Math.round(mixDuration / beatSec),
    };
  }

  _selectOutgoingWindow(deck, profile, cfg, mixDuration) {
    const duration = deck.duration();
    const pos = deck.position();
    const latestStart = Math.max(0, duration - mixDuration - 0.5);
    const earlyLead = this._beatsToSec(deck, cfg.startLeadBeats || 0);
    const dropGate = this._outgoingDropGate(profile, pos, latestStart);
    const earliestStart = dropGate.active ? dropGate.at : pos + 1;
    const targetRaw = Math.min(
      latestStart,
      Math.max(earliestStart, (duration * cfg.mixOutAt) - earlyLead),
    );
    const targetStart = cfg.snapPhrase
      ? (dropGate.active
        ? this._snapToPhraseAfter(targetRaw, deck, pos, latestStart, cfg.phraseBeats, earliestStart)
        : this._snapToPhrase(targetRaw, deck, pos, latestStart, cfg.phraseBeats, cfg.snapEarlier))
      : Math.max(pos + 1, targetRaw);
    const timed = {
      type: "timed",
      startAt: Math.max(0, Math.min(targetStart, latestStart)),
      profileAware: false,
      dropGate,
    };
    if (!this._hasReliableOutgoingProfile(profile, duration)) return timed;

    const candidates = [];
    const minStructuralStart = Math.max(earliestStart, Math.min(latestStart, duration * cfg.mixOutAt));
    if (profile.outro_start < duration - 4 && profile.outro_start > pos + 1) {
      const lead = cfg.waitForOutro ? 0 : cfg.prepLead;
      const startAt = Math.max(0, profile.outro_start - lead - earlyLead);
      if (startAt >= earliestStart || profile.outro_start >= earliestStart) candidates.push({
        type: "outro",
        at: profile.outro_start,
        startAt: Math.max(startAt, earliestStart),
        priority: 5,
      });
    }
    for (const [start, end] of profile.breakdowns || []) {
      if (end - start >= 3 && start >= minStructuralStart) {
        candidates.push({
          type: "breakdown",
          at: start,
          startAt: Math.max(0, start - earlyLead),
          priority: cfg.recipe === "club" ? 2 : 3,
        });
      }
    }
    for (const build of profile.builds || []) {
      if (build >= minStructuralStart) {
        candidates.push({
          type: "build",
          at: build,
          startAt: Math.max(earliestStart, build - mixDuration * (cfg.buildLeadRatio || 0.2) - earlyLead),
          priority: cfg.recipe === "hype" ? 1 : 3,
        });
      }
    }

    if (!candidates.length) return timed;
    candidates.sort((a, b) => {
      const aDist = Math.abs(a.startAt - targetStart);
      const bDist = Math.abs(b.startAt - targetStart);
      return (a.priority - b.priority) || (aDist - bDist) || (a.at - b.at);
    });
    const chosen = candidates[0];
    let startAt = Math.min(chosen.startAt, latestStart);
    if (cfg.snapPhrase) {
      startAt = dropGate.active
        ? this._snapToPhraseAfter(startAt, deck, pos, latestStart, cfg.phraseBeats, earliestStart)
        : this._snapToPhrase(startAt, deck, pos, latestStart, cfg.phraseBeats, cfg.snapEarlier);
    }
    return {
      type: chosen.type,
      startAt: Math.max(0, startAt),
      profileAware: true,
      dropGate,
    };
  }

  _selectIncomingTarget(deck, profile, cfg, mixDuration) {
    const duration = deck.duration();
    const targetInSec = mixDuration * cfg.dropAt;
    const timed = {
      type: "timed",
      at: targetInSec,
      cueStart: 0,
      targetInSec,
      profileAware: false,
    };
    if (!this._hasReliableIncomingProfile(profile, duration)) {
      return this._bassSafeIncomingTarget(deck, profile, timed, mixDuration);
    }

    const drop = this._chooseMarker(profile.drops, duration, targetInSec);
    if (drop != null) {
      const cueStart = Math.max(0, Math.min(duration - 1, drop - targetInSec));
      return this._bassSafeIncomingTarget(deck, profile, {
        type: "drop",
        at: drop,
        cueStart,
        targetInSec: Math.max(0, drop - cueStart),
        profileAware: true,
      }, mixDuration);
    }

    const build = this._chooseMarker(profile.builds, duration, mixDuration * 0.3);
    if (build != null) {
      const cueStart = Math.max(0, Math.min(duration - 1, build - mixDuration * 0.3));
      return this._bassSafeIncomingTarget(deck, profile, {
        type: "build",
        at: build,
        cueStart,
        targetInSec: Math.max(0, build - cueStart),
        profileAware: true,
      }, mixDuration);
    }

    if (Number.isFinite(profile.intro_end) && profile.intro_end > 2 && profile.intro_end < duration - 8) {
      return this._bassSafeIncomingTarget(deck, profile, {
        type: "intro_end",
        at: profile.intro_end,
        cueStart: 0,
        targetInSec: profile.intro_end,
        profileAware: true,
      }, mixDuration);
    }
    return this._bassSafeIncomingTarget(deck, profile, timed, mixDuration);
  }

  _bassSafeIncomingTarget(deck, profile, target, mixDuration) {
    if (!profile || !deck?.duration()) return target;
    const beatSec = 60 / (deck.effectiveBpm() || deck.bpm || 120);
    const required = Math.max(beatSec * 8, Math.min(8, mixDuration * 0.35));
    const threshold = profile.hasBassStem ? 0.28 : 0.2;
    if (profile.hasBassLightWindow(target.cueStart || 0, required, threshold)) {
      return { ...target, bassSafeCue: true };
    }

    const markerAt = Number.isFinite(target.at) ? target.at : null;
    const candidates = (profile.bassFreeRegions || [])
      .filter(([a, b]) => b - a >= required)
      .filter(([a]) => markerAt == null || a < markerAt)
      .filter(([a]) => markerAt == null || markerAt - a <= mixDuration * 0.95)
      .map(([a]) => ({
        cueStart: a,
        distance: Math.abs(a - (target.cueStart || 0)),
      }))
      .sort((a, b) => a.distance - b.distance);

    if (candidates.length) {
      const cueStart = Math.max(0, candidates[0].cueStart);
      return {
        ...target,
        cueStart,
        targetInSec: markerAt == null ? Math.max(target.targetInSec || 0, required) : Math.max(0, markerAt - cueStart),
        bassSafeCue: true,
      };
    }

    const cue = target.cueStart || 0;
    const startsOnBassline = cue < 1.5 && profile.isBassHeavy(cue, threshold);
    return {
      ...target,
      bassUnsafe: true,
      bassUnsafeReason: startsOnBassline
        ? "next track starts on bassline"
        : "incoming cue is bass-heavy",
    };
  }

  _prepareIncomingForPlan(plan = this.plan, cfg = plan?.cfg || this._modeConfig(), out = this.app.decks[this.outIdx]) {
    if (!plan) return;
    const incoming = this.app.decks[this.inIdx];
    if (!incoming?.buffer) return;
    this._resetDeckPerformance(incoming);
    incoming.syncTo(out, { upOnly: true });
    incoming.seek(plan.cueStart);
    incoming.phaseAlignTo(out);
    incoming.setVolume(1);
    incoming.setEq("low", cfg.inLowStart);
    incoming.setEq("mid", 0);
    incoming.setEq("high", 0);
    incoming.setFilter(cfg.inFilterStart);
    plan.flags.cueSet = true;
  }

  _waitingStatus() {
    return this.plan?.status || `${this._modeConfig().label}: ${this.nextTrack?.title || "armed"}`;
  }

  _planStatus(cfg, outWindow, inTarget, fallback) {
    const suffix = this._dropGateStatusSuffix(outWindow.dropGate);
    if (inTarget.bassUnsafe) return `WAIT: ${inTarget.bassUnsafeReason || "incoming cue is bass-heavy"}${suffix}`;
    if (inTarget.bassSafeCue) return `${cfg.label}: bass-safe cue${suffix}`;
    if (fallback) return `fallback: timed mix${suffix}`;
    if (cfg.recipe === "hype" && inTarget.type === "drop") return `HYPE: aiming drop${suffix}`;
    if (cfg.recipe === "club" && outWindow.type === "outro") return `CLUB: outro blend${suffix}`;
    if (cfg.recipe === "bass") return `BASS: phrase bass exchange${suffix}`;
    if (cfg.recipe === "radio") return `RADIO: echo cut${suffix}`;
    if (outWindow.type === "breakdown") return `${cfg.label}: breakdown blend${suffix}`;
    return `${cfg.label}: ${cfg.move}${suffix}`;
  }

  _buildPlanEvents(plan) {
    const inDeck = AutoMixer._deckLabel(plan.inIdx);
    const events = [];
    if (plan.autoPick) events.push({ id: "auto", label: "AUTO PICK", kind: "cue" });
    events.push(
      { id: "cue", label: `CUE ${inDeck}`, kind: "cue" },
    );
    if (plan.outGate?.active) {
      events.push({
        id: "drop-gate",
        label: `DROP ${plan.outGate.count} GATE`,
        kind: "outgoing",
        at: plan.outGate.at,
      });
    }
    events.push({ id: "start", label: "START MIX", kind: "outgoing", at: plan.startAt });
    for (const event of this._recipeActionEvents(plan)) events.push(event);
    if (plan.targetMoment) {
      events.push({
        id: "target",
        label: plan.targetMoment.type === "drop" ? "DROP" : "BUILD",
        kind: "mix",
        at: plan.targetInSec,
      });
    } else if (plan.fallback) {
      events.push({
        id: "timed",
        label: "TIMED MIX",
        kind: "mix",
        at: plan.mixDuration * 0.5,
      });
    }
    events.push({ id: "finish", label: "FINISH", kind: "mix", at: plan.mixDuration });
    return events
      .filter((event) => event.kind === "cue" || Number.isFinite(event.at))
      .sort((a, b) => this._eventSortValue(a, plan) - this._eventSortValue(b, plan));
  }

  _recipeActionEvents(plan) {
    if (plan.layeringPlan) {
      const d = plan.mixDuration;
      const swapAt = plan.layeringPlan.bassSwapPoint || d * (plan.cfg.bassSwapAt || 0.70);
      const events = [
        { id: "lock", label: "LOW LOCK", kind: "mix", at: 0 },
        { id: "layer", label: plan.layeringPlan.label || "LAYER", kind: "mix", at: d * 0.12 },
        { id: "bass", label: "BASS HANDOFF", kind: "mix", at: swapAt },
      ];
      if (plan.layeringPlan.code === "melody_vocal") {
        events.splice(1, 0, { id: "melody", label: "MELODY BED", kind: "mix", at: d * 0.05 });
        events[2].label = "LAYER VOCAL";
      }
      if (plan.layeringPlan.code === "echo_tail") {
        events[1] = { id: "echo", label: "ECHO TAIL", kind: "mix", at: d * 0.42 };
      }
      events.push({ id: "open", label: "LOW OPEN", kind: "mix", at: Math.min(d * 0.92, swapAt + d * 0.18) });
      return events;
    }
    const d = plan.mixDuration;
    const swapAt = d * (plan.cfg.bassSwapAt || 0.52);
    const openAt = d * Math.min(0.95, (plan.cfg.bassSwapAt || 0.52) + (plan.cfg.bassFadeWidth || 0.16));
    const bassEvents = [
      { id: "lock", label: "LOW LOCK", kind: "mix", at: 0 },
      { id: "bass", label: plan.recipe === "bass" ? "BASS HIT" : "BASS SWAP", kind: "mix", at: swapAt },
      { id: "open", label: "LOW OPEN", kind: "mix", at: openAt },
    ];
    if (plan.recipe === "club" || plan.recipe === "bass") return bassEvents;
    if (plan.recipe === "radio") {
      return [
        { id: "lock", label: "LOW LOCK", kind: "mix", at: 0 },
        { id: "echo", label: "ECHO CUT", kind: "mix", at: d * 0.58 },
        { id: "open", label: "LOW OPEN", kind: "mix", at: openAt },
      ];
    }
    if (plan.recipe === "hype") {
      const canRoll = !plan.fallback && plan.targetMoment?.type === "drop" && d >= (plan.cfg.loopRollMin || 0);
      return canRoll
        ? [
          { id: "lock", label: "LOW LOCK", kind: "mix", at: 0 },
          { id: "roll", label: "LOOP ROLL", kind: "mix", at: d * 0.18 },
          { id: "bass", label: "BASS SWAP", kind: "mix", at: swapAt },
          { id: "open", label: "LOW OPEN", kind: "mix", at: openAt },
        ]
        : [
          { id: "lock", label: "LOW LOCK", kind: "mix", at: 0 },
          { id: "bass", label: "BASS SWAP", kind: "mix", at: swapAt },
          { id: "slam", label: "FX PEAK", kind: "mix", at: d * 0.68 },
          { id: "open", label: "LOW OPEN", kind: "mix", at: openAt },
        ];
    }
    return [];
  }

  _eventSortValue(event, plan) {
    if (event.kind === "cue") return -1;
    if (event.kind === "outgoing") return 0;
    return 1 + (event.at / Math.max(1, plan.mixDuration));
  }

  _renderTimeline() {
    this._renderPlanSummary();
    const el = document.getElementById("automixTimeline");
    if (!el) return;
    if (!this.active || (!this.plan && this.stage !== "prepare")) {
      el.innerHTML = "";
      return;
    }
    const rows = this._timelineRows();
    if (!rows.length) {
      el.innerHTML = `<div class="automix-step"><span class="automix-step-dot"></span><span class="automix-step-label">NO PLAN</span><span class="automix-step-time">--</span></div>`;
      return;
    }
    el.innerHTML = rows.map((row) => (
      `<div class="automix-step is-${row.state}">` +
      `<span class="automix-step-dot"></span>` +
      `<span class="automix-step-label">${AutoMixer._escape(row.label)}</span>` +
      `<span class="automix-step-time">${AutoMixer._escape(row.time)}</span>` +
      `</div>`
    )).join("");
  }

  _clearTimeline() {
    const el = document.getElementById("automixTimeline");
    if (el) el.innerHTML = "";
    this._renderPlanSummary(null);
  }

  _renderPlanSummary(plan = this.plan) {
    const badge = document.getElementById("automixMixBadge");
    const why = document.getElementById("automixWhy");
    const creative = plan?.mixType === "creative";
    if (badge) {
      badge.textContent = creative ? "CREATIVE" : "SAFE";
      badge.classList.toggle("is-creative", creative);
    }
    if (why) {
      why.textContent = plan?.why ? `WHY THIS MIX ${plan.why}` : "WHY THIS MIX --";
    }
  }

  _timelineRows() {
    const plan = this.plan;
    if (!plan) return [];
    const out = this.app.decks[plan.outIdx];
    const rows = [];
    const elapsed = this.mix
      ? Math.max(0, this.app.engine.ctx.currentTime - this.mix.started)
      : 0;
    const outPos = out?.position ? out.position() : 0;

    for (const event of plan.events || []) {
      if (event.kind === "cue") {
        rows.push({
          label: event.label,
          time: event.id === "auto" ? "lib" : AutoMixer._fmtShort(plan.cueStart),
          state: plan.flags.cueSet ? "done" : "current",
        });
        continue;
      }

      if (event.kind === "outgoing") {
        const delta = event.at - outPos;
        rows.push({
          label: event.label,
          time: this.stage === "mixing" ? "done" : AutoMixer._fmtCountdown(delta),
          state: this.stage === "mixing" ? "done" : (delta <= 6 ? "current" : "upcoming"),
        });
        continue;
      }

      const delta = event.at - elapsed;
      let state = "upcoming";
      let time = AutoMixer._fmtCountdown(delta);
      if (this.stage !== "mixing") {
        const untilStart = Math.max(0, plan.startAt - outPos);
        time = AutoMixer._fmtCountdown(untilStart + event.at);
      } else if (delta <= -0.75) {
        state = "done";
        time = "done";
      } else if (delta <= 2) {
        state = "current";
        time = delta <= 0 ? "now" : AutoMixer._fmtCountdown(delta);
      }
      rows.push({ label: event.label, time, state });
    }
    return rows;
  }

  _hasReliableOutgoingProfile(profile, duration) {
    if (!profile || !Number.isFinite(duration) || duration < 30) return false;
    const hasOutro = Number.isFinite(profile.outro_start) && profile.outro_start < duration - 4;
    return hasOutro || !!profile.breakdowns?.length || !!profile.builds?.length;
  }

  _hasReliableIncomingProfile(profile, duration) {
    if (!profile || !Number.isFinite(duration) || duration < 30) return false;
    return !!profile.drops?.length || !!profile.builds?.length ||
      (Number.isFinite(profile.intro_end) && profile.intro_end > 2 && profile.intro_end < duration - 8);
  }

  _chooseMarker(markers, duration, targetInSec) {
    const usable = (markers || [])
      .filter((sec) => Number.isFinite(sec) && sec > 2 && sec < duration - 4)
      .sort((a, b) => {
        const aCue = a - targetInSec;
        const bCue = b - targetInSec;
        if (aCue >= 0 && bCue < 0) return -1;
        if (aCue < 0 && bCue >= 0) return 1;
        return a - b;
      });
    return usable.length ? usable[0] : null;
  }

  _snapToPhrase(sec, deck, currentPos, latestStart, phraseBeats = 32, preferEarlier = false) {
    const bpm = deck.effectiveBpm() || deck.bpm || 120;
    const phraseSec = phraseBeats * 60 / bpm;
    if (!Number.isFinite(phraseSec) || phraseSec <= 0) return sec;
    const origin = deck.beatOffset || 0;
    const units = (sec - origin) / phraseSec;
    let snapped = origin + (preferEarlier ? Math.floor(units) : Math.round(units)) * phraseSec;
    if (snapped < currentPos + 0.5) snapped += phraseSec;
    if (snapped > latestStart) snapped = latestStart;
    return Math.max(0, snapped);
  }

  _snapToPhraseAfter(sec, deck, currentPos, latestStart, phraseBeats = 32, minStart = currentPos + 0.5) {
    const bpm = deck.effectiveBpm() || deck.bpm || 120;
    const phraseSec = phraseBeats * 60 / bpm;
    if (!Number.isFinite(phraseSec) || phraseSec <= 0) {
      return Math.max(minStart, Math.min(sec, latestStart));
    }
    let snapped = this._snapToPhrase(sec, deck, currentPos, latestStart, phraseBeats, false);
    while (snapped < minStart && snapped + phraseSec <= latestStart + 0.001) {
      snapped += phraseSec;
    }
    if (snapped < minStart) snapped = Math.min(latestStart, minStart);
    return Math.max(0, Math.min(snapped, latestStart));
  }

  async _loadToDeck(track, idx) {
    if (!track) return;
    this.busy = true;
    this._status(`Loading ${idx === 0 ? "A" : "B"}: ${track.title}`);
    try {
      await this.app.loadTrackToDeck(track, idx);
    } finally {
      this.busy = false;
    }
  }

  _preloadPrepCandidates(tracks) {
    if (typeof document === "undefined") return;
    document.querySelectorAll("link[data-automix-preload]").forEach((el) => el.remove());
    const currentIds = new Set(this.app.decks.map((deck) => deck.track?.id).filter(Boolean));
    tracks
      .filter((track) => track?.url && !currentIds.has(track.id))
      .slice(0, 2)
      .forEach((track) => {
        const link = document.createElement("link");
        link.rel = "preload";
        link.as = "audio";
        link.href = track.url;
        link.dataset.automixPreload = "1";
        document.head.appendChild(link);
      });
  }

  _applyRecipe(m, out, incoming, raw, progress) {
    const cfg = m.cfg;
    if (m.plan?.layeringPlan || String(cfg.recipe || "").startsWith("creative_")) {
      return this._recipeCreative(m, out, incoming, raw, progress);
    }
    if (cfg.recipe === "hype") return this._recipeHype(m, out, incoming, raw, progress);
    if (cfg.recipe === "radio") return this._recipeRadio(m, out, incoming, raw, progress);
    if (cfg.recipe === "bass") return this._recipeBass(m, out, incoming, raw, progress);
    return this._recipeClub(m, out, incoming, raw, progress);
  }

  _applyBassMutex(out, incoming, raw, cfg) {
    const swapAt = cfg.bassSwapAt ?? 0.52;
    const width = cfg.bassFadeWidth ?? 0.16;
    const outFloor = cfg.outgoingLowFloor ?? -30;
    const inFloor = cfg.incomingLowFloor ?? -30;
    const outKill = AutoMixer._range(raw, Math.max(0, swapAt - width), swapAt);
    const inOpen = AutoMixer._range(raw, swapAt + 0.04, Math.min(1, swapAt + width));
    const outLow = outFloor * outKill;
    const inLow = inFloor * (1 - inOpen);
    out.setEq("low", outLow);
    incoming.setEq("low", inLow);
    return { outKill, inOpen, outLow, inLow };
  }

  _recipeClub(_m, out, incoming, raw, progress) {
    const bass = this._applyBassMutex(out, incoming, raw, _m.cfg);
    incoming.setFilter(0.58 - 0.08 * progress);
    out.setFilter(0.5);
    this._status(bass.inOpen > 0 ? "CLUB: low open" : "CLUB: bass locked");
  }

  _recipeRadio(_m, out, incoming, raw, progress) {
    const cut = AutoMixer._range(raw, 0.18, 0.58);
    const echo = AutoMixer._range(raw, 0.26, 0.74);
    out.setEq("low", -26 * AutoMixer._range(raw, 0.12, 0.42));
    incoming.setEq("low", -18 * (1 - AutoMixer._range(raw, 0.05, 0.34)));
    out.setFilter(0.5 + 0.34 * cut);
    incoming.setFilter(0.5);
    out.setEcho(raw > 0.24 ? 0.46 * echo : 0);
    out.setReverb(raw > 0.48 ? 0.10 * AutoMixer._range(raw, 0.48, 0.86) : 0);
    out.setVolume(1 - 0.72 * AutoMixer._range(raw, 0.42, 0.86));
    incoming.setVolume(0.78 + 0.22 * progress);
    _m.flags.echo = raw > 0.24;
    this._status(raw < 0.45 ? "RADIO: quick cut armed" : "RADIO: echo out");
  }

  _recipeBass(_m, out, incoming, raw, progress) {
    const bass = this._applyBassMutex(out, incoming, raw, _m.cfg);
    const tension = Math.sin(Math.PI * raw);
    out.setFilter(0.5 - 0.05 * tension);
    incoming.setFilter(0.62 - 0.12 * bass.inOpen);
    incoming.setEq("mid", -4 * (1 - AutoMixer._range(raw, 0.28, 0.72)));
    out.setEq("high", -3 * AutoMixer._range(raw, 0.72, 1));
    this._status(bass.inOpen > 0 ? "BASS: sub handoff" : "BASS: double-deck low lock");
  }

  _recipeHype(m, out, incoming, raw, progress) {
    const flags = m.flags;
    const beatHz = (out.effectiveBpm() || 120) / 60;
    const allowLoopRoll = !m.plan?.fallback &&
      m.plan?.targetMoment?.type === "drop" &&
      m.duration >= (m.cfg.loopRollMin || 0);

    if (allowLoopRoll && raw > 0.12 && !flags.loop) {
      out.loops?.setSlip(true);
      out.loops?.loopN(1);
      flags.loop = true;
    }
    if (allowLoopRoll && raw > 0.32 && !flags.roll) {
      out.loops?.halve();
      flags.roll = true;
    }
    if (allowLoopRoll && raw > 0.54 && !flags.release) {
      out.loops?.exit();
      flags.release = true;
    }

    out.setGate(raw > 0.14 && raw < 0.70 ? 0.46 : 0, beatHz * 4);
    out.setEcho(raw > 0.24 ? 0.52 * AutoMixer._range(raw, 0.24, 0.76) : 0);
    out.setReverb(raw > 0.58 ? 0.24 * AutoMixer._range(raw, 0.58, 1) : 0);
    flags.gate = raw > 0.14 && raw < 0.70;
    flags.echo = raw > 0.24;
    flags.reverb = raw > 0.58;
    out.setFilter(0.5 + 0.34 * AutoMixer._range(raw, 0.30, 0.86));

    const bass = this._applyBassMutex(out, incoming, raw, m.cfg);
    out.setEq("mid", -10 * AutoMixer._range(raw, 0.58, 1));
    incoming.setEq("high", 2.5 * AutoMixer._range(raw, 0.15, 0.74));
    incoming.setFilter(0.72 - 0.22 * progress);
    this._status(raw < 0.58 && allowLoopRoll ? "HYPE: roll to drop" : (bass.inOpen > 0 ? "HYPE: slam open" : "HYPE: build pressure"));
  }

  _recipeCreative(m, out, incoming, raw, progress) {
    const layer = m.plan?.layeringPlan || {};
    const bass = this._applyBassMutex(out, incoming, raw, m.cfg);
    const arc = Math.sin(Math.PI * raw);
    out.setFilter(0.5);
    incoming.setFilter(0.5);
    out.setEcho(0);
    out.setReverb(0);

    if (layer.code === "melody_vocal") {
      out.setEq("mid", 1.5 * AutoMixer._range(raw, 0.05, 0.45) - 7 * AutoMixer._range(raw, 0.72, 1));
      out.setEq("high", 1.2 * AutoMixer._range(raw, 0.05, 0.50) - 4 * AutoMixer._range(raw, 0.80, 1));
      incoming.setEq("mid", 2.5 * AutoMixer._range(raw, 0.14, 0.48));
      incoming.setEq("high", 1.8 * AutoMixer._range(raw, 0.14, 0.55));
      incoming.setFilter(0.58 - 0.08 * AutoMixer._range(raw, 0.20, 0.70));
      out.setReverb(raw > 0.72 ? 0.16 * AutoMixer._range(raw, 0.72, 1) : 0);
      this._status(bass.inOpen > 0 ? "Creative: bass handoff" : "Creative: melody over vocal");
      return;
    }

    if (layer.code === "vocal_groove") {
      out.setEq("mid", -2 * AutoMixer._range(raw, 0.55, 1));
      incoming.setEq("mid", 3.2 * AutoMixer._range(raw, 0.08, 0.42));
      incoming.setEq("high", 2 * AutoMixer._range(raw, 0.08, 0.52));
      incoming.setVolume(0.82 + 0.18 * progress);
      this._status(bass.inOpen > 0 ? "Creative: bass handoff" : "Creative: vocal layer");
      return;
    }

    if (layer.code === "percussion_bed") {
      out.setEq("mid", -3 * AutoMixer._range(raw, 0.55, 1));
      incoming.setEq("high", 2.6 * AutoMixer._range(raw, 0.12, 0.62));
      incoming.setFilter(0.62 - 0.12 * progress);
      out.setEcho(raw > 0.78 ? 0.22 * AutoMixer._range(raw, 0.78, 1) : 0);
      this._status(bass.inOpen > 0 ? "Creative: percussion handoff" : "Creative: percussion bed");
      return;
    }

    if (layer.code === "breakdown_bridge") {
      out.setEq("mid", 1.6 * arc - 6 * AutoMixer._range(raw, 0.70, 1));
      incoming.setEq("mid", 2.2 * AutoMixer._range(raw, 0.10, 0.56));
      out.setReverb(0.18 * AutoMixer._range(raw, 0.28, 0.82));
      incoming.setFilter(0.56 - 0.06 * progress);
      this._status(bass.inOpen > 0 ? "Creative: bridge drop handoff" : "Creative: breakdown bridge");
      return;
    }

    if (layer.code === "echo_tail") {
      const cut = AutoMixer._range(raw, 0.18, 0.62);
      out.setEq("low", -30 * AutoMixer._range(raw, 0.08, 0.36));
      incoming.setEq("low", -24 * (1 - AutoMixer._range(raw, 0.28, 0.58)));
      out.setFilter(0.5 + 0.34 * cut);
      out.setEcho(raw > 0.24 ? 0.54 * AutoMixer._range(raw, 0.24, 0.74) : 0);
      out.setReverb(raw > 0.42 ? 0.20 * AutoMixer._range(raw, 0.42, 1) : 0);
      out.setVolume(1 - 0.78 * AutoMixer._range(raw, 0.50, 0.90));
      incoming.setVolume(0.84 + 0.16 * progress);
      this._status("Creative: echo tail");
      return;
    }

    incoming.setFilter(0.60 - 0.10 * progress);
    incoming.setEq("mid", 1.2 * AutoMixer._range(raw, 0.12, 0.62));
    this._status(bass.inOpen > 0 ? "Creative: bass handoff" : "Creative: bass-safe layer");
  }

  _pickBest(outDeck, tracks) {
    return this._rankCandidates(outDeck, tracks)[0];
  }

  _rankCandidates(outDeck, tracks) {
    const current = outDeck?.track || {};
    const ranked = tracks.slice().sort((a, b) => (
      this._scoreTrack(current, outDeck, a) - this._scoreTrack(current, outDeck, b)
    ));
    const hasBetterKey = ranked.some((track) =>
      track?.camelot && !this._hasLowKeyConfidence(track)
    );
    return hasBetterKey
      ? ranked.filter((track) => !this._hasLowKeyConfidence(track))
      : ranked;
  }

  _scoreTrack(current, outDeck, candidate) {
    const cfg = this._modeConfig();
    let score = 0;
    const refBpm = outDeck?.effectiveBpm() || Number(current.bpm) || 0;
    const bpm = window.DJUtils ? DJUtils.effectiveTrackBpm(candidate, refBpm) : (Number(candidate.bpm) || 0);
    if (bpm && refBpm) {
      const diff = Math.abs(bpm - refBpm);
      score += diff * cfg.bpmWeight;
      if (diff > cfg.bpmLimit) score += cfg.bpmPenalty;
      if (cfg.preferLift && bpm < refBpm - 1) score += (refBpm - bpm) * 2.5;
      if (cfg.preferLift && bpm > refBpm + 7) score += (bpm - refBpm - 7) * 3;
    } else {
      score += 45;
    }
    if (bpm && refBpm && bpm > refBpm + 0.1) {
      score += cfg.tempoDownPenalty || 55;
    }

    score += this._harmonicScore(current.camelot || "", candidate.camelot || "", cfg);
    score -= this._creativeCandidateScore(current, outDeck, candidate, cfg) * (cfg.creativeScoreWeight ?? 0.32);
    if (this._hasLowKeyConfidence(candidate)) {
      score += cfg.lowKeyConfidencePenalty || 0;
    }
    if (cfg.preferLift && this.lastEnergyBoost && this._isEnergyBoost(outDeck, candidate)) {
      score += cfg.repeatBoostPenalty || 0;
    }

    const order = this.queue.findIndex((t) => t.id === candidate.id);
    score += Math.max(0, order) * cfg.orderWeight;
    return score;
  }

  _harmonicScore(refCam, cam, cfg) {
    if (!refCam || !cam) return 20;
    if (cam === refCam) return -40;
    const relation = AutoMixer.camelotRelation(refCam, cam);
    if (relation === "relative") return -(cfg.camelotBonus + 8);
    if (relation === "neighbor") return -cfg.camelotBonus;
    if (relation === "energy") return cfg.allowEnergyBoost ? -cfg.energyBoostBonus : cfg.camelotPenalty;
    return cfg.recipe === "radio" ? cfg.camelotPenalty * 0.45 : cfg.camelotPenalty;
  }

  _isEnergyBoost(outDeck, candidate) {
    const refBpm = outDeck?.effectiveBpm() || Number(outDeck?.track?.bpm) || 0;
    const bpm = window.DJUtils ? DJUtils.effectiveTrackBpm(candidate, refBpm) : (Number(candidate?.bpm) || 0);
    const harmonicBoost = AutoMixer.camelotRelation(
      outDeck?.track?.camelot || "",
      candidate?.camelot || "",
    ) === "energy";
    return harmonicBoost || !!(refBpm && bpm && bpm > refBpm + 1);
  }

  _hasLowKeyConfidence(track) {
    const confidence = Number(track?.key_confidence);
    if (!Number.isFinite(confidence)) return false;
    return confidence < (this._modeConfig().minKeyConfidence ?? 0.22);
  }

  _creativeCandidateScore(current, outDeck, candidate, cfg) {
    const settings = this._creativeSettings();
    if (!settings.enabled || this.creativeCooldownRemaining > 0) return 0;
    if (!current?.camelot || !candidate?.camelot || !candidate?.bpm) return 0;
    if (this._hasLowKeyConfidence(candidate)) return 0;
    if (!this._tempoPilotCandidateAllowsUpOnly(outDeck, candidate)) return 0;
    const relation = AutoMixer.camelotRelation(current.camelot, candidate.camelot);
    if (!AutoMixer.CREATIVE_RELATIONS.has(relation)) return 0;
    if (relation === "energy" && !cfg.allowEnergyBoost && settings.intensity !== "high") return 0;
    let score = 0;
    if (relation === "same") score += 44;
    else if (relation === "relative") score += 40;
    else if (relation === "neighbor") score += 36;
    else if (relation === "energy") score += 24;
    const text = AutoMixer._trackText(candidate);
    if (AutoMixer._hasTextSignal(text, ["house", "tech", "club", "groove"])) score += 8;
    if (AutoMixer._hasTextSignal(text, ["vocal", "vox", "feat", "piano", "synth", "melodic"])) score += 6;
    if (settings.intensity === "high") score += 4;
    return score;
  }

  _creativeSettings() {
    const enabled = document.getElementById("automixCreativeToggle")?.checked !== false;
    const intensity = document.querySelector("[data-automix-intensity].is-active")?.dataset.automixIntensity || "mid";
    const maxBeats = { low: 48, mid: 64, high: 96 }[intensity] || 64;
    return { enabled, intensity, maxBeats };
  }

  _dropGateSettings() {
    const raw = document.querySelector("[data-automix-drop-gate].is-active")?.dataset.automixDropGate || "auto";
    const count = Number(raw);
    return Number.isInteger(count) && count >= 1 && count <= 3 ? count : 0;
  }

  _outgoingDropGate(profile, pos, latestStart) {
    const count = this._dropGateSettings();
    if (!count) return { count: 0, mode: "auto", active: false, satisfied: true, fallback: false };

    const base = { count, mode: String(count), active: false, satisfied: false, fallback: false };
    const dropAt = Array.isArray(profile?.drops) ? Number(profile.drops[count - 1]) : NaN;
    if (!Number.isFinite(dropAt)) {
      return { ...base, fallback: true, reason: `drop ${count} unavailable` };
    }
    if (dropAt <= pos + 0.5) {
      return { ...base, at: dropAt, satisfied: true };
    }
    if (dropAt > latestStart) {
      return { ...base, at: dropAt, fallback: true, reason: `drop ${count} too late` };
    }
    return { ...base, at: dropAt, active: true };
  }

  _dropGateStatusSuffix(gate) {
    if (!gate?.count) return "";
    if (gate.active || gate.satisfied) return ` · after drop ${gate.count}`;
    if (gate.fallback) return ` · ${gate.reason || `drop ${gate.count} fallback`}`;
    return "";
  }

  _dropGateWhy(gate) {
    if (!gate?.count) return "";
    if (gate.active || gate.satisfied) return `after drop ${gate.count}`;
    if (gate.fallback) return gate.reason || `drop ${gate.count} fallback`;
    return "";
  }

  _safeWhy(out, incoming, cfg, outWindow, inTarget, fallback) {
    if (inTarget.bassUnsafe) return inTarget.bassUnsafeReason || "incoming bass-heavy";
    const relation = AutoMixer.camelotRelation(out?.track?.camelot || "", incoming?.track?.camelot || "");
    const bits = [cfg.label.toLowerCase()];
    if (relation && relation !== "unknown") bits.push(relation);
    if (inTarget.bassSafeCue) bits.push("bass-safe cue");
    if (fallback) bits.push("timed fallback");
    else bits.push(`${outWindow.type} -> ${inTarget.type}`);
    const dropGate = this._dropGateWhy(outWindow.dropGate);
    if (dropGate) bits.push(dropGate);
    if (this.creativeCooldownRemaining > 0) bits.push(`creative cooldown ${this.creativeCooldownRemaining}`);
    if (!this._tempoPilotAllowsUpOnly(out, incoming)) bits.push("tempo up-only");
    return bits.join(" · ");
  }

  _tempoPilotCandidateAllowsUpOnly(outDeck, candidate) {
    const target = outDeck?.effectiveBpm?.() || Number(outDeck?.track?.bpm) || 0;
    const bpm = window.DJUtils ? DJUtils.effectiveTrackBpm(candidate, target) : (Number(candidate?.bpm) || 0);
    if (!target || !bpm) return false;
    return bpm <= target + 0.1 && (target / bpm) <= 1.5;
  }

  _tempoPilotAllowsUpOnly(outDeck, incomingDeck) {
    const target = outDeck?.effectiveBpm?.() || Number(outDeck?.track?.bpm) || 0;
    const bpm = incomingDeck?.bpm || Number(incomingDeck?.track?.bpm) || 0;
    if (!target || !bpm) return false;
    return bpm <= target + 0.1 && (target / bpm) <= 1.5;
  }

  _hasAnyBassLightLayer(outProfile, inProfile, plan, inDuration) {
    const inWindow = inProfile?.hasBassLightWindow?.(plan.cueStart || 0, Math.max(4, plan.mixDuration * 0.25), 0.28);
    const inIntro = inProfile?.hasBassLightWindow?.(0, Math.min(16, inDuration * 0.25), 0.28);
    const outBreak = (outProfile?.breakdowns || []).some(([a, b]) => b > plan.startAt && b - a >= 4);
    const outOutro = Number.isFinite(outProfile?.outro_start) && outProfile.outro_start <= plan.startAt + plan.mixDuration;
    return !!(inWindow || inIntro || outBreak || outOutro);
  }

  _hasPerformanceWarning() {
    return !!(
      this.app?.engine?.dropWarning ||
      this.app?.engine?.cpuWarning ||
      document.body?.classList?.contains("drop-warning")
    );
  }

  _recordTransition(plan, out, incoming) {
    this.app?.recordSessionEvent?.({
      type: "automix_transition",
      mixType: plan.mixType || "safe",
      recipe: plan.layeringPlan?.recipeName || plan.recipe,
      reason: plan.why || plan.status,
      creativeScore: plan.creativeScore || 0,
      durationSec: plan.mixDuration,
      from: {
        id: out?.track?.id,
        title: out?.track?.title,
        bpm: out?.effectiveBpm?.(),
        camelot: out?.track?.camelot,
      },
      to: {
        id: incoming?.track?.id,
        title: incoming?.track?.title,
        bpm: incoming?.effectiveBpm?.(),
        camelot: incoming?.track?.camelot,
        pitchPercent: incoming?.pitchPercent,
      },
      layeringPlan: plan.layeringPlan ? {
        recipeName: plan.layeringPlan.recipeName,
        layerStart: plan.layeringPlan.layerStart,
        layerEnd: plan.layeringPlan.layerEnd,
        bassSwapPoint: plan.layeringPlan.bassSwapPoint,
        eqAutomation: plan.layeringPlan.eqAutomation,
        filterAutomation: plan.layeringPlan.filterAutomation,
        fxAutomation: plan.layeringPlan.fxAutomation,
      } : null,
    });
  }

  _mixDuration(deck, cfg = this._modeConfig()) {
    const beatSec = 60 / (deck.effectiveBpm() || deck.bpm || 120);
    return Math.max(cfg.minDuration, Math.min(cfg.maxDuration, beatSec * (cfg.liveOverlapBeats || cfg.beats)));
  }

  _beatsToSec(deck, beats) {
    const bpm = deck?.effectiveBpm?.() || deck?.bpm || 120;
    return Math.max(0, beats || 0) * 60 / bpm;
  }

  _crossProgress(raw, cfg) {
    if (String(cfg.recipe || "").startsWith("creative_")) {
      if (raw < 0.45) return raw * 0.55;
      if (raw < 0.78) return 0.25 + 0.30 * AutoMixer._range(raw, 0.45, 0.78);
      return 0.55 + 0.45 * Math.pow(AutoMixer._range(raw, 0.78, 1), 0.55);
    }
    if (cfg.recipe === "bass") {
      if (raw < 0.32) return raw * 0.95;
      if (raw < 0.68) return 0.30 + 0.18 * AutoMixer._range(raw, 0.32, 0.68);
      return 0.48 + 0.52 * AutoMixer._range(raw, 0.68, 1);
    }
    if (cfg.recipe === "hype") {
      if (raw < 0.22) return raw * 0.85;
      if (raw < 0.58) return 0.18 + 0.18 * AutoMixer._range(raw, 0.22, 0.58);
      return 0.36 + 0.64 * Math.pow(AutoMixer._range(raw, 0.58, 1), 0.45);
    }
    if (cfg.recipe === "radio") {
      if (raw < 0.18) return raw * 1.1;
      return 0.20 + 0.80 * Math.pow(AutoMixer._range(raw, 0.18, 1), 0.38);
    }
    return raw * raw * (3 - 2 * raw);
  }

  _resetDeckPerformance(deck) {
    if (!deck) return;
    deck.loops?.exit();
    deck.loops?.setSlip(false);
    deck.setEcho(0);
    deck.setReverb(0);
    deck.setGate(0, (deck.effectiveBpm() || 120) / 60 * 4);
    deck.setEq("low", 0);
    deck.setEq("mid", 0);
    deck.setEq("high", 0);
    deck.setFilter(0.5);
    deck.setVolume(1);
  }

  _resetAllPerformance() {
    this._resetDeckPerformance(this.app.decks[0]);
    this._resetDeckPerformance(this.app.decks[1]);
    this.app.refreshDeck(0);
    this.app.refreshDeck(1);
  }

  _modeConfig() {
    const mode = document.querySelector("[data-automix-mode].is-active")?.dataset.automixMode || "hype";
    const modes = {
      club: {
        label: "CLUB", move: "32 beat bass swap", recipe: "club",
        beats: 32, liveOverlapBeats: 48, minDuration: 16, maxDuration: 42,
        inLowStart: -30, inFilterStart: 0.58, waitForOutro: false, prepLead: 18,
        dropAt: 0.46, snapPhrase: true, snapEarlier: true, phraseBeats: 32, loopRollMin: 999,
        mixOutAt: 0.48, startLeadBeats: 16, buildLeadRatio: 0.35,
        bassSwapAt: 0.50, bassFadeWidth: 0.16,
        incomingLowFloor: -30, outgoingLowFloor: -30, recentLimit: 28,
        bpmWeight: 4, bpmLimit: 8, bpmPenalty: 35,
        camelotBonus: 16, camelotPenalty: 50, orderWeight: 0.5,
        tempoDownPenalty: 70, creativeScoreWeight: 0.34,
        minKeyConfidence: 0.22, lowKeyConfidencePenalty: 35,
        preferLift: false, allowEnergyBoost: false, energyBoostBonus: 0, repeatBoostPenalty: 0,
      },
      hype: {
        label: "HYPE", move: "early build + loop slam", recipe: "hype",
        beats: 24, liveOverlapBeats: 40, minDuration: 14, maxDuration: 34,
        inLowStart: -30, inFilterStart: 0.72, waitForOutro: false, prepLead: 34,
        dropAt: 0.78, snapPhrase: true, snapEarlier: true, phraseBeats: 16, loopRollMin: 10,
        mixOutAt: 0.36, startLeadBeats: 16, buildLeadRatio: 0.55,
        bassSwapAt: 0.62, bassFadeWidth: 0.16,
        incomingLowFloor: -30, outgoingLowFloor: -30, recentLimit: 28,
        bpmWeight: 3, bpmLimit: 10, bpmPenalty: 26,
        camelotBonus: 12, camelotPenalty: 30, orderWeight: 0.35,
        tempoDownPenalty: 62, creativeScoreWeight: 0.30,
        minKeyConfidence: 0.20, lowKeyConfidencePenalty: 24,
        preferLift: true, allowEnergyBoost: true, energyBoostBonus: 8, repeatBoostPenalty: 18,
      },
      radio: {
        label: "RADIO", move: "8 beat echo cut", recipe: "radio",
        beats: 8, liveOverlapBeats: 12, minDuration: 5, maxDuration: 12,
        inLowStart: -18, inFilterStart: 0.50, waitForOutro: false, prepLead: 14,
        dropAt: 0.25, snapPhrase: true, snapEarlier: true, phraseBeats: 8, loopRollMin: 999,
        mixOutAt: 0.34, startLeadBeats: 8, buildLeadRatio: 0.20,
        bassSwapAt: 0.30, bassFadeWidth: 0.10,
        incomingLowFloor: -18, outgoingLowFloor: -26, recentLimit: 24,
        bpmWeight: 2, bpmLimit: 12, bpmPenalty: 18,
        camelotBonus: 8, camelotPenalty: 18, orderWeight: 1.4,
        tempoDownPenalty: 45, creativeScoreWeight: 0.20,
        minKeyConfidence: 0.22, lowKeyConfidencePenalty: 24,
        preferLift: false, allowEnergyBoost: false, energyBoostBonus: 0, repeatBoostPenalty: 0,
      },
      bass: {
        label: "BASS", move: "64 beat low-end handoff", recipe: "bass",
        beats: 64, liveOverlapBeats: 64, minDuration: 24, maxDuration: 54,
        inLowStart: -32, inFilterStart: 0.62, waitForOutro: false, prepLead: 30,
        dropAt: 0.36, snapPhrase: true, snapEarlier: true, phraseBeats: 32, loopRollMin: 999,
        mixOutAt: 0.38, startLeadBeats: 24, buildLeadRatio: 0.45,
        bassSwapAt: 0.70, bassFadeWidth: 0.18,
        incomingLowFloor: -30, outgoingLowFloor: -32, recentLimit: 28,
        bpmWeight: 4.5, bpmLimit: 6, bpmPenalty: 42,
        camelotBonus: 14, camelotPenalty: 46, orderWeight: 0.6,
        tempoDownPenalty: 78, creativeScoreWeight: 0.32,
        minKeyConfidence: 0.24, lowKeyConfidencePenalty: 38,
        preferLift: false, allowEnergyBoost: false, energyBoostBonus: 0, repeatBoostPenalty: 0,
      },
    };
    return modes[mode] || modes.hype;
  }

  _playingDeckIndex() {
    const playing = this.app.decks
      .map((d, idx) => ({ d, idx }))
      .filter(({ d }) => d.isPlaying);
    if (!playing.length) return null;
    if (playing.length === 1) return playing[0].idx;
    return this.app.engine.crossfader < 0.5 ? 0 : 1;
  }

  _setButton(on) {
    const btn = document.getElementById("automixBtn");
    if (!btn) return;
    btn.classList.toggle("is-active", on);
    btn.textContent = on ? "STOP AUTO" : "AUTO MIX";
  }

  _status(text) {
    if (this.active && this.usingLibraryFallback && text && !text.includes("library fallback")) {
      text = `${text} · library fallback`;
    }
    if (text === this.lastMessage) return;
    this.lastMessage = text;
    const status = document.getElementById("automixStatus");
    if (status) status.textContent = text;
  }

  static _range(v, a, b) {
    return Math.max(0, Math.min(1, (v - a) / (b - a)));
  }

  static _deckLabel(idx) {
    return idx === 0 ? "A" : "B";
  }

  static _fmtShort(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  static _fmtCountdown(sec) {
    if (!Number.isFinite(sec)) sec = 0;
    if (sec <= 0) return "now";
    return `+${AutoMixer._fmtShort(sec)}`;
  }

  static _escape(text) {
    return String(text || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  static _trackText(track) {
    const tags = Array.isArray(track?.tags) ? track.tags.join(" ") : (track?.tags || "");
    return `${track?.title || ""} ${track?.artist || ""} ${track?.genre || ""} ${tags}`.toLowerCase();
  }

  static _hasTextSignal(text, words) {
    const haystack = String(text || "").toLowerCase();
    return words.some((word) => haystack.includes(word));
  }

  static camelotRelation(ref, candidate) {
    if (window.DJUtils) return DJUtils.camelotRelation(ref, candidate);
    if (!ref || !candidate || ref.length < 2 || candidate.length < 2) return "clash";
    if (ref === candidate) return "same";
    const refNum = parseInt(ref.slice(0, -1), 10);
    const candNum = parseInt(candidate.slice(0, -1), 10);
    const refLetter = ref.slice(-1);
    const candLetter = candidate.slice(-1);
    if (!refNum || !candNum || !["A", "B"].includes(refLetter) || !["A", "B"].includes(candLetter)) {
      return "clash";
    }
    if (refNum === candNum && refLetter !== candLetter) return "relative";
    const up = (refNum % 12) + 1;
    const down = ((refNum + 10) % 12) + 1;
    if (refLetter === candLetter && (candNum === up || candNum === down)) return "neighbor";
    const upTwo = ((refNum + 1) % 12) + 1;
    if (candLetter === refLetter && candNum === upTwo) return "energy";
    return "clash";
  }

  static camelotNeighbors(c) {
    if (!c || c.length < 2) return [];
    const num = parseInt(c.slice(0, -1), 10);
    const letter = c.slice(-1);
    if (!num || (letter !== "A" && letter !== "B")) return [];
    const other = letter === "A" ? "B" : "A";
    const up = (num % 12) + 1;
    const down = ((num + 10) % 12) + 1;
    return [`${num}${other}`, `${up}${letter}`, `${down}${letter}`];
  }
}

AutoMixer.CREATIVE_RELATIONS = new Set(["same", "relative", "neighbor", "energy"]);
window.AutoMixer = AutoMixer;

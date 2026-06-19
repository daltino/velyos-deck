const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");

function loadBrowserScripts(files) {
  const documentState = {
    mode: "club",
    creative: true,
    intensity: "mid",
    dropGate: "auto",
  };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        checked: true,
        textContent: "",
        innerHTML: "",
        dataset: {},
        classList: {
          toggle() {},
          contains() { return false; },
        },
        appendChild() {},
        remove() {},
      });
    }
    return elements.get(id);
  };
  const context = {
    console,
    performance: { now: () => 0 },
    fetch: async () => { throw new Error("fetch is not available in tests"); },
    documentState,
    document: {
      body: { classList: { contains: () => false } },
      head: { appendChild() {} },
      getElementById(id) {
        if (id === "automixCreativeToggle") {
          return { checked: documentState.creative };
        }
        return element(id);
      },
      querySelector(selector) {
        if (selector === "[data-automix-mode].is-active") {
          return { dataset: { automixMode: documentState.mode } };
        }
        if (selector === "[data-automix-intensity].is-active") {
          return { dataset: { automixIntensity: documentState.intensity } };
        }
        if (selector === "[data-automix-drop-gate].is-active") {
          return { dataset: { automixDropGate: documentState.dropGate } };
        }
        return null;
      },
      querySelectorAll() {
        return [];
      },
      createElement(tagName) {
        return {
          tagName,
          dataset: {},
          set rel(value) { this._rel = value; },
          set as(value) { this._as = value; },
          set href(value) { this._href = value; },
          remove() {},
        };
      },
    },
    localStorage: {
      getItem() { return null; },
      setItem() {},
    },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of files) {
    vm.runInContext(
      fs.readFileSync(path.join(repoRoot, file), "utf8"),
      context,
      { filename: file },
    );
  }
  return context;
}

function loadAutoMixContext() {
  return loadBrowserScripts(["dj/dj-utils.js", "dj/automix.js"]);
}

function fakeProfile({
  drops = [64],
  builds = [],
  breakdowns = [],
  outroStart = 210,
  introEnd = 32,
  bassFreeRegions = [[0, 96]],
  heavy = false,
  section = "groove",
  energy = 0.6,
} = {}) {
  return {
    drops,
    builds,
    breakdowns,
    outro_start: outroStart,
    intro_end: introEnd,
    bassFreeRegions,
    hasBassStem: true,
    hasBassLightWindow(start, duration) {
      return bassFreeRegions.some(([a, b]) => start >= a && start + duration <= b);
    },
    isBassHeavy() {
      return heavy;
    },
    sectionAt() {
      return section;
    },
    energyAt() {
      return energy;
    },
  };
}

function fakeDeck({
  idx,
  id,
  title,
  bpm,
  camelot,
  duration = 240,
  position = 80,
  keyConfidence = 0.9,
  profileText = "",
}) {
  return {
    idx,
    buffer: { duration },
    track: {
      id,
      title,
      artist: "",
      genre: profileText,
      tags: profileText,
      bpm,
      raw_bpm: bpm,
      camelot,
      key_confidence: keyConfidence,
    },
    bpm,
    pitchPercent: 0,
    isPlaying: true,
    beatOffset: 0,
    duration() { return duration; },
    position() { return position; },
    effectiveBpm() { return this.bpm * (1 + this.pitchPercent / 100); },
    syncTo(otherDeck, opts = {}) {
      const target = otherDeck.effectiveBpm();
      let pitch = ((target / this.bpm) - 1) * 100;
      if (opts.upOnly) pitch = Math.max(0, pitch);
      this.pitchPercent = Math.max(-50, Math.min(50, pitch));
    },
    seek(sec) { this.startedAtTrack = sec; },
    phaseAlignTo() {},
    play() { this.isPlaying = true; },
    stop() { this.isPlaying = false; },
    setVolume(value) { this.volume = value; },
    setEq(band, value) { this.eq = { ...(this.eq || {}), [band]: value }; },
    setFilter(value) { this.filter = value; },
    setEcho(value) { this.echo = value; },
    setReverb(value) { this.reverb = value; },
    setGate(value) { this.gate = value; },
    loops: {
      exit() {},
      setSlip() {},
    },
  };
}

function makeMixer({
  outBpm = 128,
  inBpm = 126,
  outCamelot = "8A",
  inCamelot = "9A",
  outProfile = fakeProfile({ breakdowns: [[120, 150]], section: "breakdown" }),
  inProfile = fakeProfile({ bassFreeRegions: [[0, 96]] }),
  outPosition = 80,
  inTitle = "Incoming Vocal",
  inText = "vocal house",
} = {}) {
  const context = loadAutoMixContext();
  const outDeck = fakeDeck({
    idx: 0,
    id: "out",
    title: "Outgoing Melodic Synth",
    bpm: outBpm,
    camelot: outCamelot,
    position: outPosition,
    profileText: "melodic synth house",
  });
  const inDeck = fakeDeck({
    idx: 1,
    id: "in",
    title: inTitle,
    bpm: inBpm,
    camelot: inCamelot,
    position: 0,
    profileText: inText,
  });
  const app = {
    decks: [outDeck, inDeck],
    engine: { ctx: { currentTime: 0 }, crossfader: 0 },
    coach: { profiles: [outProfile, inProfile] },
    library: {
      tracks: [],
      getPrepareTracks: () => [],
      removeFromPrepare() {},
    },
    generative: { stopFill() {}, triggerFill() {} },
    _setCrossfader(value) { this.engine.crossfader = value; },
    refreshDeck() {},
    recordSessionEvent() {},
  };
  const mixer = new context.AutoMixer(app);
  mixer.outIdx = 0;
  mixer.inIdx = 1;
  mixer.nextTrack = inDeck.track;
  return { context, mixer, app, outDeck, inDeck };
}

function labels(plan) {
  return (plan.events || []).map((event) => event.label);
}

test("creative compatible neighbor selects creative with layering metadata", () => {
  const { mixer, outDeck, inDeck } = makeMixer();

  const plan = mixer._buildTransitionPlan(outDeck, inDeck);

  assert.equal(plan.mixType, "creative");
  assert.match(plan.why, /melody bed|vocal|neighbor/i);
  assert.ok(plan.layeringPlan);
  assert.equal(plan.layeringPlan.code, "melody_vocal");
  assert.equal(plan.layeringPlan.camelotText, "8A -> 9A");
});

test("incompatible Camelot relation stays safe", () => {
  const { mixer, outDeck, inDeck } = makeMixer({ inCamelot: "4B" });

  const plan = mixer._buildTransitionPlan(outDeck, inDeck);

  assert.equal(plan.mixType, "safe");
  assert.equal(plan.layeringPlan, null);
  assert.match(plan.why, /clash/i);
});

test("faster incoming tempo is rejected for creative and up-only sync never pitches down", () => {
  const { mixer, outDeck, inDeck } = makeMixer({
    outBpm: 132,
    inBpm: 134,
    outCamelot: "8A",
    inCamelot: "9A",
  });

  const plan = mixer._buildTransitionPlan(outDeck, inDeck);
  mixer._prepareIncomingForPlan(plan);

  assert.equal(plan.mixType, "safe");
  assert.match(plan.why, /tempo up-only/i);
  assert.equal(inDeck.pitchPercent, 0);
});

test("two bass-heavy overlap candidates do not become creative", () => {
  const outProfile = fakeProfile({
    breakdowns: [[120, 150]],
    bassFreeRegions: [[0, 240]],
    heavy: true,
    section: "breakdown",
  });
  const inProfile = fakeProfile({
    bassFreeRegions: [[0, 96]],
    heavy: true,
  });
  const { mixer, outDeck, inDeck } = makeMixer({ outProfile, inProfile });

  const plan = mixer._buildTransitionPlan(outDeck, inDeck);

  assert.equal(plan.mixType, "safe");
  assert.equal(plan.layeringPlan, null);
  assert.equal(plan.bassUnsafe, false);
});

test("creative cooldown blocks the next two otherwise creative transitions", () => {
  const { mixer, outDeck, inDeck } = makeMixer();

  const first = mixer._buildTransitionPlan(outDeck, inDeck);
  assert.equal(first.mixType, "creative");

  mixer.creativeCooldownRemaining = 2;
  const second = mixer._buildTransitionPlan(outDeck, inDeck);
  assert.equal(second.mixType, "safe");
  assert.match(second.why, /creative cooldown 2/i);

  mixer.creativeCooldownRemaining = 1;
  const third = mixer._buildTransitionPlan(outDeck, inDeck);
  assert.equal(third.mixType, "safe");
  assert.match(third.why, /creative cooldown 1/i);

  mixer.creativeCooldownRemaining = 0;
  const fourth = mixer._buildTransitionPlan(outDeck, inDeck);
  assert.equal(fourth.mixType, "creative");
});

test("DROP 2 gate delays outgoing transition until second drop", () => {
  const outProfile = fakeProfile({
    drops: [60, 128],
    builds: [150],
    breakdowns: [[132, 154]],
    outroStart: 210,
  });
  const { context, mixer, outDeck, inDeck } = makeMixer({ outProfile, outPosition: 70 });
  context.documentState.creative = false;
  context.documentState.dropGate = "2";

  const plan = mixer._buildTransitionPlan(outDeck, inDeck);

  assert.equal(plan.outGate.count, 2);
  assert.equal(plan.outGate.active, true);
  assert.ok(plan.startAt >= 128, `expected startAt >= 128, got ${plan.startAt}`);
  assert.match(plan.why, /after drop 2/i);
  assert.ok(labels(plan).includes("DROP 2 GATE"));
});

test("DROP 2 gate is satisfied when current playback is already past second drop", () => {
  const outProfile = fakeProfile({
    drops: [60, 128],
    builds: [170],
    breakdowns: [[160, 182]],
    outroStart: 220,
  });
  const auto = makeMixer({ outProfile, outPosition: 150 });
  auto.context.documentState.creative = false;
  const gated = makeMixer({ outProfile, outPosition: 150 });
  gated.context.documentState.creative = false;
  gated.context.documentState.dropGate = "2";

  const autoPlan = auto.mixer._buildTransitionPlan(auto.outDeck, auto.inDeck);
  const gatedPlan = gated.mixer._buildTransitionPlan(gated.outDeck, gated.inDeck);

  assert.equal(gatedPlan.outGate.satisfied, true);
  assert.equal(gatedPlan.outGate.active, false);
  assert.equal(gatedPlan.startAt, autoPlan.startAt);
  assert.ok(!labels(gatedPlan).includes("DROP 2 GATE"));
});

test("missing requested drop falls back to normal AutoMix planning", () => {
  const outProfile = fakeProfile({
    drops: [60],
    builds: [150],
    breakdowns: [[132, 154]],
    outroStart: 210,
  });
  const auto = makeMixer({ outProfile, outPosition: 70 });
  auto.context.documentState.creative = false;
  const gated = makeMixer({ outProfile, outPosition: 70 });
  gated.context.documentState.creative = false;
  gated.context.documentState.dropGate = "2";

  const autoPlan = auto.mixer._buildTransitionPlan(auto.outDeck, auto.inDeck);
  const gatedPlan = gated.mixer._buildTransitionPlan(gated.outDeck, gated.inDeck);

  assert.equal(gatedPlan.outGate.fallback, true);
  assert.equal(gatedPlan.startAt, autoPlan.startAt);
  assert.match(gatedPlan.why, /drop 2 unavailable/i);
});

test("creative plan respects DROP 2 gate after phrase snapping", () => {
  const outProfile = fakeProfile({
    drops: [60, 128],
    builds: [150],
    breakdowns: [[132, 154]],
    outroStart: 210,
    section: "breakdown",
  });
  const { context, mixer, outDeck, inDeck } = makeMixer({ outProfile, outPosition: 70 });
  context.documentState.dropGate = "2";

  const plan = mixer._buildTransitionPlan(outDeck, inDeck);

  assert.equal(plan.mixType, "creative");
  assert.equal(plan.outGate.active, true);
  assert.ok(plan.startAt >= 128, `expected creative startAt >= 128, got ${plan.startAt}`);
  assert.ok(labels(plan).includes("DROP 2 GATE"));
});

test("creative timeline includes layer events while safe plan keeps safe events", () => {
  const creative = makeMixer();
  const creativePlan = creative.mixer._buildTransitionPlan(creative.outDeck, creative.inDeck);
  assert.equal(creativePlan.mixType, "creative");
  assert.ok(labels(creativePlan).includes("MELODY BED"));
  assert.ok(labels(creativePlan).includes("LAYER VOCAL"));
  assert.ok(labels(creativePlan).includes("BASS HANDOFF"));

  const safe = makeMixer({ inCamelot: "4B" });
  const safePlan = safe.mixer._buildTransitionPlan(safe.outDeck, safe.inDeck);
  assert.equal(safePlan.mixType, "safe");
  assert.ok(labels(safePlan).includes("CUE B"));
  assert.ok(labels(safePlan).includes("START MIX"));
  assert.ok(labels(safePlan).includes("LOW LOCK"));
  assert.ok(labels(safePlan).some((label) => label === "BASS SWAP" || label === "BASS HIT"));
});

test("Deck.syncTo upOnly clamps faster incoming tracks at zero pitch", () => {
  const context = loadBrowserScripts(["dj/cues.js", "dj/deck.js"]);
  context.LoopEngine = class {};
  const engine = { ctx: { currentTime: 0 } };
  const incoming = new context.Deck(1, engine);
  const outgoing = new context.Deck(0, engine);
  incoming.bpm = 134;
  outgoing.bpm = 132;
  outgoing.effectiveBpm = () => 132;

  incoming.syncTo(outgoing, { upOnly: true });

  assert.equal(incoming.pitchPercent, 0);
});

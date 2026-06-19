// sb3-mapping.js - Pioneer DDJ-SB3 MIDI map -> app actions
//
// Source of truth: AlphaTheta "DDJ-SB3 List of MIDI messages ver. 1.01".
// This app intentionally exposes DDJ-SB3 as a practical 2-deck controller:
// Deck 1/2 map to A/B, Deck 3/4 layer messages are accepted but ignored.

const SB3 = {
  PLAY: 0x0B,
  PLAY_SHIFT: 0x47,
  CUE: 0x0C,
  CUE_SHIFT: 0x48,
  SYNC: 0x58,
  SYNC_SHIFT: 0x5C,
  KEYLOCK: 0x1A,
  KEYLOCK_SHIFT: 0x60,
  SHIFT: 0x3F,
  VINYL: 0x17,
  VINYL_SHIFT: 0x40,
  DECK: 0x72,
  DECK_SHIFT: 0x73,
  AUTO_LOOP: 0x14,
  AUTO_LOOP_SHIFT: 0x50,
  LOOP_HALF: 0x12,
  LOOP_HALF_SHIFT: 0x61,
  LOOP_DOUBLE: 0x13,
  LOOP_DOUBLE_SHIFT: 0x62,
  CUE_HEADPHONE: 0x54,
  CUE_HEADPHONE_SHIFT: 0x68,
  CH_FADER_START_PLAY: 0x66,
  CH_FADER_START_SYNC: 0x51,
  CH_FADER_START_CUE: 0x52,

  TEMPO_MSB: 0x00,
  TEMPO_LSB: 0x20,
  TEMPO_SHIFT_MSB: 0x05,
  TEMPO_SHIFT_LSB: 0x25,
  TRIM_MSB: 0x04,
  TRIM_LSB: 0x24,
  EQ_HIGH_MSB: 0x07,
  EQ_HIGH_LSB: 0x27,
  EQ_MID_MSB: 0x0B,
  EQ_MID_LSB: 0x2B,
  EQ_LOW_MSB: 0x0F,
  EQ_LOW_LSB: 0x2F,
  CH_VOL_MSB: 0x13,
  CH_VOL_LSB: 0x33,
  JOG_PLATTER_VINYL: 0x22,
  JOG_PLATTER_NOVINYL: 0x23,
  JOG_SEARCH: 0x1F,
  JOG_TOUCH: 0x36,
  JOG_TOUCH_SHIFT: 0x67,
  JOG_SIDE: 0x21,
  JOG_SIDE_SHIFT: 0x26,

  FX_BUTTONS: [0x47, 0x48, 0x49],
  FX_SHIFT_BUTTONS: [0x63, 0x64, 0x65],
  FX_LEVEL_MSB: [0x02, 0x04, 0x06],
  FX_LEVEL_LSB: [0x22, 0x24, 0x26],
  FX_SHIFT_LEVEL_MSB: 0x12,
  FX_SHIFT_LEVEL_LSB: 0x32,

  MASTER_MSB: 0x08,
  MASTER_LSB: 0x28,
  HEADPHONES_MSB: 0x0D,
  HEADPHONES_LSB: 0x2D,
  MASTER_CUE: 0x5B,
  MASTER_CUE_SHIFT: 0x78,
  XFADER_MSB: 0x1F,
  XFADER_LSB: 0x3F,
  FILTER_MSB: [0x17, 0x18],
  FILTER_LSB: [0x37, 0x38],
  BROWSE: 0x40,
  BROWSE_SHIFT: 0x64,
  BROWSE_PRESS: 0x41,
  BROWSE_PRESS_SHIFT: 0x42,
  LOAD_A: 0x46,
  LOAD_A_SHIFT: 0x58,
  LOAD_B: 0x47,
  LOAD_B_SHIFT: 0x59,
  LOAD_DECK3: 0x48,
  LOAD_DECK3_SHIFT: 0x60,
  LOAD_DECK4: 0x49,
  LOAD_DECK4_SHIFT: 0x61,

  PAD_MODE_HOT_CUE: 0x1B,
  PAD_MODE_HOT_CUE_SHIFT: 0x69,
  PAD_MODE_FX_FADE: 0x1E,
  PAD_MODE_FX_FADE_SHIFT: 0x6B,
  PAD_MODE_PAD_SCRATCH: 0x20,
  PAD_MODE_PAD_SCRATCH_SHIFT: 0x6D,
  PAD_MODE_SAMPLER: 0x22,
  PAD_MODE_SAMPLER_SHIFT: 0x6E,
  PAD_BASES: {
    hotCue: 0x00,
    fxFade: 0x10,
    padScratch: 0x20,
    sampler: 0x30,
    beatJump: 0x40,
    roll: 0x50,
    slicer: 0x60,
    trans: 0x70,
  },
};

const SB3_PAD_MODE_BY_NOTE = {
  [SB3.PAD_MODE_HOT_CUE]: "hotCue",
  [SB3.PAD_MODE_HOT_CUE_SHIFT]: "beatJump",
  [SB3.PAD_MODE_FX_FADE]: "fxFade",
  [SB3.PAD_MODE_FX_FADE_SHIFT]: "roll",
  [SB3.PAD_MODE_PAD_SCRATCH]: "padScratch",
  [SB3.PAD_MODE_PAD_SCRATCH_SHIFT]: "slicer",
  [SB3.PAD_MODE_SAMPLER]: "sampler",
  [SB3.PAD_MODE_SAMPLER_SHIFT]: "trans",
};

class CC14Reassembler {
  constructor() { this.msbs = new Map(); }

  push(channel, msbCC, value, isLsb) {
    const key = `${channel}:${msbCC}`;
    if (!isLsb) {
      this.msbs.set(key, value & 0x7F);
      return null;
    }
    const msb = this.msbs.get(key) ?? 0;
    return ((msb << 7) | (value & 0x7F)) / 16383;
  }
}

function ensureSB3State(state) {
  if (!state.cc14) state.cc14 = new CC14Reassembler();
  if (!state.padModes) state.padModes = ["hotCue", "hotCue"];
  if (!state.shiftDown) state.shiftDown = [false, false];
  if (state.vinylMode == null) state.vinylMode = [true, true];
  return state;
}

function sb3RelativeJog(value) {
  if (value === 0x40 || value === 0) return 0;
  return value > 0x40 ? value - 0x40 : value - 0x80;
}

function sb3RelativeBrowse(value) {
  if (value >= 0x01 && value <= 0x1E) return value;
  if (value >= 0x62 && value <= 0x7F) return value - 0x80;
  return 0;
}

function cc14Action(state, out, channel, d1, d2, pairs) {
  for (const [msb, lsb, action, extra = {}] of pairs) {
    if (d1 === msb) {
      state.cc14.push(channel, msb, d2, false);
      return true;
    }
    if (d1 === lsb) {
      const value = state.cc14.push(channel, msb, d2, true);
      if (value != null) out.push({ action, value, ...extra });
      return true;
    }
  }
  return false;
}

function translatePad(deck, note, pressed, state) {
  const out = [];
  const mode = state.padModes[deck] || "hotCue";
  for (const [name, base] of Object.entries(SB3.PAD_BASES)) {
    if (note >= base && note < base + 0x10) {
      const slot = note - base;
      out.push({ action: "pad", deck, mode: name, slot: slot % 8, shifted: slot >= 8, pressed });
      return out;
    }
  }
  if (note < 0x10) {
    out.push({ action: "pad", deck, mode, slot: note % 8, shifted: note >= 8, pressed });
  }
  return out;
}

function translateSB3(bytes, state = {}) {
  state = ensureSB3State(state);
  const status = bytes[0] ?? 0;
  const d1 = bytes[1] ?? 0;
  const d2 = bytes[2] ?? 0;
  const cmd = status & 0xF0;
  const ch = status & 0x0F;
  const isNote = cmd === 0x90 || cmd === 0x80;
  const pressed = cmd === 0x90 && d2 > 0;
  const out = [];

  if (isNote && (ch === 0 || ch === 1)) {
    const deck = ch;
    if (d1 === SB3.SHIFT) {
      state.shiftDown[deck] = pressed;
      out.push({ action: "shift", deck, pressed });
      return out;
    }
    if (SB3_PAD_MODE_BY_NOTE[d1] && pressed) {
      const mode = SB3_PAD_MODE_BY_NOTE[d1];
      state.padModes[deck] = mode;
      out.push({ action: "padMode", deck, mode });
      return out;
    }
    switch (d1) {
      case SB3.PLAY:
        if (pressed) out.push({ action: "play", deck });
        break;
      case SB3.PLAY_SHIFT:
        if (pressed) out.push({ action: "startStop", deck });
        break;
      case SB3.CUE:
        out.push({ action: "cue", deck, pressed });
        break;
      case SB3.CUE_SHIFT:
        if (pressed) out.push({ action: "jumpStart", deck });
        break;
      case SB3.SYNC:
        if (pressed) out.push({ action: "sync", deck });
        break;
      case SB3.SYNC_SHIFT:
        if (pressed) out.push({ action: "syncOff", deck });
        break;
      case SB3.KEYLOCK:
        if (pressed) out.push({ action: "keylock", deck });
        break;
      case SB3.KEYLOCK_SHIFT:
        if (pressed) out.push({ action: "tempoRange", deck });
        break;
      case SB3.VINYL:
        if (pressed) {
          state.vinylMode[deck] = !state.vinylMode[deck];
          out.push({ action: "vinyl", deck, on: state.vinylMode[deck] });
        }
        break;
      case SB3.VINYL_SHIFT:
        if (pressed) out.push({ action: "slip", deck });
        break;
      case SB3.DECK:
      case SB3.DECK_SHIFT:
        if (pressed) out.push({ action: "deckLayerIgnored", deck });
        break;
      case SB3.AUTO_LOOP:
        if (pressed) out.push({ action: "autoLoop", deck });
        break;
      case SB3.AUTO_LOOP_SHIFT:
        if (pressed) out.push({ action: "reloopExit", deck });
        break;
      case SB3.LOOP_HALF:
        if (pressed) out.push({ action: "loopHalf", deck });
        break;
      case SB3.LOOP_HALF_SHIFT:
        if (pressed) out.push({ action: "loopIn", deck });
        break;
      case SB3.LOOP_DOUBLE:
        if (pressed) out.push({ action: "loopDouble", deck });
        break;
      case SB3.LOOP_DOUBLE_SHIFT:
        if (pressed) out.push({ action: "loopOut", deck });
        break;
      case SB3.JOG_TOUCH:
      case SB3.JOG_TOUCH_SHIFT:
        out.push({ action: "jogTouch", deck, pressed });
        break;
      case SB3.CUE_HEADPHONE:
        if (pressed) out.push({ action: "cueListen", deck });
        break;
      case SB3.CUE_HEADPHONE_SHIFT:
        if (pressed) out.push({ action: "cueListenOff", deck });
        break;
      case SB3.CH_FADER_START_PLAY:
        if (pressed) out.push({ action: "play", deck });
        break;
      case SB3.CH_FADER_START_SYNC:
        if (pressed) out.push({ action: "sync", deck });
        break;
      case SB3.CH_FADER_START_CUE:
        if (pressed) out.push({ action: "cue", deck, pressed: true });
        break;
    }
  }

  if (isNote && (status === 0x94 || status === 0x95)) {
    const deck = status - 0x94;
    const idx = SB3.FX_BUTTONS.indexOf(d1);
    const shiftIdx = SB3.FX_SHIFT_BUTTONS.indexOf(d1);
    if (idx >= 0) out.push({ action: "fxButton", deck, fx: idx, pressed });
    if (shiftIdx >= 0) out.push({ action: "fxShiftButton", deck, fx: shiftIdx, pressed });
  }

  if (isNote && status === 0x96) {
    if (d1 === SB3.BROWSE_PRESS && pressed) out.push({ action: "browserPress" });
    if (d1 === SB3.BROWSE_PRESS_SHIFT && pressed) out.push({ action: "browserBack" });
    if (d1 === SB3.LOAD_A && pressed) out.push({ action: "loadSelected", deck: 0 });
    if (d1 === SB3.LOAD_B && pressed) out.push({ action: "loadSelected", deck: 1 });
    if (d1 === SB3.LOAD_A_SHIFT && pressed) out.push({ action: "sortLibrary", key: "bpm" });
    if (d1 === SB3.LOAD_B_SHIFT && pressed) out.push({ action: "sortLibrary", key: "artist" });
    if ((d1 === SB3.LOAD_DECK3 || d1 === SB3.LOAD_DECK4 ||
         d1 === SB3.LOAD_DECK3_SHIFT || d1 === SB3.LOAD_DECK4_SHIFT) && pressed) {
      out.push({ action: "deckLayerIgnored" });
    }
    if (d1 === SB3.MASTER_CUE && pressed) out.push({ action: "masterCue" });
    if (d1 === SB3.MASTER_CUE_SHIFT && pressed) out.push({ action: "allCueOff" });
  }

  if (isNote && (status === 0x97 || status === 0x98)) {
    out.push(...translatePad(status - 0x97, d1, pressed, state));
  }

  if (cmd === 0xB0 && (ch === 0 || ch === 1)) {
    const deck = ch;
    if (cc14Action(state, out, ch, d1, d2, [
      [SB3.TEMPO_MSB, SB3.TEMPO_LSB, "tempo", { deck }],
      [SB3.TEMPO_SHIFT_MSB, SB3.TEMPO_SHIFT_LSB, "tempoFine", { deck }],
      [SB3.TRIM_MSB, SB3.TRIM_LSB, "trim", { deck }],
      [SB3.EQ_HIGH_MSB, SB3.EQ_HIGH_LSB, "eqHigh", { deck }],
      [SB3.EQ_MID_MSB, SB3.EQ_MID_LSB, "eqMid", { deck }],
      [SB3.EQ_LOW_MSB, SB3.EQ_LOW_LSB, "eqLow", { deck }],
      [SB3.CH_VOL_MSB, SB3.CH_VOL_LSB, "volume", { deck }],
    ])) return out;
    if (d1 === SB3.JOG_PLATTER_VINYL || d1 === SB3.JOG_PLATTER_NOVINYL || d1 === SB3.JOG_SIDE) {
      out.push({ action: "jog", deck, delta: sb3RelativeJog(d2), mode: "nudge" });
    }
    if (d1 === SB3.JOG_SEARCH || d1 === SB3.JOG_SIDE_SHIFT) {
      out.push({ action: "jog", deck, delta: sb3RelativeJog(d2), mode: "search" });
    }
  }

  if (cmd === 0xB0 && (ch === 4 || ch === 5)) {
    const deck = ch - 4;
    const pairs = SB3.FX_LEVEL_MSB.map((msb, idx) => [msb, SB3.FX_LEVEL_LSB[idx], "fxLevel", { deck, fx: idx }]);
    pairs.push([SB3.FX_SHIFT_LEVEL_MSB, SB3.FX_SHIFT_LEVEL_LSB, "fxLevelAll", { deck }]);
    if (cc14Action(state, out, ch, d1, d2, pairs)) return out;
  }

  if (cmd === 0xB0 && ch === 6) {
    if (d1 === SB3.BROWSE || d1 === SB3.BROWSE_SHIFT) {
      const delta = sb3RelativeBrowse(d2);
      if (delta) out.push({ action: "browse", delta, fast: d1 === SB3.BROWSE_SHIFT });
    }
    if (cc14Action(state, out, 6, d1, d2, [
      [SB3.MASTER_MSB, SB3.MASTER_LSB, "masterVolume"],
      [SB3.HEADPHONES_MSB, SB3.HEADPHONES_LSB, "headphonesVolume"],
      [SB3.XFADER_MSB, SB3.XFADER_LSB, "crossfader"],
      [SB3.FILTER_MSB[0], SB3.FILTER_LSB[0], "filter", { deck: 0 }],
      [SB3.FILTER_MSB[1], SB3.FILTER_LSB[1], "filter", { deck: 1 }],
    ])) return out;
  }

  return out;
}

window.SB3 = SB3;
window.CC14Reassembler = CC14Reassembler;
window.translateSB3 = translateSB3;

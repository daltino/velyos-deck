// coach.js — AI Mix Coach v2
//
// V2 vylepšení:
//  - lepší detekce struktury (intro/build/drop/breakdown/outro)
//  - sledování fáze (kde jsme uvnitř fráze 32 beats)
//  - timing přechodu na kolik beats / kolik vteřin
//  - rady o EQ + xfaderu + filteru zaroveň
//  - struct markers se vykreslují na waveform overview

class TrackProfile {
  constructor(buffer, bpm = 0, bassBuffer = null) {
    this.duration = buffer.duration;
    const data = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const winSize = Math.max(1, Math.floor(sr * 0.5));   // 0.5-sec windows
    const numWin = Math.floor(data.length / winSize);
    const rms = new Float32Array(numWin);
    let max = 0;
    for (let i = 0; i < numWin; i++) {
      let sum = 0;
      const start = i * winSize;
      for (let j = 0; j < winSize; j++) {
        const v = data[start + j];
        sum += v * v;
      }
      rms[i] = Math.sqrt(sum / winSize);
      if (rms[i] > max) max = rms[i];
    }
    if (max > 0) for (let i = 0; i < numWin; i++) rms[i] /= max;
    this.rms = rms;
    this.numWin = numWin;
    this.winDur = 0.5;       // seconds per window
    this.bpm = bpm;
    this.hasBassStem = !!bassBuffer;

    // Sliding median for smoothing
    this.smooth = TrackProfile._smooth(rms, 5);
    const bassSource = bassBuffer || buffer;
    this.bass = TrackProfile._bassEnergy(bassSource, this.winDur);
    this.bassSmooth = TrackProfile._smooth(this.bass, 3);
    this.bassSegments = TrackProfile._segmentsAbove(this.bassSmooth, 0.34, this.winDur, 2.0);
    this.bassFreeRegions = TrackProfile._segmentsBelow(this.bassSmooth, 0.22, this.winDur, 2.0, this.duration);
    this.bassFirstAt = this.bassSegments.length ? this.bassSegments[0][0] : null;

    // Detect intro_end and outro_start by 0.5 threshold on smoothed energy
    const HIGH = 0.45;
    let introEnd = 0;
    for (let i = 0; i < numWin; i++) {
      if (this.smooth[i] >= HIGH) { introEnd = i * 0.5; break; }
    }
    let outroStart = this.duration;
    for (let i = numWin - 1; i >= 0; i--) {
      if (this.smooth[i] >= HIGH) { outroStart = (i + 1) * 0.5; break; }
    }
    this.intro_end = introEnd;
    this.outro_start = outroStart;

    // Detect drops: sharp transitions from breakdown (<0.4) to high (>0.7) within 4 windows (2s)
    this.drops = [];
    for (let i = 4; i < numWin; i++) {
      if (this.smooth[i] >= 0.7) {
        // check 4 windows back for breakdown
        let lowAcross = false;
        for (let k = 1; k <= 4; k++) {
          if (this.smooth[i - k] < 0.35) { lowAcross = true; break; }
        }
        if (lowAcross) {
          // dedupe — keep at least 16s apart
          if (!this.drops.length || (i * 0.5 - this.drops[this.drops.length - 1]) > 16) {
            this.drops.push(i * 0.5);
          }
        }
      }
    }

    // Detect breakdowns: 4+ consecutive low windows after intro
    this.breakdowns = [];
    let inLow = false, lowStart = 0;
    const startIdx = Math.floor(introEnd / 0.5);
    const endIdx = Math.floor(outroStart / 0.5);
    for (let i = startIdx; i < endIdx; i++) {
      if (this.smooth[i] < 0.35) {
        if (!inLow) { inLow = true; lowStart = i; }
      } else if (inLow) {
        if (i - lowStart >= 6) {  // ≥ 3 sec
          this.breakdowns.push([lowStart * 0.5, i * 0.5]);
        }
        inLow = false;
      }
    }

    // Builds: ascending energy 6+ windows
    this.builds = [];
    for (let i = 6; i < numWin - 4; i++) {
      let ascending = true;
      for (let k = 0; k < 5; k++) {
        if (this.smooth[i - k] <= this.smooth[i - k - 1] - 0.02) {
          ascending = false; break;
        }
      }
      if (ascending && this.smooth[i] >= 0.55 && this.smooth[i - 6] <= 0.4) {
        if (!this.builds.length || (i * 0.5 - this.builds[this.builds.length - 1]) > 16) {
          this.builds.push(i * 0.5);
        }
      }
    }
  }

  static _smooth(arr, n = 5) {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let sum = 0, c = 0;
      for (let k = -n; k <= n; k++) {
        if (i + k >= 0 && i + k < arr.length) { sum += arr[i + k]; c++; }
      }
      out[i] = sum / c;
    }
    return out;
  }

  static _bassEnergy(buffer, winDur = 0.5) {
    const data = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const winSize = Math.max(1, Math.floor(sr * winDur));
    const numWin = Math.floor(data.length / winSize);
    const out = new Float32Array(numWin);
    const cutoff = 170;
    const alpha = (2 * Math.PI * cutoff) / (sr + 2 * Math.PI * cutoff);
    let low = 0;
    let max = 0;
    for (let i = 0; i < numWin; i++) {
      let sum = 0;
      const start = i * winSize;
      for (let j = 0; j < winSize; j++) {
        low += alpha * (data[start + j] - low);
        sum += low * low;
      }
      out[i] = Math.sqrt(sum / winSize);
      if (out[i] > max) max = out[i];
    }
    if (max > 0) for (let i = 0; i < numWin; i++) out[i] /= max;
    return out;
  }

  static _segmentsAbove(arr, threshold, winDur, minDur) {
    return TrackProfile._segmentsBy(arr, (v) => v >= threshold, winDur, minDur);
  }

  static _segmentsBelow(arr, threshold, winDur, minDur, duration) {
    const segs = TrackProfile._segmentsBy(arr, (v) => v <= threshold, winDur, minDur);
    const end = arr.length * winDur;
    if (duration > end && duration - end >= minDur) segs.push([end, duration]);
    return segs;
  }

  static _segmentsBy(arr, pred, winDur, minDur) {
    const out = [];
    let active = false;
    let start = 0;
    for (let i = 0; i < arr.length; i++) {
      if (pred(arr[i])) {
        if (!active) {
          active = true;
          start = i * winDur;
        }
      } else if (active) {
        const end = i * winDur;
        if (end - start >= minDur) out.push([start, end]);
        active = false;
      }
    }
    if (active) {
      const end = arr.length * winDur;
      if (end - start >= minDur) out.push([start, end]);
    }
    return out;
  }

  bassEnergyAt(sec) {
    const i = Math.max(0, Math.min(this.bassSmooth.length - 1, Math.floor(sec / this.winDur)));
    return this.bassSmooth[i] || 0;
  }

  isBassHeavy(sec, threshold = 0.3) {
    return this.bassEnergyAt(sec) >= threshold;
  }

  hasBassLightWindow(sec, durationSec, threshold = 0.28) {
    const start = Math.max(0, Math.floor(sec / this.winDur));
    const end = Math.min(this.bassSmooth.length - 1, Math.ceil((sec + durationSec) / this.winDur));
    for (let i = start; i <= end; i++) {
      if ((this.bassSmooth[i] || 0) > threshold) return false;
    }
    return true;
  }

  energyAt(sec) {
    const i = Math.max(0, Math.min(this.numWin - 1, Math.floor(sec / 0.5)));
    return this.smooth[i];
  }

  // What "section" are we in at sec?
  sectionAt(sec) {
    if (sec < this.intro_end) return "intro";
    if (sec >= this.outro_start) return "outro";
    for (const [a, b] of this.breakdowns) {
      if (sec >= a && sec < b) return "breakdown";
    }
    // Near a drop?
    for (const d of this.drops) {
      if (sec >= d - 1 && sec < d + 4) return "drop";
    }
    for (const b of this.builds) {
      if (sec >= b - 4 && sec < b) return "build";
    }
    return "main";
  }

  // Next significant event coming up (drop/breakdown end/outro)
  nextEvent(sec) {
    const events = [];
    for (const d of this.drops) if (d > sec) events.push({ type: "drop", at: d });
    for (const [a, b] of this.breakdowns) {
      if (a > sec) events.push({ type: "breakdown_start", at: a });
      if (b > sec) events.push({ type: "breakdown_end", at: b });
    }
    if (this.outro_start > sec) events.push({ type: "outro", at: this.outro_start });
    events.sort((x, y) => x.at - y.at);
    return events[0] || null;
  }
}

class MixCoach {
  constructor(decks, engine) {
    this.decks = decks;
    this.engine = engine;
    this.profiles = [null, null];
  }

  setProfile(idx, buffer, bassBuffer = null) {
    this.profiles[idx] = new TrackProfile(buffer, this.decks[idx].bpm, bassBuffer);
  }

  clearProfile(idx) {
    this.profiles[idx] = null;
  }

  current() {
    const A = this.decks[0], B = this.decks[1];
    const pA = this.profiles[0], pB = this.profiles[1];
    const xf = this.engine.crossfader;

    if (!A.buffer && !B.buffer)        return s("Začni: drag track z library do deck A", "info");
    if (A.buffer && !B.buffer)         return s(`Připrav deck B${this._camelotHint(A)}`, "prep");
    if (B.buffer && !A.buffer)         return s(`Připrav deck A${this._camelotHint(B)}`, "prep");

    const aPlay = A.isPlaying, bPlay = B.isPlaying;
    const bpmDiff = (A.effectiveBpm() && B.effectiveBpm())
      ? Math.abs(A.effectiveBpm() - B.effectiveBpm()) : 0;

    if (aPlay && bPlay && bpmDiff > 1.0) {
      return s(`⚠ BPM rozdíl ${bpmDiff.toFixed(1)} — stiskni SYNC na příchozím decku!`, "urgent");
    }

    if (aPlay && !bPlay) return this._stagePrep(0, A, B, pA);
    if (bPlay && !aPlay) return this._stagePrep(1, B, A, pB);
    if (aPlay && bPlay)  return this._stageMix(A, B, pA, pB, xf);

    return s("Stiskni ▶ na decku s nahraným trackem", "info");
  }

  _camelotHint(deck) {
    const cam = deck.track?.camelot;
    if (!cam) return "";
    return ` (kompatibilní: ${camelotHints(cam).join(", ")})`;
  }

  _stagePrep(playIdx, playDeck, prepDeck, prof) {
    const inIdx = 1 - playIdx;
    const pos = playDeck.position();
    const next = prof?.nextEvent(pos);
    const outroStart = prof?.outro_start ?? playDeck.duration() - 30;
    const toOutro = outroStart - pos;

    const section = prof?.sectionAt(pos) || "main";
    const sectionEmoji = {
      intro: "🎬", build: "📈", drop: "🔥", breakdown: "🌊", main: "🎵", outro: "🌅",
    }[section];

    if (toOutro > 90) {
      let hint = `${sectionEmoji} ${L(playIdx)} v ${section}, ${fmt(toOutro)} do outra. Cue ${L(inIdx)}.`;
      if (next?.type === "breakdown_start" && next.at - pos < 32) {
        hint += ` Breakdown za ${fmt(next.at - pos)}.`;
      }
      return s(hint, "info");
    }
    if (toOutro > 32) {
      return s(`🎯 SYNC ${L(inIdx)} na ${playDeck.effectiveBpm().toFixed(1)} BPM. EQ low ${L(inIdx)} DOWN. ${fmt(toOutro)} do outra.`, "prep");
    }
    if (toOutro > 16) {
      return s(`🎚 Vol ${L(inIdx)} na 100%, EQ low DOWN. Drž a poslouchej fráze. ${fmt(toOutro)} do outra.`, "prep");
    }
    if (toOutro > 0) {
      return s(`▶ PUSŤ DECK ${L(inIdx)}! Slide xfader → ${L(inIdx)} přes 16 beats. EQ low ${L(inIdx)} UP postupně.`, "act");
    }
    return s(`🚨 ${L(playIdx)} v outru — pusť ${L(inIdx)} TEĎ. Xfader → ${L(inIdx)} rychle, kill ${L(playIdx)} bass.`, "urgent");
  }

  _stageMix(A, B, pA, pB, xf) {
    const aPos = A.position(), bPos = B.position();
    const aRem = (pA?.outro_start ?? A.duration()) - aPos;
    const bRem = (pB?.outro_start ?? B.duration()) - bPos;
    const aSec = pA?.sectionAt(aPos);
    const bSec = pB?.sectionAt(bPos);

    // detect drops within 4s on either deck
    if (aSec === "drop") return s(`🔥 DROP na A! Kill EQ low ${xf < 0.5 ? "B" : "A"}, push xfader.`, "act");
    if (bSec === "drop") return s(`🔥 DROP na B! Kill EQ low ${xf > 0.5 ? "A" : "B"}, push xfader.`, "act");

    if (xf < 0.45) {
      if (aRem < 8) return s(`🚨 Slide xfader → B! A končí za ${fmt(aRem)}.`, "urgent");
      if (xf < 0.2) return s(`Slide xfader → B přes 8–16 beats. EQ low A → -∞.`, "act");
      return s(`Plynulý přechod. EQ low A dolů, EQ high B nahoru.`, "act");
    }
    if (xf > 0.55) {
      if (bRem < 8) return s(`🚨 Slide xfader → A! B končí za ${fmt(bRem)}.`, "urgent");
      if (xf > 0.8) return s(`Slide xfader → A přes 8–16 beats. EQ low B → -∞.`, "act");
      return s(`Plynulý přechod. EQ low B dolů, EQ high A nahoru.`, "act");
    }
    return s(`50/50 mix — kill bass jednoho decku, druhý plně. Zvedni filter pro tension.`, "info");
  }
}

function s(msg, level) { return { msg, level }; }

function fmt(sec) {
  if (!isFinite(sec)) sec = 0;
  if (sec < 0) sec = 0;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60), r = Math.floor(sec % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function L(idx) { return idx === 0 ? "A" : "B"; }

function camelotHints(c) {
  if (!c || c.length < 2) return [];
  const num = parseInt(c.slice(0, -1), 10);
  const letter = c.slice(-1);
  if (!num || (letter !== "A" && letter !== "B")) return [];
  const other = letter === "A" ? "B" : "A";
  const up = (num % 12) + 1;
  const dn = ((num - 2) % 12) + 1;
  return [`${num}${other}`, `${up}${letter}`, `${dn}${letter}`];
}

window.MixCoach = MixCoach;
window.TrackProfile = TrackProfile;

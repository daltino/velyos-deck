// dj-utils.js — shared DJ math helpers for BPM and Camelot sorting
const DJUtils = {
  bpmCandidates(raw) {
    const base = Number(raw) || 0;
    if (!base) return [];
    const out = new Set();
    for (const mult of [0.25, 0.5, 1, 2, 4]) {
      const v = base * mult;
      if (v >= 50 && v <= 220) out.add(Math.round(v * 10) / 10);
    }
    return [...out].sort((a, b) => a - b);
  },

  normalizeBpm(raw, ref = 0) {
    const candidates = DJUtils.bpmCandidates(raw);
    if (!candidates.length) return 0;
    const target = Number(ref) || 0;
    if (target > 40) {
      return candidates.slice().sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    }
    const preferred = candidates.filter((v) => v >= 95 && v <= 180);
    if (preferred.length) return preferred[Math.floor(preferred.length / 2)];
    return candidates.slice().sort((a, b) => Math.abs(a - 128) - Math.abs(b - 128))[0];
  },

  effectiveTrackBpm(track, ref = 0) {
    if (!track) return 0;
    const raw = Number(track.raw_bpm || track.bpm) || 0;
    return DJUtils.normalizeBpm(raw, ref);
  },

  parseCamelot(camelot) {
    const m = String(camelot || "").trim().toUpperCase().match(/^(\d{1,2})([AB])$/);
    if (!m) return null;
    const num = Number(m[1]);
    if (num < 1 || num > 12) return null;
    return { num, letter: m[2] };
  },

  camelotNeighbors(camelot) {
    const parsed = DJUtils.parseCamelot(camelot);
    if (!parsed) return [];
    const other = parsed.letter === "A" ? "B" : "A";
    const up = (parsed.num % 12) + 1;
    const down = ((parsed.num + 10) % 12) + 1;
    return [`${parsed.num}${other}`, `${up}${parsed.letter}`, `${down}${parsed.letter}`];
  },

  camelotRelation(ref, candidate) {
    const r = DJUtils.parseCamelot(ref);
    const c = DJUtils.parseCamelot(candidate);
    if (!r || !c) return "unknown";
    const refCode = `${r.num}${r.letter}`;
    const candCode = `${c.num}${c.letter}`;
    if (refCode === candCode) return "same";
    if (r.num === c.num && r.letter !== c.letter) return "relative";
    const up = (r.num % 12) + 1;
    const down = ((r.num + 10) % 12) + 1;
    if (r.letter === c.letter && (c.num === up || c.num === down)) return "neighbor";
    const energy = ((r.num + 1) % 12) + 1;
    if (c.letter === r.letter && c.num === energy) return "energy";
    return "clash";
  },

  harmonicScore(ref, candidate) {
    const relation = DJUtils.camelotRelation(ref, candidate);
    if (relation === "same") return 0;
    if (relation === "relative") return 1;
    if (relation === "neighbor") return 2;
    if (relation === "energy") return 5;
    if (relation === "clash") return 8;
    return 12;
  },

  camelotWheelIndex(camelot) {
    const parsed = DJUtils.parseCamelot(camelot);
    if (!parsed) return 999;
    return (parsed.letter === "A" ? 0 : 12) + parsed.num - 1;
  },
};

window.DJUtils = DJUtils;

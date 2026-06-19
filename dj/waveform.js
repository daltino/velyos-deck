// waveform.js — Canvas overview + zoomed waveform
//
// Overview = full track downsampled to ~width samples
// Zoom     = ±~5 sec around playhead, scrolling

class Waveform {
  constructor(deck, overviewCanvas, zoomCanvas) {
    this.deck = deck;
    this.over = overviewCanvas;
    this.zoom = zoomCanvas;
    this.peaks = null;       // Float32Array (downsampled |x|)
    this.peaksLen = 0;
    this.color = deck.idx === 0 ? "#00e5ff" : "#ff3df0";
    this.colorDim = deck.idx === 0 ? "#00e5ff66" : "#ff3df066";
    this.cueColor = "#ffb84d";
    this._sizeCanvases();
    window.addEventListener("resize", () => this._sizeCanvases());

    // click on overview = seek
    this.over.addEventListener("click", (e) => {
      if (!deck.duration()) return;
      const rect = this.over.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      deck.seek(deck.duration() * ratio);
    });
  }

  _sizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.over, this.zoom]) {
      const r = c.getBoundingClientRect();
      c.width = Math.max(100, Math.floor(r.width * dpr));
      c.height = Math.max(40, Math.floor(c.clientHeight * dpr || c.height * dpr));
    }
  }

  computePeaks(buffer, target = 2000) {
    const data = buffer.getChannelData(0);
    const block = Math.max(1, Math.floor(data.length / target));
    const peaks = new Float32Array(target);
    for (let i = 0; i < target; i++) {
      let max = 0;
      const start = i * block;
      const end = Math.min(data.length, start + block);
      for (let j = start; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks[i] = max;
    }
    this.peaks = peaks;
    this.peaksLen = target;
    this.drawOverview();
  }

  drawOverview() {
    const ctx = this.over.getContext("2d");
    const w = this.over.width;
    const h = this.over.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.peaks) return;
    const mid = h / 2;
    const dur = this.deck.duration();

    // Section bands (intro/main/outro/breakdown) — drawn under waveform
    const profile = window.djApp?.coach?.profiles?.[this.deck.idx];
    if (profile && dur > 0) {
      // Intro
      const introX = (profile.intro_end / dur) * w;
      ctx.fillStyle = "#5fa8ff22";
      ctx.fillRect(0, 0, introX, h);
      // Outro
      const outroX = (profile.outro_start / dur) * w;
      ctx.fillStyle = "#ff847722";
      ctx.fillRect(outroX, 0, w - outroX, h);
      // Breakdowns
      ctx.fillStyle = "#ffb84d18";
      for (const [a, b] of profile.breakdowns) {
        const ax = (a / dur) * w;
        const bx = (b / dur) * w;
        ctx.fillRect(ax, 0, bx - ax, h);
      }
      // Bass-heavy regions, from bass stem when available.
      ctx.fillStyle = profile.hasBassStem ? "#4dffb118" : "#ff557712";
      for (const [a, b] of profile.bassSegments || []) {
        const ax = (a / dur) * w;
        const bx = (b / dur) * w;
        ctx.fillRect(ax, h * 0.72, bx - ax, h * 0.28);
      }
    }

    // Waveform
    ctx.fillStyle = this.colorDim;
    for (let x = 0; x < w; x++) {
      const i = Math.floor(x / w * this.peaksLen);
      const peak = this.peaks[i] || 0;
      const half = peak * mid * 0.95;
      ctx.fillRect(x, mid - half, 1, half * 2);
    }

    // Drop markers
    if (profile && dur > 0) {
      ctx.fillStyle = "#ff5577";
      for (const d of profile.drops) {
        const dx = (d / dur) * w;
        ctx.fillRect(dx - 1, 0, 2, h);
        // little triangle
        ctx.beginPath();
        ctx.moveTo(dx - 5, 0);
        ctx.lineTo(dx + 5, 0);
        ctx.lineTo(dx, 6);
        ctx.fill();
      }
      // Build markers
      ctx.fillStyle = "#ffb84daa";
      for (const b of profile.builds) {
        const bx = (b / dur) * w;
        ctx.fillRect(bx, 0, 1, h);
      }
    }

    // Playhead progress
    if (dur > 0) {
      const pos = this.deck.position();
      const px = (pos / dur) * w;
      ctx.fillStyle = this.color + "33";
      ctx.fillRect(0, 0, px, h);
      ctx.fillStyle = this.color;
      ctx.fillRect(px - 1, 0, 2, h);
    }

    // Hot cue markers
    if (this.deck.cues && dur > 0) {
      const slots = this.deck.cues.serialize();
      ctx.fillStyle = this.cueColor;
      for (let i = 0; i < slots.length; i++) {
        if (slots[i] == null) continue;
        const cx = (slots[i] / dur) * w;
        ctx.fillRect(cx - 1, 0, 2, h);
      }
    }

    // Loop region
    if (this.deck.loops?.active && dur > 0) {
      const ax = (this.deck.loops.start / dur) * w;
      const bx = (this.deck.loops.end / dur) * w;
      ctx.fillStyle = "#4dffb133";
      ctx.fillRect(ax, 0, bx - ax, h);
      ctx.strokeStyle = "#4dffb1";
      ctx.lineWidth = 2;
      ctx.strokeRect(ax, 0, bx - ax, h);
    }
  }

  drawZoom() {
    const ctx = this.zoom.getContext("2d");
    const w = this.zoom.width;
    const h = this.zoom.height;
    ctx.clearRect(0, 0, w, h);
    if (!this.peaks || !this.deck.buffer) return;
    const dur = this.deck.duration();
    const pos = this.deck.position();
    const ZOOM_SEC = 5;
    const halfSec = ZOOM_SEC / 2;
    const startSec = Math.max(0, pos - halfSec);
    const endSec = Math.min(dur, pos + halfSec);
    // map to peaks indices
    const fromIdx = (startSec / dur) * this.peaksLen;
    const toIdx = (endSec / dur) * this.peaksLen;
    const span = toIdx - fromIdx;
    const mid = h / 2;
    // BPM beatgrid (assume 4/4, spacing = 60/bpm seconds; each beat px)
    const bpm = this.deck.effectiveBpm() || this.deck.bpm;
    if (bpm > 0) {
      const beatSec = 60 / bpm;
      // align to beats: find nearest beat <= startSec
      const phase = (startSec % beatSec);
      let firstBeatSec = startSec - phase;
      if (firstBeatSec < startSec) firstBeatSec += beatSec;
      ctx.fillStyle = "#ffffff14";
      for (let t = firstBeatSec; t <= endSec; t += beatSec) {
        const x = ((t - startSec) / ZOOM_SEC) * w;
        ctx.fillRect(x, 0, 1, h);
      }
    }
    // waveform
    ctx.fillStyle = this.color;
    for (let x = 0; x < w; x++) {
      const i = Math.floor(fromIdx + (x / w) * span);
      const peak = this.peaks[i] || 0;
      const half = peak * mid * 0.95;
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
    // center playhead
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(w / 2 - 1, 0, 2, h);
    // cue point marker
    if (this.deck.cuePoint > 0) {
      const cx = ((this.deck.cuePoint - startSec) / ZOOM_SEC) * w;
      if (cx >= 0 && cx <= w) {
        ctx.fillStyle = this.cueColor;
        ctx.fillRect(cx - 1, 0, 2, h);
      }
    }
  }

  draw() {
    this.drawOverview();
    this.drawZoom();
  }
}

window.Waveform = Waveform;

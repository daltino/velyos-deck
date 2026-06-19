// visualizer.js — Audio-reactive visuals
//
// Uses Canvas 2D (no Three.js dep — keep deps zero). Two modes:
//   - Inline (small, in deck card)
//   - Fullscreen (open new window for projector)
// Both consume engine.fft (Uint8Array spectrum).

class Visualizer {
  constructor(engine) {
    this.engine = engine;
    this.fullCanvas = null;
    this.fullWin = null;
    this._raf = 0;
    this._t = 0;
    // particle pool for drop bursts
    this.particles = [];
  }

  openFullscreen() {
    if (this.fullWin && !this.fullWin.closed) {
      this.fullWin.focus(); return;
    }
    const w = window.open(
      "", "djviz",
      "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no"
    );
    if (!w) {
      alert("Pop-up blocker zablokoval visualizer. Povol pop-upy a zkus znovu.");
      return;
    }
    w.document.write(`
      <!doctype html><html><head>
      <title>DJ Visualizer</title>
      <style>
        html,body{margin:0;background:#000;overflow:hidden;cursor:none;height:100%}
        canvas{display:block;width:100vw;height:100vh}
      </style>
      </head><body>
      <canvas id="viz"></canvas>
      <script>
        document.body.addEventListener("keydown",(e)=>{
          if(e.key==="f"||e.key==="F"){
            if(!document.fullscreenElement) document.documentElement.requestFullscreen();
            else document.exitFullscreen();
          }
          if(e.key==="Escape") window.close();
        });
      </script>
      </body></html>`);
    w.document.close();
    this.fullWin = w;
    this.fullCanvas = w.document.getElementById("viz");
    const resize = () => {
      const dpr = w.devicePixelRatio || 1;
      this.fullCanvas.width = w.innerWidth * dpr;
      this.fullCanvas.height = w.innerHeight * dpr;
    };
    w.addEventListener("resize", resize);
    resize();
    if (!this._raf) this._loop();
  }

  closeFullscreen() {
    if (this.fullWin && !this.fullWin.closed) this.fullWin.close();
    this.fullWin = null;
    this.fullCanvas = null;
  }

  _loop() {
    cancelAnimationFrame(this._raf);
    const tick = () => {
      this._t += 0.016;
      this._draw();
      this._raf = requestAnimationFrame(tick);
    };
    tick();
  }

  _draw() {
    if (!this.fullCanvas || !this.fullWin || this.fullWin.closed) return;
    const ctx = this.fullCanvas.getContext("2d");
    const W = this.fullCanvas.width, H = this.fullCanvas.height;
    const fft = this.engine.getFFT();
    const lvl = this.engine.getMasterLevels();

    // Trail/clear
    ctx.fillStyle = "rgba(7, 9, 15, 0.18)";
    ctx.fillRect(0, 0, W, H);

    if (!fft) return;
    const bins = fft.length;
    // Bands: low (0..bins/16), mid (bins/16..bins/4), high (bins/4..bins/2)
    let bassSum = 0, midSum = 0, highSum = 0;
    for (let i = 0; i < bins / 16; i++) bassSum += fft[i];
    for (let i = bins / 16; i < bins / 4; i++) midSum += fft[i];
    for (let i = bins / 4; i < bins / 2; i++) highSum += fft[i];
    const bass = bassSum / (bins / 16) / 255;
    const mid  = midSum  / (bins * 3 / 16) / 255;
    const high = highSum / (bins / 4) / 255;

    // Center pulse — circle whose radius = bass
    const cx = W / 2, cy = H / 2;
    const r = 80 + bass * Math.min(W, H) * 0.45;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `hsla(${(this._t * 10) % 360}, 100%, 60%, ${0.45 + bass * 0.4})`);
    grad.addColorStop(0.6, `hsla(${(this._t * 10 + 60) % 360}, 100%, 50%, ${0.18 + mid * 0.3})`);
    grad.addColorStop(1, `hsla(${(this._t * 10 + 180) % 360}, 100%, 30%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Spectrum ring
    const ringR = Math.min(W, H) * 0.32;
    ctx.lineWidth = 2;
    for (let i = 0; i < bins / 2; i++) {
      const angle = (i / (bins / 2)) * Math.PI * 2 - Math.PI / 2;
      const v = fft[i] / 255;
      const r1 = ringR;
      const r2 = ringR + v * Math.min(W, H) * 0.18;
      const x1 = cx + Math.cos(angle) * r1;
      const y1 = cy + Math.sin(angle) * r1;
      const x2 = cx + Math.cos(angle) * r2;
      const y2 = cy + Math.sin(angle) * r2;
      ctx.strokeStyle = `hsla(${(i / (bins / 2)) * 360 + this._t * 30}, 90%, 60%, ${0.5 + v * 0.5})`;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // High-freq sparks → particles on drops (peak > 0.65)
    if (lvl.peak > 0.65 && bass > 0.5 && Math.random() < 0.35) {
      for (let i = 0; i < 8; i++) {
        this.particles.push({
          x: cx, y: cy,
          vx: (Math.random() - 0.5) * 18,
          vy: (Math.random() - 0.5) * 18,
          life: 1,
          hue: Math.random() * 360,
        });
      }
    }
    // particles update
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.018;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      ctx.fillStyle = `hsla(${p.hue}, 90%, 60%, ${p.life})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // BPM/track info banner
    if (window.djApp && window.djApp.decks) {
      const A = window.djApp.decks[0];
      const B = window.djApp.decks[1];
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.font = `${Math.max(14, W / 60)}px -apple-system, sans-serif`;
      ctx.textAlign = "left";
      const aLine = A.track
        ? `▶ A · ${A.track.title} · ${A.effectiveBpm().toFixed(1)} BPM · ${A.track.camelot || ""}`
        : "A · empty";
      const bLine = B.track
        ? `▶ B · ${B.track.title} · ${B.effectiveBpm().toFixed(1)} BPM · ${B.track.camelot || ""}`
        : "B · empty";
      ctx.fillText(aLine, 24, 40);
      ctx.fillText(bLine, 24, 70);
    }
  }
}

window.Visualizer = Visualizer;

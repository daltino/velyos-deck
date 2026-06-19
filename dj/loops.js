// loops.js — Loop engine: auto-loop N beats, slip mode
//
// Loop is a [startSec, endSec] range. While active, position wraps from end → start.
// We implement it by:
//   - watching position in animation loop; when crossed end, seek to start.
//   - slip mode: when loop disabled, jump back to "shadow position" that ran
//     forward through the original timeline (as if no loop existed).
//
// This isn't sample-accurate (RAF resolution ≈ 16ms), but for performance loops
// 1/16 beat or longer it works well enough on macOS Chrome.

class LoopEngine {
  constructor(deck) {
    this.deck = deck;
    this.start = 0;
    this.end = 0;
    this.active = false;
    this.slip = false;
    this.shadowPos = 0;          // imagined position if no loop
    this.lastTickTime = 0;
  }

  // Set loop of N beats from current position.
  loopN(beats) {
    if (!this.deck.buffer || !this.deck.bpm) return;
    const beatSec = 60 / this.deck.effectiveBpm();
    const len = beats * beatSec;
    const pos = this.deck.position();
    this.start = pos;
    this.end = pos + len;
    this.active = true;
    if (this.slip) this.shadowPos = pos;
  }

  // Manual loop in/out
  setIn() {
    if (!this.deck.buffer) return;
    this.start = this.deck.position();
    this.end = this.start + 4 * (60 / (this.deck.effectiveBpm() || 120));
    this.active = false;
  }
  setOut() {
    if (!this.deck.buffer) return;
    this.end = this.deck.position();
    if (this.end <= this.start) this.end = this.start + 0.1;
    this.active = true;
    if (this.slip) this.shadowPos = this.end;
  }

  toggle() {
    if (this.end <= this.start) return;
    this.active = !this.active;
    if (this.active && this.slip) this.shadowPos = this.deck.position();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    if (this.slip && this.deck.buffer) {
      // jump to where the track would have been
      const target = Math.min(this.shadowPos, this.deck.duration());
      this.deck.seek(target);
    }
  }

  setSlip(on) {
    this.slip = on;
    if (on) this.shadowPos = this.deck.position();
  }

  halve() {
    if (this.end <= this.start) return;
    this.end = this.start + (this.end - this.start) / 2;
  }
  doubleLen() {
    if (this.end <= this.start) return;
    this.end = this.start + (this.end - this.start) * 2;
  }
  shift(beats) {
    if (this.end <= this.start) return;
    const beatSec = 60 / (this.deck.effectiveBpm() || 120);
    const d = beats * beatSec;
    this.start += d;
    this.end += d;
    if (this.active) this.deck.seek(this.start);
  }

  tick(now) {
    if (!this.active || !this.deck.buffer) return;
    // Update shadow forward as if not looping (track-rate based)
    if (this.lastTickTime) {
      const dt = (now - this.lastTickTime) / 1000;
      this.shadowPos += dt * this.deck._currentRate();
    }
    this.lastTickTime = now;
    const pos = this.deck.position();
    if (pos >= this.end) {
      this.deck.seek(this.start);
    }
  }
}

window.LoopEngine = LoopEngine;

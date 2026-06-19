// cues.js — Hot Cues storage (8 slots)
class HotCues {
  constructor(slots = 8) {
    this.slots = new Array(slots).fill(null);
  }
  set(i, sec) { this.slots[i] = sec; }
  get(i) { return this.slots[i]; }
  clear(i) { this.slots[i] = null; }
  clearAll() { this.slots.fill(null); }
  serialize() { return this.slots.slice(); }
}
window.HotCues = HotCues;

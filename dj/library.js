// library.js — load library JSON, render table, drag/drop to deck
class Library {
  constructor(tbody, statsEl, searchInput, app) {
    this.tbody = tbody;
    this.statsEl = statsEl;
    this.search = searchInput;
    this.app = app;
    this.tracks = [];
    this.filtered = [];
    this.view = "all";
    this.sort = { key: null, dir: 1 };
    this.prepareIds = [];
    this.sets = [];
    this.activeSet = "PREP";
    this.recentIds = this._loadIds("scdl.dj.recent");
    this.selectedId = null;
    this.search.addEventListener("input", () => this.applyFilter());
    this.refreshBtn = document.getElementById("libraryRefresh");
    this.refreshBtn?.addEventListener("click", () => this.load());
    this.setSelect = document.getElementById("setSelect");
    this.setName = document.getElementById("setName");
    document.getElementById("setSave")?.addEventListener("click", () => this.saveCurrentSet());
    document.getElementById("setLoad")?.addEventListener("click", () => this.loadSelectedSet());
    document.getElementById("setClear")?.addEventListener("click", () => this.clearPrepare());
    document.getElementById("setDelete")?.addEventListener("click", () => this.deleteSelectedSet());
    document.getElementById("setExportM3u")?.addEventListener("click", () => this.exportSet("m3u"));
    document.getElementById("setExportJson")?.addEventListener("click", () => this.exportSet("json"));
    this.setSelect?.addEventListener("change", () => {
      if (this.setName) this.setName.value = this.setSelect.value || this.activeSet || "PREP";
    });
    document.querySelectorAll("[data-lib-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.view = btn.dataset.libView || "all";
        document.querySelectorAll("[data-lib-view]").forEach((b) =>
          b.classList.toggle("is-active", b === btn));
        this.applyFilter();
      });
    });
    document.querySelectorAll(".lib-table th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (this.sort.key === key) this.sort.dir *= -1;
        else this.sort = { key, dir: 1 };
        this.applyFilter();
      });
    });
  }

  async load() {
    if (this.refreshBtn) this.refreshBtn.disabled = true;
    try {
      const [libraryResp, prepareResp] = await Promise.all([
        fetch(`/library.json?t=${Date.now()}`, { cache: "no-store" }),
        fetch(`/prepare.json?t=${Date.now()}`, { cache: "no-store" }),
      ]);
      this.tracks = libraryResp.ok ? await libraryResp.json() : [];
      if (prepareResp.ok) {
        const prep = await prepareResp.json();
        this.prepareIds = Array.isArray(prep.ids) ? prep.ids.filter((id) => this.findById(id)) : [];
        this.activeSet = prep.active_set || this.activeSet || "PREP";
      } else {
        this.prepareIds = [];
      }
      await this._loadSets();
      await this._migrateLegacyPrepare();
    } catch (e) {
      this.tracks = [];
      this.prepareIds = [];
      this.sets = [];
    } finally {
      if (this.refreshBtn) this.refreshBtn.disabled = false;
    }
    this.applyFilter();
  }

  applyFilter() {
    const q = this.search.value.trim().toLowerCase();
    let rows = this.tracks.slice();
    if (this.view === "prepare") {
      rows = this.prepareIds
        .map((id) => this.tracks.find((t) => t.id === id))
        .filter(Boolean);
    } else if (this.view === "ready") {
      rows = rows.filter((t) => t.ready_for_set);
    } else if (this.view === "recent") {
      rows = this.recentIds
        .map((id) => this.tracks.find((t) => t.id === id))
        .filter(Boolean);
    }
    if (q) {
      rows = rows.filter((t) => {
        return (
          (t.title || "").toLowerCase().includes(q) ||
          (t.artist || "").toLowerCase().includes(q) ||
          (t.key || "").toLowerCase().includes(q) ||
          (t.camelot || "").toLowerCase().includes(q) ||
          (t.genre || "").toLowerCase().includes(q) ||
          (t.energy || "").toLowerCase().includes(q) ||
          (t.analysis_status || "").toLowerCase().includes(q) ||
          (Array.isArray(t.tags) ? t.tags.join(" ") : "").toLowerCase().includes(q) ||
          String(t.bpm).includes(q)
        );
      });
    }
    this.filtered = this._sortRows(rows);
    this._ensureSelection();
    this.render();
  }

  setReferenceBpm(bpm) {
    this.refBpm = bpm;
    this.render();
  }

  render() {
    const refBpm = this._currentRefBpm();
    const rows = this.filtered.map((t, i) => {
      const bpm = this._displayBpm(t, refBpm);
      const delta = (refBpm > 0 && bpm)
        ? (bpm - refBpm).toFixed(1)
        : "";
      let dCls = "neutral";
      if (delta !== "") {
        const ad = Math.abs(parseFloat(delta));
        if (ad <= 1.5) dCls = "good";
        else if (ad >= 8) dCls = "bad";
      }
      const dStr = delta === "" ? "" : (delta >= 0 ? `+${delta}` : delta);
      const stemBadge = t.stems ? `<span class="stem-mini">ST</span>` : "";
      const energy = this._energyLabel(t);
      const ready = t.ready_for_set
        ? `<span class="ready-pill is-ready">READY</span>`
        : `<span class="ready-pill is-${escapeHtml(t.analysis_status || "missing")}">${escapeHtml(t.analysis_status || "missing")}</span>`;
      const prepAdded = this.prepareIds.includes(t.id);
      return `
        <tr draggable="true" data-id="${t.id}" class="${t.id === this.selectedId ? "is-selected" : ""}">
          <td>${i + 1}</td>
          <td>${escapeHtml(t.title)}</td>
          <td>${escapeHtml(t.artist)}</td>
          <td class="col-bpm" title="${this._bpmTitle(t, bpm)}">${bpm ? bpm.toFixed(1) : ""}</td>
          <td class="col-key">${escapeHtml(t.key)}</td>
          <td><span class="col-cam">${escapeHtml(t.camelot || "?")}</span></td>
          <td class="col-delta ${dCls}">${dStr}</td>
          <td class="col-energy">${escapeHtml(energy)}</td>
          <td class="col-ready">${ready}</td>
          <td class="col-stems">${stemBadge}</td>
          <td class="col-actions">
            <button class="lib-load-btn a" data-load="0">A</button>
            <button class="lib-load-btn b" data-load="1">B</button>
            <button class="lib-load-btn prep ${prepAdded ? "is-added" : ""}" data-prep="1">PREP</button>
          </td>
        </tr>
      `;
    });
    this.tbody.innerHTML = rows.join("");
    this.statsEl.textContent = `${this.filtered.length} / ${this.tracks.length} · ${this.activeSet}`;
    this._refreshSortHeaders();
    this._renderSets();
    this._wireRows();
    this._scrollSelectionIntoView(false);
  }

  _currentRefBpm() {
    if (!this.app) return 0;
    const d = this._referenceDeck();
    return d?.effectiveBpm() || 0;
  }

  _referenceDeck() {
    if (!this.app?.engineReady || !this.app.decks) return null;
    const [a, b] = this.app.decks;
    if (a?.isPlaying && !b?.isPlaying) return a;
    if (b?.isPlaying && !a?.isPlaying) return b;
    if (a?.isPlaying && b?.isPlaying) return this.app.engine.crossfader < 0.5 ? a : b;
    return a?.buffer ? a : (b?.buffer ? b : null);
  }

  _displayBpm(track, refBpm = this._currentRefBpm()) {
    if (window.DJUtils) return DJUtils.effectiveTrackBpm(track, refBpm);
    return Number(track?.bpm) || 0;
  }

  _bpmTitle(track, displayBpm) {
    const raw = Number(track?.raw_bpm || track?.bpm) || 0;
    if (!raw || Math.abs(raw - displayBpm) < 0.05) return "";
    return `raw ${raw.toFixed(1)} BPM`;
  }

  _sortRows(rows) {
    const key = this.sort.key;
    if (!key) return rows;
    const refDeck = this._referenceDeck();
    const refBpm = refDeck?.effectiveBpm() || 0;
    const refCam = refDeck?.track?.camelot || "";
    const dir = this.sort.dir;
    return rows.slice().sort((a, b) => {
      if (key === "key" || key === "camelot") {
        const aScore = refCam ? DJUtils.harmonicScore(refCam, a.camelot) : DJUtils.camelotWheelIndex(a.camelot);
        const bScore = refCam ? DJUtils.harmonicScore(refCam, b.camelot) : DJUtils.camelotWheelIndex(b.camelot);
        if (aScore !== bScore) return (aScore - bScore) * dir;
        const aDelta = Math.abs(this._displayBpm(a, refBpm) - refBpm);
        const bDelta = Math.abs(this._displayBpm(b, refBpm) - refBpm);
        if (refBpm && aDelta !== bDelta) return aDelta - bDelta;
        return DJUtils.camelotWheelIndex(a.camelot) - DJUtils.camelotWheelIndex(b.camelot);
      }
      if (key === "bpm") {
        return (this._displayBpm(a, refBpm) - this._displayBpm(b, refBpm)) * dir;
      }
      if (key === "energy") {
        return (this._energyValue(a) - this._energyValue(b)) * dir;
      }
      if (key === "analysis_status") {
        return (this._readyRank(a) - this._readyRank(b)) * dir;
      }
      return String(a[key] || "").localeCompare(String(b[key] || ""), undefined, { sensitivity: "base" }) * dir;
    });
  }

  _refreshSortHeaders() {
    document.querySelectorAll(".lib-table th[data-sort]").forEach((th) => {
      th.classList.toggle("is-sorted", th.dataset.sort === this.sort.key);
    });
  }

  _ensureSelection() {
    if (!this.filtered.length) {
      this.selectedId = null;
      return;
    }
    if (!this.selectedId || !this.filtered.some((t) => t.id === this.selectedId)) {
      this.selectedId = this.filtered[0].id;
    }
  }

  _setSelected(id, scroll = true) {
    if (!id || id === this.selectedId) return;
    this.selectedId = id;
    for (const tr of this.tbody.querySelectorAll("tr")) {
      tr.classList.toggle("is-selected", tr.dataset.id === id);
    }
    if (scroll) this._scrollSelectionIntoView(true);
    this.app?.midi?.syncLeds?.();
  }

  _scrollSelectionIntoView(smooth) {
    const id = this.selectedId || "";
    const escaped = window.CSS?.escape ? CSS.escape(id) : String(id).replace(/["\\]/g, "\\$&");
    const tr = this.tbody.querySelector(`tr[data-id="${escaped}"]`);
    tr?.scrollIntoView({ block: "nearest", behavior: smooth ? "smooth" : "auto" });
  }

  moveSelection(delta) {
    if (!this.filtered.length) return null;
    const current = Math.max(0, this.filtered.findIndex((t) => t.id === this.selectedId));
    const next = Math.max(0, Math.min(this.filtered.length - 1, current + delta));
    this._setSelected(this.filtered[next].id);
    return this.selectedTrack();
  }

  selectedTrack() {
    if (!this.filtered.length) return null;
    this._ensureSelection();
    return this.filtered.find((t) => t.id === this.selectedId) || null;
  }

  loadSelected(deckIdx) {
    const track = this.selectedTrack();
    if (track) this.app.loadTrackToDeck(track, deckIdx);
    return track;
  }

  cycleView(direction = 1) {
    const views = ["all", "ready", "prepare", "recent"];
    const idx = Math.max(0, views.indexOf(this.view));
    this.view = views[(idx + direction + views.length) % views.length];
    document.querySelectorAll("[data-lib-view]").forEach((btn) =>
      btn.classList.toggle("is-active", btn.dataset.libView === this.view));
    this.applyFilter();
  }

  sortBy(key) {
    if (!key) return;
    if (this.sort.key === key) this.sort.dir *= -1;
    else this.sort = { key, dir: 1 };
    this.applyFilter();
  }

  _wireRows() {
    for (const tr of this.tbody.querySelectorAll("tr")) {
      const id = tr.dataset.id;
      const track = this.tracks.find((t) => t.id === id);
      if (!track) continue;
      tr.addEventListener("dragstart", (e) => {
        this._setSelected(id, false);
        tr.classList.add("dragging");
        e.dataTransfer.setData("text/track-id", id);
        e.dataTransfer.effectAllowed = "copy";
      });
      tr.addEventListener("dragend", () => tr.classList.remove("dragging"));
      tr.addEventListener("click", () => this._setSelected(id, false));
      tr.querySelectorAll("button[data-load]").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const deckIdx = parseInt(btn.dataset.load, 10);
          this.app.loadTrackToDeck(track, deckIdx);
        });
      });
      tr.querySelector("button[data-prep]")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.togglePrepare(track.id);
      });
      tr.addEventListener("dblclick", () => {
        this._setSelected(id, false);
        // double-click: load into the deck that's empty / not playing, default A
        const target = this.app.findFreeDeck();
        this.app.loadTrackToDeck(track, target);
      });
    }
  }

  findById(id) { return this.tracks.find((t) => t.id === id); }

  getPrepareTracks() {
    return this.prepareIds
      .map((id) => this.findById(id))
      .filter(Boolean);
  }

  removeFromPrepare(id) {
    if (!id || !this.prepareIds.includes(id)) return;
    this.prepareIds = this.prepareIds.filter((x) => x !== id);
    this._savePrepareToServer();
    this.applyFilter();
  }

  markPlayed(track) {
    if (!track?.id) return;
    this.recentIds = [track.id, ...this.recentIds.filter((id) => id !== track.id)].slice(0, 50);
    this._saveIds("scdl.dj.recent", this.recentIds);
    this.applyFilter();
  }

  togglePrepare(id) {
    if (!id) return;
    if (this.prepareIds.includes(id)) {
      this.prepareIds = this.prepareIds.filter((x) => x !== id);
    } else {
      this.prepareIds = [...this.prepareIds, id].slice(-100);
    }
    this._savePrepareToServer();
    this.applyFilter();
  }

  async _savePrepareToServer() {
    try {
      const r = await fetch("/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: this.prepareIds }),
      });
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data.ids)) {
        this.prepareIds = data.ids.filter((id) => this.findById(id));
        this.activeSet = data.active_set || this.activeSet;
        await this._loadSets();
        this.applyFilter();
      }
    } catch (e) {
      console.warn("PREP save failed:", e);
    }
  }

  async _loadSets() {
    try {
      const resp = await fetch(`/sets.json?t=${Date.now()}`, { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      this.activeSet = data.active_set || this.activeSet || "PREP";
      this.sets = Array.isArray(data.sets) ? data.sets : [];
    } catch (e) {
      console.warn("Set load failed:", e);
    }
  }

  _renderSets() {
    if (!this.setSelect) return;
    const current = this.setSelect.value || this.activeSet;
    this.setSelect.innerHTML = this.sets.map((set) => (
      `<option value="${escapeHtml(set.name)}">${escapeHtml(set.name)} (${set.count || 0})</option>`
    )).join("");
    const desired = this.sets.some((set) => set.name === this.activeSet) ? this.activeSet : current;
    this.setSelect.value = desired || "";
    if (this.setName && !this.setName.value) this.setName.value = this.activeSet || "PREP";
  }

  async saveCurrentSet() {
    const name = this.setName?.value || this.activeSet || "PREP";
    const data = await this._postSet({ action: "save", name, ids: this.prepareIds });
    this._applySetPayload(data);
  }

  async loadSelectedSet() {
    const name = this.setSelect?.value || this.setName?.value || this.activeSet || "PREP";
    const data = await this._postSet({ action: "load", name });
    this._applySetPayload(data);
  }

  async deleteSelectedSet() {
    const name = this.setSelect?.value || this.activeSet;
    if (!name || !window.confirm(`Delete set "${name}"?`)) return;
    const data = await this._postSet({ action: "delete", name });
    this._applySetPayload(data);
  }

  async clearPrepare() {
    this.prepareIds = [];
    await this._savePrepareToServer();
  }

  exportSet(format) {
    const name = this.setSelect?.value || this.activeSet || "PREP";
    const qs = new URLSearchParams({ format, set: name });
    window.location.href = `/export?${qs.toString()}`;
  }

  async _postSet(payload) {
    try {
      const resp = await fetch("/sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`server: ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.warn("Set update failed:", e);
      return null;
    }
  }

  _applySetPayload(data) {
    if (!data) return;
    this.activeSet = data.active_set || this.activeSet || "PREP";
    this.sets = Array.isArray(data.sets) ? data.sets : this.sets;
    if (Array.isArray(data.ids)) {
      this.prepareIds = data.ids.filter((id) => this.findById(id));
    }
    if (this.setName) this.setName.value = this.activeSet;
    this.applyFilter();
  }

  _energyLabel(track) {
    const value = track?.energy;
    if (value === "" || value == null) return "";
    const num = Number(value);
    if (Number.isFinite(num)) return `${Math.max(1, Math.min(10, Math.round(num)))}`;
    return String(value);
  }

  _energyValue(track) {
    const num = Number(track?.energy);
    return Number.isFinite(num) ? num : 0;
  }

  _readyRank(track) {
    if (track?.ready_for_set) return 0;
    if (track?.analysis_status === "partial") return 1;
    return 2;
  }

  async _migrateLegacyPrepare() {
    const marker = "scdl.dj.prepare.server_migrated";
    if (window.localStorage.getItem(marker) === "1") return;
    window.localStorage.setItem(marker, "1");
    if (this.prepareIds.length) return;
    const legacyIds = this._loadIds("scdl.dj.prepare").filter((id) => this.findById(id));
    if (!legacyIds.length) return;
    this.prepareIds = legacyIds;
    await this._savePrepareToServer();
  }

  _loadIds(key) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    } catch (_) {
      return [];
    }
  }

  _saveIds(key, ids) {
    try {
      window.localStorage.setItem(key, JSON.stringify(ids));
    } catch (_) {}
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

window.Library = Library;

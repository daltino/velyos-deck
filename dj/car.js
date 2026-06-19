const state = {
  tracks: [],
  filtered: [],
  index: -1,
};

const player = document.getElementById("player");
const titleEl = document.getElementById("title");
const artistEl = document.getElementById("artist");
const listEl = document.getElementById("list");
const statsEl = document.getElementById("stats");
const searchEl = document.getElementById("search");
const playBtn = document.getElementById("playBtn");
let lastError = "";

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadLibrary() {
  const r = await fetch(`/library.json?t=${Date.now()}`, { cache: "no-store" });
  state.tracks = await r.json();
  applyFilter();
}

function applyFilter() {
  const q = searchEl.value.trim().toLowerCase();
  state.filtered = state.tracks.filter((track) => {
    if (!q) return true;
    return [track.title, track.artist, track.camelot, track.key, track.bpm]
      .some((v) => String(v || "").toLowerCase().includes(q));
  });
  renderList();
}

function renderList() {
  statsEl.textContent = `${state.filtered.length} tracků`;
  listEl.innerHTML = state.filtered.map((track) => {
    const active = state.tracks[state.index]?.id === track.id;
    return `
      <button class="track ${active ? "is-active" : ""}" data-id="${escapeHtml(track.id)}">
        <span>
          <span class="track-title">${escapeHtml(track.title)}</span>
          <span class="track-artist">${escapeHtml(track.artist || track.filename || "")}</span>
        </span>
        <span class="track-meta">${escapeHtml(track.camelot || "")} ${track.bpm ? Math.round(track.bpm) : ""}</span>
      </button>
    `;
  }).join("");
  listEl.querySelectorAll(".track").forEach((btn) => {
    btn.addEventListener("click", () => playTrackById(btn.dataset.id));
  });
}

async function playTrackById(id) {
  const idx = state.tracks.findIndex((track) => track.id === id);
  if (idx >= 0) await playIndex(idx);
}

async function playIndex(idx) {
  if (!state.tracks.length) return;
  state.index = (idx + state.tracks.length) % state.tracks.length;
  const track = state.tracks[state.index];
  titleEl.textContent = track.title || track.filename || "Track";
  artistEl.textContent = track.artist || "";
  lastError = "";
  player.src = mediaUrl(track);
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: titleEl.textContent,
      artist: artistEl.textContent,
    });
  }
  renderList();
  try {
    await player.play();
  } catch (_) {
    playBtn.textContent = "PLAY";
    showError("iPhone odmítl autoplay. Klepni PLAY ještě jednou.");
  }
}

function mediaUrl(track) {
  const id = encodeURIComponent(track.id || "");
  const name = encodeURIComponent(track.filename || `${track.title || "track"}.mp3`);
  return `/media/${id}/${name}`;
}

function showError(text) {
  lastError = text;
  artistEl.textContent = text;
}

function next(delta) {
  if (!state.tracks.length) return;
  playIndex(state.index < 0 ? 0 : state.index + delta);
}

playBtn.addEventListener("click", async () => {
  if (!player.src) return playIndex(0);
  if (player.paused) await player.play();
  else player.pause();
});
document.getElementById("prevBtn").addEventListener("click", () => next(-1));
document.getElementById("nextBtn").addEventListener("click", () => next(1));
document.getElementById("refreshBtn").addEventListener("click", loadLibrary);
searchEl.addEventListener("input", applyFilter);
player.addEventListener("play", () => { playBtn.textContent = "PAUSE"; });
player.addEventListener("pause", () => { playBtn.textContent = "PLAY"; });
player.addEventListener("ended", () => next(1));
player.addEventListener("error", () => {
  const code = player.error?.code;
  const msg = {
    1: "Přehrávání zrušeno.",
    2: "Síťová chyba audio streamu.",
    3: "iPhone neumí dekódovat tenhle soubor.",
    4: "Soubor není podporovaný pro CarPlay.",
  }[code] || "Neznámá chyba přehrávače.";
  showError(`${msg} Zkus další track.`);
});

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("previoustrack", () => next(-1));
  navigator.mediaSession.setActionHandler("nexttrack", () => next(1));
}

loadLibrary().catch(() => {
  statsEl.textContent = "Knihovna nejde načíst";
});

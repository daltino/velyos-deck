# Third-Party Inventory and SBOM Starter

Human-readable inventory. A machine-readable SBOM (CycloneDX) should be generated
from a clean environment before each public release and committed as `docs/sbom.json`.

Velyos Deck is licensed AGPL-3.0-only. The dependencies below are **invoked or
imported**, not relicensed; none are bundled into this repository.

## Python runtime (core — installed via requirements.txt)

| Package | License | Note |
|---|---|---|
| FastAPI | MIT | ✅ permissive |
| Uvicorn | BSD-3-Clause | ✅ permissive |
| Pydantic | MIT | ✅ permissive |
| websockets | BSD-3-Clause | ✅ permissive |
| python-rtmidi | MIT / PSF | ✅ permissive |
| mutagen | **GPL-2.0+** | Used only to read/write audio tags (metadata-only / mere aggregation). Compatible with our AGPL distribution; flagged for awareness. Consider a permissive tag library (e.g. taglib bindings) in future. |

## Web runtime

| Package | License |
|---|---|
| React 18 / React DOM 18 | MIT |
| lucide-react | ISC |

## Web development (not shipped)

| Package | License |
|---|---|
| Vite | MIT |
| TypeScript | Apache-2.0 |
| @vitejs/plugin-react | MIT |
| @types/react, @types/react-dom | MIT |

## Optional external tools and models (analyzer / stems — installed on opt-in)

Invoked as external processes / installed into the separate `.analyzer-venv`. Not
bundled or redistributed. See docs/MODELS.md.

| Tool | License | Concern |
|---|---|---|
| `ffmpeg` | LGPL-2.1+ (some builds GPL) | LGPL notice in NOTICE; do not redistribute a GPL build bundled. |
| Demucs | MIT (code) | **Model weights** have separate license — user-downloaded, experimental. |
| Torch (PyTorch) | BSD-3-Clause | ✅ permissive |
| AudioSR | code permissive; **model weights** TBD | Audit weight license before advertising; experimental. |
| `librosa` | ISC | ✅ permissive |
| `numpy` | BSD-3-Clause | ✅ permissive |
| `shazamio` | wraps proprietary Shazam API | Service-ToS risk; experimental. Consider Chromaprint/AcoustID. |

## Excluded from the public release

The streaming downloader (`scdl`, `yt-dlp`, `spotdl`) is **not published** in the
public Velyos Deck repository (legal / brand risk). It lives in a gitignored
local-only module and is therefore out of scope for the public SBOM.

## Public release gate

- [x] Generate CycloneDX SBOM from clean `.venv` + `web/` → `docs/sbom.json`.
- [ ] Confirm Demucs/AudioSR model-weight licenses before advertising those features.
- [ ] Confirm Shazam API terms or replace shazamio with an OSS fingerprinter.
- [x] Core dependency licenses recorded (above).
- [x] ffmpeg LGPL notice added to NOTICE.

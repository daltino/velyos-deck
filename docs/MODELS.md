# Machine-learning models

Velyos Deck can use external ML models for a few **optional, experimental**
features. These models are **not bundled** with Velyos Deck. They are downloaded
by the user (or their package manager) on explicit opt-in, and each carries its
own license and terms that you are responsible for reviewing.

| Feature | Tool | Model | How it's obtained | Status |
|---|---|---|---|---|
| Stem separation | Demucs (Torch) | `htdemucs` and related weights | Downloaded by Demucs on first run | Experimental / optional |
| Audio super-resolution | AudioSR | AudioSR weights | Downloaded on first run | Experimental / optional |
| Track identification | shazamio | Shazam service API (no local model) | Network calls to Shazam | Experimental / optional |

## Installation

These features live in a separate Python 3.11 environment and are installed only
when you ask for them:

```bash
./scripts/setup-analyzer.sh            # librosa, numpy, shazamio
./scripts/setup-analyzer.sh --demucs   # + Demucs stem separation
./scripts/setup-analyzer.sh --all      # + AudioSR
```

If these are not installed, Velyos Deck runs normally and the corresponding
features are simply unavailable.

## Licensing notes

- **Demucs** code is MIT-licensed, but the pretrained model weights may be
  released under different terms. Review the weight license before relying on
  stem separation in a commercial context.
- **AudioSR** weights' license must be confirmed before this feature is
  advertised as production-ready.
- **shazamio** uses Shazam's proprietary service. Programmatic/bulk use may be
  restricted by Shazam's terms. A fully open alternative is Chromaprint/AcoustID.

This file is not legal advice.

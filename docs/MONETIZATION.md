# Monetization strategy (internal)

> Internal planning note. Not legal/financial advice. Keep out of marketing copy
> until validated.

## Model: open-core + dual-license

- **Free core (AGPL-3.0):** the browser DJ deck, AutoMix, Coach, local-file
  harmonic analysis, library, sets, Club Master enhancement, MIDI. This is the
  verified, production-grade IP (see `docs/FEATURE_STATUS.md`).
- **Velyos Pro (paid, future):** hardened/hosted extras that are expensive to run
  or require accounts/infrastructure:
  - Cloud stem separation (no local Torch/GPU needed)
  - AI automix "pro" presets / smarter transition models
  - Library sync across devices
  - Curated preset / sample / content packs
- **Commercial license (dual-license):** for companies that want to embed Velyos
  Deck in a closed-source or hosted product without AGPL obligations
  (see `COMMERCIAL-LICENSE.md`).

## Why AGPL for the core

Max-adoption MIT would let a competitor wrap the deck into a closed paid product
with nothing back. AGPL keeps network/hosted derivatives open, which (a) protects
the IP and (b) creates demand for the paid commercial license — the open-core
revenue lever.

## Revenue streams, rough order of effort

1. **GitHub Sponsors / donations** — lowest effort, switch on at launch.
2. **Commercial license sales** — needs a contact + a simple agreement template.
3. **Velyos Pro subscription** — needs real product work (billing, license keys
   or hosted backend, the Pro features themselves). Separate future project.

## What NOT to do yet

- Do not advertise Velyos Pro features as available until they are built + QA'd.
- Do not gate any currently-working core feature behind a paywall retroactively
  (community backlash). Pro = genuinely new/hosted value.

## Open technical question (for Pro)

How to separate paid features cleanly: feature flag + license key check, or a
hosted Velyos backend the desktop app calls. Decide when Pro work actually starts.

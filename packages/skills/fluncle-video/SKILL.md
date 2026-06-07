---
name: fluncle-video
description: "Make, render, or compose a Fluncle social video: the per-track video pipeline, social:preview, Remotion compositions for tracks, the Journey/Cosmos primitives, stills, the moodboard, and visual tests. Use whenever the task touches a Fluncle vertical clip on any surface, even small ones: authoring or registering a composition, picking a texture family or travelling vehicle, choosing a musical cut, running social:preview or remotion still, opening Remotion Studio, retinting a moodboard reference, or critiquing a render. Also use when the user mentions the One Vehicle Rule, the Retint Rule, the Eclipse, the close card, NostalgicCosmos, the video kit, or the video agent."
---

# Fluncle Video

Use this skill to make Fluncle's per-track social videos: 1080×1920 vertical clips that put one banger under the burning eclipse, every one unmistakably from the same archive. This is a router. The grammar, the kit, and the operating instructions live in the repo and evolve there; this skill tells you which file to load for what and never duplicates them. If a living doc disagrees with this skill, the doc wins.

## Source priority

Read top-down; later sources fill in detail, earlier sources override on conflict.

1. The user's current brief and the trackId they gave you.
2. `docs/video-agent.md`: the operating instructions for the per-track video agent. Canon order, the firecrawl research split (facts that may render vs creative fuel that never does), the authoring workflow, the still-critique loop, the safety rails. This is your runbook; follow it step by step.
3. `packages/video/README.md`: the kit and the grammar. The constants-vs-variables split, the primitives catalog (`Grain`, `Starfield`, `Eclipse`, `TowerBlocks`, `DitherField`, `FloatingType`, `KaleidoMirror`), the hooks (`useBeat`, `useOnset`, `useEnergy`, `useBass`), the `NostalgicCosmosProps` inputProps contract, and how to author and register a new composition. Import everything from `src/remotion/cosmos.ts`.
4. `packages/video/moodboard/MOODBOARD.md`: the references, the six texture families, the travelling-vehicle index, and the Retint Rule. The first-party `posted/` collages are the only assets you may sample directly into a video; everything else is technique reference only.
5. `DESIGN.md` and `VOICE.md` at the repo root: the visual canon (Nostalgic Cosmos, palette doctrine, named rules) and the copy canon (every word on screen passes it).

## Compressed reminders

Reminders, not the spec. The spec is the docs above.

- **One Vehicle Rule.** Every video is a journey carried by exactly ONE travelling medium: orb (the Eclipse riding the beat), lines (waveform ridges, contour displacement), fractal (mirror/kaleido recursion), glass (refractive panels and ribs), or glitch (dither/pixel corruption travelling across the frame). Choose the vehicle FIRST; everything else supports it. Two competing vehicles means one is wrong.
- **Constants vs variables.** Constants are LAW: grain over the whole frame always, exactly one Eclipse Gold sun moment, Oxanium for brand marks and numerals only, the `Artist — Title` line with the one sanctioned em dash, discovery dates (`Discovered Jun 4`, UTC, tabular, never released/added), warm darks only, and the close card to end every video. Variables are YOURS: palette blend (`paletteMix(track.swatches)`), texture family, motion energy, scene composition. If your concept fights a constant, change the concept.
- **The Retint Rule.** Steal the reference TECHNIQUE (halftone, scanlines, line displacement, liquid folds, mirror tiling, gel split); retint everything to the canon palette: warm dark ground, Eclipse Gold as the single light source, Re-entry Red as the heat accent, Starlight Cream as ink. Cool hues survive only as minor counter-accents. Kaleido chroma comes from the artwork, never gold; gold stays the sun.
- **kebab-case filenames.** New compositions live next to `src/remotion/nostalgic-cosmos.tsx` with kebab-case filenames (pre-commit enforces; the composition export and `Root.tsx` id stay PascalCase). Format with `bunx oxfmt --write <files>`, never prettier.
- **Determinism.** A frame is a pure function of its inputs. Never JS built-in randomness (`Math.random()`) or wall-clock time (`Date.now()`, `new Date()` for "now") inside a composition; use Remotion's `random(seed)` and frame-derived values (`useCurrentFrame()`, `fps`) only. Derive seeded layers from the `seed` prop. Audio reactivity comes only from the `audio.*` arrays through the hooks. CPU-friendly only: SVG/CSS compositing, no WebGL, no canvas.
- **The still-critique loop.** Render at least four stills across the timeline and look at them before paying for a render. Minimum two critique rounds: type legible inside the safe inset (`MARGIN_X` 96, `SAFE_TOP` 150, `SAFE_BOTTOM` 230), palette warm and inky, grain present, nothing blown out. Taste is part of the job.
- **Musical cuts.** The default clip is 20s; rerun with `--duration-ms <10000-30000>` when the waveform suggests a better cut. The cut is a musical decision: end on a drop or just before a transition, never mid-build.

## Commands

Run from the repo root (or `bun run --cwd packages/video <script>`). Use `bun`, never npm/pnpm/yarn. The exact, current flags live in `docs/video-agent.md` and `packages/video/README.md`; check there before running.

- `bun run social:preview <trackId> --skip-render` — resolve + analyze audio (BPM, beat grid, onsets, energy/bass curves), extract artwork palette, write `packages/video/out/<trackId>.props.json`. Run this first; the props file is your ground truth for energy and color.
- `bun run social:preview <trackId>` — the full pipeline through render to `out/<trackId>.mp4`; point it at your composition per the README/agent doc when authoring a new scene.
- `bunx remotion still ... --props=out/<trackId>.props.json --frame=N` — the stills for the critique loop (exact invocation in `docs/video-agent.md`).
- `bun run studio` — Remotion Studio to scrub a scene live with default props.
- `bun run --cwd packages/video typecheck` and `bunx oxlint packages/video` — the quality gates before any render.

## Hard rails

- **Never publish.** Rendering is local only; the artifact is the MP4 and your run report. Nothing leaves the machine; publishing to any platform is out of scope.
- **Audio: Deezer/iTunes only.** Preview audio comes solely from the pipeline's resolver. Never source audio from YouTube or rip full tracks. No legal audio means no video; stop and report.
- **One video per run.** Do not commit, push, or delete anything.
- **Every fact on screen has a cited source URL; every word passes VOICE.md.** Track metadata from the props file is always safe and needs no citation; an unverified fact never renders. Drum & bass aliases collide with mainstream names: when unsure, drop the fact.

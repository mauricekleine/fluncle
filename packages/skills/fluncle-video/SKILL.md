---
name: fluncle-video
description: "Make, render, or compose a Fluncle social video: the per-track video pipeline, social:preview, the archive under tracks/, Remotion compositions for tracks, the near-blank canvas (ShaderLayer + GLSL, the audio hooks, useJourney, FloatingType, CloseCard), stills, the moodboard, and visual tests. Use whenever the task touches a Fluncle vertical clip on any surface, even small ones: authoring or registering a track composition in the dated tracks/ archive, writing a scene shader, picking a texture family or travelling vehicle, choosing a musical cut, running social:preview or remotion still, opening Remotion Studio, retinting a moodboard reference, or critiquing a render. Also use when the user mentions the One Driver rule (One Vehicle Rule), the Always-Visible Vehicle, the Eclipse, the Retint Rule, the close card, NostalgicCosmos, the video kit, or the video agent."
---

# Fluncle Video

Use this skill to make Fluncle's per-track social videos: 1080×1920 vertical clips that put one banger under the burning eclipse, every one unmistakably from the same archive, no two looking alike. **This skill is the constitution.** The package (`packages/video`) is a near-blank canvas — machinery and brand law, nothing styled — and the agent writes the scene and the shader for each track itself. More creative freedom, more diversity; the doctrine lives here.

This file is a router. Read it top-down, then load the reference for the phase you are in. The doctrine below is authoritative; where a living doc in the repo adds detail, follow it, but the rulings here win on conflict.

## Why this exists

A styled component library made agents produce same-looking videos: identical text spots and timing, default eclipse discs, the same vehicle three runs in a row. The best output came from an agent writing its own shader from scratch. So the styled scene library is gone, the package slimmed to the core surface, and the rules that used to be enforced by components are now doctrine you uphold by hand. Diversity is the point. If your video could be swapped with the last one and nobody would notice, you have failed.

The aesthetic is already captured and it is strong — warm dark, one burning sun, grain, the through-the-glass calm. **Trust it, and use it freely.** The rulings below fence the brand; the space inside them is wide and it is yours. Lean toward the bolder, more alive idea over the safe repeat — a render that is unmistakably Fluncle yet unlike anything in the archive is the win. The doctrine is a short list of laws plus the few failure modes that have actually bitten us, not a recipe to follow step by step.

## The two things that are always true

1. **The video IS the archive file.** Each video is one self-contained file: `packages/video/src/remotion/tracks/YYYYMMDD-<kebab-slug-of-title>.tsx` (kebab-case, enforced by a pre-commit hook), exporting a named PascalCase component, registered in `src/remotion/root.tsx`, importing only the core from `../cosmos`. It is deterministic, so it re-renders identically forever. The archive is the collection; rendered MP4s are never committed.
2. **You write the scene.** There are no prebuilt vehicles, no styled scene components, no static image assets (fonts excepted). You compose the scene and author the GLSL shader yourself, against the core surface. The core gives you a canvas and the brand law; the picture is yours.

## Source priority

Read top-down; later sources fill in detail, earlier sources override on conflict.

1. The user's current brief and the trackId they gave you.
2. **This skill and its references** (`packages/skills/fluncle-video/`): the constitution. The doctrine, the technique cookbook, the workflow, the safety rails.
3. `packages/video/README.md`: the core surface in code — exact import names, the props contract, the `ShaderLayer` header and `GLSL.*` inventory, how to register a composition. Code-of-record; if a name here disagrees with the README, the README is right about the name.
4. `packages/video/moodboard/MOODBOARD.md`: the references, the six texture families, the Retint Rule. The first-party `posted/` collages are the only assets you may sample directly; everything else is technique reference only.
5. `DESIGN.md` and `VOICE.md` at the repo root: the visual canon (Nostalgic Cosmos, palette doctrine, named rules) and the copy canon (every word on screen passes it).

## The core surface (what you may import)

Everything comes from `src/remotion/cosmos.ts`. Nothing else exists to import; if you reach for a styled vehicle or a static image, it is gone on purpose.

- **`ShaderLayer`** + the **`GLSL`** snippet helpers — the GPU fragment-shader layer and the composable GLSL function strings. This is where you draw. See [references/cookbook.md](references/cookbook.md).
- **Audio hooks** — `useEnergy`, `useBeat`, `useBass`, `useOnset` — the only legal source of audio reactivity (they read the `audio.*` curves).
- **`useJourney`** — the narrative clock (`progress` / `phase` / `phaseProgress` / `arc`). One shared timeline for the whole scene.
- **`Grain`** — the CSS film-grain overlay (the system base texture for non-shader layers).
- **`Starfield`** — the orbital star field.
- **`FloatingType`** — typography for the four sanctioned roles, with a built-in legibility guarantee. Use it for every word on screen.
- **`CloseCard`** — the locked brand ending.
- **`paletteMix`** — locks palette roles to canon (field stays Deep Field, sun stays Eclipse Gold, ink stays cream; artwork hues live only in secondary swatches).
- **color helpers** (`withAlpha`, `mix`, `luminance`, …), **fonts**, and the **props contract** types (`NostalgicCosmosProps` and friends).

That is the whole kit. The README has the exact signatures.

## Doctrine

Nine rulings. They are LAW. If a concept fights one, change the concept.

1. **One Driver.** Exactly ONE travelling, beat-synced medium per video. orb / lines / fractal / glass / glitch are EXAMPLES, not an enum — invented vehicles are welcome, provided there is exactly one. When the vehicle is NOT an orb, the One Sun Eclipse Gold moment is expressed THROUGH the vehicle (a gold crest line igniting, a gold resolution front) — never as a second celestial body sharing the frame. Two drivers means one is wrong.

2. **Always-Visible Vehicle.** The vehicle is on screen and holds the center of attention from frame one to the final frame; it may fade/scale in over the first second, transform, travel, intensify — never a late reveal, never absent waiting for the drop.

3. **Vehicle diversity.** Before choosing, `ls packages/video/src/remotion/tracks/` and read the vehicle line in the most recent 2-3 archive files' header comments; do not repeat the most recent vehicle unless the music demands it. (In the last batch two of three agents independently chose the orb.)

4. **Type staging is a VARIABLE.** Placement and timing of the artist mark, track line, and date are yours, chosen musically per scene — entering on a fill, riding a riser, anchored where the composition gives them room. What is LAW: legibility (use `FloatingType`), safe margins (~96px x, ~150/230px top/bottom on 1080×1920), VOICE.md for every word ("Artist — Title", "Found Jun 4", sentence case, no exclamation marks), and the `CloseCard` ending. The last batch placed identical text in identical spots at identical times in all three videos — that is the failure mode this rule kills.

5. **Metadata must visibly matter.** Facts come from the track's Spotify metadata, surfaced in the props file — never from web search. (a) FACTS that may render on screen: release year and label (when present in the props). They are authoritative — straight from Spotify, the source of truth — so they need no citation and carry no alias-collision risk; render only fields the props actually expose, and never invent one. Rendering a verified fact is ENCOURAGED. (b) CREATIVE FUEL that never renders as text: the artwork palette the pipeline extracts, the album and label names, the track title, and the shape of the energy curve. This shapes your vehicle, texture family, palette lean, and scene concept; your run report must name how it drove specific visual decisions ("a liquid-funk label and a drifting energy curve → a glass vehicle, fluent family") so the operator can see it in the pixels. BPM is measured by the audio pipeline (beat-grid aligned, more accurate than any metadata tempo) — that is what the vehicle syncs to; musical Key, if the props expose it, is an optional DJ touch on the overlay, never required.

6. **The quad law.** Every `ShaderLayer` must drive final color AND alpha to exactly 0.0 inside its quad bounds (a circular fade in layer space covers the corners — r reaches 1.41 there). The printed-rectangle incident happened twice.

7. **Motion law — audio drives intensity, not position.** Anything that moves across the frame — a vehicle, a field, a streak, a star — advances MONOTONICALLY and continuously, from `u_time`, the journey `arc`, or a monotonic rise. Beat-synced and transient audio (`u_beatPulse`, onsets, energy spikes) modulates BRIGHTNESS, width, exposure, glow, or grain — never a position/flow coordinate. Subtract a snappy pulse from a position and the scene jumps forward and snaps back on every beat (the Wings glitch); feed that same pulse to brightness and it breathes. Keep procedural detail low-frequency enough (or fbm-softened) that it does not shimmer or alias as it travels. The starfield is the same law: monotonic orbital drift, audio touches twinkle only.

8. **Musical cut.** 20s default; choose `--duration-ms` (10–30s) from the waveform; end on a drop or just before a transition, never mid-build.

9. **The music leads, the video follows.** Audio reactivity is the point, not a finishing touch — the vehicle must visibly, legibly move WITH the track: lock to the beat grid, let the drop and the onsets HIT, map the energy curve to real swings in exposure / scale / width / density. The test, applied on the rendered MP4 (not the stills): **if the motion would look the same with the audio muted, the video has failed.** This stays inside the Motion law — reactivity rides intensity, never position (doctrine 7) — but it must be FELT; ambient drift that merely coexists with the music is the failure this kills (the 06-09 batch over-smoothed into floatiness). Sharp, structured textures (below) carry this far better than soft haze.

## Failure modes from the last batch (avoid these)

Not new law — the shapes of getting it wrong, so you can see them coming. Recent clips have drifted off-brand in these ways the rulings above don't spell out:

- **Lose the vehicle two ways — fog or chart.** A vehicle reads when it is STRUCTURE with DEPTH, and there are two opposite ways to lose it. A **formless fog**: soft warm gradients with no legible form (the 06-09 `straight-to-your-heart` / `teddys-gate` haze) — pretty, but nothing is actually _there_. A **flat chart**: thin, hard, sparse ruled primitives that reveal nothing (the 06-08 `spears` equalizer of shafts) — structure with no depth or meaning. The target sits between them: **structure that looks like a real thing, but only just so.** A halftone dot-screen dissolving a bloom (`moodboard/halftone-tulip-bloom.png`), a CRT/scanline raster over a subject (`crt-scanline-roses.png`), contour lines that DISPLACE to sculpt an eclipse out of an otherwise flat ruled field (`contour-eclipse-lines.png`) — all are sharp and structured AND representational and deep. **Sharp is welcome; sparse-and-empty and soft-and-formless are not.** Bonus: structure beat-syncs far more legibly than haze (doctrine 9).
- **The copy-paste climax.** Every clip bloomed bright in the dead centre and settled — the One Sun moment landing as a centred mid-clip glow every single time. The moment is always present and always ONE (a constant), but its TIMING, PLACEMENT, and FORM are yours: ignite late, build slow and hold, sweep across as a front, sit off-centre, pulse and recede, crest at the very end. `useJourney`'s depart→travel→arrive with a centred settle is ONE option, not a mandate. If your bright moment lands where the last clip's did, move it.
- **Copy-paste type.** Identical cream/gold lines in identical spots at identical times (doctrine 4 already forbids this). Vary placement musically AND derive the ink from the scene's own palette — a dusty rose, an artwork counter-accent — not always cream/gold. `FloatingType` carries its own contrast guarantee, so a non-cream ink still reads. Cream/gold is a default, not a requirement.

## The constants you cannot touch

Grain over the whole frame, always. Exactly one Eclipse Gold sun moment (expressed through the vehicle when it is not an orb). Oxanium for brand marks and numerals only. `Artist — Title` with the one sanctioned em dash. `Found Jun 4` dates (UTC, tabular, never released/added). Warm darks only. The `CloseCard` ending. Determinism: remotion seeded `random()` and frame-derived values only — never `Math.random` / `Date.now` / `new Date()`. The Retint Rule: artwork hues are minor counter-accents only; gold stays the sun.

## References

- [references/workflow.md](references/workflow.md) — the per-track runbook, end to end: trackId → props → metadata → concept → author → still-critique → gates → render → report. Read this when you start a video.
- [references/cookbook.md](references/cookbook.md) — technique, not style: fbm haze fields, ridge/contour fields, dither/halftone fronts, SDF bodies, beat-mapping patterns, the `GLSL.*` inventory, palette discipline. Worked examples cite the archive files. Read this while authoring the shader.

## Commands

Run from `packages/video` (or `bun run --cwd packages/video <script>`). Use `bun`, never npm/pnpm/yarn. Exact flags live in `packages/video/README.md`.

- `bun run social:preview <trackId> --skip-render` — resolve + analyze audio (BPM, beat grid, onsets, energy/bass curves), extract artwork palette, write `out/<trackId>.props.json`. Run first; the props file is your ground truth.
- `bun run social:preview <trackId> --composition <CompId>` — the full pipeline through render to `out/<trackId>.mp4`, pointed at your composition.
- `bunx remotion still src/remotion/index.ts <CompId> out/still-N.png --props=out/<trackId>.props.json --frame=N --gl=angle` — the stills for the critique loop (GPU shaders require `--gl=angle`).
- `bun run studio` — Remotion Studio, to scrub a scene live with default props.
- `bun run --cwd packages/video typecheck` and `bunx oxlint packages/video` — the gates before any render. Format with `bunx oxfmt --write <files>`, never prettier.

## Hard rails

- **Never publish.** Rendering is local only; the artifact is the MP4 and your run report. Nothing leaves the machine.
- **Audio: the pipeline resolver only (Deezer/iTunes).** Never source audio from YouTube or rip full tracks. No legal audio means no video; stop and report.
- **One video per run. Never commit, push, or delete anything.**
- **Every fact on screen comes from the props' Spotify metadata; every word passes VOICE.md.** Release year and label are authoritative and need no citation. Render only fields the props expose — never invent a fact, never web-search for one.

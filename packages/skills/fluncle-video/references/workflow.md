# Workflow: one track → one video

The per-track runbook, end to end. You are given a trackId; you produce one 9:16 rendered MP4 with its own visual character, unmistakably from the same archive as every other Fluncle video, plus a run report. You work inside a checkout of the Fluncle repo. Read [SKILL.md](../SKILL.md) (the doctrine) first; this is the procedure that applies it.

## 1. Props (the ground truth)

Run `bun run social:preview <trackId> --skip-render` from the repo root first. This resolves preview audio, analyzes it (BPM, beat grid, onsets, energy and bass curves), extracts the artwork palette, and writes `packages/video/out/<trackId>.props.json`.

Read that file. It is the ground truth for the music's energy and the track's colors — title, artists, `discoveredAt`, the swatches, and the `audio.*` arrays your hooks will read. If preview resolution fails, stop and report; there is no video without legal audio.

The default clip is 20s. You may rerun with `--duration-ms <10000-30000>` when the waveform suggests a better cut. **The cut is a musical decision** (doctrine 8): read the energy curve, end on a drop or just before a transition, never mid-build. Derive the drop timestamp(s) from the energy curve peaks — those are the moments your vehicle ignites.

## 2. Metadata (Spotify, via the props)

No web search. The facts come from the track's Spotify metadata, surfaced in the props file, and **the metadata must visibly matter** (doctrine 5). You are mining two kinds of material:

- **FACTS** that may appear on screen: release year and label, when present in the props. They are authoritative — straight from Spotify, the source of truth — so they need no citation and carry no alias-collision risk. Render only fields the props actually expose; never invent one. The track metadata (title, artists, album, Found date) is always safe.
- **CREATIVE FUEL** that never renders as text: the artwork palette the pipeline extracts, the album and label names, the track title, and the shape of the energy curve. This shapes your vehicle, texture family, palette lean, and scene concept. Your run report must **name how it drove specific visual decisions** so the operator can see it in the pixels.

BPM comes from the audio analysis already in the props — measured off the actual clip, beat-grid aligned, more accurate than any metadata tempo; that is what your vehicle syncs to. Musical **Key**, if the props expose it, is an optional DJ touch on the overlay — never required, silently omitted when absent.

## 3. Concept (vehicle FIRST)

In order:

1. **Diversity check (doctrine 3).** `ls packages/video/src/remotion/tracks/` and read the vehicle line in the most recent 2-3 files' header comments. Do not repeat the most recent vehicle unless the music demands it.
2. **Choose the vehicle (doctrine 1, One Driver).** Exactly one travelling beat-synced medium: orb / lines / fractal / glass / glitch, or one you invent. Everything else supports it. Decide how the one Eclipse Gold sun moment is expressed — as the orb itself, or, for any other vehicle, THROUGH the vehicle (a gold crest igniting, a gold resolution front), never as a second celestial body.
3. **Choose the texture family** (nebula / analog / dither / paint / fluent / duotone — see MOODBOARD.md) that fits the tune. A liquid roller wants drift, nebula, or fluent; a neuro stomper wants dither, glitch, hard onset flashes; a gel-lit duotone suits the meditative ones.
4. **Write a two-sentence journey:** from where, through what, arriving where — matched to the song's energy curve. Name where the drop lands and how the vehicle ignites there.

Confirm the **Always-Visible Vehicle** (doctrine 2) in the concept: the vehicle fills the frame from the first frame (a dim ember, a flat field, a scrambled matrix that is unmistakably present), never a late reveal.

## 4. Author the archive file

Create `packages/video/src/remotion/tracks/YYYYMMDD-<kebab-slug-of-title>.tsx` (kebab-case is enforced by a pre-commit hook). Use today's date as the prefix and the kebab-cased track title as the slug.

- Export a named PascalCase `React.FC<NostalgicCosmosProps>` (reuse the contract unchanged so the pipeline feeds it).
- Import ONLY from `../cosmos` (plus `remotion`, `react`, `@fluncle/tokens`). No styled vehicles, no static image assets.
- Write your scene and your GLSL shader. Lean on [cookbook.md](cookbook.md) for technique and the `GLSL.*` inventory.
- Honor the quad law (doctrine 6): every `ShaderLayer` drives color AND alpha to 0.0 inside its quad. Starfield law (doctrine 7): monotonic drift, audio touches brightness/twinkle only.
- Keep all type inside the safe inset via `FloatingType`; place and time it musically (doctrine 4), not in the same spots as the last video.
- End with `CloseCard`, driven by the journey's `"arrive"` phase.
- **Determinism:** remotion `random(seed)` and frame-derived values only. Never `Math.random` / `Date.now` / `new Date()`. Audio reactivity only through the hooks.
- Open the file with a header comment that states, at minimum: the track and label, the **vehicle** (so the next agent's diversity check works), the texture family, and the two-sentence concept. Match the style of the existing archive headers.

Register it in `src/remotion/root.tsx`: import the component, add `{ component, id: "<PascalId>" }` to the `trackCompositions` array. The id is unique PascalCase.

## 5. Still-critique loop (minimum two rounds)

Render stills across the timeline and **view them** — code review alone misses overflow and blowouts:

```
bunx remotion still src/remotion/index.ts <CompId> out/still-N.png --props=out/<trackId>.props.json --frame=N --gl=angle
```

GPU shaders require `--gl=angle`. Render at least four frames across the clip, and ALWAYS include:

- **frame ~5** — verify the vehicle is present and holding center (Always-Visible Vehicle).
- **the brightest frame** (the drop, from the energy curve) — verify type legibility and that nothing is blown out, that gold is ~10% of the frame, that the warm dark holds.

Iterate until type is legible inside the safe inset, the palette stays warm and inky, grain is present, and the vehicle reads from frame one. Two critique rounds minimum; taste is part of the job.

## 6. Gates

`bun run --cwd packages/video typecheck` and `bunx oxlint packages/video` must pass. Format with `bunx oxfmt --write <files>`.

## 7. Render

`bun run social:preview <trackId> --composition <CompId>` and **wait for the encode to finish** — renders take minutes and the MP4 is invalid until the process exits. Confirm with `ffprobe`: 1080×1920, h264, aac audio, 15–30s.

## 8. Ship (package, upload, link)

Once the render passes its gates, package the bundle and link it to the track. All local; the operator runs it.

1. **Package** — `bun run --cwd packages/video ship <trackId|log-id>` builds `out/<log-id>/`:
   - `review.mp4` — with audio; the web cut + your QA pass
   - `social.mp4` — audio-less remux (`ffmpeg -c copy -an`); the cut you upload to TikTok and attach the official sound to by hand (keeps licensing inside TikTok)
   - `poster.jpg` — a ~80% drop frame
   - `caption.txt` — the fixed-template caption: `Artist — Title (Year)` / Label / `Found <date>: fluncle://<log-id>` / `#dnb #drumnbass #drumandbass` + sub-genre tags (lowercased, deduped)

   The track MUST have a Log ID (no Log ID → no ship; backfill the ISRC first). Requires an existing render (`out/<trackId>.mp4`) — run step 7 first.

2. **Upload + link** — `fluncle admin track video <log-id> --dir packages/video/out/<log-id>` uploads the bundle to R2 under `<log-id>/` (served at `found.fluncle.com`) and sets the track's `video_url` to the review cut. The Worker owns R2; you never hold R2 credentials.
3. **Post (manual)** — grab `social.mp4`, upload to TikTok, attach the official sound, paste the caption, post. Auto-draft is deferred.

## 9. Report

Output:

- output MP4 path and composition id;
- the **vehicle** and the **texture family**;
- the concept in one line;
- the **on-screen facts** (release year, label) — all from the props' Spotify metadata, so no citation is needed;
- the **metadata-to-pixels trace** — which creative-fuel finding drove which visual decision;
- the still paths you reviewed;
- if shipped: the `<log-id>/` bundle and the linked `video_url`.

The operator reviews the MP4, runs the ship step, and posts; you never auto-publish to any platform.

## Safety rails (also in SKILL.md; they survive even if the rest is skipped)

- One video per run. The render is local; the only thing that leaves the machine is the operator-run ship step (the bundle → R2 via the admin endpoint, linked as `video_url`). No auto-publish to TikTok or any social platform — that stays manual.
- Preview audio comes only from the pipeline's resolver (Deezer/iTunes). Never source audio from YouTube or rip full tracks. The `social.mp4` cut you ship is audio-less by design.
- The constants are not yours to restyle: if your concept fights the grammar, change the concept.
- Every word on screen and in the caption passes VOICE.md; every fact on screen has a source; the track metadata needs none.
- Do not commit, push, or delete anything; your artifacts are the MP4 bundle, the linked `video_url`, and your report.

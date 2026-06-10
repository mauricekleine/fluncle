# Workflow: one track → one video

The per-track runbook, end to end. You are given a trackId; you produce one 9:16 rendered MP4 with its own visual character, plus a source-backed output bundle that can be uploaded to R2 and rerendered later. You work inside a checkout of the Fluncle repo. Read [SKILL.md](../SKILL.md) (the doctrine) first; this is the procedure that applies it.

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

1. **Diversity check (doctrine 3).** Run `fluncle recent --json` and read the `videoVehicle` field of the recent findings — the diversity ledger. List the vehicles already used and choose one clearly different (the last batch all landed on voronoi/cellular with no ledger to warn them — don't repeat that). Also honor the brief and the SKILL.md failure modes.
2. **Choose the vehicle (doctrine 1, One Driver).** Exactly one travelling beat-synced medium: orb / lines / fractal / glass / glitch, or one you invent. Everything else supports it. Decide how the one Eclipse Gold sun moment is expressed — as the orb itself, or, for any other vehicle, THROUGH the vehicle (a gold crest igniting, a gold resolution front), never as a second celestial body.
3. **Choose the texture family** (nebula / analog / dither / paint / fluent / duotone — see MOODBOARD.md) that fits the tune. A liquid roller wants drift, nebula, or fluent; a neuro stomper wants dither, glitch, hard onset flashes; a gel-lit duotone suits the meditative ones.
4. **Write a two-sentence journey:** from where, through what, arriving where — matched to the song's energy curve. Name where the drop lands and how the vehicle ignites there.
5. **Score the movements (doctrine 10).** Split the clip into 2–3 movements and pin each boundary to a real musical seam — a drop, a bar boundary, a breakdown, an energy shift — by reading the beat grid and energy curve (the timestamps go in your header comment). Name what visibly changes at each boundary (palette lean, density/scale jump, reframe, a new behavior of the same vehicle): same theme, a legible shift. If you cannot say what changes at second N, the clip has one movement and will exhaust the eye.
6. **Write the reactivity map (doctrine 9).** Use `useAudioReactivity(audio, profile)` unless there is a specific reason not to. Name at least one structural reaction (`u_audioHit`/`u_audioSwell` changes width, density, radius, scale, threshold), one light reaction (glow, exposure, One Sun intensity), and one texture reaction (grain, dither, chroma, edge roughness). Audio disturbs the material, not just illuminates it; never feed these signals into travel position.

Confirm the **Always-Visible Vehicle** (doctrine 2) in the concept: the vehicle fills the frame from the first frame (a dim ember, a flat field, a scrambled matrix that is unmistakably present), never a late reveal.

## 4. Author the temporary composition

Create a temporary self-contained composition source file under `packages/video/src/remotion/` while you work. A dated filename is still useful for local clarity, but it is not an archive contract and must not be committed. `ship` will copy the exact source into `packages/video/out/<log-id>/composition.tsx`; R2 keeps the durable copy.

- Export a named PascalCase `React.FC<NostalgicCosmosProps>` (reuse the contract unchanged so the pipeline feeds it).
- Import ONLY from `../cosmos` (plus `remotion`, `react`, `@fluncle/tokens`). No styled vehicles, no static image assets.
- Write your scene and your GLSL shader. Lean on [cookbook.md](cookbook.md) for technique and the `GLSL.*` inventory.
- Honor the quad law (doctrine 6): every `ShaderLayer` drives color AND alpha to 0.0 inside its quad. Starfield law (doctrine 7): monotonic drift, audio touches brightness/twinkle only.
- Render the facts through `TypePlate` (doctrine 4): one drop-in, fixed homes, prescriptive timing — pass scene-derived `ink`/`dimInk`, and nudge `identityInSec`/`telemetryInSec` onto a musical seam if the intro asks. Never hand-place the facts with raw `FloatingType`.
- End with `CloseCard`, driven by the journey's `"arrive"` phase — it owns its lower-left home; pass it the scene `palette` for ink + emphasis accent.
- **Determinism:** remotion `random(seed)` and frame-derived values only. Never `Math.random` / `Date.now` / `new Date()`. Audio reactivity only through the hooks.
- **Reactivity bus:** prefer `useAudioReactivity` and pass its `uniforms` into `ShaderLayer` (or pass `onsets`/`reactivity` directly to `ShaderLayer` for built-in `u_audio*` uniforms). Map those uniforms to material disturbance: width, density, threshold, radius, refraction, grain, dither, glow. Do not map them to travel position.
- Open the file with a header comment that states, at minimum: the track and label, the **vehicle** (so the next agent's diversity check works), the texture family, and the two-sentence concept. Keep it useful as future rerender context because this exact file is shipped as `composition.tsx`.

Register it in `src/remotion/root.tsx`: import the component, add `{ component, id: "<PascalId>" }` to the `trackCompositions` array. The id is unique PascalCase. This registration is temporary working state; remove it after the bundle is shipped.

## 5. Still-critique loop (minimum two rounds)

Render stills across the timeline and **view them** — code review alone misses overflow and blowouts:

```
bunx remotion still src/remotion/index.ts <CompId> out/still-N.png --props=out/<trackId>.props.json --frame=N --gl=angle
```

GPU shaders require `--gl=angle`. Render at least four frames across the clip, and ALWAYS include:

- **frame ~5** — verify the vehicle is present and holding center (Always-Visible Vehicle).
- **the brightest frame** (the drop, from the energy curve) — verify type legibility and that nothing is blown out, that gold is ~10% of the frame, that the warm dark holds. Verify the vehicle's FOCAL MASS sits inside the frame — off-centre is good, but the centre of attention must not be cropped out of frame (a crescent whose body lives past the edge reads as a missed framing, not a composition).
- **one still per MOVEMENT** (doctrine 10) — put them side by side: a viewer should see at a glance that these are different passages of the same world (palette lean, density, scale, regime). If two movements' stills could be swapped without anyone noticing, the shift is too timid — push it.
- **a mid-travel frame** — check the vehicle reads as STRUCTURE WITH DEPTH — neither a flat diagram of thin hard primitives nor a formless warm fog (SKILL.md failure-modes); check the type ink is drawn from the composition's palette and there is NO gold type anywhere. Across your frames, confirm the `TypePlate` blocks sit in their fixed homes (identity lower-left, telemetry upper-right with the Log ID), both legible over the scene and both gone before the drop; check the movement boundaries read as a passage arriving over ~a bar, not a cut (doctrine 10).

Iterate until type is legible inside the safe inset, the palette stays warm and inky, grain is present, and the vehicle reads from frame one. Two critique rounds minimum; taste is part of the job.

**Stills cannot show motion jitter or reactivity.** After the gates, scrub the MP4 (or render 3–4 ADJACENT frames around a beat) to confirm the vehicle FLOWS — position advances smoothly, audio only brightens/widens, nothing jumps-and-snaps on the kick (Motion law, doctrine 7). Then the **reactivity gate** (doctrine 9): play the MP4 against the audio — can you FEEL the kick and the drop in the picture? If the motion would look the same with the sound muted, the reactivity is too weak; push it before you ship. Finally the **swap test**: compare against recent run reports, R2 composition artifacts, or operator-provided stills when available. If the climax blooms in the same place, or the type sits in the same spot, or the geometry rhymes — change it.

## 6. Gates

`bun run --cwd packages/video typecheck` and `bunx oxlint packages/video` must pass. Format with `bunx oxfmt --write <files>`.

## 7. Render

`bun run social:preview <trackId> --composition <CompId> --composition-source <path-to-composition.tsx>` and **wait for the encode to finish** — renders take minutes and the MP4 is invalid until the process exits. The render writes `out/<trackId>.mp4` and `out/<trackId>.render.json`. Confirm with `ffprobe`: 1080×1920, h264, aac audio, 15–30s.

## 8. Ship (package, upload, link)

Once the render passes its gates, package the bundle and link it to the track. All local; the operator runs it.

1. **Package** — `bun run --cwd packages/video ship <trackId|log-id> --vehicle "<your vehicle>"` builds `out/<log-id>/` (the `--vehicle` tag, e.g. `"caustic web"`, lands in `render.json` and becomes the track's diversity-ledger entry on upload):
   - `footage.mp4` — with audio; the public/web cut (becomes `video_url`) + your QA pass
   - `footage-silent.mp4` — audio-less remux (`ffmpeg -c copy -an`); the cut you upload to TikTok and attach the official sound to by hand (keeps licensing inside TikTok)
   - `poster.jpg` — a ~80% drop frame
   - `note.txt` — the fixed-template caption that accompanies the footage: `Artist — Title (Year)` / Label / `Found <date>: fluncle://<log-id>` / `#dnb #drumnbass #drumandbass` + sub-genre tags (lowercased, deduped)
   - `composition.tsx` — the exact temporary Remotion source used for the render
   - `props.json` — analyzed audio curves, beat grid, palette, and track props
   - `render.json` — composition id, rerender pointers, and the `vehicle` tag (the diversity-ledger entry, read by the upload step into `video_vehicle`)

   The track MUST have a Log ID (no Log ID → no ship; backfill the ISRC first). Requires an existing render (`out/<trackId>.mp4`) — run step 7 first.

2. **Upload + link** — `fluncle admin track video <log-id> --dir packages/video/out/<log-id>` uploads the bundle to R2 under `<log-id>/` (served at `found.fluncle.com`) and sets the track's `video_url` to the review cut. The Worker owns R2; you never hold R2 credentials.
3. **Post (manual)** — grab `footage-silent.mp4`, upload to TikTok, attach the official sound, paste `note.txt`, post. Auto-draft is deferred.
4. **Clean local source** — after `composition.tsx` is present in the output bundle, remove the temporary composition file and its `root.tsx` registration before committing. Generated compositions are output artifacts, not codebase history.

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
- Preview audio comes only from the pipeline's resolver (Deezer/iTunes). Never source audio from YouTube or rip full tracks. The `footage-silent.mp4` cut you ship is audio-less by design.
- The constants are not yours to restyle: if your concept fights the grammar, change the concept.
- Every word on screen and in the caption passes VOICE.md; every fact on screen has a source; the track metadata needs none.
- Do not commit, push, or delete anything; your artifacts are the MP4 bundle, the linked `video_url`, and your report.

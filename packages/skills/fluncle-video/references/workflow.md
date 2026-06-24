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

1. **Diversity check (doctrine 3).** Run `fluncle admin tracks vehicles --json` — the recently-used vehicles, newest first — the diversity ledger. List the vehicles already used and choose one clearly different; parallel runs converge on the same idea (voronoi/cellular, horizontal lines) unless each deliberately diverges. Also honor the brief and the SKILL.md failure modes.
2. **Commit to the whole-frame register, THEN the driver (doctrine 1).** First decide what the WHOLE frame is: **fully abstract** (the field itself is the image, edge to edge) or **recognizably real, shown abstractly** (the eye can name it — a flock, flowers, a wing); never the uncanny middle, and never a small object on a dead background. Then pick the ONE driver inside it — the full-field surface ITSELF, or a focal subject that integrates the whole frame. orb / lines / fractal / glass / glitch, or one you invent; everything else supports it. Let `track.features` (the enrichment spectral summary in props, when present) steer the choice — a sub-bass-heavy track (`subBassRatio`) wants a dense, heavy vehicle; a bright high-`centroidHz` one wants treble sparkle and fine detail; a busy high-`onsetRate` one wants a snappier field. Decide how the one committed climax is expressed — the vehicle's OWN material intensifying in the SCENE's palette (a crest igniting, a resolution front completing, a body's limb surging), never a second celestial body and never a bolted-on gold/yellow sun. Eclipse Gold is optional, reached only when the vehicle's own material genuinely runs hot; a cool scene climaxes cool.
3. **Choose the texture family** (nebula / analog / dither / paint / fluent / duotone / smear — see MOODBOARD.md) that fits the tune. A liquid roller wants drift, nebula, or fluent; a neuro stomper wants dither, glitch, hard onset flashes; a gel-lit duotone suits the meditative ones; a headlong, propulsive track suits smear (velocity blur). Pick a DIFFERENT region than the last few renders — the moodboard is a map of distinct looks, not an average to converge on.
4. **Write a two-sentence journey:** from where, through what, arriving where — matched to the song's energy curve. Name where the drop lands and how the vehicle ignites there.
5. **Read the music's arc (doctrine 10) — drive the arc from the live envelopes.** The energy curve and the drop are the clip's shape. Drive the vehicle's structural arc — density, threshold, width, ignition, exposure, framing — from the live audio uniforms (`u_energy` / `u_audioSwell` / `u_audioDrop`) so the build IS the music, the same on any track. Place the drop crest with the `reactivity.drop` envelope (`{ peakTimeMs, riseMs, holdMs, fallMs }`), which derives a smoothed `u_audioDrop` from the energy curve — that is the sanctioned home for the crest timestamp. Keep hardcoded `sec`-timeline structure (the "scripted-clock arc") for the journey baseline only; a vehicle whose density or ignition is a JS `interpolate(sec, …)` aligns with the music only on the one track it was tuned to. List the key timestamps in your header comment as a read, not as constants the structure indexes.
6. **Write the reactivity map (doctrine 9).** Use `useAudioReactivity(audio, profile)` unless there is a specific reason not to. Name at least one structural reaction (`u_audioHit`/`u_audioSwell` changes width, density, radius, scale, threshold), one light reaction (glow, exposure, climax intensity), and one texture reaction (grain, dither, chroma, edge roughness). Split the THREE frequency bands across elements (`u_bass`/`useBass` kick → one element, `u_mid`/`useMid` lead → another, `u_treble`/`useTreble` hats → fine detail/sparkle) so the clip PLAYS the music, not just moves with it. Audio disturbs the material IN PLACE — that is where ALL the reactivity belongs; GLOBAL translation (travel, flow, convergence) stays an audio-free constant clock by default (doctrine 7). If audio MUST bend translation, only a smoothed envelope with a SMALL coefficient over a dominant constant base, never the raw per-beat transient.
7. **Write the render intent (`out/<trackId>.intent.json`).** Capture the reactivity map as a machine-readable record at `out/<trackId>.intent.json` (schema `fluncle.render-intent/1`): the `vehicle`, `textureFamily`, `register`, `arcSource: "energyCurve"`, `motionModel`, `dropMs` (from the energy-curve crest), the `climax` {form, colour drawn FROM the scene, atMs}, and the `bindings[]` — one entry per `{band, element, axis, intendedStrength}`. Cover ≥1 structural axis (width/threshold/warpAmp/wallSharpness/density/radius/scale/curvature), ≥1 light axis (brightness/exposure/glow/ignition), and ≥1 texture axis (grain/chroma/dither/edgeRough). Any binding with `axis: "translation"` MUST use a smoothed band (`swell`/`drop`/`energy`). This file is the contract the render is checked against and is shipped into the bundle (`ship` copies `out/<trackId>.intent.json` → `intent.json`; a missing intent is warn-and-stub in v1, not a blocker). The frozen schema lives in `packages/video/src/pipeline/intent.ts` (`type RenderIntent`); the shader's header comment may mirror it for human read.

Confirm the **Always-Visible Vehicle** (doctrine 2) in the concept: the vehicle fills the frame from the first frame (a dim ember, a flat field, a scrambled matrix that is unmistakably present), never a late reveal.

## 4. Author the composition (in the gitignored workbench)

Create your composition at `packages/video/src/remotion/workbench/<CompId>.tsx`. `workbench/` is gitignored and `root.tsx` AUTO-REGISTERS every `.tsx` in it — **the composition id is the filename** (so `workbench/caustic-weave.tsx` renders as `--composition caustic-weave`). You never touch `root.tsx`, and because workbench is gitignored there is nothing to clean up and no commit hazard. `ship` copies the exact source into `packages/video/out/<log-id>/composition.tsx`; R2 keeps the durable copy.

- Pick a unique **kebab-case** `<CompId>` for the filename (e.g. `caustic-weave.tsx` → `--composition caustic-weave`) — the repo's `oxlint` `unicorn/filename-case` gate REJECTS PascalCase filenames, and the composition id is simply whatever the filename is. **`export default`** your `React.FC<NostalgicCosmosProps>` (reuse the contract unchanged so the pipeline feeds it).
- Import ONLY from `../cosmos` (plus `remotion`, `react`, `@fluncle/tokens`). No styled vehicles, no static image assets.
- Write your scene and your GLSL shader. Lean on [cookbook.md](cookbook.md) for technique and the `GLSL.*` inventory.
- Honor the quad law (doctrine 6): every `ShaderLayer` drives color AND alpha to 0.0 inside its quad. Motion law (doctrine 7) for any background/field you author yourself (a star drift, motes — the core ships no Starfield): a smooth baseline drift that audio may bend only through smoothed envelopes, never a raw-beat snap.
- Render the facts through `TypePlate` (doctrine 4): one drop-in, fixed homes, prescriptive timing — pass scene-derived `ink`/`dimInk`, and nudge `identityInSec`/`telemetryInSec` onto a musical seam if the intro asks. Never hand-place the facts with raw `FloatingType`.
- End with `CloseCard`, driven by the journey's `"arrive"` phase — it owns its lower-left home; pass it the scene `palette` for ink + emphasis accent.
- **Play the audio (MANDATORY):** drop `<TrackAudio audio={audio} />` in once. The hooks drive only the VISUALS; this is what makes the render carry SOUND. Omit it and the cut is silent (the render fails on a silence check). `ship` strips audio separately for the `footage-silent.mp4` TikTok cut — your review `footage.mp4` keeps it.
- **Determinism:** remotion `random(seed)` and frame-derived values only. Never `Math.random` / `Date.now` / `new Date()`. Audio reactivity only through the hooks.
- **Reactivity bus:** prefer `useAudioReactivity` and pass its `uniforms` into `ShaderLayer` (or pass `onsets`/`reactivity` directly to `ShaderLayer` for built-in `u_audio*` uniforms). Map those uniforms to material disturbance — width, density, threshold, radius, warp amplitude, wall sharpness, refraction, grain, dither, glow — and route the fast bands (`u_bassFast`/`u_midFast`/`u_trebleFast`, `u_audioHit`, `u_onsetPulse`) onto in-place STRUCTURAL deformation as sharply as the music hits (the gate-safe binding idiom). Keep GLOBAL translation (travel, flow, convergence) an audio-free constant clock — `u_time` / `arc` / a steady eased rise — by default; if audio must bend it at all, only the smoothed envelopes (`u_audioSwell` / `u_audioDrop` / `u_energy`) with a small coefficient over a dominant constant base, never the raw per-beat transient (doctrine 7).
- Open the file with a header comment that states, at minimum: the track and label, the **vehicle** (so the next agent's diversity check works), the texture family, and the two-sentence concept. Keep it useful as future rerender context because this exact file is shipped as `composition.tsx`.

No registration step — dropping the file in `workbench/` is the registration (root.tsx globs it). Nothing to add to `root.tsx`, nothing to remove afterward.

## 5. Still-critique loop (minimum two rounds)

Render stills across the timeline and **view them** — code review alone misses overflow and blowouts:

```
bunx remotion still src/remotion/index.ts <CompId> out/still-N.png --props=out/<trackId>.props.json --frame=N
```

GPU shaders need a GL context — ANGLE locally / swangle on a GPU-less host, inherited from `remotion.config.ts` via `FLUNCLE_GL` (no `--gl` flag needed). Render at least four frames across the clip, and ALWAYS include:

- **frame ~5** — verify the vehicle is present and holding center (Always-Visible Vehicle).
- **the brightest frame** (the drop, from the energy curve) — verify type legibility and that nothing is blown out, that the warm dark holds. Verify the vehicle's FOCAL MASS sits inside the frame — off-centre is good, but the centre of attention must not be cropped out of frame (a crescent whose body lives past the edge reads as a missed framing). Check the corners: the full-bleed field must reach all four — if the frame reads as a circle/porthole, the background vignette is too tight (doctrine 6).
- **stills across the arc** (doctrine 10) — one at the open, one mid-build, one at the crest; side by side they should read as the SAME world evolving (the energy curve's rise carried into density, palette lean, scale, exposure), not a static loop. Composition check (doctrine 11): if the vehicle is symmetric/radial, the symmetry holds the whole clip (centre doesn't wander off-axis); if it has a single focal mass, that mass is dead-centre or decisively off-centre, never _slightly_ off. (A translational/continuous vehicle is exempt from both.)
- **a mid-travel frame** — check the vehicle reads as STRUCTURE WITH DEPTH — neither a flat diagram of thin hard primitives nor a formless warm fog (SKILL.md failure-modes); check the type ink is drawn from the composition's palette and there is NO gold type anywhere. Across your frames, confirm the `TypePlate` blocks sit in their fixed homes (identity lower-left, telemetry upper-right with the Log ID), both legible over the scene and both gone before the drop; check the clip evolves continuously with the energy curve, never holding a static loop (doctrine 10).

Iterate until type is legible inside the safe inset, the palette stays warm and inky, grain is present, and the vehicle reads from frame one. Two critique rounds minimum; taste is part of the job.

**Aim, don't discover — and pivot the primitive, don't tweak a fragile one.** Decide the **brightness + density intent across the arc up front** (what the open vs the breakdown vs the drop should each look like) before tuning, so you're steering toward a target, not stumbling onto one. Then the convergence rule: **if 2–3 tuning rounds don't converge, the vehicle/primitive is wrong — pivot it, don't keep tweaking constants.** Oscillating between two bad poles (a smooth bright blob ↔ dark and flat) is the tell that the underlying primitive can't hit the target (dots are a classic offender — see the dots-as-overlay note in the cookbook); change the primitive (a continuous ridged-filament or cellular field instead) rather than grinding the same one for ten rounds.

**The iteration ladder: stills → draft → one full ship render.** Stills (seconds) settle the static look — composition, palette, framing across the arc. They CANNOT show motion, reactivity, or whether the drop lands. Don't reach for the slow ship render to check those: render a **draft** (`bun run social:preview <trackId> --composition <CompId> --draft` → `out/<trackId>.draft.mp4`, half-res, ~6× faster, full motion + real audio) and eyeball motion + run the beat-pull gate on it (`detect-beat-pull out/<trackId>.draft.mp4`) for a FAST directional read while you iterate on the fix. Caveat: the draft is half-res, so it can UNDER-REPORT reversal on fine-stipple / live-grain clips (the churn the gate scores only fully manifests at full res — measured: a clip read 0.15 on the draft but 0.23 on the full). So the draft gate is DIRECTIONAL, not authoritative — the PASS verdict is always the full render's gate (step 7). Only once stills + the draft look right do you spend the one full ship render — which confirms the gate AND is the only thing that can judge the load-bearing grain. Drafts never ship (half-res/jpeg hide the grain; `ship` refuses a draft-only).

**Stills cannot show motion jitter or reactivity.** After the gates, scrub the MP4 (or render 3–4 ADJACENT frames around a beat) to confirm the vehicle FLOWS — position advances smoothly, audio only brightens/widens, nothing jumps-and-snaps on the kick (Motion law, doctrine 7). Then the **reactivity gate** (doctrine 9): play the MP4 against the audio — first confirm it HAS audible audio at all (the render's silence check guards this, but listen), then ask: can you FEEL the kick and the drop in the picture? If the motion would look the same with the sound muted, the reactivity is too weak; push it. But the motion itself must stay SMOOTH — if the picture jitters/lurches on the beat, audio is wrongly driving speed or position; move that reactivity into brightness/size/thickness/curvature instead (doctrine 7). Catch this here by eye, but the **beat-pull gate at step 7** is the objective backstop — a clip that lurches will fail it. Also confirm the clip's evolution EASES with the energy curve — a continuous build, never a static hold or a hard step (doctrine 10). And the climax check (doctrine 1): the bright moment must read as the VEHICLE igniting (its own material intensifying in the scene's palette), not a round sun-glow layered on top — and if the scene is cool, the climax stays cool, with no gold/yellow reached for. Deleting the vehicle should delete the bright moment. Finally the **swap test**: compare against recent run reports, R2 composition artifacts, or operator-provided stills when available. If the climax blooms in the same place, or the type sits in the same spot, or the geometry rhymes — change it.

## 6. Gates

`bun run --cwd packages/video typecheck` and `bunx oxlint packages/video` must pass. Format with `bunx oxfmt --write <files>`.

## 7. Render

`bun run social:preview <trackId> --composition <CompId>` and **wait for the encode to finish** — renders take minutes and the MP4 is invalid until the process exits. (`<CompId>` is your `workbench/<CompId>.tsx` filename; the source is auto-resolved from there, so `--composition-source` is no longer needed.) The render writes `out/<trackId>.mp4` and `out/<trackId>.render.json`. Confirm with `ffprobe`: 1080×1920, h264, aac audio, 15–30s.

**Beat-pull gate (MANDATORY — do not skip, do not ship past a fail).** Your eyes at step 5 are the first line, but beat-pull is a temporal artifact a scrub can miss, so it is gated objectively:

```
bun run --cwd packages/video detect-beat-pull <trackId>
```

It measures the clip's short-lag motion reversal — whether the picture jumps then snaps back, jittering back and forth (the lurch-and-snap, Motion law doctrine 7) — and exits non-zero on a fail. It does NOT punish a crisp surge that hits on the beat and flows on (that's doctrine 9, and it's wanted); only motion that UNDOES itself fails. A **fail** means a per-beat signal is driving position/travel/flow: find it (a raw `beat`/`hit`/`onset`/`u_audioBeat`/`u_audioHit` or a raised `swellBeatWeight` feeding a transform), move it into material (brightness/width/scale/glow — doctrine 7), and re-render. Iterate until it passes. (Inconclusive — too few frames — passes; that's fine.)

## 8. Ship (package, upload, link)

Once the render passes its gates, package the bundle and link it to the track. All local; the operator runs it.

1. **Package** — `bun run --cwd packages/video ship <trackId|log-id> --vehicle "<your vehicle>" --grain "<your grain family>"` builds `out/<log-id>/` (the `--vehicle` and `--grain` tags, e.g. `"caustic web"` / `"grainCoarseSilver"`, land in `render.json` and become the track's diversity-ledger entries on upload):
   - `footage.mp4` — with audio; the public/web cut (becomes `video_url`) + your QA pass
   - `footage-silent.mp4` — audio-less remux (`ffmpeg -c copy -an`); the cut you upload to TikTok and attach the official sound to by hand (keeps licensing inside TikTok)
   - `poster.jpg` — a ~80% drop frame
   - `note.txt` — the fixed-template caption that accompanies the footage: `Artist — Title (Year)` / Label / `Found <date>: fluncle://<log-id>` / `#dnb #drumnbass #drumandbass` + sub-genre tags (lowercased, deduped)
   - `composition.tsx` — the exact Remotion source used for the render (copied from `workbench/<CompId>.tsx`)
   - `props.json` — analyzed audio curves, beat grid, palette, and track props
   - `render.json` — composition id, rerender pointers, and the `vehicle` + `grain` tags (the diversity-ledger entries, read by the upload step into `video_vehicle` / `video_grain`)

   The track MUST have a Log ID (no Log ID → no ship; backfill the ISRC first). Requires an existing render (`out/<trackId>.mp4`) — run step 7 first.

2. **Upload + link** — `fluncle admin tracks video <log-id> --dir packages/video/out/<log-id>` uploads the bundle to R2 under `<log-id>/` (served at `found.fluncle.com`) and sets the track's `video_url` to the review cut. The Worker owns R2; you never hold R2 credentials.
3. **Post (manual)** — grab `footage-silent.mp4`, upload to TikTok, attach the official sound, paste `note.txt`, post. Auto-draft is deferred.

No cleanup step: the composition lives in the gitignored `workbench/` and `root.tsx` was never edited, so there is nothing to remove and nothing can leak into a commit. The durable copy is the R2 bundle; the local `workbench/` file and `out/` render are disposable scratch (an ephemeral agent VM discards them; a fresh agent starts clean from source).

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

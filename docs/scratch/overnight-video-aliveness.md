# Overnight: Video Aliveness RFC — Part I built + a before/after render pilot

**Branch:** `video-aliveness-overnight` (NOTHING pushed to main, no deploy, no publish — all left for the operator).
**Date:** 2026-06-22 → overnight.
**What this is:** Part I of `docs/rfcs/video-aliveness-rfc.md` built on the branch (Tiers 1), then 3 not-yet-posted findings each rendered TWICE — once on the new pipeline with NO judge (Tier 2), once on the new pipeline WITH a local LLM judge in the loop (Tier 3) — for a before/after comparison.

---

## TIER 1 — Part I built on the branch (committed BEFORE any render)

Commits (oldest→newest), all gate-green at each step:

| Commit    | Unit                      | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4dfc86a` | Step 0                    | Froze the §B6 `RenderIntent` schema → `packages/video/src/pipeline/intent.ts` (type + `validateRenderIntent` + `generateIntentStub` + axis-group sets). Pasted the gate-safe binding idiom into the cookbook (attributed by primitive, not scene).                                                                                                                                                                                                                                |
| `fd5c761` | A — signal chain          | HOP_MS 50→20; STFT frame 0.09→0.046 (~46ms) paired with the hop; peak-per-band (bass stays the FULL <150Hz peak bin — NOT narrowed); shared-reference P97 normalization + pow(0.7) lift (cross-band loudness survives); swell 0.6/0.4 (reaches 1.0); useEnergy sf 6→4; shipped `fluxCurve`+`u_flux`+`useFlux`; shipped `rawDynamicsHint` (A↔C contract); uniform-bag cleanup (only `u_audioDisturbance` survives).                                                                |
| `dc6360c` | C — deterministic metrics | `frames.ts` (param extractors + `structuralDelta`); `analyze-motion.ts` = `judge:metrics` (flash-safety HARD with a sliding 10°-field area rule + static 0.02 deadband; coupling with a SINGLE principled lag + the intent-declared band + a per-clip permutation null; intent-vs-actual + the translation tripwire + axis coverage); detect-beat-pull refactored onto a shared frame path (golden byte-identical); ship.ts copies `intent.json` into the bundle (warn-and-stub). |
| `64454d4` | B — doctrine + docs       | SKILL doctrine 7/9 reframe (reversal in TRANSLATION is the only motion sin; material may be sharp in place), the symmetric "sharpen the bind, never add motion" cure, soul retune, the new "scripted-clock arc" failure mode; cookbook arc-from-audio; workflow step 7 "Write the render intent"; README contract (flux/rawDynamics/the eval scripts/the bundle files).                                                                                                           |

### Test results (the gate — green)

- `bun run --cwd packages/video typecheck` clean · `bunx oxlint packages/video` exit 0 · `bun test` all 8 files pass (the repo's self-running-assert pattern: "0 tests" but every assert executes).
- **flash-safety** fixtures: strobe → **unsafe**, boiling-grain → **safe**, **fast-flash-in-grain → unsafe** (the new P0 fixture — grain cannot hide a real flash), localized-quadrant strobe → **unsafe** (proves the sliding 10°-window vs whole-frame), red-strobe → red branch fires. The CLI exits non-zero on the conjunction; `--allow-flash` overrides flash only, never beat-pull.
- **coupling permutation null** on the noise fixture: a **defined false-positive rate of ~7%** (block-shuffle, mulberry32 seed=0, N=200), where the naive max-over-bands-and-lags estimator the RFC rejected reads "alive" 21–73% of the time on noise.
- **detect-beat-pull golden**: byte-identical after the C1 refactor (grain raw `0.6800544743756005`, hardened `0.5070420720154718`).
- **intent-vs-actual**: drop spike + arc-peak alignment, the translation tripwire, and ≥1-structural/light/texture coverage all assert correctly.

---

## TIER 2 — the 3 findings on the NEW pipeline, NO judge (video #1 each)

3 true not-yet-posted findings (have `video_url`, `posts: []` for both TikTok + YouTube). Each rendered by a FRESH sub-agent via the `/fluncle-video` flow on the new pipeline, no LLM judge. All three: beat-pull PASS, flash SAFE, coupling ALIVE (P100 vs the per-clip null — the new dials are demonstrably moving the picture with the music), 1080×1920 h264+aac, 20s.

| Log ID   | Track                  | Vehicle (family)                 | beat-pull | flash | coupling                                | output                               |
| -------- | ---------------------- | -------------------------------- | --------- | ----- | --------------------------------------- | ------------------------------------ |
| 020.9.8S | Revolution — Dimension | loom interference (analog)       | 0.14 pass | safe  | alive r=0.68 **z=6.60** (bass, 100ms)   | `out/overnight/020.9.8S.nojudge.mp4` |
| 020.0.8R | Run To You — Archangel | plasma filaments (fluent)        | 0.15 pass | safe  | alive r=0.66 **z=7.22** (midFast, 33ms) | `out/overnight/020.0.8R.nojudge.mp4` |
| 020.0.5L | Do U? — Ownglow        | cell membrane / voronoi (fluent) | 0.12 pass | safe  | alive r=0.50 **z=5.86** (energy)        | `out/overnight/020.0.5L.nojudge.mp4` |

(Each finding's no-judge `metrics.json` + `intent.json` snapshot is preserved beside the mp4 as `<logId>.nojudge.metrics.json` / `.nojudge.intent.json`.)

Notes from the fresh render sessions (unsteered): all three independently landed on the new doctrine's escape route — bind a fast band to in-place material (width/threshold/ignition), keep the kick OFF translation — and each cleared beat-pull by moving an audio-on-coordinate term to a constant clock. The diversity nudge held: three distinct vehicles, none a repeat of the recent archive.

---

## TIER 3 — the same 3 via the local judge loop (video #2 each)

The judge tonight is a **LOCAL throwaway harness** (`packages/video/out/_judge/judge-local.ts`, gitignored): it builds a contact-sheet (ffmpeg tile), runs `judge:metrics`, and POSTs the sheet + metrics + intent + an audio digest to OpenRouter `google/gemini-3.1-flash-lite` for a rubric-only structured critique (no operator anchors). It is NOT Unit D (the real Worker relay is Part II — deferred). Validated end-to-end against a real render: schema-valid critique, metrics reach the model (it cites per-binding coupling values in its `likelyCodeFixes`), fail-advisory-open on error.

Each track: fresh sub-agent → author → draft → judge → auto-iterate ≤ N=2 DRAFT rounds → full render. Sequential (the parallel agents share the gitignored `workbench/` and collided on file writes in Tier 2).

<!-- TIER 3 RESULTS — filled in as each track completes -->

| Log ID   | Track                  | Vehicle (family)                | judge rounds                             | final verdict | final gates                                                 | output                             |
| -------- | ---------------------- | ------------------------------- | ---------------------------------------- | ------------- | ----------------------------------------------------------- | ---------------------------------- |
| 020.9.8S | Revolution — Dimension | carrier smear (smear)           | 2 (both `ship`) + 1 advisory             | ship          | beat-pull 0.11 · flash safe · coupling alive z=3.43 (P99.5) | `out/overnight/020.9.8S.judge.mp4` |
| 020.0.8R | Run To You — Archangel | molten glaze / voronoi (fluent) | 2 (both `ship`) + 1 advisory             | ship          | beat-pull 0.147 · flash safe · coupling alive z=4.76 (P100) | `out/overnight/020.0.8R.judge.mp4` |
| 020.0.5L | Do U? — Ownglow        | liquid lens / caustic (fluent)  | 2 (R1 `ship`, R2 truncated) + 1 advisory | ship          | beat-pull 0.16 · flash safe · coupling alive z=4.91 (P100)  | `out/overnight/020.0.5L.judge.mp4` |

All six deliverables ffprobe **h264 · 1080×1920 · aac**, ~20.0s.

### Per-track judge delta

**020.9.8S Revolution — Dimension** (Tier 3 vehicle: carrier smear, a degraded-broadcast streak field; 2 pivots scanlines→filaments→smear because the fine-periodic primitives had an intrinsic ~0.28 beat-pull reversal floor).

- **Round 1** → `ship` · readability 4, others (brandFit 5, motionEnergy 4, beatSync 4, divergence 5). `likelyCodeFixes`: (a) `threshold-decay-curve` groundedIn `readability` — "the smear breaks into large disconnected blobs during the build"; (b) `chroma-shimmer-shader-gain` groundedIn `intent.bindings(chroma)`. **Applied:** tightened the streak survival-threshold range + reduced the width swell so the open gate keeps coherent threads; bumped the trebleFast chroma gain.
- **Round 2** → `ship` · **readability rose 4→5** (the blob fix landed). `likelyCodeFixes`: (a) streak-crest ignition groundedIn `midFlatness 0.788`; (b) streak width groundedIn `bass crest 5.27`. **Applied:** pushed midFast ignition + the audioHit term, and the bassFast width swell — both in-place (the doctrine-9 "sharpen the material bind" move). Stopped at the N=2 cap on a `ship` verdict.
- **Visible change the judge drove:** the build phase went from confetti-like blob breakup to coherent streaming threads (readability 4→5), and the climax ignition + kick-width punch got sharper without touching translation. Likely code fixes were all grounded in real metric keys / `track.features`, demonstrating the judge reasoning WITH the deterministic numbers (it cited per-binding coupling and the bass crest, not vibes).

**020.0.8R Run To You — Archangel** (Tier 3 vehicle: molten glaze, a cracked-membrane voronoi crust; no pivot).

- **Round 1** → `ship` · 5/4/4/5/4. `likelyCodeFixes`: (a) ignition-lerp intensity groundedIn `intent.climax`; (b) width-binding lag groundedIn `beatPull lagFrames=2`. **Applied:** strengthened the build's core-open/ignite to kill a flagged 14–15s pre-drop responsiveness dip. **Gate-respecting:** a width-boost trial pushed beat-pull to the fail line, so the agent reverted it and kept only the gate-safe brightness/threshold changes.
- **Round 2** → `ship` · 5/4/4/5/4, no off-brand moments (only a non-blocking `deadZone@14000` advisory). Converged at the N=2 cap.
- **Visible change the judge drove:** a livelier pre-drop build (the responsiveness dip closed) without breaking the Motion law — the loop's own discipline (revert the change that fails beat-pull) is exactly the bounded-sharpen doctrine working.

**020.0.5L Do U? — Ownglow** (Tier 3 vehicle: liquid lens, a warm caustic refraction field; no pivot).

- **Round 1** → `ship` · 5/4/4/5/4. `likelyCodeFixes`: strengthen bass→brightness and flux→grain. **Applied:** added a whole-field kick flinch + a focus pulse on bass, and lifted the flux→grain coefficient (both in-place, gate-safe). **Effect:** coupling went from `null` → **alive (r=0.48, z=4.91, mid-led)** — the judge's fix measurably raised aliveness.
- **Round 2** → scores held (5/4/4/5/4) but the critique JSON was **truncated at max_tokens** (`ok:false` — a harness artifact, not a quality signal; the raw fragment showed identical ship-level scores). Treated as advisory-unavailable; deterministic gates carried the decision. Converged.
- **Visible change the judge drove:** a dead → alive coupling jump (the build now flinches on the kick and the focus pulses) plus warmer threads, all in-place. The clearest single before/after where the judge's grounded fix moved a metric.

### Before/after read (the honest headline)

The felt aliveness win is **Part I (the signal chain)**, not the judge: **all six renders — judged or not — are "alive"** against each clip's own permutation null (coupling P99.5–P100). With the old per-band absolute-max normalization + the 0.64 swell ceiling, "alive" was hard to reach; with the new shared-reference normalization, peak-per-band, uncapped swell, and the flux channel, three independent fresh sessions hit strong coupling on the first pass.

Coupling-z by track (no-judge vehicle → judge vehicle; both alive):

- 020.9.8S: 6.60 (loom interference) → 3.43 (carrier smear)
- 020.0.8R: 7.22 (plasma filaments) → 4.76 (molten glaze)
- 020.0.5L: 5.86 (cell membrane) → 4.91 (liquid lens)

The judge versions are different _vehicles_ (fresh sessions, by design), so the z-deltas are not "judge made it worse" — they reflect different compositions, all comfortably alive. **The judge's demonstrated value is the taste/readability/brand layer on top of an already-alive render:** it caught a build-phase blob breakup (020.9.8S readability 4→5), a pre-drop responsiveness dip (020.0.8R), and a dead→alive coupling gap (020.0.5L R1) — each fix _grounded in a real metric key or `track.features`, not vibes_, and each kept inside the Motion law (it reverted a 020.0.8R width boost that would have failed beat-pull). That is exactly the RFC's framing: Part I carries the felt win; the judge is the advisory taste/divergence guard.

---

## What is blocked / scoped out (honest)

- **Part II (Unit D — the LLM judge Worker relay) is DEFERRED** by design. Tonight's judge is the local throwaway harness; the real `critique_track_video` oRPC relay + the `OPENROUTER_API_KEY` Worker secret + the `OPENROUTER_JUDGE_MODEL` config var are Part II (one prod deploy — a human action).
- **Unit E (production render-queue loop wiring)** — inserting the metrics + judge calls into `render-queue.prompt.md`/`workflow.md` automation is Phase 2; not wired tonight (the workflow's intent-authoring step IS added so renders produce `intent.json`).
- **Coupling stays ADVISORY in v1** — it ships with the corrected permutation-null estimator but is not a hard gate until its cutoffs are calibrated against operator labels (Decision 2). The two HARD gates are flash-safety (new) + beat-pull (existing).
- **Unit C build interruption (handled):** the Unit C sub-agent hit a transient OpenRouter/API rate limit before finishing its last three items; the orchestrator completed them directly (the `judge:metrics` package.json script, the ship.ts intent copy/stub, and reporting `provisionalThresholds` on the coupling result) and re-ran the full gate green.
- **Local judge harness artifact (minor):** one of ~8 judge calls (020.0.5L round 2) returned `ok:false` because the model's JSON ran past the harness's `max_tokens` (1600) and truncated mid-string. The fail-advisory-open path handled it correctly (the run proceeded on the deterministic gates + the visible raw scores). For Part II's real relay, raise the token ceiling / set the schema's `summary` shorter. Throwaway harness lives at `packages/video/out/_judge/judge-local.ts` (gitignored).

## Orchestration note (method)

Units A/B/C and all 6 renders were built by FRESH sub-agents (own context, own creative choices), but in the SHARED working tree rather than isolated git worktrees. Rationale: (a) the cross-unit contracts force ordering anyway (C consumes A's `types.ts`; B documents A+C), so A→C ran sequentially and B (docs) ran parallel to C since they are file-disjoint; (b) worktree agents branch from origin's last _pushed_ commit, but the brief forbids pushing — they would have missed the local Step-0/A/C commits; (c) merging worktree branches back without touching main adds fragility for an unattended run. The substantive requirements held: disjoint file sets, B owns all README/skill docs, each unit reviewed + gated + committed before the next. Tier-3 renders ran sequentially (the parallel Tier-2 agents collided writing the shared gitignored `workbench/`).

## Operator's pending calls

1. **Pick the judge anchors (Decision 6):** choose 1–2 strong renders + 1 dead one and label them; they wire into the judge prompt as few-shot anchors (teach the bar, never "make it look like this"). The 6 pilot clips in `out/overnight/` are a natural starting set.
2. **Deploy Part II (Unit D):** the Worker relay + `wrangler secret put OPENROUTER_API_KEY` + the model config var — the one prod deploy, landed isolated, build confirmed on the final commit (coalescing).
3. **Review + merge Part I:** review the four commits on `video-aliveness-overnight` and merge to main when no other `apps/web` deploy is in flight.
4. **Label the pilot for calibration (Decisions 4–5):** tag each of the 6 clips dead/weak/alive to seed the coupling-cutoff corpus (target ≥60 clips before promoting coupling to a soft gate); the pilot also lets you swap any not-yet-posted clip for its new render if it wins.

## Reproduce / locate

- New-pipeline props for any track: `bun run --cwd packages/video social:preview <trackId> --skip-render`.
- Metrics on a render: `bun run --cwd packages/video judge:metrics <trackId|video> --json --intent <file>`.
- The local judge: `bun packages/video/out/_judge/judge-local.ts --video <mp4> --track <trackId> --intent <file>` (needs the Bash sandbox disabled for the OpenRouter call; reads the key from `~/.config/fluncle/.env.local`).
- All 6 deliverables + their metrics/intent snapshots + the Tier-2 composition sources: `packages/video/out/overnight/` (gitignored).

---

## Reviewer note (heartbeat, 2026-06-23 ~01:10) — Part I + the 6-clip pilot, independently verified

Re-ran on the branch (no live render in flight):

- **Gates GREEN:** `typecheck` exit 0 · `oxlint` exit 0 · `bun test` — all 8 files' asserts pass, beat-pull golden byte-identical (raw `0.6800544743756005` / hardened `0.5070420720154718`). The panel's P0 fixes are present and tested: the 10°-field flash rule + the fast-flash-in-grain fixture, the coupling per-clip permutation null (~7% FP vs the rejected 21–73%), peak-per-band over the full <150Hz, `rawDynamicsHint`.
- **All 6 renders valid:** 1080×1920 h264+aac, ~20.0s; each passes flash (safe) + beat-pull + `hardPass`.

**Before/after coupling (raw r) — the headline finding:**

| Track    | no-judge | judge |
| -------- | -------- | ----- |
| 020.0.5L | 0.504    | 0.482 |
| 020.0.8R | 0.659    | 0.447 |
| 020.9.8S | 0.684    | 0.230 |

On all three tracks the judge-loop render has LOWER raw coupling than the no-judge render (all still "alive" + gate-pass). Two caveats: each clip is a DIFFERENT vehicle (a fresh author, not the same comp refined), and the judge optimizes its rubric (brandFit / readability / divergence / motionEnergy) — NOT the coupling metric. So this is "what the agent makes with vs without judge feedback," n=1 per track, rubric-only, no anchors.

**Likely correction (ties to Decision 6):** when picking the judge anchors, include at least one HIGH-coupling alive clip scored 5 on motionEnergy (e.g. the 0.68 no-judge 020.9.8S) as the "this is alive" anchor — a rubric-only judge with no anchors appears to drift toward polish/readability over raw reactivity. The 6 pilot clips are the natural anchor set. Eyeball the mp4s directly to decide whether the judge's trade (more brand/readability, less raw coupling) reads better to you — that taste call is exactly what this comparison was built to surface.

Heartbeat stood down — run complete (Part I built + verified green, 6/6 pilot videos rendered).

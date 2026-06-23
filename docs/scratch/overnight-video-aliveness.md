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

---

## Round 2 — beat-having tracks (2026-06-23)

Round 1's three source tracks were all intros/lulls (per `out/overnight/labels.json`: "NO real beat … reactivity-to-a-drop was never tested"). Round 2 re-runs the before/after on **3 findings whose preview audio has a real, sustained beat**, with fresh **unbiased** sub-agents (each got only the trackId + "make the best Fluncle video per the skill" — no vehicle/coupling/round-1 hints), so the comparison is honest. 6 new mp4s in `packages/video/out/overnight/` (`<logId>.{nojudge,judge}.mp4` + `.metrics.json` + `.intent.json`), all ffprobe **1080×1920 h264+aac, ~20s**.

### The beat filter (and a metric bug it caught)

The first gate (`onsetDensity≥1.5 ∧ bassCrest≥2.0 ∧ energyRise`) **passed all three round-1 lulls** — the analyzer's onsets fire on atmospheric build texture, and a build IS an energy rise. Worse, across **36 sampled candidates, 0 passed** a `bassCrest≥2.0`-plus-sustain gate, because **`bassCrest` (p95/mean of the bass curve) is ANTI-correlated with a real beat**: a sustained dropped beat has _compressed_ bass (loud throughout → low crest); a sparse intro has _spiky_ bass (high crest). Requiring high crest selects FOR intros. Corrected gate (`packages/video/out/_judge/beat-gate.ts`, gitignored): **`onsetDensity≥1.5 ∧ sustainHigh≥0.35 ∧ secondHalfMean≥0.55 ∧ bassSustain≥0.3`** — sustained loudness + bass presence. It cleanly fails the round-1 lulls (sustainHigh 0.01–0.08, bassSustain 0.03–0.20) and passes real drops. Only **2 not-yet-posted** findings cleared it, so the 3rd is a **posted** track (Krakota — flagged; not swappable). Never padded with a lull.

### Labeling-ready table (operator: fill the last column by eyeballing the mp4s)

| Log ID   | Track                                                                           | Beat confirm (onset/s · sustainHigh · 2ndHalf · bassSustain · bpm) | Variant | Vehicle (family)                             | Hard gates                       | Coupling r (z / pctile)          | Your label |
| -------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------- | -------------------------------------------- | -------------------------------- | -------------------------------- | ---------- |
| 019.3.9J | Empty Love (GLXY Remix) — Submotion Orchestra/Ed Thomas/GLXY · _not-yet-posted_ | 4.3 · 0.39 · 0.65 · 0.53 · 185                                     | nojudge | watered silk — interference weave (fluent)   | beat-pull 0.16 ✓ · flash safe ✓  | **0.04 (dead)**                  |            |
| 019.3.9J | ″                                                                               | ″                                                                  | judge   | cell skin — voronoi (fluent)                 | beat-pull 0.14 ✓ · flash safe ✓  | **0.573** (z 6.21 / P100, alive) |            |
| 018.5.7Y | Shelter — Flowidus · _not-yet-posted_                                           | 5.1 · 0.64 · 0.77 · 0.76 · 175                                     | nojudge | cold murmuration — ridged streaming + dither | beat-pull 0.16 ✓ · flash safe ✓  | **0.06 (dead)**                  |            |
| 018.5.7Y | ″                                                                               | ″                                                                  | judge   | frost bloom — crystalline voronoi (fluent)   | beat-pull 0.098 ✓ · flash safe ✓ | **0.43** (z 5.55 / P100, alive)  |            |
| 011.6.8K | Sea Air — Krakota · **POSTED (not swappable)**                                  | 5.85 · 0.60 · 0.63 · 1.0 · 185                                     | nojudge | tide screen — halftone/dither                | beat-pull 0.16 ✓ · flash safe ✓  | **−0.31 (dead)**                 |            |
| 011.6.8K | ″                                                                               | ″                                                                  | judge   | drift veil — smear                           | beat-pull 0.13 ✓ · flash safe ✓  | **0.25** (z 3.45, alive)         |            |

All 6 PASS both hard gates (beat-pull + flash). Each `judge` variant is a DIFFERENT vehicle from its `nojudge` sibling (fresh author per the unbiased design), so coupling deltas conflate vehicle + judge — **the eyeball is the arbiter.**

### The headline finding — coupling is miscalibrated for real beats

**All three NO-JUDGE renders read coupling "dead" (0.04 / 0.06 / −0.31)** despite passing beat-pull + flash and reacting per each agent's frame-verify. This reproduces (on real beats) the blind spot `labels.json` flagged, and explains it:

- The coupling estimator runs on `structuralDelta`, which is **brightness-normalized** (mean-luma subtracted) — so it is BLIND to luminosity/exposure reactivity, a primary gate-safe channel. Krakota's no-judge "tide screen" expresses loudness through brightness → coupling went **negative** (−0.31).
- It correlates against the audio curve's variance, but a **sustained** beat has flat-high energy (little variance) → correlation collapses toward 0 even when the picture reacts in-place to the kick.
- Net: coupling reads "dead" on exactly the renders that ARE reacting on a real beat. **Do NOT promote coupling to a gate** (Decision 2) on this estimator; Part II needs a beat-grid-aligned reactivity measure (does material deform ON the beats, luminosity included), not curve-variance correlation.

### The judge, on real beats (honest read)

Every `judge` variant scored coupling "alive" (0.57 / 0.43 / 0.25) where its `nojudge` sibling read "dead" — but this is **not** clean evidence the judge improves aliveness:

- The judge optimizes its rubric + the (flawed) coupling number, which rewards large-scale structural change. On **Flowidus** the agent pivoted its motion model to a **rigid one-way slide** to clear beat-pull — that is the operator's "dead sliding" failure mode, yet it scores coupling 0.43 "alive." A higher coupling number can mean _more sliding_, not more felt aliveness.
- Where the judge clearly helped: **real brand + arc catches** grounded in metrics — GLXY's judge caught a "bolted-on golden sun" (the climax's "perfect circularity reads procedural") and the fix removed it; Krakota's judge drove the climax from **10627ms → 340ms** off the real drop. And the agents correctly **overrode** bad suggestions (GLXY's judge said "remove text overlays" — refused; the TypePlate is mandatory per doctrine 4).
- `beatSync` stayed low (1–2) across Krakota's judge rounds — the contact-sheet (keyframes) can't perceive beat-locked in-place reactivity, so the judge leans on the flawed coupling number for "motion."

**Verdict to confirm by eye:** consistent with round 1, the judge is a useful brand/arc/readability + divergence layer but does not reliably raise _felt_ aliveness and can push toward sliding. Label the 6 clips; if the judge variants read worse despite higher coupling, that confirms both the metric and the rubric-only judge need the anchors (Decision 6) before either is trusted for aliveness.

### Round-2 operator calls

- **Label the 6 clips above** (eyeball — the table's last column). This is the real test of judge-vs-nojudge on a beat, and seeds the coupling re-calibration.
- **The coupling metric needs a redesign before it gates anything** — stop brightness-normalizing away luminosity; measure beat-aligned in-place reactivity, not curve-variance correlation. (Feeds Part II.)
- Krakota (`011.6.8K`) is **already posted** — its clip is not swappable; it is here only to test aliveness-on-a-beat.
- **OpenRouter credits ran out mid-run once** (Krakota's first judge attempt fell through to an un-judged render — no contact-sheet produced; I stopped it and re-ran after the balance recovered, then all judge calls returned `ok:true`). Part II's relay should surface a clear "judge unavailable / out of credits" advisory rather than silently shipping an un-judged render as a judged one.

---

## Reviewer note (heartbeat, 2026-06-23 ~11:35) — Round 2 closeout + the converged conclusion

The round-2 run + the operator labels + the metric reads now agree on a single, cheap story. All 6 round-2 clips ffprobe valid (1080×1920 h264+aac, ~20s); both hard gates pass on all.

**Judge-vs-nojudge beat-pull (the whole-vehicle jump), per track:** 011.6.8K 0.164→0.130 (−0.034); 018.5.7Y 0.157→0.098 (−0.059); 019.3.9J 0.164→0.141 (−0.024). The judge lowered the jump on all three — but at least one (Flowidus 018.5.7Y) reached it by pivoting to a **rigid one-way slide** (the operator's "dead sliding" failure), then scoring coupling 0.43 "alive." So the judge trades JUMP for DEAD-SLIDE. The contact-sheet (keyframes) cannot perceive beat-locked in-place reactivity, so the judge falls back on the flawed coupling number → optimizes toward sliding. **Verdict: the judge is a dead end for ALIVENESS** (both rounds). It may still serve as a brand/off-brand/readability checker — but not for the goal.

**Coupling is miscalibrated for real beats (sharper diagnosis):** it correlates the picture-delta against the audio curve's VARIANCE, but a sustained dropped beat is flat-high energy (low variance) → correlation collapses to ~0 even when the picture reacts on the kick. All 3 no-judge renders read "dead" (0.04 / 0.06 / −0.31) while reacting. The fix is a **beat-grid-aligned reactivity measure** — does material deform/brighten ON the beatGrid timestamps vs between — NOT curve-variance correlation. Do not gate on the current coupling.

**The beat-filter bug the run caught (good catch):** `bassCrest` (p95/mean) is ANTI-correlated with a real beat (a sustained drop has compressed bass → low crest; a sparse intro has spiky bass → high crest), so the original gate selected FOR intros. Corrected gate (`out/_judge/beat-gate.ts`): onsetDensity + sustainHigh + secondHalfMean + bassSustain. Only 2 not-yet-posted findings cleared it; 011.6.8K (Krakota, POSTED) is flagged not-swappable.

**The converged, cheap, high-confidence plan** (see `out/overnight/INSIGHTS.md`): (1) DOCTRINE — global translation = constant clock, audio-free; all reactivity → in-place internal deformation (018.5.7Y "cold murmuration" nojudge is the exemplar; the jump came from `drift = …swell*1.4…` / `drift = u_audioSwell*0.10`). (2) STATIC LINT — flag an audio uniform on any drift/travel/pos term. (3) TIGHTEN beat-pull ~0.17→0.15 (the nojudge jumpers sit 0.157–0.164). (4) REBUILD coupling as beat-grid-aligned, or keep it advisory-only. (5) DROP the judge for aliveness. Operator to label the 6 round-2 clips (eyeball) to seed the recalibration.

Heartbeat stood down — round 2 complete (6/6 + report).

---

## CORRECTION (operator eyeballed the round-2 JUDGE variants, 2026-06-23 ~11:50)

The reviewer note above called the judge "a dead end for aliveness." **That was wrong** — it leaned on the broken coupling metric + a misread "rigid slide" alarm. Operator labels on the 3 judge variants: **ALL THREE ALIVE**, and BETTER than 2/3 of the no-judge variants (which jumped/scratched). See `out/overnight/round2-labels.json`.

- **Judge verdict → UNRESOLVED, leaning HELPFUL on beat tracks.** Confounded (each variant is a different fresh-author vehicle; n=3) — settle with a same-vehicle judge-refine-vs-not test. The judge variants had LOWER beat-pull (continuous global, no jump) + real internal reactivity → they EXEMPLIFY the aliveness law. The metric (and a prediction) said the opposite of the eye; the eye wins.
- **NEW PRIZED DOCTRINE TARGET (operator-requested): the reactive SCENE-CHANGE / structural arc** — the composition visibly shifts CHARACTER across the song structure (calm build → drop → vibrant main), not just per-beat. = doctrine 10 made vivid; only appears on beat tracks. Exemplars: `018.5.7Y.judge` (clear build/drop/main change, layered cloud-gradient voronoi — best voronoi yet) + `019.3.9J.judge` (oil-painting palette; calm-before → vibrant-on-drop; goldilocks of reactive-not-jumpy). A beat-grid-aligned metric would also measure this.

The cheap aliveness fixes (global-drift-audio-free doctrine + the static lint + beat-pull tighten) STAND — they fix the no-judge jumpers. We ADD the structural-arc doctrine, and we KEEP the judge in the experiment rather than dropping it.

---

## Round 3 — fold-in (Phase A) + same-vehicle judge isolation (Phase B), 2026-06-23

This round acts on the heartbeat plan above: it (A) folds the global-vs-internal findings into doctrine + tooling, then (B) runs the **same-vehicle judge-refine-vs-not test** the note asked for — settling the round-2 confound (each round-2 pair was a _different_ fresh-author vehicle, so "judge vs no-judge" was tangled with "vehicle A vs vehicle B"). In Round 3 each pair is ONE vehicle, rendered, then the judge's `likelyCodeFixes` applied to that SAME composition and re-rendered. The before/after now isolates exactly what the judge changes.

### Phase A — folded in (committed `5e1c72d`, gate green: typecheck + oxlint + bun test, 9 test files)

- **Doctrine (`fluncle-video` skill):** GLOBAL translation is an audio-free constant clock; ALL reactivity is INTERNAL deformation (sharpens doctrine 7). Two new Failure-modes: the DJ-scratch (audio on drift, no constant base) + the uncapped-swell drift surge (audio coeff ≥ the clock coeff). New PRIZED pattern: the reactive scene-change / structural arc (calm build → drop → vibrant main, read from the energy curve). Exemplars cited (cold-murmuration; 018.5.7Y.judge + 019.3.9J.judge).
- **Static lint** `bun run --cwd packages/video lint:composition <comp.tsx>` (`src/pipeline/lint-composition.ts` + test): flags a translation term that binds audio over/without a dominant constant clock. **Validated on the real round-2 sources 3/3:** cold-murmuration clean; tide-screen flagged (`swell*1.4 ≥ sec*0.85`); watered-silk flagged (`drift = u_audioSwell*0.10`, no base) — the two operator-confirmed jumpers, caught at author time.
- **Coupling rebuilt beat-grid-aligned** (`analyze-motion.ts` `beatReactivity` block): on-beat vs off-beat contrast on a combined structural+LUMINANCE delta (fixes the brightness-normalize blind spot) + a phase-shuffle null + a structural-arc score; the legacy `coupling` stays for comparison. **Validated vs all 12 labelled clips:** beat-pull@0.16 cleanly separates the 3 jumpers (≥0.16) from all 8 alive (<0.16); the new beat-reactivity trends alive>weak but is NOISY (it can't see a localized off-centre bloom or a sustained-roller, both frame-averaged away) → it stays ADVISORY, not a gate. **The reliable gate remains beat-pull; the eye remains the arbiter.**
- **Judge harness** re-anchored: motionEnergy/beatSync now read the new beat-grid block (the legacy coupling is told to be ignored on beat tracks), and a per-beat **motion-delta montage** (ffmpeg frame-diffs) is sent beside the keyframe sheet so the judge can SEE reactivity stills can't; max_tokens raised (round-2 truncation fix).
- **beat-pull threshold 0.17 → 0.16** (provisional; alive-exemplar 0.157 / jumpers 0.164).

### Phase B — same-vehicle judge isolation (6 clips for the operator to label)

3 beat-having findings (corrected gate); only **2 not-yet-posted cleanly passed** (the pool is genuinely thin), so the 3rd is the strongest borderline (a real beat at sustainHigh 0.34 vs ~0.35, bassSustain 0.88 — not a lull, not posted). Each pair: ONE vehicle, no-judge baseline → the judge's fixes applied to the SAME composition (material/binding/arc only, never a vehicle pivot) → judge final. All 6 ffprobe **1080×1920 h264+aac, ~20s**; **both intent.json `vehicle` fields match within each pair (isolation confirmed).**

| Log ID   | Track                                                        | Beat confirm (onset/s · sustainHigh · bassSustain · bpm) | Vehicle (one per pair)        | Variant | beat-pull | beatReactivity (bgc / verdict / arc) | Your label |
| -------- | ------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------- | ------- | --------- | ------------------------------------ | ---------- |
| 019.1.7X | Strength — Technimatic · _not-yet-posted_                    | 3.95 · 0.37 · 0.99 · 185                                 | caustic bloom (fluent)        | nojudge | 0.14 ✓    | −0.005 / dead / 0                    |            |
| 019.1.7X | ″                                                            | ″                                                        | ″                             | judge   | 0.14 ✓    | −0.006 / dead / 0                    |            |
| 012.2.4L | See For Miles — Krakota · _not-yet-posted_                   | 5.35 · 0.47 · 0.74 · 185                                 | terrain ridge (nebula)        | nojudge | 0.057 ✓   | 0.026 / reactive / 0.080             |            |
| 012.2.4L | ″                                                            | ″                                                        | ″                             | judge   | 0.144 ✓   | **0.057** / reactive / 0             |            |
| 020.1.1A | Take Me There — Krakota · _not-yet-posted · borderline gate_ | 4.80 · 0.34 · 0.88 · 185                                 | starling murmuration (dither) | nojudge | 0.08 ✓    | 0.022 / weak / 0.05                  |            |
| 020.1.1A | ″                                                            | ″                                                        | ″                             | judge   | 0.09 ✓    | 0.008 / weak / 0.047                 |            |

All 6 pass both hard gates (beat-pull <0.16 + flash safe) and the motion lint (no audio on global translation).

### What the judge did to each fixed vehicle, and the honest read

- **Strength / caustic bloom:** judge said "mild render" at the climax → fixes: bass→brightness gain 0.42→0.95 + ignition re-aligned to the drop. Visually the crest ignites far harder; the beat-grid metric stayed flat (it frame-averages, so a small off-centre bloom is invisible to it).
- **See For Miles / terrain ridge:** judge said low motion → fixes: a stronger energy structural-arc + a per-beat hit pulse. **beatGridCoupling doubled (0.026→0.057), pictureActivity 2.01→2.71** — a measured reactivity gain on the SAME vehicle. Cost: beat-pull 0.057→0.144 (more reactive → closer to the jump line, still passing).
- **Take Me There / starling murmuration:** judge said the climax doesn't condense → fixes: drop→condensation density + per-kick bind + treble sparkle. The arc contrast rose (arcLumaDelta 0.064→0.080, the climax now visibly condenses) but the on-beat metric dipped (a sustained roller has no punchy per-beat transient to lock to without tripping beat-pull).

**The de-confounded finding:** on a FIXED vehicle the judge's fixes are consistently in the right spirit (sharpen the climax / add the arc / increase reactivity), grounded in metric keys, and gate-safe (no pivot; beat-pull still passing; lint clean) — and at least once (terrain ridge) produced a clear measured reactivity gain. This is unlike round 2, where the judge "helped" partly by pivoting to a rigid slide. BUT the deterministic beat-grid metric deltas are MIXED (one doubled, one flat, one dropped) because the metric still can't see localized blooms or sustained-roller reactivity — so the metric cannot certify the judge. **The operator's eye on these 3 same-vehicle before/after pairs is the clean test the round-2 confound blocked.** The judge also showed its weakness mid-run (it mislabeled warm-dark ground as "static blackness" on terrain ridge); the agents corrected by steering on the deterministic signals + the eye.

### Round-3 operator calls

- **Label the 6 clips** (the table's last column). Because each pair is ONE vehicle, the label difference within a pair = the judge's effect, cleanly. This settles "is the judge helpful on beats" without the round-2 vehicle confound.
- **The beat-grid metric needs a localized + envelope-aware read** before it can certify aliveness — it frame-averages, so an off-centre bloom (caustic bloom) and a sustained roller (starling murmuration) both read flat despite visible reactivity. Beat-pull + the lint + the eye remain the reliable trio.
- Only 2 not-yet-posted beat-having findings remain in the recent pool (the well is nearly dry for swappable beat clips); future rounds may need newer findings or posted tracks.
- The `lint:composition` is ready to wire into the render workflow as an author-time gate (it caught both round-2 jumpers); consider adding it to the skill's Gates step.

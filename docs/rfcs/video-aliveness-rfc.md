# RFC: Video Aliveness & Evaluation — make the findings breathe with the music, and close the loop that proves it

**Status:** Final (divergent research → /taste → 4-role adversarial panel, corrections baked in, 2026-06-22) — completeness standard applied.
**For:** a fresh build session or a small team of sub-agents in worktrees (agent-orchestration skill). It is **two deliveries on one spine**: Part I (signal chain + doctrine + objective metrics — local, no deploy, ships first, carries the felt win) and Part II (the LLM judge — the one prod deploy, separable, depends on Part I's frozen intent schema).
**Canon/authority:** the codebase + `AGENTS.md`, `DESIGN.md`, `PRODUCT.md`, `VOICE.md`, `docs/naming-conventions.md`, the `fluncle-video` skill. Non-canonical planning (`docs/`); where it deviates from code or canon, code and canon win.

> Process note. Divergent research across five threads (each grounded in the real files + current external practice: OpenRouter June-2026 multimodal docs/pricing, WCAG 2.3.1/2.3.2 + ISO 9241-391 photosensitive-flash thresholds, LLM-as-judge reliability literature), then a /taste pass, then a 4-role adversarial panel (staff/graphics engineer · brand-canon director · ML-eval specialist · product/scope-ops) that **verified claims live and found real defects** — a statistically invalid coupling estimator, a flash area-rule that false-negatives localized strobes, a doctrine reframe that licensed the brand's one banned strobe, and a convergence-engine risk. **All P0/P1 corrections are merged below.** Line numbers in this doc are indicative — they were exact when researched, but the build session must **re-grep each anchor** (the codebase moves).

---

## The standard (definition of done)

Boil the ocean: the whole thing, done right, with tests and docs, every thread tied off. The bar is "holy shit, that's done."

- **Nothing is cut.** The Part I / Part II split is _ordering a complete delivery_ (the felt win + the safety net land first, local; the one deploy lands second), not a menu. Both parts ship complete.
- **Tests + docs are part of done.** New metrics ship with self-running assert-tests (the repo's `*.test.ts` pattern — `bun test` reports "0 tests" but executes the asserts and fails on `throw`, verified). The intent schema is documented where produced and consumed. Doctrine, the README contract, and the skill are updated in the delivery that changes their behaviour.
- **The only sanctioned "not now"** is a true external chain (Part II's relay needs `OPENROUTER_API_KEY` provisioned — a human action) or an outcome we calibrate not assert (whether a render _feels_ alive). Both stated as honest scoping below.
- **Threads this build ties off:** the silent-zero uniform-bag footgun (in full, not half), the stale `analyze-audio` doc-comments, the flux channel computed-then-never-shipped, the asymmetric gate (no anti-dead counterpart), the unparseable header-comment reactivity map (→ `intent.json`), and the STFT analysis frame left un-scaled when the hop changed.

---

## 0. Summary / the reframe

**The reframe — one quantity, produced and proved.** Everything here is about _audio↔picture coupling_: how legibly the picture moves with the music. Half the work raises it (fix the analyzer's prime flatteners; give authors a positive recipe for sharp-but-safe aliveness); the other half measures it (an objective coupling metric, an intent checker, an art-director). The metric the evaluator computes _is_ the quantity the dials raise — so the evaluator is not a bolt-on, it is the instrument that proves the fixes landed and catches regressions.

**The spine — the render-intent JSON.** The author _declares_ intent (`intent.json`: vehicle, drop, which band drives which structural axis, how strongly, the motion model) → the fixed signal chain + binding doctrine are _how intent becomes pixels_ → the metrics + judge _verify pixels against that declared intent_. One artifact threads authoring, the bundle, and evaluation — the way the Log ID already spines every Fluncle surface. **Critically: `intent.json` is descriptive, not prescriptive — a record of what the agent already chose, never read back as a template by the next run** (the package's founding law is divergence; see §B6, §D5).

**The loop today has one objective signal — "don't jitter" (`detect-beat-pull`). That asymmetry is the disease.** A hard gate against being jittery, only prose against being dead, converges the system on "rule-compliant but timid." This RFC completes the feedback the loop has been missing — but it is **not a neat triad**. Honestly:

- **One aliveness axis, bounded on both sides.** `detect-beat-pull` (reversal) is the _upper_ bound on motion (too reactive → lurch); the new **reactivity-coupling** metric is the _lower_ bound (not reactive enough → dead). These two are the genuine symmetric pair.
- **An orthogonal safety floor.** A new HARD **flash-safety** gate (WCAG 2.3.1; epilepsy) is _not_ the third leg of an aliveness triad — it is a separate, non-negotiable luminance-safety concern that happens to also be about brightness change. It is the _exposure/coverage_ cap the brand's motion law already names (§B3).
- **An intent verification** (deterministic intent-vs-actual) and **a taste signal** (the advisory LLM judge) sit on top, reading the spine.

**Decomposition (Part I is the win; Part II is separable):**

| Unit                           | What                                                                               | Part | Coupled to                                                          | Independent of                            |
| ------------------------------ | ---------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------- | ----------------------------------------- |
| **A. Signal chain**            | analyzer + hook + shader dials (the prime flatteners) + the flux channel           | I    | B's doctrine references the flux band                               | the judge; local-only                     |
| **B. Doctrine + intent spine** | `fluncle-video` skill edits + the `intent.json` schema                             | I    | the schema is the contract C and D build against — **freeze first** | runtime code                              |
| **C. Deterministic metrics**   | flash-safety (HARD), coupling (with its windowed dead-zone read), intent-vs-actual | I    | consumes B's intent; refactors beat-pull's frame path               | the judge; the Worker; local-only         |
| **D. LLM judge**               | Worker relay + contact-sheet + structured critique                                 | II   | consumes C's metrics + B's intent; the **only prod deploy**         | A and C ship and deliver value without it |
| **E. Integration**             | wire C (Part I) + D (Part II) into the loop                                        | I+II | depends on A/C                                                      | —                                         |

**Part I (A+B+C) is the deliverable that matters:** it restores cross-band loudness, uncaps the swell, de-lags energy, ships the flux channel, hands authors the gate-safe-but-bounded recipe, and adds a HARD flash safety net + an objective anti-dead number — **no deploy, no secret.** The diagnosis's "if you do only three" (normalization, swell weights, `useEnergy` lag) all live here. **Part II (D)** is the taste layer reading the same spine; it carries all the genuine risk (a prod deploy, a vendor secret, model selection, calibration) and none of the felt aliveness win. Ship Part I first; Part II is a clean follow-on once B6's schema is frozen.

---

## 1. Context & goals

**Why now.** A verified diagnosis (`/tmp/fv-diagnosis.md`) traced the audio signal from preview to pixels and found "not alive enough" is _structurally produced_ in two compounding layers: the analyzer flattens dynamics before the shader sees them (per-band absolute-max normalization destroys cross-band loudness; a `swell` ceiling of ~0.64 caps the only sanctioned motion driver; `useEnergy` over-smooths the headline gesture), and the one gate rewards the calm one-way drift that reads as dead. The workbench audit confirmed it: the alive scenes (`cinder-cells`, `plasma-current-web`, `warp-weave`, `sq-005-9-9L`) bind a fast band to _in-place structural deformation_ and read their arc live from the energy curve; the dead one (`gate-transit`) scripts its arc to `sec` and demotes audio to grain + exposure.

**Goals (in reach), honestly split.** Unit A is a _genuine aliveness win_ — real signal real shaders will receive. Units C and D are _measurement and brand-guard apparatus_ — they make deadness catchable and brand-drift visible; they do not themselves make a video alive. The "produce vs prove" frame is the unity, but the honest accounting is **one aliveness unit (A) + a doctrine unit (B) + objective evaluation (C) + a taste layer (D)**:

1. Raise real coupling: fix the prime flatteners (A) + give the model a _positive, bounded recipe for sharp aliveness_ it lacks (B).
2. Make coupling _measurable_ (C) — with a statistically valid estimator (a per-clip null), not a raw correlation against an eyeballed threshold.
3. Add a HARD epilepsy-flash safety gate (C) — implemented to the _10°-field_ area rule, conservative-by-coverage, because a false negative here is the one genuinely dangerous failure.
4. Add the missing taste + anti-convergence signal (D): an art-director judging brand-fit, aliveness, and _divergence from the recent archive_, advisory, grounded in the metrics + intent.

**Honest calibration (outcomes we tune, not assert).** _Whether a render feels alive_ is partly subjective; we make coupling objective-against-a-null and keep the judge advisory, with the operator review as the backstop. _The coupling/intent thresholds_ are derived from each clip's own permutation null (§C3), not hand-set, and the dead/alive cutoffs are calibrated against operator labels before any promotion to a gate. _The judge's agreement with operator taste_ is calibrated (a labelled sample, Cohen's κ with a confidence interval), not assumed — and the corpus is small (43 local renders, some 10s), so the calibration is **sequenced, not simultaneous** (coupling threshold first, judge κ second), with a concrete labelling target (§Acceptance).

---

# PART I — Aliveness + objective evaluation (local, no deploy, ships first)

## 2. Unit A — Signal chain (the prime flatteners)

Pure-function/default edits in `packages/video`; local; determinism preserved (no `Math.random`/`Date.now`); no oxlint `!`. Sequenced so changes compose: spectral resolution (A4+A5 together) → normalization (A1) → flux (A6) → hooks (A2,A3) → shader cleanup (A7). **Anchors are indicative — re-grep each before editing.**

### A1. Normalization redesign (highest leverage, riskiest) — `analyze-audio.ts` `normalizeInPlace` + its per-band call sites

Replace the per-curve absolute-max normalization _for the three bands_ with one shared-reference pass: the **97th percentile of the pooled bass+mid+treble distribution** as a single divisor (robust to a lone clip/crash outlier that today crushes the curve toward 0), then a mild perceptual lift `pow(x, 0.7)`, then clamp. Energy keeps self-referencing (the headline gesture, must reach 1.0); flux keeps its own. New exported helpers `normalizeBandsShared(bands, {percentile, gamma})` + `percentile(values, p)` (export for tests).

**Window-selection side-effect (panel P0, must own).** The window scorer (`meanEnergy + 2·meanBass + onsetDensity`) consumes the normalized bands, so A1 silently changes _which 20s of the track ships_, not just the values. Guard: in addition to the cross-band-ratio test, capture a **before/after curve snapshot of one real track**, eyeball the chosen window, and ratify on the pilot. Leave scorer weights as-is for v1.

### A4 + A5 (shipped together). Spectral resolution: peak-per-band + finer timebase + a shortened STFT frame

The panel found these are not separable: dropping the hop to 20 ms while leaving the STFT analysis frame at ~93 ms pushes inter-frame overlap **46% → 78%**, over-smoothing the very bands that feed onsets/BPM/grid (the diagnosis's DAMPEN #B, made worse). So ship them as one coherent change:

- **`HOP_MS = 50 → 20`** (50 Hz; ~1.7 curve samples per 30 fps frame). Every HOP_MS consumer scales relatively (verified); `calculateMetadata`/`durationInFrames` is HOP-independent; `detect-beat-pull` reads rendered frames, not curves, so it is unaffected.
- **Shorten the STFT frame with the hop** (e.g. `sampleRate * 0.046` ≈ 46 ms) so overlap stays sane. This halves the bin count and doubles `binHz` (~21.5 Hz), which moves `bassMaxBin` — so **recompute every band boundary as an Hz-derived constant**, never a literal bin index.
- **Peak-per-band, not mean-per-bin:** ship each band as `sqrt(maxBinPower)` over its band range (the `/binCount` divisor disappears; bands become bin-count-independent by construction — the original intent, now structural). **Keep the canonical band ranges** — bass = the full `< BASS_CUTOFF_HZ` (150 Hz) range, taking its _peak_ bin (the transient win) — **do not narrow bass to a 40–120 Hz sub-band** (that silently drops the sub-bass that _is_ D&B's kick, per `subBassRatio`; canon P0). Mid and treble keep their `BASS_CUTOFF_HZ`/`MID_CUTOFF_HZ` boundaries, peak-per-band.

**Tests:** `fft.test.ts`'s `dominantBand`/separation assertions must be **re-derived from the new `binHz`** and confirmed green (`bun test`); add an assertion that `pickOnsets`/`estimateBpm` stay sharp at the new hop+frame on a synthetic 174 BPM click train (the BPM test alone does not cover onset-envelope sharpness, which is where over-smoothing bites). Update the `analyze-audio.ts` header doc-comments ("50 ms hops", "only 171.43 lands in [160,185]", the mean-per-bin rationale).

### A2. Swell ceiling — `use-audio-reactivity.ts` swell composite

`bass·0.42 + energy·0.22` (ceiling 0.64) → `bass·0.6 + energy·0.4` (reaches 1.0). **Keep `swellBeatWeight = 0`** (verified correct, proven on 173 BPM D&B). `clamp01` becomes a guarantee. No tracked scene overrode the weights (grep-confirmed).

### A3. `useEnergy` de-lag — `use-energy.ts`

`smoothingFrames` default 6 → **4** (≈135 ms vs ≈200 ms lag; 3 admits jitter into the broad-gesture channel). Treble: no code change — sparkle binds read `trebleFast` (already exposed); that is doctrine (B).

### A6. Ship the flux curve — `analyze-audio.ts` `onsetEnvNorm`

`onsetEnvNorm` is **computed and consumed internally for the beat grid (`bestPhaseGrid`) but never shipped as a continuous curve** (corrected wording). Ship it as **`fluxCurve`** + a **`u_flux`** uniform + a **`useFlux`** hook (sf=2), the field **optional** (`fluxCurve?`) so old props.json + Studio defaults keep working (flux=0 = today's behaviour). **The complete consumer list (panel-corrected — the draft's was short):**

1. `types.ts` `CosmosAudio` — add `fluxCurve?: EnergySample[]`.
2. `analyze-audio.ts` — push a flux sample in the emit loop; add `fluxCurve` to the return.
3. `social-preview.ts` — no change (audio spread whole); optional `fluxSamples` in the summary.
4. `ship.ts` — no change (copies whole props.json).
5. `root.tsx` Studio defaults — add `fluxCurve: []`.
6. `shader-layer.tsx` — **three** edits: HEADER `uniform float u_flux;`; add `fluxCurve?` to `ShaderLayerProps` **and** its destructure **and** the `useAudioReactivity` input object; push `gl.uniform1f(u("u_flux"), audio.flux)`.
7. `use-audio-reactivity.ts` — add to `AudioReactivityInput`, the return (`flux: number`), the uniforms bag, a `flux?` option.
8. **New** `hooks/use-flux.ts` (mirrors `use-energy.ts`, sf=2).
9. **`hooks/index.ts`** — the barrel re-exports each hook; add `useFlux` here (not in `cosmos.ts`, which does `export * from "./hooks"`).
10. Docs (delivered by Unit B, not A — see §Sequencing): the README contract (hook list, ShaderLayer uniform list, `CosmosAudio` one-liner) + the skill references.

### A7. Uniform-bag footgun — full cleanup — `use-audio-reactivity.ts` uniforms bag, `shader-layer.tsx`

The draft fixed two orphans; the panel found **six**. `u_audioBeat`/`u_audioOnset`, **and** `u_bassFast`/`u_energyFast`/`u_midFast`/`u_trebleFast`, **and** `u_audioHit`/`u_audioSwell`/`u_audioDrop` in the returned bag are all redundant with header-declared uniforms that ShaderLayer already pushes by name. The internal code reads **only** `u_audioDisturbance` from the bag. **Fix: the bag's only legitimate entry is `u_audioDisturbance`; drop every other alias and unify on the header uniforms.** After this, every uniform a shader can declare by name _exists in the HEADER and is pushed by name_ — the silent-zero class is closed at the source, not half-set.

### A8. BPM clamp `[160,185]` — out of this delivery (its own pass; widening it moves the `social-preview.ts` assert + the fold + the docstring in lockstep).

**Riskiest change:** A1 (changes every new props.json + the chosen window). Guarded by the ratio test, the before/after window snapshot, tunable percentile/gamma, **and the precondition that C2's flash gate is green on the A-dial pilot re-renders before the dials go wide** (§Sequencing — louder/sharper dials compound toward the climax the brand caps, so the flash net must exist first).

---

## 3. Unit B — Authoring doctrine + the render-intent spine

Make the gate-safe-**but-bounded** audio-driven authoring the default reading of the skill, and formalise the reactivity map as `intent.json`. Per the operator's instruction rule, **doctrine/cookbook edits are pure terse positives; anti-patterns go in the existing "Failure modes" section** (its sanctioned home), not injected into doctrine bullets as "do X not Y."

### B1. Codify the gate-safe binding idiom (cookbook) — **pre-extracted before fan-out**

The alive scenes bind a fast band to the amplitude/threshold/width of an _in-place_ deformation while coordinates advance on a constant-speed clock; the gate scores reversal in _translation_ and brightness-normalizes, so in-place pulses are invisible to it. Add a named cookbook block "The gate-safe binding idiom" with three reduced GLSL idioms (warp _amplitude_ on a band; ridge-survival _threshold_ + filament _width_; cell-wall _width_ + voronoi wall sharpness), attributed by **axis/primitive, not by recognizable scene** (so agents don't reconstruct the scene from the quote — Retint-Rule-shaped: steal the technique, not the surface). **Sequencing hazard the panel flagged: the source scenes live in gitignored `workbench/`, invisible to a worktree branched from origin — so the ~6-line idioms must be extracted into the RFC/skill text BEFORE any B-agent fans out** (done; the idioms are in `/tmp/fv-rfc/T2-doctrine-intent.md` §1 and must be pasted into the cookbook as the first build step).

### B2. Arc-from-audio is the rule (doctrine/cookbook, positive); the scripted-clock arc is a Failure-mode

Doctrine/cookbook (positive): drive the structural arc (density, threshold, width, ignition, exposure) from `u_energy`/`u_audioSwell`/`u_audioDrop` live; place the crest with the `reactivity.drop` envelope (`{peakTimeMs, …}`, which derives a smoothed `u_audioDrop` from the energy curve); reserve `interpolate(sec, …)` for the journey baseline. **Add "the scripted-clock arc" (a JS `interpolate(sec,…)` timeline pinned to a `peakTimeMs` driving structure) to the "Failure modes" section** as a sibling of "the copy-paste climax" — that is where the negative framing belongs.

### B3. The bounded "sharpen, don't soften" instruction (the brand-critical fix)

The draft's "material may be as sharp as the kick" licensed the brand's one banned strobe. **The line is exposure/coverage, not material-vs-translation** — and the existing doctrine already states it (doctrine 9: "even legal material reactivity must be smoothed, not strobed … cap the climax exposure … never wash the whole frame to white"; the cookbook's `tone = min(tone, 0.90)`). So the symmetric cure, **bounded**: _when the muted-audio test fails or the clip reads dead, sharpen the material bind — route a fast band onto in-place structural deformation (warp amplitude, ridge threshold, width, wall sharpness), sharp in ATTACK, capped below the cream stop and never a full-frame brightness flash on the kick._ Smoothing fixes jitter; a sharper-but-capped attack fixes deadness; motion is the lever for neither. State this at the same surfaces the smoothing cure appears (doctrine 7/9, the mild-render mode), each reconciled with the existing exposure cap.

### B4. Reframe the gate (bounded)

Reframe doctrine 7 to: **reversal in TRANSLATION is the only motion sin; material may answer the beat sharply in ATTACK but stays bounded in amplitude and coverage** (the exposure/coverage cap, doctrine 9). The gate brightness-normalizes and scores only translation, so a _capped_ width/threshold pulse is invisible to it — but an _uncapped full-frame_ brightness flash is the banned strobe even though it never translates. A gate pass is not a licence to be calm (the muted-audio test still governs aliveness), and not a licence to strobe (the exposure cap + the new flash gate govern safety).

### B5. Promote the STRONG scenes — **doctrine-only** (decision taken)

Quote the ~6-line _idioms_ inline in the cookbook (a technique, attributed by axis/primitive), no committed example file — preserves the near-blank-canvas principle and, more importantly, avoids the committed example becoming the attractor every parallel run rediscovers (the diversity law, doctrine 3). The byte-level archive stays the R2 `composition.tsx`.

### B6. The render-intent schema — `out/<trackId>.intent.json` → bundle `intent.json` (the spine; **descriptive, not prescriptive**)

The canonical schema (Unit C adapts its checker to it):

```ts
// out/<trackId>.intent.json — a RECORD of what the agent already chose. Never read back as a template.
type RenderIntent = {
  schema: "fluncle.render-intent/1";
  trackId: string;
  logId: string | null;
  vehicle: string; // == the --vehicle ledger tag (ship.ts sources both from one value)
  textureFamily: "nebula" | "analog" | "dither" | "paint" | "fluent" | "duotone" | "smear";
  register: "abstract" | "representational";
  representationalSubject?: string; // e.g. "a murmuration" — lets the judge check the claim vs pixels (uncanny-middle guard)
  concept: string; // free text (the judge reads this) — Part II only
  arcSource: "energyCurve" | "scripted"; // load-bearing for C
  motionModel: "constant-drift" | "directed-front" | "static-field"; // load-bearing for C
  dropMs: number; // load-bearing for C
  climax: { form: string; colour: string; atMs: number }; // form/colour: Part II (Retint check)
  bindings: Array<{
    // load-bearing for C (band, axis); element: Part II
    band:
      | "bass"
      | "mid"
      | "treble"
      | "bassFast"
      | "midFast"
      | "trebleFast"
      | "energy"
      | "swell"
      | "drop"
      | "hit"
      | "onset"
      | "flux";
    element: string;
    axis:
      | "width"
      | "threshold"
      | "warpAmp"
      | "wallSharpness"
      | "density"
      | "radius"
      | "scale"
      | "curvature" // structural
      | "brightness"
      | "exposure"
      | "glow"
      | "ignition" // light
      | "grain"
      | "chroma"
      | "dither"
      | "edgeRough" // texture
      | "translation"; // motion — MUST pair with a smoothed band (C's tripwire)
    intendedStrength: "subtle" | "strong";
  }>;
  secondaryPeaks?: number[]; // optional, future (judge fuel)
};
```

The **load-bearing fields C consumes** are `arcSource`, `motionModel`, `dropMs`, and `bindings[].{band, axis}` (the translation tripwire + the ≥1-structural/≥1-light/≥1-texture axis-coverage check). The free-text `concept`/`climax.form`/`element` exist only for Part II's judge; if Part II is deferred, they are inert. The agent hand-authors it as a new **workflow step 3.5** (inserted between Concept (step 3) and Author the composition (step 4)); `ship.ts` copies it into the bundle and records it in `render.json`.

**v1 safety (panel P1): a missing `intent.json` is a WARNING, not a ship blocker.** `ship` writes a generated stub and ships; promote to a hard precondition only after the loop demonstrably authors it reliably (mirrors the advisory-first ladder — an unattended LLM loop that already needs heavy prompting must not get a new "stuck forever" failure mode).

---

## 4. Unit C — Deterministic metrics (flash-safety, coupling, intent-vs-actual)

New local scripts under `packages/video/src/pipeline/`, mirroring `detect-beat-pull`'s shape. One combined report `out/<trackId>.metrics.json` is Part II's input. **The panel found the draft's metric core had a fatal statistical defect and a safety bug — both fixed below.**

### C1. Shared frame + structural-delta extraction (extract **+ extend**, with a golden test — not a "pure refactor")

`extractFrames` today takes one arg, **hardcodes** `48×86` and `fps=30` (it never probes), and the mean-subtract/temporal-fence/`step[]` live **inside** `scoreBeatPull` (not exported). So this is real new code on the one calibrated gate's path. Build:

- `frames.ts`: `extractGrayFrames(video, {width, height})` + `probeFps(video)` + `probeDurationSec(video)`.
- **`export function structuralDelta(frames, {smoothFrames}): number[]`** — the mean-subtract + 3-frame fence + consecutive `meanAbsDiff` that coupling/dead-zone/intent all consume. Refactor `scoreBeatPull` to call it.
- **A golden test is a build gate:** `scoreBeatPull` must produce **byte-identical scores** on the existing fixtures after the refactor (its 0.17 calibration was earned against the hardcoded 30 fps + the local pipeline). So `detect-beat-pull` pins `fps=30` internally; **coupling/intent use the _probed_ fps for timeline alignment** (a 24/60 fps render must not silently mis-align), and a probed-fps mismatch marks the report `unreliable: true` (not just a warning).

### C2. Flash-safety — the HARD gate (epilepsy) — implemented to the 10°-field rule

WCAG 2.3.1 / ISO 9241-391 (PEAT retired; implement the published thresholds). A clip is unsafe when, in **any 1-second window**, there are **more than 3 flashes** (a flash = a pair of opposing relative-luminance transitions each **≥ 0.10** of max, with the **darker state < 0.80**) over **> 25% of a 10° visual field** — plus the red-flash rule (saturated red R/(R+G+B) ≥ 0.8, chroma change > 0.2 CIE-1976). Relative luminance is the WCAG sRGB→linear→BT.709 formula on a 64×114 RGB extraction.

**The area rule is a sliding window, not whole-frame (panel P0 safety fix).** "25% of the field" is 25% of a **10° sub-region** (≈ a 341×256 px rectangle, ~⅓ of frame width), slid across the frame — **not** 25% of the whole vertical video. The draft's `flashingPixels/totalPixels > 0.25` requires a strobe to cover a quarter of the _entire_ frame before it gates, false-negativing a flashing corner/quadrant/logo — the wrong (permissive) direction for a safety gate. Implement: test "≥ 25% of _any_ 10°-sized window flashing," conservative-by-coverage.

**Grain reconciliation (panel-corrected).** Immunity to Fluncle's ~24 Hz grain comes from **spatial averaging + the area rule** (zero-mean grain cancels to ~σ/√N on the spatial mean; incoherent noise never paints a coherent ≥0.10 swing over a 10° window). **Drop the "self-calibrating `4·g` deadband"** — the panel proved it is either inert (always below the 0.02 floor) or _dangerous_ (a real fast flash IS high-frequency content in the mean-luma series, so it inflates `g`, raises the deadband, and can suppress itself). Use a **static 0.02 extrema deadband** (5× headroom below WCAG's 0.10), justified directly; if any grain estimate is used it must come from a **grain-only reference** (the `flags=area` downscale spatial-noise variance, independent of the temporal flash signal) and may only _lower_, never raise, the safety floor. **Add the missing fixture: a real fast flash buried in grain MUST fail** (the draft only tested grain-without-flash).

**HARD verdict:** the conjunction blocks ship (exit non-zero), `--allow-flash` override only after an eyeball.

### C3. Reactivity-coupling — the anti-dead lower bound — **statistically valid against a per-clip null** (the fatal-defect fix)

The draft's `coupling = max(couplingEnergy, couplingBass, couplingFlux)`, each a lag-tolerant Pearson over a 0–400 ms window, with eyeballed 0.15/0.30 cutoffs, is **invalid**: the panel's simulation showed that on pure noise in the exact EMA-smoothed regime the RFC describes, the headline clears "dead" 73% of the time and "alive" 21% of the time — it measures autocorrelation length and max-of-36 inflation, not coupling. The corrected estimator:

- **Single, principled lag** (not max-over-12): align using the _known_ hook EMA group delay (`useEnergy` sf≈4 ≈ 135 ms, `useBass` sf≈3 ≈ 100 ms) computed from the props, not scanned.
- **The intent-declared driving band, not `max` of all three.** `intent.json` says which band drives structure; correlate the structural delta against _that_ band (report the others as diagnostics, never as the headline — taking the max of correlated bands inflates the score).
- **A per-clip permutation null:** phase-randomize / block-shuffle the curve and re-run the _identical_ estimator ~200×; report coupling as a **z-score or empirical percentile against that null**, so "dead" has a _defined false-positive rate_. Derive the dead/weak/alive cutoffs from the null distribution (calibrated against operator labels), not as constants below the noise floor.
- The structural delta is `structuralDelta(frames)` from C1 (mean-subtracted, fenced) — the same representation the beat-pull scorer trusts.

**The windowed read replaces the separate "dead-zone metric"** (taste #4: dead-zone _is_ coupling per-window, not a new metric): slide the same estimator across 1 s windows; a window with energetic audio (`E ≥ 0.6`) and near-null coupling is a **dead zone**, escalated to a named intent failure if it overlaps `dropMs`.

**Fault attribution — demoted to an advisory hint, made to actually work.** The draft's attribution (flat curve ⇒ Layer 1) rarely fired (gated on the broken `coupling < 0.15`) and its evidence number (`curveCrest`) was _inverted_ (a dynamic track crushed by the normalizer reads _flatter_ than a truly-flat one). Fix both: gate attribution on the _corrected_ z-score; replace `curveCrest` with **the fraction of curve samples below 5% of max** (a crushed curve has a huge low-mass tail; a flat one does not — these separate cleanly); and **ship the analyzer's `rawDynamicsHint` per band in THIS delivery** (the analyzer has the raw bands _before_ normalization — emit a cheap per-band raw crest), so attribution can finally distinguish "the track was flat" (Layer 1: signal) from "the normalizer flattened it" (Layer 1: the prime flattener — a _different_ fix) from "the picture ignores a dynamic curve" (Layer 2: binding). Present attribution as an advisory hint to the loop, not a hard input.

### C4. Flicker — **cut** (taste #3 / panel)

The deterministic flicker metric is redundant with the judge's `tooChaoticSegments` ("buzzy") and has no v1 consumer. Cut it; the judge owns "buzzy."

### C5. Intent-vs-actual — consume B6's `intent.json`

Deterministically measurable: **drop spike** (a real luminance/structural spike in `[dropMs−500, dropMs+1000]`, and _where the actual peak is_ vs `dropMs` — a large gap flags the scripted-clock anti-pattern); **the translation tripwire** (any `axis:"translation"` binding with a fast band fails); **axis-group coverage** (the doctrine-9 ≥1-structural/≥1-light/≥1-texture mandate). **Per-binding band coupling and band-discrimination are advisory, with realistic floors:** through EMA-lagged hooks against a noisy structural delta, even a genuinely strong bind rarely reaches Pearson 0.8 — so do **not** set `strong → 0.8` (the draft's number would fail correct binds); calibrate the floor (expect ~0.3–0.4 for a strong bind), gate it on the corrected null, and tag `discriminates` "low-confidence on short clips" (the bands are near-collinear; on a 10–20 s clip the comparison is marginal). A `deferToJudge` block names what only Part II can judge.

### C6. Surface, report, gates

- **Module** `pipeline/analyze-motion.ts`, **script** `judge:metrics` → `bun src/pipeline/analyze-motion.ts <trackId|video> [--json] [--intent <file>] [--allow-flash]`, **test** `pipeline/analyze-motion.test.ts` (self-running, synthetic frames + curves, in `bun test`). It folds in `scoreBeatPull` on the shared extraction so one report carries both hard gates.
- **`out/<trackId>.metrics.json`**: every block tagged `deterministic`, `hard`, and `unreliable` (on fps mismatch); a `gate` roll-up (`hardPass`, `blockingFailures[]`, `advisories[]`).
- **The aliveness axis + the safety floor:** two HARD ship-blocking gates at launch — **flash-safety** (new, 10°-rule) and **beat-pull** (existing). **Coupling ships advisory in v1 with the corrected estimator** (you cannot hard-gate on a metric until its null + the operator-label calibration exist); promote to a soft gate (a loud, tracked warning + a single forced revise, override-able — _defined_, not just named) once calibrated. Intent-vs-actual and the judge are advisory.

**Tests (sized for the 10 s floor, not 20 s):** the eight synthetic fixtures (static-bright, **strobe → unsafe**, **boiling-grain-over-static → safe**, **fast-flash-buried-in-grain → unsafe** [new], one-way-drift-tracking → coupling-alive, drift+flat-curve → attribution Layer-1, drift+dynamic-curve-ignored → attribution Layer-2, drop+intent → arc-alignment, red-strobe → red branch). Real-clip cutoff calibration is a documented follow-up over the operator-labelled set.

---

# PART II — The LLM art-director judge (the one prod deploy; separable; depends on B6 frozen)

## 5. Unit D — The judge

After a render exists, build a deterministic **contact-sheet** (one tiled JPG), POST it with C's metrics + B's intent + the audio digest to a new **admin Worker relay** holding `OPENROUTER_API_KEY`. The CLI is a thin client; the Worker is the boundary.

### D1. Transport — contact-sheet via Worker relay (the R2-URL true-video path is a named fast-follow, not v1)

The contact-sheet (one ~200–600 KB tiled JPG) POSTs trivially and sidesteps the documented box-throttling on ~20 MB video uploads; keyframes suffice for a _taste_ judgment because the judge reasons _with_ C's continuous-motion numbers. Direct-from-Mac is rejected (a metered key on the box, breaks the canon). **The R2-URL true-video second opinion is cut from v1** to a named fast-follow (provider `video_url` support is uneven; it has no v1 consumer).

### D2. The relay endpoint (oRPC, contract-first) — nested under the existing per-track video path

- **Op (Convention B):** **`critique_track_video`** — verb `critique` + the per-track video noun, matching the existing siblings `finalize_track_video` and `presign_track_video_uploads` (the panel found the draft's top-level `critique_video` / `POST /admin/video/critique` broke the established `/admin/tracks/{trackId}/video/*` nesting). REST: **`POST /admin/tracks/{trackId}/video/critique`**, `operationId: critiqueTrackVideo`, admin path ⇒ auto-excluded from the public OpenAPI doc.
- **Tier:** `adminAuth` (agent-allowed) — read-only, reversible, publishes nothing; the Mac calls it with its existing `FLUNCLE_API_TOKEN` (no new credential on the box).
- **Contract:** new `packages/contracts/src/orpc/admin-video.ts` spread into `index.ts`; request `{ contactSheet: base64, metricsJson, intentJson, audioJson, model? }`; response `{ ok, critique, model }`. (Pairwise/`contactSheetB`/`videoUrl` are fast-follow fields, omitted from v1.)
- **Handler:** new `apps/web/src/lib/server/orpc/admin-video.ts` spread into `orpc.ts`; calls OpenRouter `/chat/completions` with the sheet as an `image_url` part, `response_format: json_schema` (strict), `provider: { require_parameters: true }`, the `HTTP-Referer`/`X-Title` headers, **a finite timeout that returns a clean `{ ok:false }` advisory result on timeout/failure** (the "fail advisory-open" guarantee lives in deterministic code here, **not** in agent prose — panel P0).
- **Coverage test:** add `"POST /admin/tracks/{trackId}/video/critique": "critique_track_video"` to `ADMIN_ROUTE_OPS`. **Do NOT create a TanStack route file** (the "every admin route file has a match" test would then demand one). Note: the coverage test is local CI (`bun test`), **not** in `deploy:gate` (which is `turbo run typecheck`) — a mismatch fails local test, not the Cloudflare build.

### D3. Contact-sheet — `pipeline/contact-sheet.ts` (ffmpeg tile, deterministic)

ffmpeg tile over the rendered MP4 (not Remotion still-tiling — critique what shipped). Fixed frame selection: arc keyframes (open / 3 build / the `intent.dropMs` frame / 3 post-drop / close) as a 4×3 grid **plus a per-beat strip of fixed length** (specify N beats around the drop — it drives token cost) from `audioJson.beatGrid`; baked `drawtext` timestamps so the critique's `atMs`/`fromMs` map to real time. A sibling of C1's extractor.

### D4. Structured critique schema (advisory) — with a divergence axis

Four 0–5 axes (`brandFit`, `motionEnergy`, `beatSync`, `readability`) **plus a fifth — `divergenceFromRecent`** (panel brand P0: the judge must guard the package's #1 law, diversity; feed it the vehicle ledger `fluncle admin tracks vehicles --json` + recent `poster.jpg` URLs and score "is this too like the last five"). `tooStaticSegments[]`/`tooChaoticSegments[]` (`{fromMs, toMs, why}`), `offBrandMoments[]` (`{atMs, rule, why}`), and **`likelyCodeFixes[]`** where each `{change, target, groundedIn, confidence}` cites a metric key or intent-miss. `verdict ∈ {ship, iterate, reject}` + a `summary`. **Output register is plain-tool** (the CLI register per VOICE.md — clean, parseable, third-person), **not** Fluncle-narrator and not florid art-crit.

### D5. Prompt architecture (model-agnostic) — anchors modestly anchor, they do not "reliably calibrate"

(1) SYSTEM — the canon rubric with **the SKILL.md failure modes enumerated verbatim** as the discriminators (the panel found the real off-brand detectors are _"the bolted-on golden sun," "the fake glow," "the uncanny middle," "polished-CGI," "the floating vehicle," "the mild render"_ — already written as crisp tests like "if the bright element could be a CSS `radial-gradient()`, it has failed" — not "Retint/One-Vehicle/Eclipse" paraphrases), the _corrected, bounded_ aliveness doctrine from B (so the judge rewards capped in-place punch, not "strobing"), and explicit 0–5 anchors. (2) FEW-SHOT — 1–2 operator-labelled sheets that **modestly anchor the rubric floor/ceiling** (downgraded from the draft's "reliably calibrate" — the κ=0.807 few-shot result is from _text_ eval; a 2-sheet anchor for a _visual_ judge reduces variance modestly and can _bias_ toward those clips' look, so the prompt says "anchors teach the bar, never 'make it look like this'"). (3) USER — the candidate sheet + the metrics/intent/audio as facts to reason _with_. Keep the judge **advisory** and `likelyCodeFixes` feeding no automated action until a κ exists (aligns with Decision 3).

### D6. Model — defer + verify-at-build; swappable config var

`OPENROUTER_JUDGE_MODEL` (non-secret config var, like `ELEVENLABS_VOICE_ID`) defaults to the operator's pick **`google/gemini-3.1-flash-lite`** (fallback `xiaomi/mimo-v2.5`), under a **$25/month** OpenRouter account cap. The OpenRouter API mechanics (`image_url` base64, `response_format: json_schema` strict, `provider.require_parameters`) are verified real; **the specific model IDs are unverified — treat as build-time-verify**, and note that `require_parameters: true` _routes away_ from a provider that doesn't honour strict schemas, which can surface as "no providers" rather than a clean fallback — so verify the fallback's strict-schema adherence before relying on it.

### D7. Secret + CLI

`OPENROUTER_API_KEY` is a Worker secret: add to `env.ts` `envKeys` (makes `readEnv` typecheck — `deploy:gate` cares only that it's declared, verified), `.dev.vars.tpl` as an `op://` ref, `wrangler secret put` in prod (the one human action), the README deploy list. CLI: `fluncle admin tracks video critique <id|logId>` (thin client via `adminApiPost`) `--json` (default), `--model`. The judge no-ops cleanly if the secret is unset (the loop simply doesn't call it).

---

## 6. Unit E — Loop integration (bounded auto-iterate on drafts; final judge advisory)

Wire C (Part I) and D (Part II) into the **hourly render automation** — the Claude Routine running `packages/skills/fluncle-video/references/workflow.md` via `render-queue.prompt.md` on the operator's Mac. **Edit the real integer steps** (workflow.md is steps 1–9; there is no "3.5/3.6" today — _insert_ intent.json authoring as a new step between Concept (3) and Author (4); wire the metrics + the inner-loop judge into step 5 still-critique, and the hard gates + final judge into step 7 render).

**The ladder:** props → concept → **author `intent.json` (new step)** → author composition → stills → **draft render** → C's metrics on the draft (directional) + **the judge on the draft contact-sheet (advisory)** → **bounded auto-iterate** (a weak verdict or a metrics flag → revise + re-**draft**, ≤ **N=2** judge rounds/tick) → **full render** → **HARD gates: beat-pull + flash-safety** (local, deterministic, the only ship-blockers) → C's authoritative coupling read (advisory) → **the final judge once, advisory, on the full-render contact-sheet** (a review note) → ship → stop.

**Auto-iterate is ON, bounded to N=2 rounds on the DRAFT (operator's decision).** The inner-loop judge runs on the half-res draft (~6× faster than the full render); a weak verdict or a metrics flag triggers a revise + re-draft, capped at **N=2 judge rounds per tick** (the pivot rule still applies — 2–3 non-converging rounds ⇒ wrong primitive, pivot don't grind). The cap is a **hard rail in `render-queue.prompt.md`** (the block that survives even if the rest is skipped), enforced by the loop counter, not agent discretion. The **final** judge on the full render is **advisory-once** (a review note), never blocking. **The at-least-once overlap (panel P0) is an accepted, bounded cost:** iterating on _drafts_ (never full renders) bounds the added wall-clock, and the queue gate still guarantees no double-publish — a slow iterating tick overlapping the next hourly fire costs at most one wasted render, exactly as a beat-pull fail does today. Re-drafts are half-res and never ship (`ship` refuses draft-only). "One finding per tick" holds: the judge rounds are bounded retries on the _same_ finding, never a second finding.

**Hard vs advisory:** flash-safety HARD (objective harm, day one), beat-pull HARD (kept), coupling advisory→soft-after-calibration, intent-vs-actual advisory, the LLM critique advisory (the operator reviews every MP4). **Safety verified:** the only state-changing call is still `fluncle admin tracks video` at ship; new hard gates can only _prevent_ a ship (finding stays queued, re-attempted — always the case for a beat-pull fail), never cause an extra one; every ship-blocking check is **local and deterministic**, so an OpenRouter outage can neither block nor unblock a ship (the relay fails advisory-open in CLI code); the queue gate stays the only idempotency mechanism.

**`render-queue.prompt.md` edits** (the "Hard rails" block, which survives even if the rest is skipped): name flash-safety alongside beat-pull as a hard gate; state the inner-loop judge auto-iterates **≤ N=2 rounds on the draft** and the final judge is **advisory, never blocking**; the advisory-open behaviour is enforced by the CLI/relay code, not agent discretion.

**Cost/latency (auto-iterate ≤ N=2 on drafts):** metrics ~2–10 s (free), contact-sheet ~2–5 s, up to ~3–4 judge calls (~$0.001 each on `google/gemini-3.1-flash-lite`), plus up to 2 extra **half-res** draft renders (~6× faster than full). Typical added wall-clock **~30–60 s**; worst case ~1–3 min on a heavy-shader tick (dominated by the draft re-renders), still small against the multi-minute full render. Empty ticks zero. Bounded by the N=2 cap + the relay timeout + the **$25/month** OpenRouter account spend cap. One _ship_ per tick regardless.

---

## Sequencing & ownership

**Step 0 (gating, single owner, before any fan-out): freeze B6's `intent.json` schema and pre-extract B1's idioms into the cookbook text.** B6 is the contract A6's `flux` band value, C5's checker, and D's judge all build against; the idioms live in gitignored `workbench/` invisible to worktree agents. Both must be done and committed before parallel work starts, or A6/C/D build against a moving shape and the B-agent has an empty workbench.

```
PHASE 0 — PART I: aliveness dials + doctrine + objective metrics   [LOCAL · LOW-DECISION · THE FELT WIN]
  Unit A (signal-chain + spectral-resolution + flux) · Unit B (doctrine + intent) · Unit C (metrics + flash gate).
  File ownership (the draft's "disjoint" claim was false — README/SKILL collide): Unit B OWNS all
  packages/video/README.md + skill doc edits, INCLUDING A6's flux contract entries (A delivers them as a
  checklist B applies). A: hooks/ + analyze-audio.ts + shader-layer.tsx (code only). C: new pipeline/*.ts +
  the detect-beat-pull refactor (golden-test-gated). These are then disjoint.
  EXIT GATE (not a parallel nicety): C2's flash gate green on the A-dial pilot re-renders BEFORE the louder
  dials go wide — the dials compound toward the climax the brand caps, so the flash net must exist first.
  VERIFY: typecheck + oxlint + bun test green; new gates correct exit codes + --json; flash exit-1 fires on a
  strobe comp AND a fast-flash-in-grain comp; coupling's permutation null gives a defined FP rate on the
  noise fixture; re-render a few NOT-YET-POSTED findings with the new dials, eyeball aliveness + the chosen
  window (A1), label each dead/weak/alive (seeds calibration — Decision 5), and swap the clip if the new one
  wins (Decision 4).
  → Delivers the felt win + the flash safety net + an objective anti-dead number. No deploy, no secret.

PHASE 1 — PART II: Worker relay + judge   [THE ONE PROD DEPLOY · NEEDS §Decisions 1]
  Unit D. Provision OPENROUTER_API_KEY. VERIFY: local Worker preview returns a schema-valid critique;
  adminAuth rejects an insufficient token; typecheck + build + lint + coverage test green. Land as a SINGLE
  isolated push to main when no other apps/web deploy is in flight; confirm the Cloudflare build ran on the
  final commit (coalescing). Separable: Part I is already delivering by now.

PHASE 2 — wire the loop   [SKILL EDITS · LOCAL]   Unit E: insert the intent step + the metrics/judge calls in
  workflow.md; the render-queue.prompt.md hard-rail edits. Reinstall the skill. VERIFY: dry-run the automation
  on one waiting finding (films-head / empty-no-op / double-run-doesn't-double-render); the hard gates block a
  bad comp; ship sets video_url exactly once; a missing intent.json warns + ships a stub (not blocks).

PHASE 3 — rollout   [CONFIG/DOCTRINE]   advisory → soft coupling gate after calibration → (v3, maybe) auto-iterate.
```

**Critical path:** Step 0 → Phase 0 → Phase 2. Part II (Phase 1) is **not** on the critical path for the aliveness win. **The single highest-leverage act is Step 0 + Phase 0** — the felt improvement and the safety net, zero deploy.

---

## Decisions — all resolved (operator, 2026-06-22)

1. **Judge model + spend cap.** `OPENROUTER_JUDGE_MODEL = google/gemini-3.1-flash-lite` (swappable config var; verify it honours strict `json_schema` at build, and that `provider.require_parameters` doesn't route to "no providers"). OpenRouter account spend cap **$25/month**.
2. **Coupling gate posture.** Advisory (corrected permutation-null estimator) in v1; promote to a _defined_ soft gate (loud tracked warning + one forced revise, override-able) in v2 after the cutoffs are calibrated against operator labels. Never hard in v1.
3. **Judge loop — auto-iterate ON, bounded N=2 on the draft** (§6). The inner-loop judge can trigger up to two revise+re-draft rounds per tick (drafts only); the final judge on the full render is advisory-once. The N=2 cap is a hard rail; the overlap window is an accepted, bounded cost (queue gate holds → no double-publish).
4. **Back-catalog — no mass re-render, but a targeted pilot.** Re-render a small set of _already-videoed but not-yet-posted_ findings (no YouTube/TikTok post on record), eyeball new vs old, and **swap the clip if the new one wins** — safe because nothing is live cross-platform to go inconsistent. This pilot set doubles as the **A1 window/aliveness eyeball set** and the **calibration-labelling corpus** (Decision 5). (Identify the set from the per-platform publication status the `fluncle-publish` flow records.)
5. **Calibration — label during the re-render eyeball pass** (Decision 4): tag each not-yet-posted clip dead/weak/alive as you judge the swap; the calibration wires up once the corpus reaches the targets — ≥ 60 clips for the coupling cutoffs, ≥ 40 (2–3 raters, κ with a CI) for the judge. **Sequence the two** (coupling first, judge κ second); the ~43-render corpus can't trustworthily do both at once, so the pilot grows it.
6. **Judge anchors — operator-picked.** You choose 1–2 strong renders + 1 dead one and label them; the build wires them into the judge prompt as the few-shot anchors (they teach the bar floor/ceiling, never "make it look like this"). Per-beat contact-sheet strip = one bar.

**Technical defaults (ratified by the research + panel, not open):** `HOP_MS = 20` **with the STFT frame shortened in-delivery** (A4+A5); peak-per-band over the **existing** band ranges (bass stays full `<150 Hz`, no sub-band narrowing); the uniform-bag cleanup is full (only `u_audioDisturbance` survives in the bag); `fluxCurve` optional; coupling uses a per-clip permutation null + the intent-declared band + a single principled lag; flash uses the 10°-field sliding-window area rule + a static deadband + a grain-only reference; flicker cut; pairwise A/B + R2-URL true-video are fast-follows; the relay op is `critique_track_video` nested per-track, `adminAuth`; `intent.json` is a warning (stub-and-ship) in v1.

---

## Acceptance criteria

**Ship-gates (block the delivery):**

- `bun run --cwd packages/video typecheck` + `bunx oxlint packages/video` + `bun test` green; `apps/web` typecheck + build + lint green; the oRPC admin coverage test green (`critique_track_video` registered, no TanStack route file).
- `analyze-audio.test.ts`: normalization preserves cross-band ratio + outlier robustness; the chosen window is captured before/after on one real track; flux present, ∈[0,1], `length === energyCurve.length`; the new hop+frame holds BPM/beat-grid accuracy **and onset-envelope sharpness** on a synthetic 174 BPM click train; `fft.test.ts` re-derived from the new `binHz` and green.
- `analyze-motion.test.ts`: **strobe → flash unsafe**, **boiling-grain → flash safe**, **fast-flash-in-grain → flash unsafe** (the new fixture), the 10°-window area rule fails a localized-quadrant strobe; coupling's permutation null yields a defined false-positive rate on the noise fixture (the naive max-Pearson would not); the two attribution fixtures resolve Layer-1/Layer-2 with the corrected low-mass-tail evidence; the drop fixture flags `arcPeakAlignment`; red-strobe trips the red branch.
- The `detect-beat-pull` golden test: byte-identical scores after the C1 refactor.
- The flash gate exits non-zero on a deliberate strobe; both hard gates block ship in an automation dry-run; a missing `intent.json` warns + ships a stub.
- `critique_track_video` returns a schema-valid critique from a local Worker preview; `adminAuth` rejects an insufficient token; every `likelyCodeFixes[]` carries a `groundedIn` reference; the relay returns an advisory `{ ok:false }` on timeout (no hang).
- Docs updated in the same delivery: the `fluncle-video` skill (the inserted intent step, the bounded sharpen rule, the gate reframe, the failure-modes anti-patterns, the verbatim-failure-mode judge rubric), the `packages/video` README contract (flux/`u_flux`/`useFlux`, the new scripts), the `intent.json` schema where produced + consumed.

**Calibration outcomes (NOT ship-gates — weeks-out, advisory):** the coupling cutoffs snapped to operator labels (≥ 60 clips); the judge-model κ (≥ 40 clips, with CI) before any default-model swap. Capture the baseline now: run `analyze-motion` over the current `out/*.mp4` corpus and record coupling-z + operator dead/alive labels.

---

## Risks & open questions

- **The coupling estimator was the fatal defect** (max-over-bands-and-lags reads alive on noise). Fixed by the per-clip permutation null + single principled lag + intent-declared band; the residual risk is _statistical power on 10 s clips_ — sized for the 10 s floor, advisory-only until calibrated.
- **The flash gate is a from-scratch safety implementation.** The 10°-field sliding-window area rule + the static deadband + the grain-only reference + the fast-flash-in-grain fixture are the guards against a false negative; it is biased conservative-by-coverage. Still: it is a HARD safety gate built by hand — the operator review remains a second line.
- **A1 changes every new props.json and the chosen window.** Guarded by the ratio test, the window snapshot, tunable gamma/percentile, and the C2-flash precondition.
- **Convergence risk (the package's #1 law).** The intent schema is _descriptive, never read back_; anchors teach the bar not the look; the judge has a `divergenceFromRecent` axis wired to the vehicle ledger. These are the mitigations; whether they hold is itself something the judge's divergence scores will reveal.
- **The unattended LLM loop + auto-iterate.** `intent.json` is warn-and-stub (not block) in v1; the advisory-open guarantee lives in deterministic CLI/relay code, not prompt prose. Auto-iterate is ON but bounded to **N=2 on drafts** (the cap a hard rail, the loop-counter enforced); the at-least-once overlap it widens is an accepted, bounded cost — drafts only, the queue gate holds, worst case one wasted render, never a double-publish.
- **Attribution can still mislead at the margin** (it reads normalized curves + the new `rawDynamicsHint`); demoted to an advisory hint, not a hard loop input.
- **Deploy coalescing** — exactly one prod deploy (Phase 1), landed isolated, build confirmed on the final commit.
- **Calibration corpus is at the floor** (~43 renders, some 10 s). The labelling targets + the sequenced (not simultaneous) calibration are the honest plan; more clips may be needed first.
- **Named, scoped-out fast-follows** (honest scoping, not cut work): the BPM clamp widening (A8); pairwise A/B + R2-URL true-video (D); auto-iterate (E/v3).

---

## Appendix — verifications & sources

**Verified live by the build research + the adversarial panel (file:line, at research time — re-grep before editing):** `packages/video/src/pipeline/{analyze-audio,fft,detect-beat-pull,social-preview,ship,render,resolve-preview}.ts` + tests (the panel ran `bun test`, confirmed the "0 tests but executes" pattern, and re-derived the `dominantBand` bin math); `packages/video/src/remotion/hooks/*`, `journey/shader-layer.tsx` (the single `audio.uniforms.u_audioDisturbance` read; the six redundant bag aliases; the three-place flux plumbing), `types.ts`, `root.tsx`; the `fluncle-video` skill (SKILL/cookbook/workflow integer steps 1–9; the existing exposure cap `tone = min(tone,0.90)` and doctrine-9 strobe ban; the gitignored `workbench/`); `apps/web/src/lib/server/{env.ts, orpc.ts, orpc-auth.ts, orpc/admin-backfills.ts}`, `orpc-admin-coverage.test.ts` (the `ADMIN_ROUTE_OPS` enforcement + the `finalize_track_video`/`presign_track_video_uploads` per-track nesting + the no-TanStack-route trap + deploy:gate = typecheck-only), `packages/contracts/src/orpc/*`, `apps/cli/src/{api.ts, cli.ts, commands/admin-tracks.ts}`, `apps/web/.dev.vars.tpl`, `docs/naming-conventions.md`, `render-queue.prompt.md` + `automation/README.md` (at-least-once, the queue gate, the heavy hard-rail repetition). The diagnosis is at `/tmp/fv-diagnosis.md`; the five research threads at `/tmp/fv-rfc/T{1..5}-*.md`; the panel critiques at `/tmp/fv-rfc/panel-*.md`. **Panel simulations:** the coupling-noise-floor and curveCrest-inversion sims (ML-eval) are the basis for the C3 redesign; the STFT-overlap 46%→78% computation (staff) is the basis for the A4+A5 merge.

**External sources (dated June 2026):**

- WCAG 2.2 Understanding SC 2.3.1 (general/red flash: 0.10 magnitude, 0.80 dark state, >3/sec, **25% of a 10° field ≈ a 341×256 px sub-region**, red R/(R+G+B)≥0.8 & >0.2 CIE-1976) — https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html ; relative luminance — https://www.w3.org/WAI/GL/wiki/Relative_luminance ; Technique G15 — https://www.w3.org/WAI/WCAG22/Techniques/general/G15 ; ISO 9241-391:2016 — https://www.iso.org/standard/56350.html ; PEAT retired / Harding FPA — https://trace.umd.edu/peat/ , https://www.hardingfpa.com/ .
- OpenRouter — Structured Outputs (`response_format: json_schema`, `provider.require_parameters`), Image Understanding (`image_url`), attribution headers — https://openrouter.ai/docs (Context7 `/websites/openrouter_ai`); model cards/pricing (treat IDs as build-time-verify): `google/gemini-3-flash-preview`, `minimax/minimax-m3`, `xiaomi/mimo-v2.5` + the June-2026 roundup https://www.digitalapplied.com/blog/openrouter-new-models-june-2026-roundup-pricing-rankings .
- LLM-as-judge (pairwise vs absolute; both-orders for position bias; rubric anchoring + few-shot; calibrate vs human labels with κ; the κ=0.807 few-shot result is _text_, not visual) — https://futureagi.com/blog/llm-as-judge-best-practices-2026 , https://aman.ai/primers/ai/LLM-as-a-judge/ .

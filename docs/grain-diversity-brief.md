<!-- Non-canonical brainstorm (AGENTS.md): scoped 2026-06-23 by a sub-agent. Where it deviates from code/canon, code + DESIGN.md/PRODUCT.md/VOICE.md win. -->

# Scoped brief: grain diversity in the Fluncle video kit

> **LANDED 2026-06-24 (#145).** This brief's full scope shipped: the `GrainOpts` overload of `filmGrain` plus the six named families (`grainFineEmulsion` / `grainCoarseSilver` / `grainHalftone` / `grainChemicalDye` / `grainVhsScanline` / `grainDither`) live in `packages/video/src/remotion/journey/glsl.ts`, and the `video_grain` ledger threads `ship` → CLI → `track-update`. The canonical surface is the code + the `fluncle-video` skill cookbook; keep this brief as the historical scoping record only.

Read-only scoping. No code was changed. This proposes the work; it does not do it.

## The problem, verified against source

The video kit has exactly ONE grain helper and it is hardcoded in its character.

- `GLSL.filmGrain(col, uv, time, intensity)` — `packages/video/src/remotion/journey/glsl.ts:174-195`. Its only knob is `intensity` (amount). Everything that gives the grain its CHARACTER is baked in:
  - grain SIZE = 1 px: `hash21(floor(g) + ...)` over `g = uv * u_res` (`glsl.ts:183,185`) — per-pixel speckle, no scale knob.
  - boil/reseed rate = 24 Hz: `float t = floor(time * 24.0)` (`glsl.ts:182`).
  - clump CELL size ≈ 22 px: `valueNoise(g * 0.045 + ...)` (`glsl.ts:188`).
  - clump amplitude 0.35→1.5: `mix(0.35, 1.5, clump*clump)` (`glsl.ts:189`).
  - luminance shaping 1.3→0.55, knee 0.85: `mix(1.3, 0.55, smoothstep(0.0, 0.85, l))` (`glsl.ts:193`).
  - MONOCHROME: `return col + grain * intensity * shape` (`glsl.ts:194`) — one scalar added to all of RGB.
  - ISOTROPIC: square per-pixel hash, no direction.
  - noise basis FIXED: `hash21` + `valueNoise` only.

- Empirically every composition invokes it identically and varies only the 4th arg. ~20 workbench call sites (`rg "filmGrain\\("` over `packages/video/src/remotion/workbench/`), all of the form `col = filmGrain(col, uv, <t>, <amount>)`; a handful add a small reactive term to the amount (`+ u_onsetPulse*0.06`, `+ u_audioHit*0.04`). NONE vary size/shape/anisotropy/basis; NONE roll their own grain (no `hash21(...)±0.5` added to `col` outside `filmGrain`). The grain is the one truly shared surface (the `workbench/` files are gitignored scratch; the helper is the durable contract).

Result: every Fluncle video wears the same 1-px, 24 Hz, monochrome, isotropic grain texture. The operator reads it as "a tell, not character" — predictable.

### The decisive monitor finding (must be honored)

On an external monitor that renders the grain LESS, a clip looked MORE electric / more pop than on the Macbook where the grain shows fully. So the grain is currently OVER-applied and is REDUCING the pop. The fix is not only texture variety — it must include AMOUNT, composition-led, with a real path to near-zero. Some findings want much less grain, or almost none.

### The canon tension to reconcile (honestly)

`DESIGN.md:104` (the Light-Years Rule) and `DESIGN.md:108` ("heavy grain over warm near-black **everywhere**") + MOODBOARD.md ("grain on every frame") treat grain as load-bearing brand, fixed and always-heavy. The cookbook reinforces "full liveliness," "don't slow the grain," and several workbench comments say "full liveliness (Light-Years)." The monitor finding says amount/FORM is the composition's call, not a fixed always-heavy default. The reconciliation below keeps grain a brand SIGNATURE (it is present and it BOILS on every frame) while making its AMOUNT and FORM the composition's decision — never a fixed heavy wash.

This is consistent with how the kit already treats vehicle and palette: brand-fenced, composition-led inside the fence. Grain is the one constant that never got that treatment.

---

## 1. The knob set — a new `filmGrain` signature

GLSL has no default args or structs, so the clean move is an **overload by arity**: keep the legacy 4-arg `filmGrain(col, uv, time, intensity)` (so the ~20 existing call sites and every doc snippet still compile unchanged), and add a richer entry point that takes an explicit options bundle passed as a few extra floats / a small `GrainOpts` struct defined inside the snippet.

Proposed snippet API (all inside the `filmGrain` GLSL string, so it's one import):

```glsl
struct GrainOpts {
  float amount;     // master multiplier, 0.0..0.30. 0.0 = OFF (the near-zero path)
  float scale;      // grain cell size in px, 0.5..6.0. 1.0 = today's per-pixel speckle; >1 = coarser silver
  float boilHz;     // reseed rate, 0.0..30.0. 24.0 = today; lower = slower emulsion crawl, 0 = frozen plate
  float clumpScale; // low-freq envelope cell size in px, 8.0..64.0. ~22 today; bigger = broad blotches
  float clumpAmt;   // 0.0..1.0 how strongly clumps gate the speckle. 0 = even film, 1 = pooled/patchy
  vec2  aniso;      // grain anisotropy (x,y stretch). (1,1)=isotropic; (1,3)=vertical streak (VHS/scanline lean)
  float color;      // 0.0=monochrome (today), 1.0=full per-channel RGB grain (chemical/dye speckle)
  float lumaLow;    // shadow grain strength (today 1.3)
  float lumaHigh;   // highlight grain strength (today 0.55)
  int   basis;      // 0=hash21 (today), 1=valueNoise-soft, 2=ordered-dither/bayer, 3=blue-noise-ish, 4=halftone-dot
  float seed;       // grain field seed offset; derive from u_seed so it is per-track stable
};
vec3 filmGrain(vec3 col, vec2 uv, float time, GrainOpts o);
// legacy overload retained:
vec3 filmGrain(vec3 col, vec2 uv, float time, float intensity); // = the 11-knob default below
```

Knob-by-knob (what it does, range, default = today's behavior):

| Knob                   | What it does                                                             | Range       | Default (= today)            |
| ---------------------- | ------------------------------------------------------------------------ | ----------- | ---------------------------- |
| `amount`               | master strength; **0.0 = grain OFF**                                     | 0.0–0.30    | 0.08                         |
| `scale`                | grain GRAIN size in px (coarse silver-halide vs fine emulsion)           | 0.5–6.0     | 1.0                          |
| `boilHz`               | reseed/boil rate; brand SIGNATURE lives here (it must boil)              | 0.0–30.0    | 24.0                         |
| `clumpScale`           | clump envelope cell size in px                                           | 8–64        | 22                           |
| `clumpAmt`             | how pooled/patchy the clumps read                                        | 0.0–1.0     | ~0.7 (the 0.35→1.5 envelope) |
| `aniso`                | directional stretch of the grain cell                                    | (1,1)–(1,4) | (1,1)                        |
| `color`                | monochrome → per-channel RGB grain                                       | 0.0–1.0     | 0.0                          |
| `lumaLow` / `lumaHigh` | luminance shaping                                                        | 0–2 / 0–2   | 1.3 / 0.55                   |
| `basis`                | the noise BASIS / pattern (hash / soft / dither / blue-noise / halftone) | 0–4         | 0                            |
| `seed`                 | per-track grain field offset                                             | any         | from `u_seed`                |

Determinism constraints (`packages/video/README.md` §"Determinism rules"): the grain field stays a pure function of `(uv, floor(time*boilHz), seed)`. No `Math.random`, no `Date.now`. `seed` MUST derive from the `u_seed` prop (and stable sub-seeds), so a track always renders identically. `boilHz=0` gives a frozen-plate variant that is still deterministic. The blue-noise basis (3) must be computed analytically or from a deterministic tile, never a random texture.

Encode reality (`README.md` §"Encode settings rationale"): grain is high-entropy and saturates the bitrate; `crf:23` under a 32M VBV cap is the only toolbox (no x264 `tune=grain`). COARSER grain (`scale>1`) compresses BETTER than 1-px speckle (fewer high-freq transitions), so the coarse-silver variants are bitrate-friendlier; very fine 1-px grain at high amount is the worst case. Worth a note in the helper doc so an agent doesn't crank fine+heavy and blow the cap.

---

## 2. A grain helper family — distinct grain TYPES

Six named presets layered on the knob set above, each a short spec. Expose them as named `GrainOpts` factories (e.g. `GRAIN.fineEmulsion`, `GRAIN.coarseSilver`, …) the agent can pass straight in or tweak. Each video picks a DISTINCT one.

1. **fine emulsion** — today's grain, but with amount as a real variable. Fine 1-px speckle, gentle clumping, monochrome, boils at 24 Hz. Moodboard: `phosphor-grain-field.png` (dense warm-dark grain), `grain-liquid-heat.jpg`. Reach for it: the default; a calm, atmospheric fluent/nebula field that wants the classic recovered-emulsion feel — but DIAL THE AMOUNT to the composition (often lower than the 0.08 default; the monitor finding).
2. **coarse silver-halide** — large grain (`scale 2.5–5`), strong clumping (`clumpAmt` high), monochrome, slow boil (`boilHz 8–14`). Reads as a pushed/high-ISO black-and-white stock. Moodboard: `posted/prufung.jpg` (linen-grain over everything), `posted/rainy-days.jpg` heavy grain. Reach for it: orb/nebula bodies and warm-dark fields that want WEIGHT and a hand-developed feel; bitrate-friendly.
3. **halftone / dot grain** — `basis=4` (halftone-dot), `scale` sets dot pitch, dots ride the beat. NOT TV static — a printed dot screen used as the degradation grade. Moodboard: `halftone-tulip-bloom.png`, `halftone-portrait-dots.png`, `halftone-horse-paddock.png` (newsprint). Reach for it: dither/glitch and representational halftone vehicles; the print-decay register. (Distinct from `dotField`, which is a STRUCTURE primitive; this is the grain GRADE.)
4. **chemical / dye bloom** — `color=1` per-channel RGB grain with mild channel misregistration, soft `basis=1`, broad clumps. Reads as color-film dye-cloud / cross-processed bloom. Moodboard: `watercolor-dye-bleed-portal.png`, `crt-cosmos-bloom-coral.png` (RGB-fringed bloom), `grain-pink-carnival-mask-bloom.png`. Reach for it: fluent/watercolor and bloom-from-haze scenes; the ONE place colored grain is on-brand (the dye IS the heat, retinted).
5. **VHS / scanline grain** — anisotropic (`aniso=(1,3)+`), vertical-streak speckle + faint horizontal banding term, mild chroma offset, fast boil. Reads as magnetic-tape noise. Moodboard: `crt-scanline-roses.png`, `scanline-heat-sleeve-diamond.png`, `datamosh-sleeve-preservation.png`. Reach for it: analog/CRT and sleeve-as-logbook vehicles; broadcast-decay register.
6. **dither grain** — `basis=2` ordered/Bayer dither used as the grain itself (1-bit-ish quantization noise), low color, can be near-static. Moodboard: `dither-hourglass-glitch.png`, `green-matrix-bloom.png`, `dither-relic-vase.png`. Reach for it: the dither/matrix pole and data-decay vehicles; pairs with the existing `dither8` banding-killer but as a VISIBLE texture, not a 1/255 whisper.

Note: `dither8`/`ditherValue` already exist in the injected header (`shader-layer.tsx:109-116`) at ~1/255 to kill banding — the dither-grain preset is the same idea cranked to a visible grade, so the family has a natural anchor already in the kit.

---

## 3. A diversity rule for the skill — enforce grain variety like vehicle diversity

Mirror the existing **vehicle diversity ledger** exactly. The mechanism already exists end-to-end for `vehicle`:

- DB column `video_vehicle` (`apps/web/src/db/schema.ts:161`), written via `track-update.ts:80-81,157-159`.
- `ship` emits `vehicle` into the render manifest/upload payload (`packages/video/src/pipeline/ship.ts:253-255`); the CLI forwards `manifest.vehicle → videoVehicle` (`apps/cli/src/commands/track.ts:155`).
- Surfaced for the next agent via `/api/tracks` and `fluncle admin tracks vehicles --json` (`apps/cli/src/commands/admin-tracks.ts:262-272`), described in SKILL.md §"See what's already been made" as the diversity ledger.

Proposal — add a parallel `grain` (or `videoGrain`) ledger entry that records which of the six families a finding used:

- New DB column `video_grain` (one verb_noun-clean field), written the same way `video_vehicle` is.
- `ship` writes `grain: <familyName>` into the render manifest beside `vehicle`/`model`/`reasoning`; CLI forwards it.
- Add `grain` to the vehicles ledger read (`fluncle admin tracks vehicles --json` already returns `{logId, addedAt, vehicle, title, artists}` — add `grain`) so one call gives the agent both ledgers.

Skill rule (drop into SKILL.md doctrine 3 "Vehicle diversity" as a sibling clause, and into the cookbook):

- "Pick a grain FAMILY (§grain families) the same way you pick a vehicle: read the recent ledger and choose one DISTINCT from the recent runs — don't repeat the recent grain. Map the family to the texture-family/track-features you already chose (analog→VHS, dither→dither/halftone, fluent/watercolor→chemical-dye, nebula/orb→coarse-silver or fine-emulsion). Then set the AMOUNT to the COMPOSITION, not a default: a clean, electric, high-pop scene wants LESS grain (down toward near-zero); a soft, far-travelled, melancholic scene wants more. Grain is always present and always boils (the Light-Years signature), but its amount and form are yours."
- Add grain to the run report requirement: the agent must name which grain family it chose and why (mirroring the existing "name how the Texture drove a specific visual decision"), so the operator can confirm it varied.

This makes grain variety enforceable and auditable the same way vehicle variety already is — same ledger, same read, same report discipline.

---

## 4. The canon edit — reconcile the Light-Years Rule with composition-led amount/form

### DESIGN.md

Current (`DESIGN.md:104`, the Light-Years Rule):

> **The Light-Years Rule.** Every artifact in this system arrives lossy because of how far it travelled: grain over the sun, compression in the video, glitch and dither, the worn edge of a recovered record. The degradation is narrative, never sloppiness — it is the cost of light-years, the reason a finding from the edge of the map looks the way it does. Grain and lossy texture are therefore load-bearing brand, not decoration; a surface rendered too clean reads as fake. (The video kit in `packages/video` is built entirely on this rule; VOICE.md borrows it for copy.)

Proposed revision (keep grain a SIGNATURE; make amount/form composition-led — add one sentence, change none of the existing meaning):

> **The Light-Years Rule.** Every artifact in this system arrives lossy because of how far it travelled: grain over the sun, compression in the video, glitch and dither, the worn edge of a recovered record. The degradation is narrative, never sloppiness — it is the cost of light-years, the reason a finding from the edge of the map looks the way it does. Grain and lossy texture are therefore load-bearing brand, not decoration; a surface rendered too clean reads as fake. **The grain is a SIGNATURE, not a fixed wash: it is present and it boils on every frame, but its AMOUNT and FORM are the composition's call — fine emulsion or coarse silver, a printed halftone or a tape streak, heavy on a far-travelled relic and near-silent where a clean, electric finding wants its pop. A grain over-applied flattens the very pop it should protect; match it to the finding, never default it to heavy.** (The video kit in `packages/video` is built entirely on this rule; VOICE.md borrows it for copy.)

Also soften the absolute in `DESIGN.md:108` ("**heavy grain over warm near-black** everywhere"): change "heavy grain" → "grain over warm near-black everywhere (its weight set per surface)" so the motif list no longer mandates HEAVY. (Small, keeps the motif, drops the always-heavy default.)

### SKILL.md / cookbook

- SKILL.md §"The constants you cannot touch" (`SKILL.md:118`) currently says "Grain / recovered-footage degradation on every frame, baked into your shader … varied per video." Extend "varied per video" → "varied per video in FAMILY **and AMOUNT** — present and boiling on every frame, but its weight is the composition's call (down toward near-zero for a clean, high-pop finding), never a fixed heavy wash."
- cookbook §"Do NOT slow the grain to pass the gate" (`cookbook.md:55`) stays exactly as-is — it is about BOIL RATE vs the beat-pull gate, and the signature reconciliation explicitly keeps boil ON. Add one adjacent line distinguishing the two knobs: "AMOUNT is the composition's call (often lower than the 0.08 default — see the monitor note); BOIL stays lively. Lowering amount is right; slowing the boil to game the gate is still wrong."

This is the honest reconciliation: boil rate (liveliness) stays a hard constant; amount and form become composition-led; grain stays present and on-brand on every frame.

---

## 5. Before/after experiment — prove the monitor finding

Goal: show that reduced/varied grain INCREASES pop, so the amount change is evidence-led, not taste-asserted.

- Pick a clip the operator already flagged as "more electric on the external monitor" — e.g. `019.1.7X` (operator-named) or any recent high-energy finding whose source bundle is in R2 (`composition.tsx` + `props.json` are archived, so it re-renders deterministically — `README.md` §output contract).
- Re-render the SAME composition + props three ways, changing ONLY the grain call:
  - **A (current):** `filmGrain(col, uv, t, ~0.10)` — the shipped heavy default.
  - **B (reduced amount):** same family, `amount ≈ 0.03–0.05`.
  - **C (varied family + reduced):** swap to a coarser/lower-amount family (e.g. coarse-silver at `amount 0.04`, or chemical-dye if the scene is warm) — distinct texture AND less of it.
- Render all three at FULL ship encode (not `--draft`: the README warns half-res + jpeg hide whether grain reads/blocks — `README.md` §draft mode). Compare on BOTH screens (Macbook + the external monitor the operator used), since the whole finding is screen-dependent.
- Compare: (1) does pop/contrast/"electricity" rise from A→B→C; (2) does the climax read hotter with less grain veiling it; (3) does the picture still read as recovered footage (signature intact) at the lower amount; (4) does the beat-pull gate still pass (`detect-beat-pull <trackId>` — it scores MOTION, so amount should not change it, which itself confirms amount is a free knob); (5) file size (coarser grain should encode smaller under the same cap).
- Success = B and/or C look more "pop" than A on at least the external monitor while still passing the grain-reads/recovered-footage eyeball and the beat-pull gate. That validates "amount is the composition's call, default lower."

This experiment is also the cheapest possible proof and doubles as the pilot for the phased build (below): it can be done with a one-line edit to a single re-rendered composition BEFORE any helper work.

---

## 6. Scope / effort + phased build order

Cheap, high-value first; each phase ships independently.

- **Phase 0 — the proof (XS, ~1 hr, no kit change).** Run the §5 experiment by hand-editing the grain amount/family in ONE re-rendered composition. Confirms the monitor finding and the direction before any helper work. THIS IS THE RECOMMENDED FIRST STEP. If the operator already accepts the finding, fold this into Phase 1's verification instead.
- **Phase 1 — amount + canon (S, highest value/effort).** (a) The canon edits in §4 (DESIGN.md Light-Years Rule + motif line; SKILL.md constant; cookbook amount-vs-boil line). (b) One cookbook/skill line telling the agent to set amount to the composition and bias LOWER than 0.08. NO code change — the existing `intensity` arg already lets a composition go to near-zero today; the problem is doctrine told it to stay heavy. This alone captures most of the monitor-finding win at almost no risk. Verify: re-render a clip at lower amount, eyeball + beat-pull gate.
- **Phase 2 — the knob set (M).** Add the `GrainOpts` overload to `filmGrain` in `glsl.ts`, keeping the 4-arg legacy overload so nothing breaks. Add the `scale`/`boilHz`/`clumpScale`/`clumpAmt`/`aniso`/`color`/`luma`/`basis`/`seed` knobs. Update the README `GLSL.*` inventory + the helper docstring (incl. the coarse-compresses-better and determinism notes). Verify: `bun run --cwd packages/video typecheck`, `bunx oxlint packages/video`, and a render per new basis to confirm each compiles and reads.
- **Phase 3 — the six-family presets + cookbook (M).** Add the `GRAIN.*` named factories (§2), each with its moodboard reference and "reach for it" note, into the cookbook and the kit. This is what makes the diversity actually pickable.
- **Phase 4 — the grain ledger (S–M, plumbing).** Add `video_grain` DB column + migration (`bun run --cwd apps/web db:generate`, never hand-written SQL), thread `grain` through `ship` → CLI → `track-update` exactly like `vehicle`, add it to the `vehicles --json` ledger read, and add the SKILL.md diversity clause + run-report requirement (§3). This makes grain variety enforceable/auditable.

Recommended first step: **Phase 0 → Phase 1.** The doctrine change (grain amount is composition-led, bias lower) plus a single before/after render captures the decisive monitor-finding win immediately, with zero kit risk, and de-risks the larger helper-family build that follows.

### Key files (all absolute)

- `packages/video/src/remotion/journey/glsl.ts:174-195` — `filmGrain` (the one helper to extend).
- `packages/video/src/remotion/journey/shader-layer.tsx:85-117` — injected HEADER incl. `ditherValue`/`dither8` (the dither-grain anchor).
- `packages/video/README.md` — `GLSL.*` inventory + encode/determinism rules to update.
- `packages/video/moodboard/MOODBOARD.md` — the grain references the families cite.
- `DESIGN.md:104,108` — the Light-Years Rule + motif line to edit.
- `packages/skills/fluncle-video/SKILL.md:118` + `references/cookbook.md:5,55` — the skill doctrine + grain cookbook notes.
- `apps/web/src/db/schema.ts:161`, `apps/web/src/lib/server/track-update.ts:80-159`, `packages/video/src/pipeline/ship.ts:253-255`, `apps/cli/src/commands/admin-tracks.ts:262-272`, `apps/cli/src/commands/track.ts:155` — the vehicle-ledger plumbing to mirror for a grain ledger.

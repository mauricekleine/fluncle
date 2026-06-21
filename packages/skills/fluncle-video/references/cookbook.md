# Technique cookbook

Technique, not style. This teaches how to draw the things Fluncle videos are made of; the _what_ is yours, chosen per track. There is no committed track archive — use these patterns as a vocabulary, and consult R2 output bundles only when the operator provides a specific historical composition. The exact `GLSL.*` signatures and the `ShaderLayer` injected header live in `packages/video/README.md`; this file assumes you have read that section.

The unit of drawing is one `ShaderLayer` rendering a GLSL fragment shader. Inside a shader you get the injected uniforms (`u_time`, `u_res`, `u_progress`, `u_energy`, `u_bass`, `u_mid`, `u_treble`, `u_beatPulse`, `u_seed`, `u_palette[4]`, plus the `*Fast` and `u_audio*` variants — full list in README) and the dither helpers (`ditherValue`, `dither8`). **GOTCHA: declare ONLY your own CUSTOM uniforms in the shader body — NEVER re-declare these injected ones.** Re-declaring `uniform float u_time;` (etc.) is a GLSL `redefinition` compile error, and a failed compile renders the ShaderLayer ERROR OVERLAY instead of your scene (tell: a ~1MB output file — far too small for a real grained render). Always frame-verify your final MP4; a confident "it works" is worthless if you never looked. You spread the `GLSL.*` snippet strings ahead of `void main()` and respect their dependencies (`fbm` needs `valueNoise`; `valueNoise`/`simplexNoise`/`filmGrain` need `hash`). **At the GPU level, bake grain and the palette ramp into the shader** (`GLSL.filmGrain`, `GLSL.paletteRamp`). The core ships NO CSS `Grain` overlay — the recovered-footage grain is yours, in-shader, on every frame, and varied per video (the Light-Years Rule).

## fbm haze / smoke fields

A two-layer fbm — a warp field flowing a second field — gives haze its volume so it drifts and folds like stage haze instead of scrolling. Keep time slow. Map the result low through `paletteRamp` so the background stays dark and never reaches cream: it must stay a deep warm-dark cloud so the vehicle is always the brightest thing. Drive the bloom width with `u_energy` / `u_drop`.

For a GEL-SPLIT field, let two committed light temperatures share one frame: warm heat field vs a minor artwork counter-accent under the Retint Rule, with a soft breathing boundary. The drop can flood the field warm so the cool burns off. The shader recipe is warp fbm + field fbm + seam math + low ramp cap + screened-in cool wisp, then `vignette` → `filmGrain` → `dither8`.

## ridge / contour fields (the lines vehicle)

Line displacement as terrain or signal — the Unknown Pleasures motif, data-as-landscape. Stack horizontal lines and displace each by a field; drive the displacement amplitude from the energy/bass/onset curves so the terrain reacts. Lines go in the scene's ink (Starlight Cream is the safe default); the climax is the lines' OWN material intensifying at the music's strongest structural moment — brightening, thickening, the displacement deepening — in the scene's palette (doctrine 1). Eclipse Gold is welcome only when the crest's own material genuinely runs hot, as one accent among the scene's colours; a cool line-field climaxes cool. Never bolt a separate gold bar or glow on top.

For a waveform-ridge terrain, let the stacked contour field travel monotonically and ride amplitude from broad energy plus tighter bass/onset curves. The crest intensifies at the music's strongest structural moment, not automatically in the center of the clip.

## dither / halftone resolution fronts (the glitch vehicle)

Order resolving out of corruption: the frame departs as scattered 1-bit dither noise, a corruption front travels across it resolving cell by cell through the drop, and arrives snapped into place — a clean halftone form with a single burning rim. The whole texture can be ONE shader: halftone dither, the resolving front (a smoothstep edge swept by `u_progress`/`u_drop`), the SDF body, grain, and the palette ramp all baked in. The climax is the resolution front completing — the vehicle's own material intensifying, in the scene's palette; gold rim only when that material genuinely runs hot, never a separate glow.

Keep this as one shader when possible: halftone dither + resolving front + SDF body + rim, all in one `ShaderLayer`. The resolving front is the vehicle; do not add a second light source to explain it.

## SDF celestial bodies (the orb vehicle)

A rendered-grade body, not a flat disc: an SDF circle whose body is an fbm-textured material, a hot fresnel-style limb (a thin bright burning edge), a soft outer glow with physical falloff, and emulsion grain baked INTO the surface so the grain reads as the material. Keep the body capped below the cream stop so it reads as a burning grainy body, not a washed-out white ball — only the limb reaches the brightest stop, and the hot accent lives on the rim (~10% of the frame). For an eclipse, keep it the `limb` look (body in shadow along a terminator, one edge burning) rather than a full lit ball. The orb's heat colour is the scene's — Eclipse Gold when the body genuinely runs hot, the scene's own hue (a deep-blue limb, a steel surge, a teal bloom) when it does not; the orb's climax is the limb intensifying, never a separate sun glued behind it.

**The quad law lives here (doctrine 6).** The exp glow falloff never reaches 0, so at the square layer's edge it prints a visible rectangle. Drive the glow to EXACT zero well inside the quad with a radial `edgeFade` (e.g. `1.0 - smoothstep(0.80, 0.96, r)`), and/or mask the layer to a circle in CSS — a glow falloff that never reaches zero prints a visible rectangle at the quad edge, so do not skip this. **This radial fade is ONLY for a localized layer like the orb** (one that does not cover the frame). A full-bleed background field does the opposite: it fills to the corners, so a radial vignette there just crops the frame into a porthole (doctrine 6).

Key details: limb, shadowed body, core bloom, glow falloff, and an `edgeFade` or CSS radial mask that forces alpha to zero before the quad edge. A useful variant is a small ember that grows into the full limb on a late drop.

## beat mapping patterns

Audio reactivity comes ONLY from the curve hooks / shader audio uniforms — never decode audio at render time, never wall clock.

- **Pulse decay on the beat grid:** `useBeat(beatGrid, { decay })` → `pulse` snaps to 1 on each beat and decays before the next. `u_beatPulse` in shaders. The workhorse for rim flares and scale kicks. Higher `decay` is snappier (a neuro stomper); lower breathes (a roller).
- **Energy gates for drops:** derive the drop window from the energy curve's peak timestamps, then build a `drop` scalar (an `interpolate` ramp across `[dropIn, dropOut]`, optionally floored so the intro is never stone-cold). Gate ignition, field warmth, and exposure on it so the material peak and the visual peak land together.
- **Onset flashes:** `useOnset(onsets, windowMs)` → a 0..1 spike per transient. Use for grain kicks, a dither threshold jolt, a chromatic-aberration shudder, a star twinkle — supporting accents, never the vehicle.
- **Slow gestures:** `useEnergy` (smoothed, broad) drives starfield drift speed, glow breadth, global float; `useBass` (tighter) drives rim swell and breathing.
- **Frequency bands — map instruments to elements (the music-driven win):** three bands are analysed and fed as uniforms (`u_bass` <150Hz kick/sub, `u_mid` 150Hz-2kHz lead/vocal/snare, `u_treble` >2kHz hats/cymbals/air) and React hooks (`useBass` / `useMid` / `useTreble`, plus `*Fast` near-raw variants on the bus: `bassFast`/`midFast`/`trebleFast`). Drive DIFFERENT elements off DIFFERENT bands — the kick swells the core, the lead bends the flow, the hats sparkle the grain. Reacting to one `energy` scalar reads as "moves with the music"; splitting the bands reads as "plays the music." Pick the band that matches what each element should feel. (For the track's OVERALL character — bassy vs bright vs busy — read `track.features` from props, the enrichment spectral summary: it tells you which band leads and how heavy/sparkly the whole vehicle should be before you even look at the per-frame curves.)
- **Kick emphasis (power-scaling):** `pow(u_bass, 4.0)` in-shader makes only strong kicks approach 1 (a real hit has to build before it reads) — the standard audio-reactive trick for a punchy, non-mushy response. Temporal smoothing lives in the hooks (`smoothingFrames`, attack/decay) and in the pre-smoothed `swell`/`drop` busses: a fragment shader has no previous frame to lerp against (Remotion renders frames independently), so accumulate-over-time smoothing happens in React, not the shader.
- **Deriving drop timestamps:** scan `audio.energyCurve` for the peak(s) in the chosen window; those are clip-progress positions you reuse for the drop gate and the type timing.

Build explicit beat maps with named scalars such as `drop`, `dropRise`, and `cold`, plus `DROP_IN`/`DROP_OUT` windows derived from the analyzed curve. For breakdown-led cuts, keep the vehicle visible in the quiet section and reserve the largest structural change for the late drop.

- **Evolve with the music (doctrine 10):** the clip's change rides the track's own arc. Sample the energy curve and the drop/swell envelopes (`u_energy` / `u_drop` / `u_swell`) and let them drive density, structure, palette lean, exposure, and framing continuously across the 20s, cresting at the one climax. Ease every change — `interpolate(sec, [a, b], [from, to], { easing: Easing.inOut(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" })` — so the evolution reads as the film breathing with the track, and the One Driver persists throughout (doctrine 1).

## motion, depth, and the moving climax

Three recurring failure modes, with the technique to avoid each (full framing in SKILL.md):

- **Audio may drive motion — but only SMOOTHED (doctrine 7).** A baseline of travel / flow / speed comes from `u_time` / `arc` / a steady rise; audio may then BEND it, as long as the signal driving the motion is SMOOTHED — the energy envelope, a bar swell, the drop, or a beat run through an attack/decay — never the raw per-beat transient. RIGHT: `float flow = radius*3.0 - u_time*0.85 - u_rise*1.4 - u_swell*0.6;` (a smoothed swell eases the flow faster on the build), or `pos += dir * u_drop * 0.04;` (the mass surges on the drop envelope), or a flock contracting on `u_swell` and dispersing as it falls. WRONG: `... - u_hit*0.6` on a travel term, or `u_time * (1.0 + u_beatPulse)` on a speed term — the bare kick on position/speed jump-and-snaps the whole field every beat. And keep the beat OUT of motion ENTIRELY: `swell` is bass/energy-led and its per-beat weight (`swellBeatWeight`) defaults to **0**, because even a _smoothed_ per-beat still ticks the picture forward at high BPM — proven on 173 BPM D&B, where zeroing it looked markedly smoother than a faint 0.14. Let the BASS carry the rhythmic feel of the motion (it's smoothed, so it surges without snapping); the beat itself belongs in MATERIAL, never movement. Don't raise `swellBeatWeight`, and don't fold `u_beatPulse`/`u_hit` into a travel/speed term to "make it dance" — that IS the per-1/4-note jitter. MATERIAL still takes the immediate punch freely: `brightness *= 1.0 + u_hit*0.5`, `thickness *= 1.0 + u_bass*0.4`, `curvature += u_swell*k`, `radius *= 1.0 + u_hit*0.3`. So a kick makes a filament brighter / fatter at once AND, as a smoothed swell, eases the whole field's drift faster; it never jumps the field a step per kick. Keep streak frequency low (≲ a dozen) or fbm-soften it so it doesn't strobe as it moves.
- **The climax is the vehicle igniting, not a sun glued on (doctrine 1).** Don't add a separate radial gold/colour bloom or halo behind or over the vehicle — drive the vehicle's OWN material to its hottest stop at the climax, in the scene's palette: lerp the filament/blade/node/crest colour toward the scene's peak-heat hue where it's hottest (gate on the drop envelope). When that hue is genuinely gold, lerp toward `u_palette[2]`; when the scene is cool, the climax brightens in ITS OWN colour and reaching for yellow is the error. If deleting the vehicle would delete the bright moment, you've got it right.
- **Do NOT slow the grain to pass the gate — that is the wrong knob.** The beat-pull gate is grain-HARDENED (it temporally pre-smooths, scoring MOTION, not grain), so slowing the grain clock does NOT lower the score — it only DEGRADES the look. Recovered-footage grain BOILS (lively, fresh per-frame — that liveliness IS the Light-Years grade); a slowed/crawling grain reads as smeared and dead, off-brand, and the operator catches it immediately. So leave `filmGrain` at full liveliness (`filmGrain(col, uv, u_time, amt)`); never reach for `u_time * 0.3` to game the gate. If the gate fails, the cause is the MOTION — a per-beat signal on travel/position, or an intrinsically orbiting/breathing vehicle (see the curl-orbit note in organic fields) — and the fix is always the motion wiring or the vehicle, never the grain.
- **A still hero can't mask the grain's reversal floor — give it bright DIRECTED motion.** The gate averages a per-window reversal RATIO (`1 − net/path`) over the WHOLE frame, and grain leaves a ~0.25 reversal FLOOR the temporal fence only half-removes (random per-frame noise barely travels, so net≈path → a high ratio). Bright content with DIRECTED motion (a one-way drift/flow → high net) makes low-reversal windows that dominate the frame's mean abs diff and DILUTE that floor; bright content that is STATIC contributes ≈0 to the motion metric (no frame-to-frame change) and masks NOTHING — the score then sits near the grain floor (~0.2) even when the picture visibly does NOT lurch. So a calm, smooth clip can still FAIL the gate if its hero doesn't move. The fix is not less grain (above) and not a per-beat pulse (that IS beat-pull) — it's a slow ONE-WAY drift/flow on the dominant element (the smear / streaming families gate low for exactly this reason; a dead-centre static glow gates high). Proven on a gate-transit cut: a static bright core scored 0.20 (the grain floor showing through), and wrapping it in a one-way drifting luminous veil — bright directed motion, no orbit, no beat — dropped it to 0.14 with no change to the felt motion.
- **The eye is the gate; the number is a proxy.** The gate scores _reversal_, so it reads HIGH on a smooth continuous spin or a periodic pattern sweeping past (each pixel rises and falls as features cross it — a clean slow spin can hit ~0.16) and can read LOW on a busy, fine, fast-cycling field that visibly strobes. A green number is not automatically a pass and a high one is not automatically a fail. Rule on the rendered clip: scrub 4–5 adjacent frames around a few beats and confirm the picture GLIDES evenly — broaden and slow a busy/fast field until it flows. The number is a cheap first filter; your eyes decide.
- **The gate punishes reversal, not evolution — breathe by churning FORWARD.** A vehicle whose forms only rigidly translate (a frozen texture sliding one way) gates low but reads DEAD: it glides without breathing, the look the operator rejects. The cure is not to freeze the field — it is to evolve it MONOTONICALLY. Advance the density/noise phase forward over time (a third "time" dimension fed into the `fbm` / `domainWarp` / `curl` inputs, distinct from the directed drift) so the rivers and forms roil and re-form IN PLACE as they stream. Forward-only evolution never returns → no reversal → the gate stays satisfied, and the picture is alive. Keep it SLOW and BROAD (fast/fine in-place churn flickers and bumps the gate; a light directional smear glues it). This is the breathing counterpart to the curl-orbit trap below: curl ORBITS (returns → reversal); a monotonic phase advance FLOWS (never returns → gate-safe).
- **Depth, not diagram.** Volume comes from two-layer fbm, soft radial falloff, vignette, and layered haze — not thin hard parallel primitives on a sparse field. If your field could pass for a UI element, widen it, soften the edges, and layer haze behind it until it reads as cosmos.
- **Move the climax.** Don't gate the climax to dead-centre on every clip. Scan `audio.energyCurve` for where the music ACTUALLY peaks and ignite there — late, early, a slow swell held to the close, an off-centre crest, a front sweeping across. The centred mid-clip glow is the template to escape, not the target.

## GLSL helper inventory

Spread these strings ahead of `void main()`; mind the dependency chain. (Signatures in README.)

| Snippet               | Provides                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| `hash`                | `hash21` / `hash22` / `hash13` — base for all noise.                                                     |
| `valueNoise`          | smooth bilinear `valueNoise(p) -> 0..1`. Needs `hash`.                                                   |
| `simplexNoise`        | gradient noise `simplexNoise(p) -> ~-1..1`. Needs `hash`.                                                |
| `fbm`                 | domain-rotated `fbm(p, octaves) -> 0..1`. Needs `valueNoise`.                                            |
| `curlNoise`           | divergence-free 2D flow `curlNoise(p) -> vec2` — organic advection (flocks/smoke). Needs `valueNoise`.   |
| `domainWarp`          | IQ domain warp `domainWarp(p, octaves) -> 0..1` — marbled, never-gridded fields. Needs `fbm`.            |
| `voronoi`             | cellular/worley `voronoi(p) -> vec3` (F1, F2, cellHash); walls = `smoothstep(F2-F1)`. Needs `hash`.      |
| `dotField`            | dense AA stipple/particle screen `dotField(uv, res, cells, radius, jitter, seed) -> 0..1`. Needs `hash`. |
| `paletteRamp`         | the Retint gradient-map `paletteRamp(t) -> vec3` + `retint(src)` over `u_palette`.                       |
| `polarFold`           | kaleidoscope wedge fold `polarFold(uv, segments)` — the fractal vehicle.                                 |
| `sdf`                 | `sdCircle` / `sdBox` + smooth union `smin`.                                                              |
| `sdf3d`               | 3D primitives `sdSphere3` / `sdBox3` / `sdTorus3` + `rot2`, for raymarched scenes.                       |
| `raymarch`            | sphere-tracer `raymarch(ro, rd, tmax)` + `calcNormal`; you define `float map(vec3 p)`.                   |
| `filmGrain`           | organic emulsion grain `filmGrain(col, uv, time, intensity)`. Needs `valueNoise`+`hash`.                 |
| `vignette`            | radial darkening `vignette(uv, radius, softness) -> 0..1`.                                               |
| `chromaticAberration` | per-channel UV offset helpers `caOffsetR` / `caOffsetB` for an edge-growing RGB split.                   |

Always finish a shader with `dither8(col, uv)` to kill 8-bit banding on smooth gradients.

## organic fields: curl flow, cells, domain warp

The fluid/organic/alive north star now has helpers — reach for these before hand-rolling:

- **`curlNoise(p)`** — a divergence-free flow field. Advect a coordinate by it (`p += curlNoise(p * f) * amt`) for swirling, smoke-like, never-diverging motion: flocks, embers, ink, dust. Scale `p` for eddy size; evolve it on `u_time` and bend the strength with a smoothed band (Motion law).
  - **Orbit caveat (the elastic-breathing trap).** Curl is locally ROTATIONAL, so an advected point ORBITS and returns near where it started — that is reversal (the "elastic, jumping in and out" look the beat-pull gate flags) EVEN WITH NO AUDIO. A flock that converges/disperses, or a plume that churns in place, breathes for the same reason. For motion that reads as FLOWING rather than pulsing, a DOMINANT directed/translational component must override the orbit — a strong monotonic drift/updraft that carries the field forward so the net path streams instead of returning (e.g. raise the linear advance, lower the curl amplitude). If you need clean motion and the curl keeps breathing, that vehicle may be the wrong primitive — a directed front, a translational sweep, or a field that evolves without returning will get clean far more easily than a curl-advected flock. (A surgical patch can damp this but rarely clears it; pick a non-orbiting primitive up front.)
- **`voronoi(p)`** — cellular / worley, the cellular-crackle vehicle the board calls for. Cell WALLS = `smoothstep(0.06, 0.0, vor.y - vor.x)` (cracked glaze, dry lakebed, cell membranes); cell FILL = `vor.z` (per-cell hash for varied tone). Breathe the cells on the bass; widen the walls on the drop.
- **`domainWarp(p, octaves)`** — fbm-of-fbm. Marbled, flowing fields that never read as gridded; the antidote to clean noise. Use as a base field or warp another field's coordinates through it.
- **ridged turbulence → glowing FILAMENTS** (liquid-fire / plasma / veins / lightning / molten tendrils) — the robust go-to when you want a dense, alive field. Warp an fbm field `n` (`domainWarp`, or `fbm` of curl-advected coords), RIDGE it — `float ridges = pow(1.0 - abs(2.0 * n - 1.0), 2.7);` (k ≈ 2.5–3) — then THRESHOLD so only strong ridges survive as thin tendrils on a near-black field: `float fil = smoothstep(thr, thr + w, ridges * detail);`. Why it beats dots/haze: brightness comes from the CONTINUOUS field (no coverage trilemma — see the dots note below), structure from the ridges (never foggy, never flat), and warm-dark dominance is AUTOMATIC — everything under `thr` stays the void. Grade it with a `dotField` multiply + heavy `filmGrain` for recovered-footage texture (no moiré-driving grid). Climax (doctrine 1): the filament CORES igniting — a tightly-gated core term `smoothstep(0.72, 1.0, fire)`, CAPPED (`tone = min(tone, 0.90)`) so it never washes to flat cream, plus `bloom` on those hot cores. Do NOT drop `thr` enough to flood the frame — that's the pale-wash blowout. Drive its evolution off the energy curve + drop: a churning network through the build, thinning to near-black embers in the breakdown, then flooding back with the cores flaring on the drop.
  - GLSL gotchas that cost rounds: don't reuse a header-injected name or re-declare one already in scope (e.g. a local `float t` after `t = u_time`) → fragment-shader `redefinition` → the ShaderLayer ERROR OVERLAY (tell: a ~1MB output file). Diagonalize a near-vertical advection vector to avoid vertical streaking.

## smear: velocity written into the frame (the smear family)

The moodboard's smear region — long-exposure / intentional-camera-movement, where motion ITSELF is the texture (the headlong, re-entry-velocity feel). No GLSL helper and no framework shortcut: `@remotion/motion-blur` (`Trail`/`CameraMotionBlur`) is DOM compositing that re-renders the whole subtree 10–50× per frame — a crippling tax over a fullscreen shader. Do it IN-SHADER (~1× cost, full control):

- **Directional long-exposure.** Put your field in a function `vec3 field(vec2 uv, float t)`, then average a few taps stepped BACK IN TIME along the travel direction:
  ```glsl
  vec3 smear(vec2 uv) {
    vec3 acc = vec3(0.0); float wsum = 0.0;
    const int N = 6;
    for (int i = 0; i < N; i++) {
      float k = float(i) / float(N);                 // 0..1 back in time
      float w = 1.0 - k;                              // newer taps weigh more
      vec2 off = u_travelDir * k * u_smearLen;        // and back along the motion axis
      acc += field(uv - off, u_time - k * u_smearMs) * w;
      wsum += w;
    }
    return acc / wsum;
  }
  ```
  The field is a pure function of (uv, t), so sampling it at earlier t IS its past — a true motion trail with no frame feedback (Remotion can't read frame N-1; this is the sanctioned way to fake trails).
- **Drive the smear length on a SMOOTHED signal** (Motion law): `u_smearMs`/`u_smearLen` rise with `u_audioSwell` / energy / the drop, so the frame streaks harder as the music surges and settles between — velocity that breathes, never a per-kick snap. Keep the baseline tiny so calm passages stay legible.
- **Diagonalize** the travel vector off true-vertical/horizontal to avoid axis streaking artifacts.
- It doubles as a SMOOTHER: even a 2–3 tap temporal average softens the hard 30fps time-sampling on fast motion, reading more cinematic and organic than a naked frame — reach for a light version on any fast vehicle, not only an explicit smear clip. (Don't push N high; it's per-pixel cost ×N.)

## raymarched 3D (volumetric)

For a volumetric or solid vehicle (a tumbling relic, a smoke volume, a metaball mass), `sdf3d` + `raymarch` give a 3D pipeline inside the fragment shader: define `float map(vec3 p)` from `sdSphere3` / `sdBox3` / `sdTorus3` (+ `smin` from `sdf` for smooth unions, `rot2` to tumble), then `raymarch(ro, rd, tmax)` and shade off `calcNormal`. Keep the step count modest — it runs per pixel. CRITICAL: a clean raymarched solid is the polished-CGI failure (SKILL.md) — soak it in `filmGrain`, break the edges, and warp the surface with `fbm` / `domainWarp` so it reads as recovered footage, not a 3D render. Pairs naturally with `bloom` for an emissive core.

## bloom — real emission glow (opt-in)

`<ShaderLayer bloom={{ threshold, intensity, radius }} />` adds a real multi-pass bloom: the bright pixels of YOUR shader are isolated, blurred at half-res, and added back, so hot material reads as genuinely luminous halation — not a flat bright patch. Off unless you pass the prop (the render path is otherwise unchanged).

- **Bloom the vehicle's OWN hot material, never a glued-on orb (doctrine 1).** Bloom amplifies whatever is already bright, so make the bright thing the vehicle's crest / core / filaments going hot — not a separate gradient circle. A clean bright disc plus bloom is still the banned fake-glow, just blurrier; texture the hot material (grain, broken edges) so the bloom reads as recovered-footage halation.
- **Tuning:** `threshold` (default 0.7) is the luminance cut — raise it so only the true climax blooms; `intensity` (0.8) is how much is added back; `radius` (1.0) is the spread. Drive your shader's hot pixels with the drop envelope and the bloom blooms hardest exactly when the music peaks.
- **No feedback trails.** Bloom is single-frame. Cross-frame GPU feedback (motion echoes sampled from the previous frame) is NOT possible — Remotion renders frames independently, so a shader can't read frame N-1. Fake trails with in-shader history instead (sample your field at a few `u_time - k` offsets and sum).

## palette discipline (paletteMix + the Retint Rule)

- Run `paletteMix(track.swatches)` to bend the artwork's colors toward the brand anchors; the roles are locked in code — field stays Deep Field, the warm-dark ground holds, ink stays cream, artwork hues live only in the secondary swatches. A loud cover can never repaint the night: a cold blue sleeve must never extinguish the warm dark.
- The **Retint Rule** (MOODBOARD.md): steal the reference TECHNIQUE, retint everything to canon — warm dark ground, Eclipse Gold as one accent among the scene's palette (never forced as a sun), Re-entry Red as the heat accent, Starlight Cream as ink. Cool hues survive only as minor counter-accents.
- In a shader, keep the `u_palette` / `paletteStops` on the canon ramp (Deep Field → Re-entry Red → Eclipse Gold → Starlight Cream). Admit an artwork hue only as a separate minor seep uniform, never as a ramp stop. Gold is an accent the scene may reach when its material runs hot, not a mandatory sun.
- **WHEN a warm scene's vehicle does run gold: MIX, don't ADD.** Additively blending Eclipse Gold over a warm orange/red field sums into a green/lime smear. So when the climax genuinely calls for gold on a warm ground, `mix()`/lerp the colour toward a locked gold stop (optionally darkening the bed locally under the crest first) so it reads as true gold, not lime. Reserve additive blending for gold over a dark or cool ground. (This is conditional — a cool or non-gold scene climaxes in its own colour and never reaches for gold at all; doctrine 1.)

## fractal / glass

These are good diversity lanes because they avoid the local-history loop (doctrine 3).

- **fractal:** `GLSL.polarFold(uv, segments)` folds the frame into N mirrored wedges; fly inward by scaling the folded coords with `u_time`/`arc` and tint the rings from the artwork accent. The climax is the fold center intensifying in the scene's palette — a hot core whose colour is the scene's (gold only when that core genuinely runs hot, never reached for by default).
- **glass:** refractive vertical blades sweeping across the frame — per-blade UV refraction offsets that breathe with `u_bass`, specular brightness on `u_energy`, the sweep position travelling on the arc. The climax is one specular bulge surging — its colour the scene's own (a steel/teal/blue surge for a cool scene; gold only when the blade's own highlight genuinely runs hot).

## the two registers: fully abstract OR recognizably real (never the middle)

The whole-frame law (SKILL.md) gives you exactly two registers; pick ONE per render and make the whole canvas commit to it. The failure is the **uncanny middle** — a half-real shape that reads as neither (blobs-with-lines that look like nothing).

- **Fully abstract** — the texture/field IS the image, edge to edge: an fbm/curl haze, a voronoi cell-wall screen, a caustic field, a dense stipple swarm that owns the canvas. No subject; the surface is alive and that is enough. (This is what `sonnet-plain`'s vein-screen got right — the field WAS the frame.)
- **Recognizably real, shown abstractly** — the eye must NAME it. This only works if you build on the subject's ACTUAL structure, not a vague impression of it: a real murmuration is streaming rivers with dark lanes and frayed edges (not a fuzzy cloud); real flowers are petals with form (see the moodboard's `halftone-tulip-bloom.png`, `crt-scanline-roses.png`, `dreamy-blurred-wildflowers.png` — real flora, abstracted but legible); a wing has ordered veins. If you can't make it read as the thing, drop to fully abstract — "almost real" is worse than "clearly abstract."

When you DO go representational, these treatments keep it sharp, legible, and beat-syncing more easily than soft haze (so doctrine 9 comes for free). Three reference treatments (MOODBOARD.md):

- **Halftone dot-screen** (`halftone-tulip-bloom.png`) — quantise a soft form (a bloom, a body, the energy field) through a dot grid whose dot RADIUS rides the beat. The dots are sharp; the subject reads through them.
- **CRT / scanline raster** (`crt-scanline-roses.png`) — horizontal scanlines + an RGB cell grid over a subject; jitter/roll the lines on onsets, swell the phosphor bloom on energy. Degraded broadcast, not clean UI.
- **Contour-line displacement** (`contour-eclipse-lines.png`) — the Unknown-Pleasures motif used REPRESENTATIONALLY: a field of horizontal lines that DISPLACE around hidden forms so an eclipse/figure emerges from the warp (flat sparse lines that reveal nothing are the failure to avoid). Drive the displacement amplitude from the energy/bass curves; the climax is a single crest line intensifying in the scene's palette.

**Vary the axis and the primitive.** Those three references all happen to be horizontal-line / raster motifs — left unchecked, agents converge on "horizontal lines + a horizontal gold bar." The register is far wider; reach past lines for: a **dot / stipple screen** (halftone as DOTS, or a particle/ember field quantised to a grid, dot radius riding the beat), a **woven mesh or moiré** interference, a **cellular / voronoi crackle** (cracked glaze, a dry lakebed, cell walls breathing on the bass), **caustics / refraction** (light bent through water or glass, the hot focus swelling on energy), an **emulsion / chemical bloom**. Pick a structure whose axis and primitive differ from the recent archive (read the vehicle ledger via `fluncle admin tracks vehicles --json`), and let the climax take the form that structure implies — a brightening cell, a caustic hot-spot, a sweeping shimmer, a single dot that blooms — in the scene's own colour, **not always a horizontal bar, not a default circular sun, and not forced to gold** (doctrine 1: one committed climax, free form and free colour).

Keep the warm dark throughout — the structure is the vehicle, not a second light source. Any gold is one accent among the scene's palette, present only when the vehicle's own material genuinely runs hot, never bolted on as a sun.

## Framing devices: how the finding is HELD (the log feel)

The moodboard names three ways to HOLD the finding that cut across texture families — reach for one deliberately when the concept wants "a thing observed/held," to deepen the diary register (the soul) and break the centred-orb default:

- **portal / threshold** — a framed window onto the warm side standing inside the dark (a mirror propped in foliage, a receding doorway, a dye-bleed aperture). The finding as a picture in a frame, brightening on the beat: a bright field masked to an aperture shape over a warm-dark surround, the heat gathered at the aperture edge.
- **floating plate** — the finding as a discrete object in the void, a thing you could pick up and turn over: a bounded soft-edged panel (an sdf rect) holding the vehicle on near-black, with a faint mirrored falloff below it.
- **sleeve-as-logbook** — a recovered record sleeve whose print marginalia (side, title, runtime, catalog stamp) survives as archive typography while the image decays. The found object IS the HUD — let `TypePlate`'s telemetry read as the sleeve's own catalog print up a margin.

Most clips need NO device — the field IS the frame, and that's the strongest default. But a portal/plate/sleeve, used sparingly, makes the clip feel like a page from the logbook rather than a loop.

### Density: dots, particles, flocks (the sparse-flock fix)

A dot/stipple/particle/swarm vehicle lives or dies on COUNT. The recurring miss: an agent hand-rolls a coarse one-dot-per-cell grid at ~80–120 cells, which is only a few hundred dots once gated to a body — so a "vast murmuration" renders as scattered confetti, the **flat-chart failure** (SKILL.md). The concept it was chasing has THOUSANDS of points. The canvas renders at full 1080×1920 and a cell grid costs the same per pixel no matter how many cells, so density is free — there is no reason to come out sparse.

Use **`GLSL.dotField`** and think in HUNDREDS of cells:

```glsl
${GLSL.hash} ${GLSL.fbm} ${GLSL.dotField}
// ... in main(), after you have a 0..1 `body` density field (fbm membrane, SDF,
// energy field — the shape the flock occupies) and a per-pixel cell id:
float dots = max(
  dotField(uv, u_res, 240.0, 0.0022, 0.7, u_seed),        // base octave
  dotField(uv, u_res, 360.0, 0.0016, 0.8, u_seed + 19.0)  // finer octave → sub-grid density
);
// gate the dots to the BODY so they form an organism, not confetti:
float present = step(hash21(floor(uv * u_res / 6.0)), smoothstep(0.15, 0.6, body));
dots *= present * smoothstep(0.1, 0.5, body);
```

- **Count is the cell number, not the radius.** 240–360 cells across the height gives thousands of legible points; ~100 reads as static. Keep the dot `radius` ≥ ~0.0015 (≈3px) and AA'd (the helper does this) or h264 eats the fine ones.
- **Body-gate every dot.** Multiply by a density field + a membership `step()` so the dots have a shape with edges and depth — never an even scatter across the frame (that's the formless/confetti failure).
- **Reactivity rides the dots' MATERIAL** per the Motion law (doctrine 7): dot radius swells on the hit, the membership threshold / glow lifts on the energy swell, grain kicks on onsets. What audio may do to the flock's MOTION is governed by doctrine 7 — read it and stay inside it.
- For a true sense of a living mass, layer 2–3 octaves at different cell counts and let the densest core read as depth (a faint diffuse haze of the body underneath the dots sells "one organism," not loose points).
- **`dotField` is best as a TEXTURE OVERLAY, not the lead.** As the PRIMARY image, dots hit a trilemma you cannot tune out: big dots merge into smooth silk ribbons (the clean look the brand rejects); small dots drop coverage and go dark/flat; uniform coverage reads flat; and the regular grid throws curving MOIRÉ over any smooth brightness gradient. The fix isn't a better cell count — it's role. When you just want "dense and alive," make the STRUCTURE a continuous field (ridged filaments, a curl/voronoi/caustic screen — see organic fields) and let `dotField` + grain ride ON it as the recovered-footage grade. The sparse-flock advice above holds for the NARROWER case where a literal stipple SWARM genuinely IS the subject (a murmuration, an ember field) — there, count is king. Reaching for a dot field as the lead because "dense" is what produced a mild, silky first attempt; lead with the field, grade with the dots.

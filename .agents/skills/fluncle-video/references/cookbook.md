# Technique cookbook

Technique, not style. This teaches how to draw the things Fluncle videos are made of; the _what_ is yours, chosen per track. There is no committed track archive — use these patterns as a vocabulary, and consult R2 output bundles only when the operator provides a specific historical composition. The exact `GLSL.*` signatures and the `ShaderLayer` injected header live in `packages/video/README.md`; this file assumes you have read that section.

The unit of drawing is one `ShaderLayer` rendering a GLSL fragment shader. Inside a shader you get the injected uniforms (`u_time`, `u_res`, `u_progress`, `u_energy`, `u_bass`, `u_beatPulse`, `u_seed`, `u_palette[4]`) and the dither helpers (`ditherValue`, `dither8`). You spread the `GLSL.*` snippet strings ahead of `void main()` and respect their dependencies (`fbm` needs `valueNoise`; `valueNoise`/`simplexNoise`/`filmGrain` need `hash`). **At the GPU level, bake grain and the palette ramp into the shader** (`GLSL.filmGrain`, `GLSL.paletteRamp`). The core ships NO CSS `Grain` overlay — the recovered-footage grain is yours, in-shader, on every frame, and varied per video (the Light-Years Rule).

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
- **Deriving drop timestamps:** scan `audio.energyCurve` for the peak(s) in the chosen window; those are clip-progress positions you reuse for the drop gate and the type timing.

Build explicit beat maps with named scalars such as `drop`, `dropRise`, and `cold`, plus `DROP_IN`/`DROP_OUT` windows derived from the analyzed curve. For breakdown-led cuts, keep the vehicle visible in the quiet section and reserve the largest structural change for the late drop.

- **Movement envelopes (doctrine 10):** score 2–3 movements by pinning boundary timestamps to the music's seams (a drop, a bar boundary, an energy shift), then build one 0..1 envelope per movement in React and pass them as uniforms (`u_m2`, `u_m3`). **Ease the envelope — never linear:** `interpolate(sec, [boundary, boundary + ~2], [0, 1], { easing: Easing.inOut(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" })`. A raw linear ramp makes a zoom/stretch/pan read as a mechanical slide; the slow-in/slow-out curve is what makes it feel like a polished transition, not a tween. Inside the shader each envelope shifts the REGIME of the same vehicle — lerp the palette lean, step the cell/dot/streak density or scale, tighten or break the structure, swap which term dominates — while position stays monotonic (Motion law) and the One Driver persists. **Crossfade over a BAR, not a beat** (~1.4–2.8s at 172 BPM; `interpolate(sec, [boundary, boundary + ~2], …)`): START the transition on the seam and let the new regime arrive like weather rolling in, not a cut — snapping between movements too fast makes the shift read as a glitch instead of a passage. The destination regime should land fully a couple of seconds after the seam. The result: second 18 must not look like second 4 with the brightness up — but no single frame should look like a scene change either.

## motion, depth, and the moving climax

Three recurring failure modes, with the technique to avoid each (full framing in SKILL.md):

- **Audio modulates material, never motion (doctrine 7).** Build any travel coordinate AND any animation speed from `u_time` / `arc` / a monotonic rise ONLY — keep them audio-free so the motion glides. `float flow = radius*3.0 - u_time*0.85 - u_rise*1.4;` is right; subtracting a beat spike — `... - u_lift*0.6` — causes a jump-and-snap, and multiplying `u_time` by a beat value makes the whole field lurch on the kick. The equalizer punch goes into MATERIAL: `brightness *= 1.0 + u_hit*0.5`, `thickness *= 1.0 + u_bass*0.4`, `curvature += u_swell*k`, `radius *= 1.0 + u_hit*0.3`. So a kick makes a filament brighter / fatter / more curved, never faster and never displaced. Keep streak frequency low (≲ a dozen) or fbm-soften it so it doesn't strobe as it moves.
- **The climax is the vehicle igniting, not a sun glued on (doctrine 1).** Don't add a separate radial gold/colour bloom or halo behind or over the vehicle — drive the vehicle's OWN material to its hottest stop at the climax, in the scene's palette: lerp the filament/blade/node/crest colour toward the scene's peak-heat hue where it's hottest (gate on the drop envelope). When that hue is genuinely gold, lerp toward `u_palette[2]`; when the scene is cool, the climax brightens in ITS OWN colour and reaching for yellow is the error. If deleting the vehicle would delete the bright moment, you've got it right.
- **Depth, not diagram.** Volume comes from two-layer fbm, soft radial falloff, vignette, and layered haze — not thin hard parallel primitives on a sparse field. If your field could pass for a UI element, widen it, soften the edges, and layer haze behind it until it reads as cosmos.
- **Move the climax.** Don't gate the climax to dead-centre on every clip. Scan `audio.energyCurve` for where the music ACTUALLY peaks and ignite there — late, early, a slow swell held to the close, an off-centre crest, a front sweeping across. The centred mid-clip glow is the template to escape, not the target.

## GLSL helper inventory

Spread these strings ahead of `void main()`; mind the dependency chain. (Signatures in README.)

| Snippet               | Provides                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `hash`                | `hash21` / `hash22` / `hash13` — base for all noise.                                     |
| `valueNoise`          | smooth bilinear `valueNoise(p) -> 0..1`. Needs `hash`.                                   |
| `simplexNoise`        | gradient noise `simplexNoise(p) -> ~-1..1`. Needs `hash`.                                |
| `fbm`                 | domain-rotated `fbm(p, octaves) -> 0..1`. Needs `valueNoise`.                            |
| `paletteRamp`         | the Retint gradient-map `paletteRamp(t) -> vec3` + `retint(src)` over `u_palette`.       |
| `polarFold`           | kaleidoscope wedge fold `polarFold(uv, segments)` — the fractal vehicle.                 |
| `sdf`                 | `sdCircle` / `sdBox` + smooth union `smin`.                                              |
| `filmGrain`           | organic emulsion grain `filmGrain(col, uv, time, intensity)`. Needs `valueNoise`+`hash`. |
| `vignette`            | radial darkening `vignette(uv, radius, softness) -> 0..1`.                               |
| `chromaticAberration` | per-channel UV offset helpers `caOffsetR` / `caOffsetB` for an edge-growing RGB split.   |

Always finish a shader with `dither8(col, uv)` to kill 8-bit banding on smooth gradients.

## palette discipline (paletteMix + the Retint Rule)

- Run `paletteMix(track.swatches)` to bend the artwork's colors toward the brand anchors; the roles are locked in code — field stays Deep Field, the warm-dark ground holds, ink stays cream, artwork hues live only in the secondary swatches. A loud cover can never repaint the night: a cold blue sleeve must never extinguish the warm dark.
- The **Retint Rule** (MOODBOARD.md): steal the reference TECHNIQUE, retint everything to canon — warm dark ground, Eclipse Gold as one accent among the scene's palette (never forced as a sun), Re-entry Red as the heat accent, Starlight Cream as ink. Cool hues survive only as minor counter-accents.
- In a shader, keep the `u_palette` / `paletteStops` on the canon ramp (Deep Field → Re-entry Red → Eclipse Gold → Starlight Cream). Admit an artwork hue only as a separate minor seep uniform, never as a ramp stop. Gold is an accent the scene may reach when its material runs hot, not a mandatory sun.
- **WHEN a warm scene's vehicle does run gold: MIX, don't ADD.** Additively blending Eclipse Gold over a warm orange/red field sums into a green/lime smear. So when the climax genuinely calls for gold on a warm ground, `mix()`/lerp the colour toward a locked gold stop (optionally darkening the bed locally under the crest first) so it reads as true gold, not lime. Reserve additive blending for gold over a dark or cool ground. (This is conditional — a cool or non-gold scene climaxes in its own colour and never reaches for gold at all; doctrine 1.)

## fractal / glass

These are good diversity lanes because they avoid the local-history loop (doctrine 3).

- **fractal:** `GLSL.polarFold(uv, segments)` folds the frame into N mirrored wedges; fly inward by scaling the folded coords with `u_time`/`arc` and tint the rings from the artwork accent. The climax is the fold center intensifying in the scene's palette — a hot core whose colour is the scene's (gold only when that core genuinely runs hot, never reached for by default).
- **glass:** refractive vertical blades sweeping across the frame — per-blade UV refraction offsets that breathe with `u_bass`, specular brightness on `u_energy`, the sweep position travelling on the arc. The climax is one specular bulge surging — its colour the scene's own (a steel/teal/blue surge for a cool scene; gold only when the blade's own highlight genuinely runs hot).

## semi-representational structure (real, but only just so)

The register to reach for when a scene risks formless haze (SKILL.md failure-modes): a sharp, structured texture that abstracts a RECOGNISABLE subject — present, but only just. Three reference treatments (MOODBOARD.md), all of which beat-sync more legibly than soft haze and so satisfy doctrine 9 the easy way:

- **Halftone dot-screen** (`halftone-tulip-bloom.png`) — quantise a soft form (a bloom, a body, the energy field) through a dot grid whose dot RADIUS rides the beat. The dots are sharp; the subject reads through them.
- **CRT / scanline raster** (`crt-scanline-roses.png`) — horizontal scanlines + an RGB cell grid over a subject; jitter/roll the lines on onsets, swell the phosphor bloom on energy. Degraded broadcast, not clean UI.
- **Contour-line displacement** (`contour-eclipse-lines.png`) — the Unknown-Pleasures motif used REPRESENTATIONALLY: a field of horizontal lines that DISPLACE around hidden forms so an eclipse/figure emerges from the warp (flat sparse lines that reveal nothing are the failure to avoid). Drive the displacement amplitude from the energy/bass curves; the climax is a single crest line intensifying in the scene's palette.

**Vary the axis and the primitive.** Those three references all happen to be horizontal-line / raster motifs — left unchecked, agents converge on "horizontal lines + a horizontal gold bar." The register is far wider; reach past lines for: a **dot / stipple screen** (halftone as DOTS, or a particle/ember field quantised to a grid, dot radius riding the beat), a **woven mesh or moiré** interference, a **cellular / voronoi crackle** (cracked glaze, a dry lakebed, cell walls breathing on the bass), **caustics / refraction** (light bent through water or glass, the hot focus swelling on energy), an **emulsion / chemical bloom**. Pick a structure whose axis and primitive differ from the recent archive (read the `videoVehicle` ledger via `fluncle recent --json`), and let the climax take the form that structure implies — a brightening cell, a caustic hot-spot, a sweeping shimmer, a single dot that blooms — in the scene's own colour, **not always a horizontal bar, not a default circular sun, and not forced to gold** (doctrine 1: one committed climax, free form and free colour).

Keep the warm dark throughout — the structure is the vehicle, not a second light source. Any gold is one accent among the scene's palette, present only when the vehicle's own material genuinely runs hot, never bolted on as a sun.

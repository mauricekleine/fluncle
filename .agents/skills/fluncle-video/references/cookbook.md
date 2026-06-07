# Technique cookbook

Technique, not style. This teaches how to draw the things Fluncle videos are made of; the *what* is yours, chosen per track. Every pattern below cites a worked example in the archive (`packages/video/src/remotion/tracks/`) — open the file and read the shader, not just the prose. The exact `GLSL.*` signatures and the `ShaderLayer` injected header live in `packages/video/README.md`; this file assumes you have read that section.

The unit of drawing is one `ShaderLayer` rendering a GLSL fragment shader. Inside a shader you get the injected uniforms (`u_time`, `u_res`, `u_progress`, `u_energy`, `u_bass`, `u_beatPulse`, `u_seed`, `u_palette[4]`) and the dither helpers (`ditherValue`, `dither8`). You spread the `GLSL.*` snippet strings ahead of `void main()` and respect their dependencies (`fbm` needs `valueNoise`; `valueNoise`/`simplexNoise`/`filmGrain` need `hash`). **At the GPU level, bake grain and Retint into the shader** (`GLSL.filmGrain`, `GLSL.paletteRamp`) — do not also wrap a shader in CSS `Grain`/`Retint`. The CSS `Grain` overlay is still the base texture for the non-shader layers over the whole frame.

## fbm haze / smoke fields

A two-layer fbm — a warp field flowing a second field — gives haze its volume so it drifts and folds like stage haze instead of scrolling. Keep time slow. Map the result low through `paletteRamp` so it barely reaches gold and never cream: the background must stay a deep warm-dark cloud so the vehicle is always the brightest thing (the One Sun). Drive the bloom width with `u_energy` / `u_drop`.

**Exemplar (Maurice's favorite): `20260607-down-with-your-love.tsx`** — the GEL-SPLIT field. Two committed light temperatures share one frame (warm heat field vs the artwork's teal as a minor cool counter-accent, the Retint Rule), with a soft breathing seam; the drop floods the field warm so the cool burns off. Read `GEL_FRAG`: warp+field fbm, the seam math, the low ramp cap, the screened-in cool wisp, then `vignette` → `filmGrain` → `dither8`.

## ridge / contour fields (the lines vehicle)

Line displacement as terrain or signal — the Unknown Pleasures motif, data-as-landscape. Stack horizontal lines and displace each by a field; drive the displacement amplitude from the energy/bass/onset curves so the terrain reacts. Lines go Starlight Cream with exactly ONE Eclipse Gold crest line — that gold crest is how the One Sun moment is expressed through a non-orb vehicle (doctrine 1).

**Exemplar: `20260607-4-seasons.tsx`** — `RidgeField`, a travelling waveform-ridge terrain rolling past. Read how the ridge amplitude rides the curves and where the single gold crest ignites.

## dither / halftone resolution fronts (the glitch vehicle)

Order resolving out of corruption: the frame departs as scattered 1-bit dither noise, a corruption front travels across it resolving cell by cell through the drop, and arrives snapped into place — a clean halftone form with a single burning gold rim. The whole texture can be ONE shader: halftone dither, the resolving front (a smoothstep edge swept by `u_progress`/`u_drop`), the SDF body, grain, and the palette ramp all baked in. The gold ignition is the resolution front completing — the One Sun moment through the vehicle.

**Exemplar: `20260607-take-a-deep-breath.tsx`** — read the single `ShaderLayer`: halftone dither + resolving front + eclipse SDF disc + gold rim, all in one fragment shader.

## SDF celestial bodies (the orb vehicle)

A rendered-grade body, not a flat disc: an SDF circle whose body is an fbm-textured material, a hot fresnel-style limb (a thin bright burning edge), a soft outer glow with physical falloff, and emulsion grain baked INTO the surface so the grain reads as the material. Keep the body capped below the cream stop so it reads as a burning grainy body, not a washed-out white ball — only the limb reaches the brightest stop, and gold lives on the rim (~10% of the frame). For an eclipse, keep it the `limb` look (body in shadow along a terminator, one edge burning) rather than a full lit ball.

**The quad law lives here (doctrine 6).** The exp glow falloff never reaches 0, so at the square layer's edge it prints a visible rectangle. Drive the glow to EXACT zero well inside the quad with a radial `edgeFade` (e.g. `1.0 - smoothstep(0.80, 0.96, r)`), and/or mask the layer to a circle in CSS. The printed-rectangle incident happened twice — do not skip this.

**Exemplars: `20260607-down-with-your-love.tsx`** (`ORB_FRAG`, the most thoroughly commented — read the limb, core bloom, glow falloff, and the `edgeFade` + CSS radial mask combination) and **`20260607-hold-that-sucker-down.tsx`** (`InlineOrb`, an ember rising into the full limb on the drop).

## beat mapping patterns

Audio reactivity comes ONLY from the curve hooks / shader audio uniforms — never decode audio at render time, never wall clock.

- **Pulse decay on the beat grid:** `useBeat(beatGrid, { decay })` → `pulse` snaps to 1 on each beat and decays before the next. `u_beatPulse` in shaders. The workhorse for rim flares and scale kicks. Higher `decay` is snappier (a neuro stomper); lower breathes (a roller).
- **Energy gates for drops:** derive the drop window from the energy curve's peak timestamps, then build a `drop` scalar (an `interpolate` ramp across `[dropIn, dropOut]`, optionally floored so the intro is never stone-cold). Gate ignition, field warmth, and exposure on it so the gold peak and the visual peak land together.
- **Onset flashes:** `useOnset(onsets, windowMs)` → a 0..1 spike per transient. Use for grain kicks, a dither threshold jolt, a chromatic-aberration shudder, a star twinkle — supporting accents, never the vehicle.
- **Slow gestures:** `useEnergy` (smoothed, broad) drives starfield drift speed, glow breadth, global float; `useBass` (tighter) drives rim swell and breathing.
- **Deriving drop timestamps:** scan `audio.energyCurve` for the peak(s) in the chosen window; those are clip-progress positions you reuse for the drop gate and the type timing.

See the `drop` / `dropRise` / `cold` scalars and the `DROP_IN`/`DROP_OUT` window in `20260607-down-with-your-love.tsx` for a complete worked beat map; `20260607-hold-that-sucker-down.tsx` shows building the scene around a quiet breakdown and two late drops.

## GLSL helper inventory

Spread these strings ahead of `void main()`; mind the dependency chain. (Signatures in README.)

| Snippet | Provides |
| --- | --- |
| `hash` | `hash21` / `hash22` / `hash13` — base for all noise. |
| `valueNoise` | smooth bilinear `valueNoise(p) -> 0..1`. Needs `hash`. |
| `simplexNoise` | gradient noise `simplexNoise(p) -> ~-1..1`. Needs `hash`. |
| `fbm` | domain-rotated `fbm(p, octaves) -> 0..1`. Needs `valueNoise`. |
| `paletteRamp` | the Retint gradient-map `paletteRamp(t) -> vec3` + `retint(src)` over `u_palette`. |
| `polarFold` | kaleidoscope wedge fold `polarFold(uv, segments)` — the fractal vehicle. |
| `sdf` | `sdCircle` / `sdBox` + smooth union `smin`. |
| `filmGrain` | organic emulsion grain `filmGrain(col, uv, time, intensity)`. Needs `valueNoise`+`hash`. |
| `vignette` | radial darkening `vignette(uv, radius, softness) -> 0..1`. |
| `chromaticAberration` | per-channel UV offset helpers `caOffsetR` / `caOffsetB` for an edge-growing RGB split. |

Always finish a shader with `dither8(col, uv)` to kill 8-bit banding on smooth gradients.

## palette discipline (paletteMix + the Retint Rule)

- Run `paletteMix(track.swatches)` to bend the artwork's colors toward the brand anchors; the roles are locked in code — field stays Deep Field, sun stays Eclipse Gold, ink stays cream, artwork hues live only in the secondary swatches. A loud cover can never repaint the night (the Loadstar incident: a cold blue sleeve once extinguished the sun — never again).
- The **Retint Rule** (MOODBOARD.md): steal the reference TECHNIQUE, retint everything to canon — warm dark ground, Eclipse Gold as the single light source, Re-entry Red as the heat accent, Starlight Cream as ink. Cool hues survive only as minor counter-accents.
- In a shader, keep the `u_palette` / `paletteStops` on the canon ramp (Deep Field → Re-entry Red → Eclipse Gold → Starlight Cream). Admit an artwork hue only as a separate minor seep uniform (see `u_cool` in `20260607-down-with-your-love.tsx`), never as a ramp stop. Gold stays the sun.

## fractal / glass

No archive exemplar yet — an opportunity for diversity (doctrine 3).

- **fractal:** `GLSL.polarFold(uv, segments)` folds the frame into N mirrored wedges; fly inward by scaling the folded coords with `u_time`/`arc` and tint the rings from the artwork accent, never gold. The One Sun moment is a gold core at the fold center.
- **glass:** refractive vertical blades sweeping across the frame — per-blade UV refraction offsets that breathe with `u_bass`, specular brightness on `u_energy`, the sweep position travelling on the arc. The One Sun moment is one gold specular bulge.

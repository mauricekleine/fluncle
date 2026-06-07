# @fluncle/video

Per-track social videos for Fluncle's Finest: 1080×1920 vertical clips that put one banger under the burning eclipse. This package is a kit, not a single template. The exemplar composition `NostalgicCosmos` shows the brand grammar in full; the primary reader of this README is a future AI agent that composes a fresh scene per track against the same kit, plus the operator who runs the pipeline.

Read [DESIGN.md](../../DESIGN.md) (the visual canon, the Nostalgic Cosmos) and [VOICE.md](../../VOICE.md) (the copy canon) before you compose. This README assumes both. Everything below is downstream of those two files.

## The brand grammar: constants vs variables

The North Star is the cover art: a figure floating up out of the tower blocks into a starfield, tethered to a Discman, under a burning eclipse. Awe and melancholy at once, warm dark, never cold, never corporate. A video is on-brand when it reads as a moment from that image set to one tune.

### Constants (every video keeps these; they are the brand)

- **Grain over everything, always.** A `<Grain />` layer sits on top of the whole frame in every composition. It is the base texture of the system; a frame without grain is off-brand. Thicken it briefly on transients, never remove it.
- **One Eclipse Gold sun moment.** Eclipse Gold (`#f5b800`) is the single light source (The One Sun Rule). Compose exactly one `<Eclipse />` as the sun, and reserve gold for its rim plus at most one type accent (the close-card wordmark). Two gold elements competing in a frame means one is wrong. Gold lives on roughly 10% of any frame, no more.
- **Oxanium for brand marks and numerals only.** The wordmark, the artist mark, and every number (the discovery date) are Oxanium (`FloatingType` `brandMark` and `meta`). Track titles and body copy read in the system sans (The One Voice Rule). Never set a paragraph in Oxanium.
- **`Artist — Title` with the em dash.** The track line is `Artist — Title` joined by an em dash, the only sanctioned em dash in the whole system. `FloatingType` `trackLine` bakes this in; do not hand-format it elsewhere.
- **Discovered dates, never released/added.** Dates are discovery dates, formatted `Discovered Jun 4`, tabular, no leading zero, in UTC (The Discovery Rule). `FloatingType` `meta` formats this from `track.discoveredAt`.
- **Warm darks only.** Every black and neutral leans toward the cream/dust hue (The Warm Dark Rule). The background is Deep Field or a warm near-black `paletteMix` result. Cool grays and blue-tinted darks are banned.
- **The close card.** The last beats are a close card: the tagline `Drum & bass bangers from another dimension` in cream, plus the selector signature in the one permitted gold type moment. Every video ends here.
- **Determinism.** Frame- and seed-derived values only (see Determinism rules below).

### Variables (the agent owns these; this is where each track gets its own video)

- **Palette blend.** Run `paletteMix(track.swatches)` to bend the artwork's own colors toward the brand anchors. The background stays a warm near-black, gold stays reserved for the sun, but the accent and kaleido chroma come from the artwork, so a cool track and a warm track look like different nights under the same sun.
- **The One Vehicle Rule.** Every video is a journey, and exactly one travelling medium carries it: an orb riding the beat (the sun/Eclipse), lines (waveform ridges, contour displacement), a fractal (mirror/kaleido recursion), glass (refractive panels and ribs), or a glitch (dither/pixel corruption travelling across the frame). The vehicle transforms continuously across the clip — approaching, passing through, arriving — while every other layer supports it and stays subordinate. Two competing vehicles in one video means one of them is wrong, the same way two gold elements mean one is wrong.
- **Texture family.** Pick the texture pole that fits the tune: nebula (soft `Starfield` + gradient washes), analog (heavy `Grain`, exposure flares on onsets), dither (the `DitherField` glitch pole, the squared Discman side), paint (layered translucent chroma through `KaleidoMirror`), fluent (flowing liquid gradients; motion lives in the surface), or duotone (strict two-color gel-split lighting). One family should lead; do not run them all at once. The annotated references per family live in `moodboard/MOODBOARD.md`, which also carries the Retint Rule: steal the reference techniques, recolor everything to the canon palette.
- **Motion energy.** How hard the scene reacts to the audio. Feed `useBass`, `useBeat`, `useEnergy`, `useOnset` into intensity (rim swell, window glow, scale kicks, drift speed, grain kicks). A liquid roller breathes; a heavy neuro track snaps. Same primitives, different gain.
- **Scene composition.** The order, timing, and staging of the scene beats: where the eclipse sits and how it rises, when the type enters, whether there is a kaleido passage and how long. `NostalgicCosmos` is one arrangement, not the only one. Keep the constants; rearrange the rest.
- **The tower skyline is a motif, not a constant.** `<TowerBlocks />` renders the founding image's city, the earthbound pole the figure floats out of; it is powerful when the concept calls for that gravity, absent otherwise. It is one optional motif among many (architecture is not the only earthbound anchor), so most videos should NOT include it by default; reach for it only when the tune wants the pull of the ground, not because it is the founding image.

## Primitives catalog

Single import surface: `src/remotion/cosmos.ts` re-exports everything (primitives, hooks, fonts, color, palette, types). Import from there. All primitives are deterministic (frame- and seed-derived only) and CPU-friendly for headless rendering: no canvas, no WebGL, just SVG filters, CSS backgrounds, and transforms.

### `<Grain />`

Animated film grain via SVG `feTurbulence`, covers the parent absolutely.

| Prop        | Type                            | Default     | Notes                                                                                     |
| ----------- | ------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `opacity`   | `number`                        | `0.12`      | Overall grain layer opacity.                                                              |
| `intensity` | `number`                        | `0.9`       | `feTurbulence` base frequency; higher is finer/denser grain.                              |
| `seed`      | `number`                        | `1`         | Per-frame turbulence seed derives from this via `random()`.                               |
| `framePool` | `number`                        | `12`        | Distinct seeds cycled per frame; reads as film-grain motion, keeps the filter cache warm. |
| `blendMode` | `CSSProperties["mixBlendMode"]` | `"overlay"` | Blend over the parent.                                                                    |

### `<Starfield />`

Seeded warm-white stars on transparent, with parallax drift. The founding image's starfield.

| Prop      | Type                       | Default                  | Notes                                                                 |
| --------- | -------------------------- | ------------------------ | --------------------------------------------------------------------- |
| `density` | `number`                   | `140`                    | Star count.                                                           |
| `depth`   | `number`                   | `3`                      | Parallax layers; nearer layers are bigger, brighter, faster.          |
| `seed`    | `number`                   | `1`                      | Stable star positions.                                                |
| `drift`   | `{ x: number; y: number }` | `{ x: 0.004, y: -0.01 }` | Screen-fractions per second; the cosmos breathes, it does not scroll. |
| `color`   | `string`                   | `starlightCream`         | Warm white.                                                           |
| `maxSize` | `number`                   | `2.6`                    | Max star radius (px) for the nearest layer.                           |
| `twinkle` | `number`                   | `0.35`                   | Twinkle amount, 0 disables.                                           |

### `<Eclipse />`

The signature grainy gradient orb, the One Sun. Compose exactly one per piece.

| Prop           | Type                     | Default       | Notes                                                                            |
| -------------- | ------------------------ | ------------- | -------------------------------------------------------------------------------- |
| `size`         | `number`                 | `520`         | Diameter in px.                                                                  |
| `palette`      | `Partial<CosmosPalette>` | brand palette | Orb body uses accent/glow; rim is the bright limb.                               |
| `rimIntensity` | `number`                 | `0.85`        | Brightness of the burning rim. Feed from `useBass`/`useBeat` for a swelling sun. |
| `grainAmount`  | `number`                 | `0.1`         | Grain opacity baked over the orb.                                                |
| `seed`         | `number`                 | `7`           | Seed for the orb's grain.                                                        |
| `variant`      | `"limb" \| "sun"`        | `"limb"`      | `limb` is a lit planet crescent; `sun` is the full burning hero disc.            |

### `<TowerBlocks />`

Procedural dark apartment-block silhouettes along the bottom with seeded lit windows: the towers the figure floats out of.

| Prop               | Type                     | Default       | Notes                                                                      |
| ------------------ | ------------------------ | ------------- | -------------------------------------------------------------------------- |
| `palette`          | `Partial<CosmosPalette>` | brand palette | Silhouettes from background, lit windows from glow/accent.                 |
| `seed`             | `number`                 | `1`           | Block layout and lit-window pattern.                                       |
| `litWindowDensity` | `number`                 | `0.22`        | Fraction of windows lit.                                                   |
| `maxHeight`        | `number`                 | `0.42`        | Tallest block as a fraction of container height.                           |
| `count`            | `number`                 | `11`          | Blocks across.                                                             |
| `windowGlow`       | `number`                 | `1`           | Brightness multiplier; feed from `useBass`/`useEnergy` so the city pulses. |

### `<DitherField />`

Bitmap/matrix texture for the glitch/Discman pole. `halftone` and `checker` are tiled CSS backgrounds; `pixel` is a seeded SVG `<pattern>` tile. All cheap headless.

| Prop        | Type                                 | Default          | Notes                                                                   |
| ----------- | ------------------------------------ | ---------------- | ----------------------------------------------------------------------- |
| `pattern`   | `"halftone" \| "checker" \| "pixel"` | `"halftone"`     | Which matrix texture.                                                   |
| `scale`     | `number`                             | `16`             | Cell size in px.                                                        |
| `color`     | `string`                             | `starlightCream` | Texture color.                                                          |
| `threshold` | `number`                             | `0.5`            | halftone = dot radius, checker = fill bias, pixel = on-probability cut. |
| `opacity`   | `number`                             | `1`              | Layer opacity.                                                          |
| `seed`      | `number`                             | `1`              | For the `pixel` grid.                                                   |
| `blendMode` | `CSSProperties["mixBlendMode"]`      | `"normal"`       | Blend over the parent.                                                  |

### `<FloatingType />`

Typography for the four sanctioned roles, with a gentle frame-derived float. `variant` is required.

| Prop             | Type                                                        | Default     | Notes                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `variant`        | `"brandMark" \| "trackLine" \| "meta" \| "body"`            | required    | `brandMark` = Oxanium 800 wordmark/mark; `trackLine` = `Artist — Title` in system sans; `meta` = `Discovered Jun 4` in Oxanium tabular; `body` = system sans free text. |
| `drift`          | `number`                                                    | `6`         | Float amplitude in px; 0 disables.                                                                                                                                      |
| `driftPeriodSec` | `number`                                                    | `5`         | Float period in seconds.                                                                                                                                                |
| `driftPhase`     | `number`                                                    | `0`         | Phase offset so stacked lines do not bob in lockstep.                                                                                                                   |
| `color`          | `string`                                                    | per variant | Ink override.                                                                                                                                                           |
| `fontSize`       | `number`                                                    | per variant | Size override in px.                                                                                                                                                    |
| `align`          | `CSSProperties["textAlign"]`                                | `"left"`    | Text align.                                                                                                                                                             |
| `mark`           | `string`                                                    | `"Fluncle"` | `brandMark` text.                                                                                                                                                       |
| `track`          | `Pick<CosmosTrack, "title" \| "artists" \| "discoveredAt">` | —           | Source for `trackLine` and `meta`.                                                                                                                                      |
| `text`           | `string`                                                    | —           | `body` free text (sentence case, no exclamation marks per VOICE.md).                                                                                                    |

This component bakes in the em dash, the discovery-date format, and the One Voice font split. It only formats what it is given; it never adds punctuation.

### `<KaleidoMirror />`

CSS-transform kaleidoscope: N rotated-and-mirrored copies of children inside a clipped circular container. No canvas, no WebGL (Remotion's experimental `<HtmlInCanvas>` is deliberately not used here; see the source for the rationale). Animate it by animating its children or `rotation`. Draw kaleido chroma from the artwork palette, never gold; gold stays the sun.

| Prop          | Type              | Default  | Notes                                                                        |
| ------------- | ----------------- | -------- | ---------------------------------------------------------------------------- |
| `segments`    | `number`          | `6`      | Mirrored wedges; even values mirror cleanly, 6 or 8 read as classic.         |
| `size`        | `number`          | `1080`   | Diameter in px.                                                              |
| `rotation`    | `number`          | `0`      | Static rotation of the whole assembly in degrees.                            |
| `sourceScale` | `number`          | `1.4`    | Scale of children inside each wedge, pushes interest toward the center seam. |
| `children`    | `React.ReactNode` | required | The source content mirrored into every wedge.                                |

## Hooks

Audio-reactive, pure, deterministic: each computes from `useCurrentFrame()`/`fps` and the props arrays only, safe for headless renders. Feed them the composition's `audio.*` arrays.

- **`useBeat(beatGrid, { decay? })`** → `{ beatIndex, beatProgress, pulse }`. Turns the ms beat grid into a beat-synced pulse: `pulse` snaps to 1 on each beat and decays exponentially before the next (`decay` default `3.2`, higher is snappier). The workhorse for rim flares and scale kicks; `beatIndex`/`beatProgress` let you stage on the bar.
- **`useOnset(onsets, windowMs = 180)`** → `number`. A 0..1 flash that spikes to 1 at each onset and decays linearly over `windowMs`; overlapping onsets take the max. Use for transient sparkle: grain kicks, a `DitherField` threshold jolt, a star twinkle on a snare.
- **`useEnergy(curve, { startMs?, smoothingFrames? })`** → `number`. Smoothed 0..1 overall energy (default smoothing 6 frames). Drives the big slow gestures: starfield drift speed, eclipse glow breadth, global float amplitude.
- **`useBass(curve, { startMs?, smoothingFrames? })`** → `number`. Smoothed 0..1 low-end energy (default smoothing 3 frames, tighter than `useEnergy`). Drives the eclipse rim swell, tower-window brightness, the kaleidoscope breathing.
- **`sampleCurve` / `smoothCurveAtFrame`** are the lower-level samplers behind the curve hooks if you need raw access.

## Journey components

The journey set (`src/remotion/journey/`, re-exported from `cosmos.ts` like the primitives) is the layer above the primitives: it encodes the One Vehicle Rule directly. Every video is a journey, and exactly one of these vehicles carries it across the clip. They share one narrative clock so an orb and a line field staged together travel on the identical arc.

### The narrative clock: `useJourney(options?)`

The shared timeline every vehicle reads. Returns `{ progress, phase, phaseProgress, arc }`: `progress` is linear 0..1 (raw timing); `phase` is `"depart" | "travel" | "arrive"` with a local `phaseProgress` 0..1; `arc` is the eased (smoothstep slow-in/slow-out) 0..1 that vehicles travel along for spatial motion. Options: `split` (the `[departEnd, travelEnd]` phase splits, default `[0.15, 0.85]`) and `ease` (smoothstep iterations, default `1`). Pure and frame-derived; pass the same options to two vehicles to lock them to one arc. The cover-art astronaut lifting out of the towers is the canonical depart; the close card is the arrive.

### The five vehicles (One Vehicle Rule — compose exactly one)

The mapping mirrors the rule in DESIGN.md / MOODBOARD.md: an orb (the sun), lines (waveform ridges / contours), a fractal (mirror/kaleido recursion), glass (refractive panels), or a glitch (dither corruption travelling across the frame). Each is semi-headless: it owns geometry, motion, and brand law, and exposes creativity through a `children` content slot and/or a function slot (`path`/`displacement`/`density`) that receives the eased `arc`. All feed `useJourney` internally and accept a `journey` options pass-through.

- **`<JourneyOrb>`** — the orb/Eclipse sun riding the arc. `path` (an `OrbPath` `{from,to,scaleFrom?,scaleTo?}` or `(arc) => {x,y,scale}`; default rises from `0.5,0.66` to `0.5,0.4`), `size` (520), `variant` (`"limb" | "sun"`, default `"sun"`), `rimColor`/`rimIntensity` (Eclipse Gold, 0.85), `beatPulse`/`beatGrid` and `bassBreath`/`bassCurve` for audio swell, `palette`, and a `children` surface slot (defaults to `Eclipse`).
- **`<JourneyLines>`** — a travelling line field (waveform ridge / contour / blinds). `mode` (`"ridge" | "contour" | "blinds"`, default `"ridge"`), `displacement` (preset `"energy" | "bass" | "onset"` or `(x, arc) => number`), `audio` (energy/bass/onset curves), `lineCount` (48), `amplitude` (0.55), `travel` (cycles over arc), `accentIndex`/`accentColor` (one gold line), `color` (Starlight Cream), `focal` (contour only).
- **`<JourneyFractal>`** — a kaleido tunnel that flies inward. `segments` (6), `rings` (4), `zoomPerSec` (1.16, the travel), `spinPerSec` (4), `ringScale` (0.62), `foldOnBeat`/`foldDegrees`/`beatGrid`/`beatDecay` for per-beat folds, `palette` (ring tints from accent/glow, never gold), `opacity`, and a `children` wedge-source slot mirrored into every segment.
- **`<JourneyGlass>`** — a refractive blade curtain sweeping across the frame. `bladeCount` (9), `sweep` (`"left" | "right"`) and `sweepPerSec` (0.06, the travel), `refraction` (0.6), `breathe`/`bassCurve` for per-blade bass breathing, `energyCurve` for specular brightness.
- **`<JourneyGlitch>`** — dither corruption travelling over content. `mode` (`"sweep"` front, `"bloom"` radial, `"channel-split"` RGB tear, default `"sweep"`), `sweepAngle`, `travelPerSec` (0.07), `focal` (bloom), `feather` (0.22), `density` (preset `"energy" | "onset"` or `(frame, fps) => number`), `cellSize`/`ditherPattern` (DitherField pass-through), `splitStrength` (onset-kicked RGB split), `onsets`/`energyCurve`, `palette` (split channels default to the warm Gold/Re-entry-Red retint of RGB), and a `children` slot — the glitch travels over THIS.

### The brand-law trio

Three supporting pieces that enforce brand law regardless of the vehicle:

- **`<Retint>`** — the Retint Rule in code: recolor any borrowed/sampled content to the canon palette. `mode` (`"duotone" | "gradient-map" | "tint"`, default `"gradient-map"`), `stops` (override the canon ramp), `strength` (0..1 mix over the original), `tintBlend` (tint mode only). Implemented as a deterministic SVG `feColorMatrix` luminance collapse → `feComponentTransfer` table gradient-map with `color-interpolation-filters="sRGB"`; filter IDs come from `useId()` so multiple instances never cross-wire.
- **`<Plate>`** — a first-party moodboard plate as a drifting background image (sources copied to `public/plates/`). `src` (a `staticFile` path), `fit` (`"cover"`), `drift` (`PlateDrift` or `"slow-drift" | "none"`), `grainBoost` (0.12, grain baked onto the plate), `seed`, `opacity`, `blendMode`. Pair with `<Retint>` to bend a plate to the track's palette.
- **`<CloseCard>`** — the mandatory close card (tagline in cream + selector signature in the one permitted gold type moment). Drive it with the `"arrive"` phase: pass that phase's `phaseProgress` (a clean 0..1) as `arc`/`progress` and the card reveals exactly as the journey arrives. Props: `palette` (`{ink,accent}`), `floatBoost`, `taglineSize` (30), `signatureSize` (46), `align`.

### The GPU shader workhorse: `<ShaderLayer>` + the `GLSL` snippet library

The journey set also ships a GPU layer. `<ShaderLayer>` renders a fullscreen-triangle fragment shader into a canvas via raw WebGL, compiling/linking once per shader string and pushing uniforms + drawing synchronously every frame (the working pattern reference is `src/remotion/visual-test/gl-probe.tsx`). The upgraded GPU vehicles (`JourneyOrb` surface mode, `JourneyGlass`, `JourneyFractal`) and `<TowerBlocks />` are built on it. Determinism holds: `u_time = frame / fps`, `u_progress` from the clip, and every audio uniform comes from the curve hooks (`useBeat`/`useEnergy`/`useBass`), never wall clock or `Math.random`.

**This is the preferred grain and Retint implementation at the GPU level.** A shader does its own grain via `GLSL.filmGrain` (organic emulsion clumping, luminance-shaped) and its own Retint via `GLSL.paletteRamp` / the injected `u_palette[4]` ramp (luminance → the four canon stops). Inside a shader, do NOT stack a CSS `<Grain />` or wrap in `<Retint>`; bake both into the fragment shader instead. The CSS `<Grain />` over the whole frame is still the system base texture for non-shader layers.

**GPU rendering requires ANGLE/Metal.** Stills and renders must pass `--gl=angle` (e.g. `bunx remotion still … --gl=angle`); the pipeline sets it as default (`remotion.config.ts` `Config.setChromiumOpenGlRenderer("angle")` + `chromiumOptions: { gl: "angle" }` in `render.ts`). Verified locally on Apple Silicon ("ANGLE Metal Renderer: Apple M5 Pro").

`<ShaderLayer>` injects a standard header ahead of every `fragmentShader` body, so a shader can rely on these uniforms and helpers without declaring them:

```glsl
precision highp float;
uniform float u_time;      // seconds since clip start (frame / fps)
uniform vec2  u_res;       // canvas resolution in px
uniform float u_progress;  // 0..1 clip progress
uniform float u_energy;    // 0..1 smoothed overall energy
uniform float u_bass;      // 0..1 smoothed low-end energy
uniform float u_beatPulse; // 0..1, snaps to 1 on each beat, decays before the next
uniform float u_seed;      // per-track seed
uniform vec3  u_palette[4];// Retint ramp stops, dark -> light
float ditherValue(vec2 fragCoord); // ordered ~1/255 dither
vec3  dither8(vec3 col, vec2 uv);  // call on final color to kill 8-bit banding
```

Props: `fragmentShader` (the GLSL body), `palette` / `paletteStops` (the four `u_palette` stops; default canon ramp Deep Field → Re-entry Red → Eclipse Gold → Starlight Cream), `progress`, `seed`, `beatGrid` / `beatDecay` (→ `u_beatPulse`), `energyCurve` (→ `u_energy`), `bassCurve` (→ `u_bass`), `uniforms` (custom float / vec2 / vec3 keyed by name, set per frame — declare matching `uniform`s in your shader), `opacity`, `blendMode`. On missing WebGL / compile / link failure it renders a full-screen error overlay with the GLSL info log; a `webglcontextlost` handler re-inits.

The `GLSL` snippet library (`src/remotion/journey/glsl.ts`) is a set of composable GLSL function strings you spread into a fragment shader ahead of `void main()`. Mind dependencies: `valueNoise`/`simplexNoise` need `hash`; `fbm` needs `valueNoise`; `filmGrain` needs `valueNoise` + `hash`.

| Snippet               | Provides                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `hash`                | Deterministic value hashes `hash21`, `hash22`, `hash13` (base for all noise).                          |
| `valueNoise`          | Smooth bilinear value noise `valueNoise(p) -> 0..1`. Needs `hash`.                                     |
| `simplexNoise`        | Gradient (simplex-style) noise `simplexNoise(p) -> ~-1..1`. Needs `hash`.                              |
| `fbm`                 | Domain-rotated fractal brownian motion `fbm(p, octaves) -> 0..1`. Needs `valueNoise`.                  |
| `paletteRamp`         | The Retint gradient-map `paletteRamp(t) -> vec3` + `retint(src)` over `u_palette`.                     |
| `polarFold`           | Kaleidoscope wedge fold `polarFold(uv, segments) -> vec2` around center.                               |
| `sdf`                 | Signed-distance primitives `sdCircle`/`sdBox` + smooth union `smin`.                                   |
| `filmGrain`           | Organic emulsion-clumping film grain `filmGrain(col, uv, time, intensity)`. Needs `valueNoise`+`hash`. |
| `vignette`            | Radial darkening multiplier `vignette(uv, radius, softness) -> 0..1`.                                  |
| `chromaticAberration` | Per-channel UV offset helpers `caOffsetR`/`caOffsetB` for an edge-growing RGB split.                   |

```ts
import { GLSL, ShaderLayer } from "./journey"; // or from "./cosmos"
const frag = `
  ${GLSL.hash} ${GLSL.valueNoise} ${GLSL.fbm} ${GLSL.paletteRamp} ${GLSL.filmGrain} ${GLSL.vignette}
  void main() {
    vec2 uv = gl_FragCoord.xy / u_res;
    float n = fbm(uv * 3.0 + u_time * 0.1, 5);
    vec3 col = paletteRamp(n);            // Retint at the GPU level
    col = filmGrain(col, uv, u_time, 0.08); // grain at the GPU level
    col *= vignette(uv, 0.6, 0.45);
    gl_FragColor = vec4(dither8(col, uv), 1.0);
  }`;
```

### Visual-test scratch space

`src/remotion/visual-test/` holds scratch compositions for visually testing each vehicle in isolation: `VisualTestOrb`, `VisualTestLines`, `VisualTestFractal`, `VisualTestGlass`, `VisualTestGlitch`, all registered in `root.tsx` with the same `calculateMetadata`/duration wiring and `NostalgicCosmosProps` contract as the exemplar. They ship as black-frame placeholders so one agent can own exactly one file without touching `root.tsx`; build a real vehicle scene there, scrub it in `bun run studio`, and graduate it into a proper composition once it reads on-brand.

## inputProps contract

Every producer (the pipeline, Studio default props, the agent) must satisfy `NostalgicCosmosProps` from `src/remotion/types.ts`. Any new composition should accept the same shape so one pipeline feeds all scenes.

```ts
type NostalgicCosmosProps = {
  track: CosmosTrack;
  audio: CosmosAudio;
  palette: CosmosPalette;
  seed: number;
};

type CosmosTrack = {
  trackId: string;
  title: string;
  artists: string[];
  album?: string;
  artworkUrl?: string;
  discoveredAt: string; // ISO timestamp; rendered in UTC as "Discovered Jun 4"
  note?: string;
};

type CosmosAudio = {
  file: string; // filename inside public/ for staticFile()
  startMs: number;
  durationMs: number; // 15000–30000; drives durationInFrames
  bpm: number;
  beatGrid: number[]; // ms offsets relative to clip start
  onsets: number[]; // ms offsets relative to clip start
  energyCurve: EnergySample[]; // { timeMs, energy: 0..1 }
  bassCurve: EnergySample[];
};

type CosmosPalette = {
  background: string;
  ink: string;
  accent: string;
  glow: string;
  swatches: string[]; // artwork-derived hexes
};
```

`durationInFrames` is derived from `audio.durationMs` in `Root.tsx` via `calculateMetadata`, so the video always matches the clip length. The pipeline writes the real props to `out/<trackId>.props.json`; the Studio defaults in `Root.tsx` open the exemplar with matching audio.

## Authoring a new composition

The agent's job is a fresh scene per track, alongside `NostalgicCosmos`, not editing the exemplar in place. Study `src/remotion/NostalgicCosmos.tsx` first; every gesture there is intentional and on-brand.

1. Create `src/remotion/<YourScene>.tsx` exporting a `React.FC<NostalgicCosmosProps>` (reuse the contract so the pipeline feeds it unchanged). Build only from primitives and hooks imported from `./cosmos`.
2. Keep all the constants: one `<Eclipse />`, `<Grain />` over everything, the `Artist — Title` line, the `Discovered` date, warm darks, the close card. Vary the palette blend, texture family, motion energy, and scene composition.
3. Keep type inside the safe inset (the exemplar uses `MARGIN_X` 96, `SAFE_TOP` 150, `SAFE_BOTTOM` 230) so nothing crowds the 1080×1920 edges or gets cropped by platform chrome.
4. Register it in `src/remotion/Root.tsx` as another `<Composition>` with its own `id`, the same `fps`/`width`/`height` (30 / 1080 / 1920), `defaultProps`, and the shared `calculateMetadata`. Give it sensible default props so it opens in Studio.
5. To render your composition instead of the exemplar, point `COMPOSITION_ID` in `src/pipeline/render.ts` (or branch on a flag) at your `id`. The pipeline is otherwise unchanged.

## Pipeline commands

Run from `packages/video` (or with `bun run --cwd packages/video <script>`). Use `bun`, never `npm`/`pnpm`/`yarn`.

- **`bun run social:preview <trackId>`** — the full local pipeline: fetch track → resolve a preview clip → download + normalize → analyze audio (bpm, beat grid, onsets, energy/bass curves) → extract artwork palette → assemble inputProps → write `out/<trackId>.props.json` → bundle + render `out/<trackId>.mp4`.
- **`bun run social:preview <trackId> --skip-render`** — stop after writing the props JSON. Fast loop for checking analysis, palette, and the assembled contract before paying for a render.
- **`bun run studio`** — open Remotion Studio to preview and scrub the composition live with the default props. The fastest way to iterate on a scene visually.
- **`bun run typecheck`** — `tsc --noEmit`; the quality check for any change in this package.

Outputs land in `packages/video/out/`. Rendering is local-only; publishing the resulting clips to any platform is out of scope for this package.

## Determinism rules (non-negotiable)

Remotion renders the same frame many times across processes; a frame must be a pure function of its inputs.

- Never use JS built-in randomness (`Math.random()`) or wall-clock time (`Date.now()`, `new Date()` for "now") inside a composition. Use Remotion's `random(seed)` helper and frame-derived values (`useCurrentFrame()`, `fps`) only.
- Derive every seeded layer from the `seed` prop (and stable sub-seeds like `seed % 97`) so the same track always renders the same stars, towers, and grain.
- Format dates from `track.discoveredAt` in UTC (`FloatingType` `meta` already does this) so the render never depends on the host timezone.
- Audio reactivity comes only from the `audio.*` arrays through the hooks, never from decoding audio at render time.
- Fonts load once at module scope (`fonts.ts`), not inside a composition, so loading is a side effect outside the frame function.

Stay inside this kit and the constants above and any new composition will read as the same uncle's records, one tune at a time.

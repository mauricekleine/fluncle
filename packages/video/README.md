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
- **Texture family.** Pick the texture pole that fits the tune: nebula (soft `Starfield` + gradient washes), analog (heavy `Grain`, exposure flares on onsets), dither (the `DitherField` glitch pole, the squared Discman side), paint (layered translucent chroma through `KaleidoMirror`), fluent (flowing liquid gradients; motion lives in the surface), or duotone (strict two-color gel-split lighting). One family should lead; do not run them all at once. The annotated references per family live in `moodboard/MOODBOARD.md`, which also carries the Retint Rule: steal the reference techniques, recolor everything to the canon palette.
- **Motion energy.** How hard the scene reacts to the audio. Feed `useBass`, `useBeat`, `useEnergy`, `useOnset` into intensity (rim swell, window glow, scale kicks, drift speed, grain kicks). A liquid roller breathes; a heavy neuro track snaps. Same primitives, different gain.
- **Scene composition.** The order, timing, and staging of the scene beats: where the eclipse sits and how it rises, when the type enters, whether there is a kaleido passage and how long. `NostalgicCosmos` is one arrangement, not the only one. Keep the constants; rearrange the rest.

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

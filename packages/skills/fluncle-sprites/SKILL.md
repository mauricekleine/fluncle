---
name: fluncle-sprites
description: Generate Fluncle's pixel sprites as ONE consistent family — the per-surface icons (one per @fluncle/registry surface) and game props that share a single grid, palette, perspective, and light. Use when creating, regenerating, or auditing any pixel sprite (the /sprites Sprite System, the Earth overworld props, the Galaxy game sprites, or a registry surface icon). The constitution — the fixed rails plus the AI generate→post-process pipeline that keeps every sprite on-spec.
---

# Fluncle Sprites — the Sprite System

The single doctrine for every pixel sprite in the Galaxy: the **per-surface icons** (one per `@fluncle/registry` surface, surfaced on [`/sprites`](../../../apps/web/src/routes/sprites.tsx) and `/status`), the **Earth overworld** props, and the **Galaxy** game sprites. They are not separate art — they are **one family**, and this skill is what keeps them one family.

**The core truth (write it on the wall):** cohesion is a _set_ property, not a per-sprite one. It comes from a small list of **fixed rails applied identically to every sprite** — one grid, one palette, one perspective, one light — _not_ from polishing each sprite alone. And **no prompt alone produces a true sprite**: every AI render is a high-res _mock_ that MUST pass through a deterministic grid-snap + palette-quantize post-step. AI gets you ~70%; the deterministic last 30% is non-negotiable.

The **north star** is the `web.newsletter` mailbox: recognizable in half a second, a light cream body that POPS off the dark plate, a single red-flag brand accent, clean chunky pixels. Every sprite matches its density, contrast, palette discipline, and clarity.

## The fixed rails (constants — never vary these; restate ALL of them in every prompt)

| Rail             | Value                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Canvas**       | 256×256 px PNG, transparent                                                                                                                                                                              |
| **Logical grid** | **32×32** (8 px blocks). Divides 256 cleanly. 64 is the finer-only alt when a subject genuinely needs it; 48 scales dirty — banned.                                                                      |
| **Perspective**  | **Flat front-view** ("object portrait"), locked set-wide. Never mix angles. (Flat reads best small AND models default to an inconsistent 3/4 we'd otherwise fight — so we forbid it.)                    |
| **Light**        | **ONE key light, upper-left**, set-wide. No second light. No pillow-shading (concentric value rings with no light logic).                                                                                |
| **Footprint**    | Subject fills **~80% of a fixed live area**, **optically** centered (not geometrically), constant ~10% margin. A round subject must _overshoot_ a square one to read as equal weight (keyline thinking). |
| **Outline**      | **One solid dark contour** = the sprite's OWN darkest shade (a warm near-black), not pure-black inlines. Applied identically across the set.                                                             |
| **Shading**      | Hard pixel edges. **No anti-aliasing, no gradients, no dithering, no drop shadows, no scene/ground.** One object only.                                                                                   |
| **Colors**       | ≤ ~6 per sprite (up to ~8 if a second material genuinely needs its own ramp), all from the shared Sprite Palette → [references/palette.md](references/palette.md).                                       |

## The color system (the make-or-break)

Pixel sprites blend into our dark plates when their biggest surface uses a dark surface _token_. The fix, stated precisely:

- **Pop is VALUE contrast, not hue.** The dominant mass must sit at a distinctly **higher lightness** than the dark plate it lands on. Two hues at the same value still blur together — so it is _lightness_ that carries the form. Default the dominant body to the **cream ramp**.
- **Brand colors ride as ACCENTS, never the body.** Eclipse Gold + Re-entry Red appear at only **~10–20% of the area**, reserved for highlights/accents (the One Sun Rule still governs gold). A loud saturated accent must be balanced by a larger quiet area.
- **Ramps share endpoints.** Every material ramp (base + shadow + highlight) branches from the **one shared darkest** and converges on the **one shared lightest** — that shared start/end is what makes separate sprites a family _by construction_.
- **Shade by hue-shift AND saturation-shift**, never a straight value-only ramp: cooler + desaturated in shadow, warmer + more saturated in the mids, desaturated in the highlight. Keep saturation off both 0% and 100%; peak it in the mids.

Full ramps + hex in [references/palette.md](references/palette.md). It descends from `DESIGN.md`'s Nostalgic Cosmos and matches the canon ramp already in `apps/web/src/game/palette.ts` and `docs/galaxy-sprites.md`.

## The form rules (clarity first)

1. **Silhouette-first.** A sprite must be recognizable as a **solid black shape** (squint/blur test) BEFORE any color or detail. If color is what makes it legible, the form is broken — redraw the silhouette.
2. **Recognizable in half a second at 32 px.** Pick the 2–3 function-defining features; abstract everything else away. When a detail won't fit the grid, collapse it to a single pixel rather than cram. ~2–3 main colors should carry the recognition. (`web.home`/monolith fails this; the mailbox passes.)
3. **Every pixel earns its place.** Ban orphan/stray single pixels (pure noise at this scale); separate touching forms by contrast or a 1 px gap (merged shapes destroy the read).

## The AI generation pipeline (the deterministic spine)

Treat the AI render as a MOCK. The clean sprite comes from the post-process. Scripted at [scripts/generate_sprite.py](scripts/generate_sprite.py) (extends `packages/media/scripts/generate-earth-sprites.py`).

1. **Constants header, once.** Author the rails (above) as a shared block and re-state ALL of them in EVERY prompt — constraints do NOT carry between generations; un-repeated ones silently drift.
2. **Prompt** = `8-bit / NES-era pixel-art [subject]` + `flat front view, single object, no scene/ground` + the **exact palette hex** + `top-left light` + emphatic CAPS bans: `CRITICAL: no gradients, no noise, no dithering, no shadows, NO anti-aliasing`. Hex, never color _names_. State the flat-front view explicitly (models default to 3/4).
3. **Generate at ~1024 px** on a **solid key background (`#00FF00`) with a 2–3 px white buffer outline** around the subject — image models can't emit true alpha, and AA bakes the key color into edges _unless_ the white buffer absorbs it. One sprite per generation; small batches; chat/reference-locked to the established family.
4. **PILOT ONE sprite fully through every step below and eyeball it BEFORE fanning out the set.** (Our video batch-diversity lesson, inverted: here we want sameness.)
5. **Chroma-key** the background out in **HSV** (hue ≈ 120° ±, sat/val thresholds), keeping alpha separate — not RGB keying.
6. **Detect the logical grid** from the 1024 render (1024 is an integer multiple of 32/64), overlay-verify the grid alignment, and snap pixels to it.
7. **Downscale to true 32×32 by per-CELL aggregation** (majority/dominant color per grid block, or a >X%-threshold-else-average hybrid) — **never single-point sampling** (it carries edge-AA noise through).
8. **Quantize to the fixed Sprite Palette** (median-cut → nearest-palette map by numpy distance), alpha preserved separately. Enforce the ≤6–8 color cap.
9. **Run the gate** (below). Finish any irreducible stray-pixel / contrast cleanup by hand in Aseprite.
10. **Export** 256×256 PNG with transparency. Only ever upscale for display with **nearest-neighbor** (`image-rendering: pixelated`) — never bilinear/bicubic, which re-mushes the hard edges.

## The gate (a sprite is NOT done until all pass)

- **Silhouette read** — recognizable as a black shape at small size.
- **Value-contrast** — the dominant mass clearly lighter than the dark plate; doesn't blur into it.
- **Palette** — only Sprite-Palette colors; ≤6–8; brand accents ≤~20% area.
- **One light, upper-left**; no pillow-shading.
- **Footprint** — ~80% of the live area, optically centered, equal margin with its set-mates.
- **No orphan pixels, no merged forms.**
- **On-grid** — true 32×32, hard edges, no AA/gradient.
- **Taste-gate in [`/sprites`](../../../apps/web/src/routes/sprites.tsx)** — view the new sprite alongside the family in a real browser; does it belong?

## Workflow

1. **Lock the constants** (they're fixed — confirm the grid/palette/perspective/light here).
2. **Pilot one** sprite (ideally re-deriving the mailbox as the calibration reference) end-to-end through the pipeline; pass the gate; view it in `/sprites`.
3. **Fan out** the set in small batches, restating ALL constants every prompt, each new sprite chat/reference-locked to the established family.
4. **Quantize + gate every output**; never ship an un-post-processed render.
5. **Drop the PNG** at its path (`apps/web/public/earth/<id>.png` for surface/prop sprites, `apps/web/public/galaxy/<id>.png` for game sprites) and view the family in `/sprites` before calling it done.

## Coverage policy

**Every `@fluncle/registry` surface gets a sprite** (we may need any of them later — completeness over minimalism). The sprite is a **canonical surface property**: the intended end state is a `sprite` field on the registry `Surface` type, so the game, `/sprites`, `/status`, and the homepage dev-row all read ONE source of truth. Until that lands, the assignment map lives on the `/sprites` page.

## Pointers

- [references/palette.md](references/palette.md) — the concrete Sprite Palette (ramps + hex + the color rules).
- [scripts/generate_sprite.py](scripts/generate_sprite.py) — the generate → key → snap → quantize pipeline.
- [`apps/web/src/routes/sprites.tsx`](../../../apps/web/src/routes/sprites.tsx) — the Sprite System inventory + the taste-gate surface.
- [`docs/galaxy-sprites.md`](../../../docs/galaxy-sprites.md) — the game-asset notes (fallback contract, the amen intro); this skill is the system-wide doctrine, that doc the Galaxy-specific detail.
- `DESIGN.md` — the Nostalgic Cosmos canon every color descends from (One Sun, Warm Dark, Retint rules).

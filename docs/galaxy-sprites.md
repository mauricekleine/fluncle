# Galaxy game — sprite & audio assets

How the bespoke 8-bit assets for **Fluncle's Galaxy** (`apps/web/src/game/*`, served from `apps/web/public/galaxy/`) are made. The game is canon-first (DESIGN.md, the Nostalgic Cosmos); every asset arrives quantized to the canon ramp, and the renderer always has a procedural fallback so a missing asset never breaks the game.

## The fallback contract

Every sprite the renderer draws has two sources, in order: a curated PNG in `apps/web/public/galaxy/`, and a procedural fallback in `apps/web/src/game/sprites.ts`. `render.ts` loads each PNG into an `Image()` and draws it once `onload` fires; until then (or if the file 404s) the procedural sprite draws. This means you can ship, swap, or regenerate any PNG at any time with zero code change — drop the file in `public/galaxy/` and it takes over on next load.

The black hole is intentionally **procedural only** (a void with a cool lensing rim that shimmers); it has no PNG.

## The roster

| Asset        | File           | Target px (W×H) | POV / notes                                                                                                                              |
| ------------ | -------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Ship (hero)  | `ship.png`     | 25×20           | Seen from behind; cream hull, gold canopy, red wingtips, twin engines. Flame anchors at x≈8.5/16.5.                                      |
| Earth (hero) | `earth.png`    | 96×87           | Lit from the sun side; the one place the Retint Rule's cool blue is a surface.                                                           |
| Roadster     | `roadster.png` | ~16×9           | A derelict tumbling by; cream wedge, a Re-entry-Red accent, dark wheels.                                                                 |
| UFO          | `ufo.png`      | ~16×7           | Cream saucer with a dim `coolTeal` underglow (used sparingly — Retint Rule).                                                             |
| Asteroid     | `asteroid.png` | ~14×11          | A lumpy cream-dust rock with a shadow side and a couple of lit chips. Tumbles + scales per-entity, so it never reads as one rock cloned. |
| OG card      | `og.png`       | 1200×630        | Not a sprite — rendered by `packages/media` (Remotion); see that package's README.                                                       |

The renderer scales sprites by world distance, so exact source dimensions are not load-bearing; match the aspect ratio and keep them small (the look is the upscaling, not detail).

## The canon ramp

Generated art is quantized to this palette (mirrors `apps/web/src/game/palette.ts` / DESIGN.md). Do not introduce off-canon hues.

- Warm blacks: Deep Field `#090a0b`, Sleeve Black `#10100d`, Tape Black `#171611`
- Cream ramp: `#fffbf2` / `#f4ead7` / `#b7ab95` / `#6e6657`
- Eclipse Gold ramp: `#ffd057` / `#f5b800` / `#b88a00` / `#7a5c00`
- Re-entry Red: `#ffa18f` / `#ff6b57` / `#b23c2e` / `#7a2418`
- Cool counter-accents (sparingly): `#46527a` (blue), `#3a5f5c` (teal)

**One Sun Rule:** Eclipse Gold stays the bangers and the sun — set-dressing and hazards never carry a competing gold bloom (cream / red / dim-cool only). **Light-Years Rule:** the sprite itself is clean; grain and scanlines are applied in-render over the whole frame, so do not bake film texture into a sprite.

## Generating a sprite (Nano Banana / Gemini image-gen)

The hero ship and Earth were made with Gemini image generation ("Nano Banana") and hand-quantized to the ramp; the frontier sprites follow the same workflow.

1. **Provide the key from your secrets manager.** Export `GEMINI_API_KEY` into the environment before running (read it from your password manager / secrets store; never commit a key or paste it into a file). In an interactive terminal that means signing in to the secrets CLI first, then exporting the value for the session.
2. **Prompt per sprite.** Use a tight prompt: small 8-bit / NES-era **pixel art**, **transparent background**, the subject and POV from the roster above, the exact canon hex colors, no text, no drop shadow, no film grain, a single warm light source (no second gold). Example (Roadster): _"16×9 pixel-art sprite of a sleek derelict sports car tumbling in space, seen at a slight angle, transparent background, cream body (#f4ead7/#b7ab95) with a thin re-entry-red (#ff6b57) accent stripe and dark wheels, NES palette, no text, no shadow, no grain."_
3. **Post-process to the grid.** Downscale to the target px, snap every pixel to the nearest canon-ramp color, and make the background fully transparent. Keep it crisp (nearest-neighbour, no anti-aliasing) — the renderer upscales with `image-rendering: pixelated`.
4. **Drop it in** `apps/web/public/galaxy/<name>.png` and reload; the PNG takes over from the procedural fallback automatically.
5. **View the frames before shipping.** These are taste-gated — look at them in a driven browser past hydration (do they move and feel _placed_, not pasted?), not just in code review.

This workflow is scripted at `packages/media/scripts/generate-galaxy-sprites.py` (it reads the key from the environment only, prompts on a flat magenta background it keys out, fits to target, and quantizes each sprite to its per-kind canon subset). Run it with the key exported from your secrets manager:

```bash
GEMINI_API_KEY="$(op read 'op://<your-vault>/GEMINI_API_KEY/password')" \
  UV_CACHE_DIR=/tmp/uv-cache uv run --with pillow \
  python packages/media/scripts/generate-galaxy-sprites.py [roadster ufo asteroid]
```

The committed `roadster.png` / `ufo.png` / `asteroid.png` are a first pass from this script; regenerate or hand-touch any of them, then view in a driven browser before calling them done.

## Audio: the amen intro

`apps/web/public/galaxy/amen.mp3` is the gate-tap intro (the break that birthed drum & bass, so it births the session). The committed file is a **first-party 8-bit amen breakbeat — drums only, no synths** — a ~6.4s 174-BPM loop synthesized from scratch (kick, snare, ghost snares, hats, an opening crash; the percussion voices of the game's SFX kit), generated by `packages/media/scripts/generate-amen.py`. Because it is built from scratch and samples nothing, it is clearance-clean (the sanctioned "Fluncle-made breakbeat that evokes the amen" option — not the uncleared Winstons break). It runs the amen groove (the syncopated snare + ghost pattern with the second-bar lean) over a 2-bar cycle, twice.

Tune it by editing the pattern/voices in that script and regenerating:

```bash
UV_CACHE_DIR=/tmp/uv-cache uv run python packages/media/scripts/generate-amen.py
ffmpeg -y -i /tmp/amen.wav -ac 1 -b:a 96k apps/web/public/galaxy/amen.mp3
```

The code path is sourcing-agnostic (same filename, any bytes), so a different cleared/first-party rendition can swap in anytime. It rides the gate-tap `audio.resume()` unlock, plays once below full volume, and ducks into the ambient bed after ~4 bars; routed through the music bus so the master mute covers it.

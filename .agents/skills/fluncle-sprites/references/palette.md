# The Sprite Palette

One fixed swatch set for the whole sprite family. It descends from `DESIGN.md`'s Nostalgic Cosmos and matches the canon ramp already in `apps/web/src/game/palette.ts`, `docs/galaxy-sprites.md`, and `@fluncle/sprites`' `SPRITE_PALETTE` — do not introduce off-canon hues. Every generated sprite is **quantized to a per-sprite SUBSET of these colors** (the post-step), so a sprite literally cannot drift off-palette _or_ pick up an accent it shouldn't have.

## The four principles (read before picking colors)

1. **Pop is VALUE contrast, not hue.** Sprites sit on warm near-black plates (Deep Field `#090a0b` → Tape Black `#171611`). The dominant mass must sit at a clearly **higher lightness** so the _form_ separates from the ground. Two hues at the same value blur together. → **Default the dominant body to the cream ramp (`CREAMS`).**
2. **Per-sprite SUBSET, not the whole set.** Each sprite is quantized to ONLY the ramps it should use — never all 16 colors. A mailbox = `CREAMS + BLACKS + REDS` (no gold in the set, so gold _cannot_ creep into a highlight). This is both the cohesion lever and the anti-creep guarantee. **`CREAMS + BLACKS` is always the spine**, then add only the accents the sprite earns.
3. **Every subset shares its endpoints.** Because the spine is always `CREAMS + BLACKS`, every sprite shares the **one shared darkest** (the warm outline-black `#090a0b`) and the **one shared lightest** (`#fffbf2`). That shared start/end is what makes separate sprites feel like one family _by construction_.
4. **Color by role.** One dominant body tone over most of the sprite; brand accents at only **~10–20%** of the area; balance any loud accent with a larger quiet area. Eclipse Gold obeys the One Sun Rule (≤~10%, the one light) — confine it to a single lit/identity accent, never the body.

## Shading a ramp

Never a straight value-only ramp (reads dull/plastic). Shade with **hue-shift AND saturation-shift**: shadows go cooler + desaturated, mids warmer + more saturated, highlights desaturated. Keep saturation off both 0% and 100%; peak it in the mid-tones. Three steps (base + shadow + highlight) is the minimum per material.

## The ramps (the names the script composes subsets from)

The generation script (`scripts/generate_sprite.py`) holds these as named constants; a per-sprite `palette` is a sum of them (e.g. `CREAMS + BLACKS + REDS`). Each ramp is `highlight · base · shadow · deep` (lightest → darkest). The dark end of every ramp pulls toward the shared outline-black.

**`CREAMS` — the default BODY (the popping light mass).** Aged liner-note paper; the dominant surface on most sprites. Part of every subset's spine.

- `#fffbf2` · `#f4ead7` · `#b7ab95` · `#6e6657`

**`GOLDS` (and `GOLD1`, a single gold note) — the ONE-SUN accent (≤~10%).** A single lit edge, the door, the identity glint — never a field, never a second gold in one sprite. Most sprites take `GOLD1` (one swatch) rather than the full ramp.

- `#ffd057` · `#f5b800` · `#b88a00` · `#7a5c00`

**`REDS` — the heat accent.** The mailbox flag, a warning light, a hot detail. Sparing.

- `#ffa18f` · `#ff6b57` · `#b23c2e` · `#7a2418`

**`COOL` / `TEAL` — cool counter-accents, minor only (Retint Rule).** A glass tint, a phosphor glow, a screen. Never a dominant surface; cool hues survive only as small counter-accents.

- blue `#46527a` (`COOL`) · teal `#3a5f5c` (`TEAL`)

**`BLACKS` — ground, outline, deepest shadow.** Every black leans warm (toward the cream/dust hue); cool/blue-tinted darks are prohibited. Part of every subset's spine.

- `#090a0b` (deep field) · `#10100d` (sleeve) · `#171611` (tape)

## Shared endpoints (the family glue)

- **Shared darkest / outline:** `#090a0b` — the single solid contour color and the floor of every ramp.
- **Shared lightest / key highlight:** `#fffbf2` — the top of every ramp, where the upper-left light lands.

## Per-sprite budget

A subset is the spine (`CREAMS + BLACKS`, ~7 swatches) plus one or two accents (`+ REDS`, `+ GOLD1`, `+ COOL`…). ≤ ~6 _used_ colors is typical even when the subset offers more — the quantizer only paints what the render contains. A sprite that wants three loud accents is over-detailed; abstract it down. The master set is the 17-swatch `SPRITE_PALETTE` (4 cream + 4 gold + 4 red + 2 cool + 3 black); the discipline is which slice each sprite draws from.

# The Sprite Palette

One fixed swatch set for the whole sprite family. It descends from `DESIGN.md`'s Nostalgic Cosmos and matches the canon ramp already in `apps/web/src/game/palette.ts` + `docs/galaxy-sprites.md` — do not introduce off-canon hues. Every generated sprite is **quantized to these colors** (the post-step), so a sprite literally cannot drift off-palette.

## The three principles (read before picking colors)

1. **Pop is VALUE contrast, not hue.** Sprites sit on warm near-black plates (Deep Field `#090a0b` → Tape Black `#171611`). The dominant mass must sit at a clearly **higher lightness** so the _form_ separates from the ground. Two hues at the same value blur together. → **Default the dominant body to the cream ramp.**
2. **Every ramp shares its endpoints.** All material ramps branch from the **one shared darkest** (the warm outline-black) and converge toward the **one shared lightest** (`#fffbf2`). That shared start/end is what makes separate sprites feel like one family _by construction_.
3. **Color by role.** One dominant body tone over most of the sprite; brand accents at only **~10–20%** of the area; balance any loud accent with a larger quiet area. Eclipse Gold obeys the One Sun Rule (≤~10%, the one light) — confine it to a single lit/identity accent, never the body.

## Shading a ramp

Never a straight value-only ramp (reads dull/plastic). Shade with **hue-shift AND saturation-shift**: shadows go cooler + desaturated, mids warmer + more saturated, highlights desaturated. Keep saturation off both 0% and 100%; peak it in the mid-tones. Three steps (base + shadow + highlight) is the minimum per material.

## The ramps

Each ramp is `highlight · base · shadow · deep` (lightest → darkest). The dark end of every ramp pulls toward the shared outline-black.

**Cream — the default BODY (the popping light mass).** Aged liner-note paper; this is the dominant surface on most sprites.

- `#fffbf2` · `#f4ead7` · `#b7ab95` · `#6e6657`

**Eclipse Gold — the ONE-SUN accent (≤~10%).** A single lit edge, the door, the identity glint — never a field, never a second gold in one sprite.

- `#ffd057` · `#f5b800` · `#b88a00` · `#7a5c00`

**Re-entry Red — the heat accent.** The mailbox flag, a warning light, a hot detail. Sparing.

- `#ffa18f` · `#ff6b57` · `#b23c2e` · `#7a2418`

**Cool counter-accents — minor only (Retint Rule).** A glass tint, a phosphor glow, a screen. Never a dominant surface; cool hues survive only as small counter-accents.

- blue `#46527a` · teal `#3a5f5c`

**Warm blacks — ground, outline, deepest shadow.** Every black leans warm (toward the cream/dust hue); cool/blue-tinted darks are prohibited.

- `#090a0b` (deep field) · `#10100d` (sleeve) · `#171611` (tape)

## Shared endpoints (the family glue)

- **Shared darkest / outline:** `#090a0b` — the single solid contour color and the floor of every ramp.
- **Shared lightest / key highlight:** `#fffbf2` — the top of every ramp, where the upper-left light lands.

## Per-sprite budget

≤ ~6 colors typical; up to ~8 only if a second material genuinely needs its own ramp. Master set cap ~16–24 across the whole system. A sprite that needs more is over-detailed — abstract it down.

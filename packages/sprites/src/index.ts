// @fluncle/sprites — the canonical home for Fluncle's pixel sprites.
//
// The PNG assets live in `assets/<collection>/<id>.png` (this package owns them);
// the generation pipeline (the `fluncle-sprites` skill) writes there, and the web
// app copies them into its `public/` at build so the served paths are unchanged.
// This module is the typed layer over them: the manifest, the palette, and the
// URL resolver.
//
// One family, one source of truth, many consumers (web, CLI, OG cards, …).

/**
 * The sprite sets. `galaxy` is the game's set; `void` is the black hole at the empty
 * coordinate (the /404 page — a finding Fluncle went looking for and found nothing
 * where it should be); `probes` is the survey fleet (the /about probes beat — the
 * instruments that measure and never speak). Same family, one shared
 * perspective/light/palette.
 */
export type SpriteCollection = "galaxy" | "probes" | "void";

/** Every sprite id, by collection (the file at `assets/<collection>/<id>.png`). */
export const SPRITES = {
  galaxy: ["asteroid", "earth", "roadster", "ship", "ufo"],
  probes: ["probe", "telescope"],
  void: ["accretion", "discman", "event-horizon"],
} as const satisfies Record<SpriteCollection, readonly string[]>;

/** A sprite reference — a collection + an id within it. */
export type SpriteRef = { collection: SpriteCollection; id: string };

/**
 * The public URL the WEB serves a sprite at. The web build mirrors
 * `packages/sprites/assets/<collection>/` → `apps/web/public/<collection>/`, so a
 * sprite is served at the same stable path it always was (the game's loaders
 * resolve here, and a dropped-in PNG still hot-swaps).
 */
export function spriteUrl(ref: SpriteRef): string {
  return `/${ref.collection}/${ref.id}.png`;
}

/**
 * The Sprite Palette — the canon ramp every sprite is quantized to (mirrors
 * `DESIGN.md` + the `fluncle-sprites` skill's `references/palette.md`). The
 * dominant body sits on the cream ramp (pops on dark by VALUE), gold + red ride
 * as accents, warm blacks for the outline/shadow.
 */
export const SPRITE_PALETTE = [
  "#fffbf2",
  "#f4ead7",
  "#b7ab95",
  "#6e6657", // cream — the light body
  "#ffd057",
  "#f5b800",
  "#b88a00",
  "#7a5c00", // eclipse gold — accent
  "#ffa18f",
  "#ff6b57",
  "#b23c2e",
  "#7a2418", // re-entry red — accent
  "#46527a",
  "#3a5f5c", // cool counter-accents
  "#171611",
  "#10100d",
  "#090a0b", // warm blacks — outline / shadow
] as const;

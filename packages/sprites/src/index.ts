export type SpriteCollection = "galaxy" | "probes" | "void";

export const SPRITES = {
  galaxy: ["asteroid", "earth", "roadster", "ship", "ufo"],
  probes: ["probe", "telescope"],
  void: ["accretion", "discman", "event-horizon"],
} as const satisfies Record<SpriteCollection, readonly string[]>;

export type SpriteRef = { collection: SpriteCollection; id: string };

export function spriteUrl(ref: SpriteRef): string {
  return `/${ref.collection}/${ref.id}.png`;
}

export const SPRITE_PALETTE = [
  "#fffbf2",
  "#f4ead7",
  "#b7ab95",
  "#6e6657",
  "#ffd057",
  "#f5b800",
  "#b88a00",
  "#7a5c00",
  "#ffa18f",
  "#ff6b57",
  "#b23c2e",
  "#7a2418",
  "#46527a",
  "#3a5f5c",
  "#171611",
  "#10100d",
  "#090a0b",
] as const;

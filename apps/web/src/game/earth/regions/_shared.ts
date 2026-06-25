// The region-module contract — the seam that makes the overworld fan out across
// agents without collisions. Each region is ONE pure-data file under this dir,
// auto-discovered by `../registry.ts` via import.meta.glob. A region contributes
// its prop sprites (char grids drawn through the shared INK in `../sprites.ts`)
// and its doors (where each prop sits + what surface it opens). Adding a region
// = adding a file here (+ a matching card file under `../cards/`); no shared
// file is edited, so parallel region builds never conflict.
//
// Coordinates are absolute overworld tiles; `../world.ts` publishes each region's
// tile box (REGION_BOXES) so a region's doors land in its own area.

/** A char-grid sprite: rows of equal length; '.'/' ' = transparent, every other
 *  char maps through the INK table in ../sprites.ts. */
export type PropMap = string[];

export type DoorStatus = "gated" | "live";

export type DoorDef = {
  /** Key into the region's `props` — the sprite drawn at this tile. */
  prop: string;
  /** Anchor tile (bottom-center); the prop draws upward from here. */
  tx: number;
  ty: number;
  /** The door's name — used for the a11y label + the noscript link text. */
  label: string;
  /** A card id in the card registry (../cards/*) to open as an overlay. */
  card?: string;
  /** Or a route to navigate to instead of an overlay (the rocket → /galaxy). */
  route?: string;
  /** Defaults to "live"; "gated" doors render the coming-soon card chrome. */
  status?: DoorStatus;
};

export type RegionModule = {
  /** Stable id (matches the filename), e.g. "workshop". */
  id: string;
  /** propId -> char-grid sprite map (built once via ../sprites.ts `makeSprite`). */
  props: Record<string, PropMap>;
  doors: DoorDef[];
};

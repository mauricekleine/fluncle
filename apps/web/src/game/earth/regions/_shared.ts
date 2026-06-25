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
  /** The door's name — used for the card title, the a11y label, the noscript link. */
  label: string;
  /** A @fluncle/registry surface name (e.g. "web.mixtapes") — the owned-surface
   *  doors read their URL + blurb from the registry via the generic SurfaceCard. */
  surface?: string;
  /** Or a custom card id in the card registry (../cards/*) — the terminal, the
   *  social channels, the rocket-to-/galaxy launch card, anything the registry
   *  doesn't cover. A card that wants to navigate (the rocket) renders a typed
   *  <Link> inside itself. */
  card?: string;
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

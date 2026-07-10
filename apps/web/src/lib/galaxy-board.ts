// The `/admin/galaxies` naming view's pure view-model (Slice 3, browse-by-feel RFC).
// Given the full admin map (named + unnamed + retired), it partitions the board the
// operator reads: the NAMING QUEUE (unnamed, non-retired — the attention rows), the
// NAMED map, and the RETIRED tail, plus the naming progress the launch gate turns on
// (the public lens ships only once the whole map is named). Kept pure and free of the
// heavy `GalaxyAdminItem`/member shape so it unit-tests without a database or DOM.

// The minimal shape the partition reads — a galaxy is "named" once it carries both a
// name and a slug (naming sets them together; either alone is a half-written row that
// stays admin-only), and "retired" once `retiredAt` is stamped.
type GalaxyLike = {
  name: string | null;
  retiredAt: string | null;
  slug: string | null;
};

export type GalaxyBoard<T extends GalaxyLike> = {
  /** How many of the nameable galaxies carry a name — the launch-gate numerator. */
  namedCount: number;
  /** The named, non-retired galaxies (the live map). */
  namedGalaxies: T[];
  /** The map size the launch gate measures against — every non-retired galaxy. */
  nameableCount: number;
  /** The unnamed, non-retired galaxies — the naming queue's attention rows. */
  namingQueue: T[];
  /** The retired tail — only galaxies that were once NAMED (a real place with history).
   * A never-named retired cluster (a machine handle from a superseded fit or remint)
   * was never anywhere the operator or the crew knew — it is dropped, not memorialized. */
  retiredGalaxies: T[];
};

/** True once a galaxy carries both a name and a slug (naming sets them as a pair). */
export function isNamed(galaxy: GalaxyLike): boolean {
  return Boolean(galaxy.name?.trim()) && Boolean(galaxy.slug?.trim());
}

/**
 * Partition the full admin map into the three board sections + the naming progress.
 * Retired galaxies never count toward the launch gate (a retired region is out of the
 * map, not an unnamed debt); an unnamed live galaxy is a naming-queue row.
 */
export function partitionGalaxyBoard<T extends GalaxyLike>(galaxies: readonly T[]): GalaxyBoard<T> {
  const namingQueue: T[] = [];
  const namedGalaxies: T[] = [];
  const retiredGalaxies: T[] = [];

  for (const galaxy of galaxies) {
    if (galaxy.retiredAt) {
      if (isNamed(galaxy)) {
        retiredGalaxies.push(galaxy);
      }
    } else if (isNamed(galaxy)) {
      namedGalaxies.push(galaxy);
    } else {
      namingQueue.push(galaxy);
    }
  }

  return {
    nameableCount: namedGalaxies.length + namingQueue.length,
    namedCount: namedGalaxies.length,
    namedGalaxies,
    namingQueue,
    retiredGalaxies,
  };
}

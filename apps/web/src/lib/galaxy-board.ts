type GalaxyLike = {
  name: string | null;
  retiredAt: string | null;
  slug: string | null;
};

export type GalaxyBoard<T extends GalaxyLike> = {
  namedCount: number;

  namedGalaxies: T[];

  nameableCount: number;

  namingQueue: T[];

  retiredGalaxies: T[];
};

export function isNamed(galaxy: GalaxyLike): boolean {
  return Boolean(galaxy.name?.trim()) && Boolean(galaxy.slug?.trim());
}

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

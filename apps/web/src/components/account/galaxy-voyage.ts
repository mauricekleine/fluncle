import { type GalaxyCompletion } from "./shared";

export type VoyagePart = string | { num: number };

export function galaxiesReached(galaxies: GalaxyCompletion[], ungroupedCount: number): number {
  const named = galaxies.filter((galaxy) => galaxy.collected > 0).length;

  return named + (ungroupedCount > 0 ? 1 : 0);
}

export function flyCtaVariant(galaxies: GalaxyCompletion[]): "default" | "outline" {
  const anyComplete = galaxies.some(
    (galaxy) => galaxy.total > 0 && galaxy.collected >= galaxy.total,
  );

  return anyComplete ? "outline" : "default";
}

function starsClause(stars: number, galaxies: number): VoyagePart[] {
  if (stars === 0) {
    return ["You haven't logged a star yet"];
  }

  const starWord = stars === 1 ? "star" : "stars";
  const galaxyWord = galaxies === 1 ? "galaxy" : "galaxies";

  return [
    "You've logged ",
    { num: stars },
    ` ${starWord} across `,
    { num: galaxies },
    ` ${galaxyWord}`,
  ];
}

function homeClause(homes: number): VoyagePart[] {
  if (homes === 0) {
    return ["never flown home"];
  }

  if (homes === 1) {
    return ["flown home once"];
  }

  return ["flown home ", { num: homes }, " times"];
}

function towClause(tows: number): VoyagePart[] {
  if (tows === 0) {
    return ["never been towed"];
  }

  if (tows === 1) {
    return ["been towed once"];
  }

  return ["been towed ", { num: tows }, " times"];
}

export function buildVoyageSentence(input: {
  galaxies: number;
  homes: number;
  stars: number;
  tows: number;
}): VoyagePart[] {
  return [
    ...starsClause(input.stars, input.galaxies),
    ", ",
    ...homeClause(input.homes),
    ", and ",
    ...towClause(input.tows),
    ".",
  ];
}

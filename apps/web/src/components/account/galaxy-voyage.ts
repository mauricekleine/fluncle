// The voyage sentence and the One Sun logic for the Galaxy door (account redesign
// brief, ruling #2). Pure and JSX-free so the plural/zero variants and the CTA swap
// are unit-testable without rendering a canvas or a component. The door renders the
// parts: a bare string prints as read text (Space Grotesk); a `{ num }` part prints
// in Oxanium tabular (the coordinate face — DESIGN.md's Tabular Rule keeps every
// number from jittering).

import { type GalaxyCompletion } from "./shared";

/** One piece of the voyage sentence: read text, or a tabular number to set in Oxanium. */
export type VoyagePart = string | { num: number };

/**
 * How many galaxies the traveller has touched: every NAMED galaxy with at least one
 * star logged, plus the unnamed (ungrouped) bucket counted once when it holds
 * anything. The ungrouped bucket is a real place you've been even before the operator
 * names it, so it counts toward the tally — it just never earns a noun (the Unlit Rule
 * keeps it unheaded in the collection below).
 */
export function galaxiesReached(galaxies: GalaxyCompletion[], ungroupedCount: number): number {
  const named = galaxies.filter((galaxy) => galaxy.collected > 0).length;

  return named + (ungroupedCount > 0 ? 1 : 0);
}

/**
 * One Sun (DESIGN.md): the gold Fly CTA is the view's single sun UNTIL a galaxy is
 * fully logged — that completion earns the page's gold note, so the CTA yields and
 * drops to outline. Any one finished galaxy is enough; two suns never burn at once.
 */
export function flyCtaVariant(galaxies: GalaxyCompletion[]): "default" | "outline" {
  const anyComplete = galaxies.some(
    (galaxy) => galaxy.total > 0 && galaxy.collected >= galaxy.total,
  );

  return anyComplete ? "outline" : "default";
}

function starsClause(stars: number, galaxies: number): VoyagePart[] {
  // Reachable at zero: the door's guard opens the sentence when there are runs or
  // tows even with nothing logged, so "logged 0 stars" must read as a real sentence.
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

/**
 * The voyage in one first-person sentence: "You've logged {n} stars across {g}
 * galaxies, flown home {w} times, and been towed {t} times." Each clause carries its
 * own singular/plural and zero variant so the line reads correctly at any value —
 * "once" for a single run or tow, "never …" for a zero, and a deliberate opener when
 * nothing is logged yet. Sentence case, no em dashes.
 */
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

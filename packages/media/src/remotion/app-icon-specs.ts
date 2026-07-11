// The app-icon candidate set — the single source of truth shared by the registry
// (root.tsx maps it to <Still>s) and the render script (render-app-icons.ts).
//
// Each candidate is one <AppIcon> variant (app-icon.tsx) rendered at the 1024×1024
// master size (the size iOS and Android both want; the OS masks/downscales from
// it). This is a TASTE deliverable — the operator picks one, and only then does it
// get wired into apps/mobile (see the PR body's wiring plan). The `slug` names the
// rendered file (icon-<slug>.png) so the candidates are eyeball-able side by side.

import { type AppIconVariant } from "./app-icon";

export type AppIconSpec = {
  /** Remotion <Still> id + selectComposition id. */
  id: string;
  /** File slug: rendered to out/app-icon/icon-<slug>.png. */
  slug: string;
  /** One-line design rationale, for the render log and the PR body. */
  rationale: string;
  /** The variant this candidate renders. */
  variant: AppIconVariant;
};

// The iOS/Android master size. The OS applies its own corner mask (iOS
// superellipse, Android adaptive crop) and downscales, so we render one clean
// 1024² master per candidate and design to the full square.
export const APP_ICON_SIZE = 1024;

export const APP_ICON_SPECS: readonly AppIconSpec[] = [
  // ── The live candidates: the existing brand mark, the drifting traveler
  // (operator ruling — the icon is the canonical figure, not an invented mark;
  // the figure is scaled to ~72% of icon height so it reads at 60px). ──
  {
    id: "AppIconTraveler",
    rationale:
      "The drifting traveler on plain Deep Field — the canonical mark, nothing else, its baked rim light the only sun.",
    slug: "e-traveler-deepfield",
    variant: "traveler",
  },
  {
    id: "AppIconTravelerStars",
    rationale:
      "The traveler over the quiet starfield — the fluncle-small.jpg avatar vibe with the figure sized to read at 60px.",
    slug: "f-traveler-starfield",
    variant: "traveler-stars",
  },
  {
    id: "AppIconTravelerGlow",
    rationale:
      "The traveler with a faint warm eclipse glow behind — the figure's gold rim light picking up a halo that serves it.",
    slug: "g-traveler-eclipse",
    variant: "traveler-glow",
  },
  // ── Exploration: the four invented marks, kept for reference. ──
  {
    id: "AppIconEclipse",
    rationale:
      "The burning eclipse mark alone — the pure identity orb, the sun the traveler moves toward.",
    slug: "a-burning-eclipse",
    variant: "eclipse",
  },
  {
    id: "AppIconStamp",
    rationale:
      "A single Oxanium `F` certification stamp in the logbook plate's printed frame — the typographic mark.",
    slug: "b-coordinate-stamp",
    variant: "stamp",
  },
  {
    id: "AppIconCover",
    rationale:
      "The founding cover distilled — eclipse high over a tower skyline with relic grain, the whole scene as an icon.",
    slug: "c-cover-scene",
    variant: "cover",
  },
  {
    id: "AppIconDiamond",
    rationale:
      "The banger-diamond star motif — every banger out there is a star, the geometric fourth axis.",
    slug: "d-banger-diamond",
    variant: "diamond",
  },
] as const;

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

import { type AppIconVariant } from "./app-icon";

export type AppIconSpec = {
  id: string;

  slug: string;

  rationale: string;

  variant: AppIconVariant;
};

export const APP_ICON_SIZE = 1024;

export const APP_ICON_SPECS: readonly AppIconSpec[] = [
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

export type MobileAssetSpec = {
  file: string;

  id: string;

  rationale: string;

  variant: AppIconVariant;
};

export const MOBILE_ASSET_SPECS: readonly MobileAssetSpec[] = [
  {
    file: "icon.png",
    id: "AppIconTraveler",
    rationale: "the app icon master (the pick: the traveler on plain Deep Field; opaque)",
    variant: "traveler",
  },
  {
    file: "adaptive-icon.png",
    id: "AppIconAdaptiveForeground",
    rationale:
      "the Android adaptive-icon foreground (transparent; figure at 58% for the adaptive mask)",
    variant: "adaptive-foreground",
  },
  {
    file: "splash-icon.png",
    id: "AppIconSplash",
    rationale: "the splash mark (transparent; the traveler small over an edge-faded starfield)",
    variant: "splash",
  },
] as const;

// The app-icon spec sets — the single source of truth shared by the registry
// (root.tsx maps them to <Still>s) and the render scripts.
//
// Two sets. APP_ICON_SPECS is the CANDIDATE set (render-app-icons.ts → the
// gitignored out/, for the operator's taste pick — resolved 2026-07-12: variant
// "traveler", plain Deep Field). MOBILE_ASSET_SPECS is the PRODUCTION set
// (render-mobile-assets.ts → apps/mobile/assets/, committed): the picked icon
// master plus its two Expo siblings, the Android adaptive-icon foreground and
// the splash mark. All render at the 1024×1024 master size (Expo's recommended
// icon size; the OS masks/downscales from it).

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

export type MobileAssetSpec = {
  /** The committed file name under apps/mobile/assets/. */
  file: string;
  /** Remotion <Still> id + selectComposition id. */
  id: string;
  /** What the asset is, for the render log. */
  rationale: string;
  /** The variant this asset renders. */
  variant: AppIconVariant;
};

// The production mobile assets — the operator's pick (variant "traveler",
// 2026-07-12) plus its Expo siblings. render-mobile-assets.ts renders these to
// apps/mobile/assets/, which app.config.ts references; they are COMMITTED
// files (like the OG card), regenerated + re-committed when the design changes.
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

// The store-screenshot asset specs — the ids and sizes shared by the registry
// (root.tsx maps them to <Still>s) and the render script (render-screenshot-assets.ts).
//
// UNLIKE the other spec files here, this one carries NO fixture list: what to render is
// the synthetic dataset in `@fluncle/test-support/screenshot-fixtures`, which the
// `apps/web` seed reads too, so the rendered file names and the seeded row URLs cannot
// drift. This file holds only what belongs to the rendering side.
//
// See docs/mobile-store-screenshots.md for the capture runbook.

/** The <Still> id for the generative album sleeve. */
export const SYNTHETIC_SLEEVE_ID = "SyntheticSleeve";

/**
 * Sleeves render at 1000² — comfortably above the largest place the app puts a cover
 * (the log-detail hero on a 3× phone), and a round master size for a square asset.
 */
export const SYNTHETIC_SLEEVE_SIZE = 1000;

/** The <Still> id for the generative artist mark. */
export const SYNTHETIC_AVATAR_ID = "SyntheticAvatar";

/**
 * Avatars render at 600² — the taste picker's tile is 64pt, so 600 covers 3× with room,
 * and the mark is crop-safe to the inscribed circle (synthetic-avatar.tsx).
 */
export const SYNTHETIC_AVATAR_SIZE = 600;

/** Where the render script writes, relative to the package root. Gitignored (`out/`). */
export const SCREENSHOT_ASSET_OUT_DIR = "out/screenshot-assets";

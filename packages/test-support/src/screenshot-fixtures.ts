// The SYNTHETIC STORE-SCREENSHOT DATASET — one list, two consumers.
//
// Apple rejected Fluncle mobile 1.0 under Guideline 5.2.1 because the App Store SCREENSHOTS
// showed real album covers and Spotify artist photos we hold no rights to. The fix is to
// re-shoot every store slot against a dataset whose sleeves and avatars are Fluncle's own
// generated art. That takes two things to agree exactly:
//
//   1. `packages/media` renders one sleeve per `slug` and one avatar per `artistSlug`
//      (`bun run --cwd packages/media render:screenshot-assets`).
//   2. `apps/web` seeds the local dev database with rows whose `albumImageUrl` /
//      `imageUrl` point at those files (`bun run --cwd apps/web screenshot:seed`).
//
// If those two lists ever disagree, a screenshot shows a broken image — so there is ONE
// list, here, and both sides import it. It lives in `@fluncle/test-support` because that is
// the repo's zero-dependency home for shared synthetic fixtures: importing it drags in no
// Remotion, no libSQL, and no React.
//
// EVERY NAME HERE IS INVENTED. That is the point of the exercise — no real act, no real
// release, no real cover. The register is the e2e seed's (`apps/web/tests/e2e/seed.ts`):
// DnB-plausible and unmistakably not a real catalogue. Keep it that way; a real name in this
// list re-opens the rejection it exists to close.
//
// The operator runbook is `docs/mobile-store-screenshots.md`.

/** The default host the rendered assets are served from during a capture session. */
export const SCREENSHOT_ASSET_BASE = "http://127.0.0.1:8899";

/** One synthetic finding: its sleeve, its row, and the artist it hangs off. */
export type ScreenshotFinding = {
  /** Slug of the artist that leads this track — the avatar file, and the `artists` row. */
  artistSlug: string;
  /** Folded DnB tempo, inside the engine's 160–185 band (`mixability.ts` BPM_BAND). */
  bpm: number;
  /** Which synthetic galaxy this finding sits in (the archive row's third meta segment). */
  galaxySlug: string;
  /** Scale-text key — `parseKey`-able, spread so harmonic ranking has real work to do. */
  key: string;
  /** The `F`-free finding coordinate (FINDING_LOG_ID_PATTERN: `\d{3,4}\.\d\.\d[A-Z]`). */
  logId: string;
  /** The finding's short editorial note, as the detail screen renders it. */
  note: string;
  /**
   * The RADIO finding. Exactly one, and it carries the four columns the radio-eligibility
   * predicate reads (`getRadioEligibleTracks`); everything else stays a plain finding.
   */
  radio?: true;
  /** Stable id — the sleeve file name AND the `shot-<slug>` row id stem. */
  slug: string;
  /** The track title as the row renders it. */
  title: string;
};

/** One synthetic artist: the avatar the Decks taste picker taps. */
export type ScreenshotArtist = {
  /** Display name. */
  name: string;
  /** Stable id — the avatar file name AND the `shot-artist-<slug>` row id stem. */
  slug: string;
};

/** One synthetic sonic galaxy — the archive row's "· <galaxy>" meta segment. */
export type ScreenshotGalaxy = { name: string; slug: string };

export const SCREENSHOT_ARTISTS: readonly ScreenshotArtist[] = [
  { name: "Nova Kestrel", slug: "nova-kestrel" },
  { name: "Cobalt Mirage", slug: "cobalt-mirage" },
  { name: "Halcyon Drift", slug: "halcyon-drift" },
  { name: "Vellum Pulse", slug: "vellum-pulse" },
  { name: "Marrow & Vane", slug: "marrow-and-vane" },
  { name: "Sable Lantern", slug: "sable-lantern" },
  { name: "Quiet Cartel", slug: "quiet-cartel" },
  { name: "Ostrich Ballet", slug: "ostrich-ballet" },
] as const;

export const SCREENSHOT_GALAXIES: readonly ScreenshotGalaxy[] = [
  { name: "Deep Amber", slug: "deep-amber" },
  { name: "Slow Water", slug: "slow-water" },
] as const;

// THE KEYS ARE CHOSEN, NOT SPRINKLED. The rail pre-filters candidates to the eight Camelot
// classes a NAMED harmonic move can reach (`namedMoveKeys`), and a pair with no key is not
// rankable at all (`scoreMix`: the key is the engine's mandatory floor). So the fourteen sit
// in one tight neighbourhood of the wheel — 6A/7A/8A/9A/10A plus the 7B/8B/9B majors across
// from them — which is what makes a four-deep chain still return a full rail instead of the
// "Quiet sector tonight" empty state. The BPMs spread 170–178 inside the folded band so the
// tempo sub-score varies rather than pinning at 1.00.
export const SCREENSHOT_FINDINGS: readonly ScreenshotFinding[] = [
  {
    artistSlug: "nova-kestrel",
    bpm: 174,
    galaxySlug: "deep-amber",
    key: "A minor",
    logId: "801.1.0A",
    note: "Caught this on a night drive. The pad walks in and the whole road goes quiet.",
    slug: "synthetic-aurora",
    title: "Synthetic Aurora",
  },
  {
    artistSlug: "nova-kestrel",
    bpm: 172,
    galaxySlug: "slow-water",
    key: "E minor",
    logId: "802.2.0B",
    note: "Two minutes of nothing but breath, then it hands you the bassline and leaves.",
    slug: "longwave-hymn",
    title: "Longwave Hymn",
  },
  {
    artistSlug: "cobalt-mirage",
    bpm: 176,
    galaxySlug: "deep-amber",
    key: "D minor",
    logId: "803.3.0C",
    note: "The drums are doing something unkind to the downbeat and I love it.",
    slug: "neon-undertow",
    title: "Neon Undertow",
  },
  {
    artistSlug: "cobalt-mirage",
    bpm: 174,
    galaxySlug: "slow-water",
    key: "C major",
    logId: "804.4.0D",
    note: "Warmest thing in the sector. Sounds like a tape that's been worn thin with playing.",
    slug: "saltglass",
    title: "Saltglass",
  },
  {
    artistSlug: "halcyon-drift",
    bpm: 171,
    galaxySlug: "slow-water",
    key: "G major",
    logId: "805.5.0E",
    note: "Rolls forever. I put it on to think and came back forty minutes later.",
    slug: "glassbottom-reverie",
    title: "Glassbottom Reverie",
  },
  {
    artistSlug: "halcyon-drift",
    bpm: 170,
    galaxySlug: "slow-water",
    key: "F major",
    logId: "806.6.0F",
    note: "Slowest one out here, and it still moves. The bass does all the walking.",
    slug: "ferrite-bloom",
    title: "Ferrite Bloom",
  },
  {
    artistSlug: "vellum-pulse",
    bpm: 175,
    galaxySlug: "deep-amber",
    key: "B minor",
    logId: "807.7.0G",
    note: "Comes up like a sunrise you didn't plan to be awake for.",
    slug: "cathode-sunrise",
    title: "Cathode Sunrise",
  },
  {
    artistSlug: "vellum-pulse",
    bpm: 173,
    galaxySlug: "deep-amber",
    key: "G minor",
    logId: "808.8.0H",
    note: "Heavy and half asleep. The kind of tune that mixes into anything.",
    slug: "tungsten-lullaby",
    title: "Tungsten Lullaby",
  },
  {
    artistSlug: "marrow-and-vane",
    bpm: 177,
    galaxySlug: "deep-amber",
    key: "A minor",
    logId: "809.9.0J",
    note: "Fastest of the lot. All texture, no mercy, gone before you settle in.",
    slug: "velvet-static",
    title: "Velvet Static",
  },
  {
    artistSlug: "sable-lantern",
    bpm: 172,
    galaxySlug: "slow-water",
    key: "E minor",
    logId: "810.1.0K",
    note: "Someone let a whole choir into the breakdown and nobody stopped them.",
    slug: "paper-lantern-riot",
    title: "Paper Lantern Riot",
  },
  {
    artistSlug: "sable-lantern",
    bpm: 178,
    galaxySlug: "deep-amber",
    key: "D minor",
    logId: "811.2.0L",
    note: "Wet, loud, and relentless. Play it at the point where the room gives up.",
    slug: "copper-monsoon",
    title: "Copper Monsoon",
  },
  {
    artistSlug: "quiet-cartel",
    bpm: 174,
    galaxySlug: "slow-water",
    key: "C major",
    logId: "812.3.0M",
    note: "A tune with nowhere to be. Perfect for the hour before anyone arrives.",
    slug: "low-orbit-ferry",
    title: "Low Orbit Ferry",
  },
  {
    artistSlug: "ostrich-ballet",
    bpm: 170,
    galaxySlug: "slow-water",
    key: "B minor",
    logId: "813.4.0N",
    note: "Found it right at the end of a long night, which is exactly how it sounds.",
    slug: "moth-hour",
    title: "Moth Hour",
  },
  {
    artistSlug: "ostrich-ballet",
    bpm: 173,
    galaxySlug: "deep-amber",
    key: "G minor",
    logId: "814.5.0P",
    note: "Salt in the reverb and a bassline that keeps checking over its shoulder.",
    radio: true,
    slug: "salt-marsh-vigil",
    title: "Salt Marsh Vigil",
  },
] as const;

/** The one published mixtape the Mixtapes tab lists (its cover is Fluncle's own render). */
export const SCREENSHOT_MIXTAPE = {
  logId: "800.F.1A",
  sequenceNumber: 8,
  title: "Dream Sector Eight",
} as const;

/** The synthetic id prefix. Every row this dataset creates starts with it, and the seed deletes by it. */
export const SCREENSHOT_ID_PREFIX = "shot-";

/** The rendered sleeve's URL for a finding slug, under `base` (default {@link SCREENSHOT_ASSET_BASE}). */
export function sleeveUrl(slug: string, base: string = SCREENSHOT_ASSET_BASE): string {
  return `${base.replace(/\/+$/, "")}/sleeves/${slug}.png`;
}

/** The rendered avatar's URL for an artist slug, under `base` (default {@link SCREENSHOT_ASSET_BASE}). */
export function avatarUrl(slug: string, base: string = SCREENSHOT_ASSET_BASE): string {
  return `${base.replace(/\/+$/, "")}/avatars/${slug}.png`;
}

/** The one radio-eligible finding, or undefined if the list ever loses its `radio` flag. */
export function screenshotRadioFinding(): ScreenshotFinding | undefined {
  return SCREENSHOT_FINDINGS.find((finding) => finding.radio);
}

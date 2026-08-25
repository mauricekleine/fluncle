import rawManifest from "./manifest.json";

export const SCALE_PROFILES = ["1x", "2x", "4x"] as const;

export type ScaleProfile = (typeof SCALE_PROFILES)[number];

export type FixtureCounts = {
  albums: number;
  artists: number;
  crawlFrontier: number;
  enabledLabelTracks: number;
  findings: number;
  fullAnalysisBacklog: number;
  labels: number;
  musicbrainzIsrcBacklog: number;
  pendingFrontier: number;
  trackArtists: number;
  trackEmbeddings: number;
  tracks: number;
  youtubeProvenanceBacklog: number;
};

export type ScaleManifest = {
  baseline: {
    databaseSizeMb: number;
    inventory: typeof rawManifest.inventory;
  };
  counts: FixtureCounts;
  integrationBase: string;
  multiplier: 1 | 2 | 4;
  profile: ScaleProfile;
  schemaVersion: number;
  vector: typeof rawManifest.vector;
};

const EXPECTED_INTEGRATION_BASE = "f0b368203d42a3b92d5b5025c8064e27baa9f632";

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertRawManifest(): void {
  if (rawManifest.integrationBase !== EXPECTED_INTEGRATION_BASE) {
    throw new Error("database performance manifest integration base changed unexpectedly");
  }

  for (const [label, value] of Object.entries({
    ...rawManifest.tables,
    ...rawManifest.distributions,
    baselineRawBytes: rawManifest.vector.baselineRawBytes,
    bytesPerEmbedding: rawManifest.vector.bytesPerEmbedding,
    dimensions: rawManifest.vector.dimensions,
    productionIndexes: rawManifest.inventory.productionIndexes,
    productionTables: rawManifest.inventory.productionTables,
    scalarBytes: rawManifest.vector.scalarBytes,
    trackIndexes: rawManifest.inventory.trackIndexes,
  })) {
    assertPositiveInteger(value, label);
  }

  if (rawManifest.tables.findings > rawManifest.tables.tracks) {
    throw new Error("findings cannot outnumber tracks");
  }

  if (rawManifest.tables.trackEmbeddings > rawManifest.tables.tracks) {
    throw new Error("track embeddings cannot outnumber tracks");
  }

  if (rawManifest.tables.trackArtists < rawManifest.tables.tracks) {
    throw new Error("the audited fixture requires at least one artist edge per track");
  }

  if (rawManifest.distributions.pendingFrontier > rawManifest.tables.crawlFrontier) {
    throw new Error("pending frontier rows cannot outnumber the frontier");
  }

  if (
    rawManifest.vector.baselineRawBytes !==
    rawManifest.tables.trackEmbeddings * rawManifest.vector.bytesPerEmbedding
  ) {
    throw new Error("baseline vector footprint must derive from embedding count and row width");
  }

  if (rawManifest.inventory.sqliteStat1Available || rawManifest.inventory.sqliteStat4Available) {
    throw new Error("the audited hosted planner has no sqlite_stat1 or sqlite_stat4 statistics");
  }
}

assertRawManifest();

export const DATABASE_PERFORMANCE_MANIFEST = Object.freeze(rawManifest);

export function isScaleProfile(value: string): value is ScaleProfile {
  return SCALE_PROFILES.some((profile) => profile === value);
}

export function getScaleManifest(profile: ScaleProfile): ScaleManifest {
  const multiplier = DATABASE_PERFORMANCE_MANIFEST.profiles[profile] as 1 | 2 | 4;
  const scale = (value: number): number => value * multiplier;

  return {
    baseline: {
      databaseSizeMb: DATABASE_PERFORMANCE_MANIFEST.databaseSizeMb,
      inventory: DATABASE_PERFORMANCE_MANIFEST.inventory,
    },
    counts: {
      albums: scale(DATABASE_PERFORMANCE_MANIFEST.tables.albums),
      artists: scale(DATABASE_PERFORMANCE_MANIFEST.tables.artists),
      crawlFrontier: scale(DATABASE_PERFORMANCE_MANIFEST.tables.crawlFrontier),
      enabledLabelTracks: scale(DATABASE_PERFORMANCE_MANIFEST.distributions.enabledLabelTracks),
      findings: scale(DATABASE_PERFORMANCE_MANIFEST.tables.findings),
      fullAnalysisBacklog: scale(DATABASE_PERFORMANCE_MANIFEST.distributions.fullAnalysisBacklog),
      labels: scale(DATABASE_PERFORMANCE_MANIFEST.tables.labels),
      musicbrainzIsrcBacklog: scale(
        DATABASE_PERFORMANCE_MANIFEST.distributions.musicbrainzIsrcBacklog,
      ),
      pendingFrontier: scale(DATABASE_PERFORMANCE_MANIFEST.distributions.pendingFrontier),
      trackArtists: scale(DATABASE_PERFORMANCE_MANIFEST.tables.trackArtists),
      trackEmbeddings: scale(DATABASE_PERFORMANCE_MANIFEST.tables.trackEmbeddings),
      tracks: scale(DATABASE_PERFORMANCE_MANIFEST.tables.tracks),
      youtubeProvenanceBacklog: scale(
        DATABASE_PERFORMANCE_MANIFEST.distributions.youtubeProvenanceBacklog,
      ),
    },
    integrationBase: DATABASE_PERFORMANCE_MANIFEST.integrationBase,
    multiplier,
    profile,
    schemaVersion: DATABASE_PERFORMANCE_MANIFEST.schemaVersion,
    vector: DATABASE_PERFORMANCE_MANIFEST.vector,
  };
}

/**
 * A ratio-preserving derivative for fast local and CI contracts. It is deliberately not called a
 * scale profile: the selected 1x/2x/4x manifest remains in the report while materialized counts are
 * reported separately. Exact profile runs use {@link getScaleManifest} without this derivative.
 */
export function createCiFixtureCounts(profile: ScaleProfile, tracks = 512): FixtureCounts {
  assertPositiveInteger(tracks, "CI track count");

  if (tracks < 2) {
    throw new Error("CI track count must be at least 2");
  }

  const source = getScaleManifest(profile).counts;
  const ratio = (value: number, minimum = 0): number =>
    Math.max(minimum, Math.round((value / source.tracks) * tracks));

  return {
    albums: ratio(source.albums, 1),
    artists: ratio(source.artists, 1),
    crawlFrontier: ratio(source.crawlFrontier, 1),
    enabledLabelTracks: ratio(source.enabledLabelTracks),
    findings: ratio(source.findings, 1),
    fullAnalysisBacklog: ratio(source.fullAnalysisBacklog),
    labels: ratio(source.labels, 1),
    musicbrainzIsrcBacklog: ratio(source.musicbrainzIsrcBacklog),
    pendingFrontier: ratio(source.pendingFrontier),
    trackArtists: ratio(source.trackArtists, tracks),
    trackEmbeddings: ratio(source.trackEmbeddings),
    tracks,
    youtubeProvenanceBacklog: ratio(source.youtubeProvenanceBacklog),
  };
}

export function relevantDistributions(manifest: ScaleManifest): Record<string, number> {
  const { counts } = manifest;

  return {
    certifiedTrackSelectivity: counts.findings / counts.tracks,
    embeddingNullRate: (counts.tracks - counts.trackEmbeddings) / counts.tracks,
    enabledLabelSelectivity: counts.enabledLabelTracks / counts.tracks,
    frontierPendingSelectivity: counts.pendingFrontier / counts.crawlFrontier,
    meanTrackArtistFanout: counts.trackArtists / counts.tracks,
    musicbrainzIsrcBacklogSelectivity: counts.musicbrainzIsrcBacklog / counts.tracks,
    youtubeProvenanceBacklogSelectivity: counts.youtubeProvenanceBacklog / counts.tracks,
  };
}

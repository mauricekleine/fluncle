import { describe, expect, it } from "vitest";

import {
  DATABASE_PERFORMANCE_MANIFEST,
  createCiFixtureCounts,
  getScaleManifest,
  relevantDistributions,
} from "./manifest";

describe("database performance manifest", () => {
  it("pins the audited 1x baseline and integration base", () => {
    const manifest = getScaleManifest("1x");

    expect(manifest.integrationBase).toBe("f0b368203d42a3b92d5b5025c8064e27baa9f632");
    expect(manifest.baseline).toEqual({
      databaseSizeMb: 945,
      inventory: {
        productionIndexes: 147,
        productionTables: 78,
        sqliteStat1Available: false,
        sqliteStat4Available: false,
        trackIndexes: 31,
      },
    });
    expect(manifest.counts).toEqual({
      albums: 27_454,
      artists: 13_543,
      crawlFrontier: 211_980,
      enabledLabelTracks: 117_710,
      findings: 96,
      fullAnalysisBacklog: 0,
      labels: 6_401,
      musicbrainzIsrcBacklog: 44_473,
      pendingFrontier: 130_864,
      trackArtists: 154_551,
      trackEmbeddings: 43_372,
      tracks: 122_151,
      youtubeProvenanceBacklog: 30_260,
    });
    expect(manifest.vector).toEqual({
      baselineRawBytes: 177_651_712,
      bytesPerEmbedding: 4_096,
      dimensions: 1_024,
      scalarBytes: 4,
    });
    expect(DATABASE_PERFORMANCE_MANIFEST.vector.baselineRawBytes).toBe(43_372 * 1_024 * 4);
  });

  it("scales every audited cardinality deterministically to 2x and 4x", () => {
    const baseline = getScaleManifest("1x");

    for (const [profile, multiplier] of [
      ["2x", 2],
      ["4x", 4],
    ] as const) {
      const scaled = getScaleManifest(profile);
      expect(scaled.baseline).toEqual(baseline.baseline);
      expect(scaled.vector).toEqual(baseline.vector);
      for (const key of Object.keys(baseline.counts) as (keyof typeof baseline.counts)[]) {
        expect(scaled.counts[key], `${profile} ${key}`).toBe(baseline.counts[key] * multiplier);
      }
    }
  });

  it("records selectivity, fan-out, null, and backlog distributions", () => {
    const distributions = relevantDistributions(getScaleManifest("1x"));

    expect(distributions.meanTrackArtistFanout).toBe(154_551 / 122_151);
    expect(distributions.certifiedTrackSelectivity).toBe(96 / 122_151);
    expect(distributions.embeddingNullRate).toBe((122_151 - 43_372) / 122_151);
    expect(distributions.frontierPendingSelectivity).toBe(130_864 / 211_980);
    expect(distributions.enabledLabelSelectivity).toBe(117_710 / 122_151);
    expect(distributions.youtubeProvenanceBacklogSelectivity).toBe(30_260 / 122_151);
    expect(distributions.musicbrainzIsrcBacklogSelectivity).toBe(44_473 / 122_151);
  });

  it("offers a bounded ratio-preserving CI derivative without relabeling it as a profile", () => {
    const counts = createCiFixtureCounts("4x", 512);

    expect(counts.tracks).toBe(512);
    expect(counts.trackArtists).toBeGreaterThanOrEqual(512);
    expect(counts.findings).toBe(5);
    expect(counts.crawlFrontier).toBeLessThan(1_000);
  });
});

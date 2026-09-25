import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

let db: Client;

const lookupSpotifyIdsByMbid = vi.fn();
const fetchTrackMetadata = vi.fn();
const searchDeezerCandidates = vi.fn();

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./listenbrainz", () => ({
  lookupSpotifyIdsByMbid: async (...args: unknown[]) => {
    const result = await lookupSpotifyIdsByMbid(...args);

    if (result === null) {
      return { outcome: "no-map" };
    }

    if (typeof result === "object" && result !== null && "outcome" in result) {
      return result;
    }

    return { match: result, outcome: "match" };
  },
}));

vi.mock("./spotify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify")>();

  return { ...actual, fetchTrackMetadata: (...args: unknown[]) => fetchTrackMetadata(...args) };
});

vi.mock("./deezer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deezer")>();

  return {
    ...actual,
    searchDeezerCandidates: (...args: unknown[]) => searchDeezerCandidates(...args),
  };
});

const text = (value: unknown): string => (typeof value === "string" ? value : "");

async function seedCatalogue(row: {
  artists?: string[];
  durationMs?: number;
  isrc?: null | string;
  mbid?: null | string;
  title?: string;
  trackId: string;
}): Promise<void> {
  await db.execute({
    args: [
      row.trackId,
      row.title ?? "Weightless",
      JSON.stringify(row.artists ?? ["Etherwood"]),
      row.durationMs ?? 261_901,
      row.isrc ?? null,
      row.mbid ?? null,
    ],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, isrc, mb_recording_id)
          values (?, ?, ?, ?, ?, ?)`,
  });
}

async function anchorState(trackId: string): Promise<{
  attempted: unknown;
  deezerAttemptedAt: unknown;
  deezerAttempts: unknown;
  deezerDoneAt: unknown;
  deezerFailures: unknown;
  deezerTrackId: unknown;
  deezerVerifiedAt: unknown;
  deezerVerifiedBy: unknown;
  isrcRecoveryAttemptedAt: unknown;
  isrc: unknown;
  uri: unknown;
}> {
  const row = await db.execute({
    args: [trackId],
    sql: `select spotify_uri, spotify_anchor_attempted_at, isrc,
                 isrc_recovery_attempted_at,
                 deezer_track_id, deezer_verified_at, deezer_verified_by,
                 backfill_deezer_attempted_at, backfill_deezer_attempts,
                 backfill_deezer_done_at, backfill_deezer_failures
          from tracks where track_id = ?`,
  });

  return {
    attempted: row.rows[0]?.spotify_anchor_attempted_at,
    deezerAttemptedAt: row.rows[0]?.backfill_deezer_attempted_at,
    deezerAttempts: row.rows[0]?.backfill_deezer_attempts,
    deezerDoneAt: row.rows[0]?.backfill_deezer_done_at,
    deezerFailures: row.rows[0]?.backfill_deezer_failures,
    deezerTrackId: row.rows[0]?.deezer_track_id,
    deezerVerifiedAt: row.rows[0]?.deezer_verified_at,
    deezerVerifiedBy: row.rows[0]?.deezer_verified_by,
    isrc: row.rows[0]?.isrc,
    isrcRecoveryAttemptedAt: row.rows[0]?.isrc_recovery_attempted_at,
    uri: row.rows[0]?.spotify_uri,
  };
}

function metadata(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    albumImageUrl: "https://i.scdn.co/image/cover",
    artists: ["Etherwood"],
    durationMs: 261_800,
    isrc: "GBCJY1300173",
    spotifyArtistIds: ["sp-etherwood"],
    spotifyUri: "spotify:track:lbAnchor001",
    spotifyUrl: "https://open.spotify.com/track/lbAnchor001",
    title: "Weightless",
    trackId: "lbAnchor001",
    ...over,
  };
}

beforeEach(async () => {
  db = await createIntegrationDb();
  lookupSpotifyIdsByMbid.mockReset();
  fetchTrackMetadata.mockReset();

  searchDeezerCandidates.mockReset();
  searchDeezerCandidates.mockResolvedValue([]);
});

describe("resolveAnchorFree — a ListenBrainz hit through the verification gate", () => {
  it("anchors + stamps via ISRC-equality, using exactly ONE Spotify metadata read", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ isrc: "gbcjy1300173", mbid: "mbid-1", trackId: "mb_rec-1" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Etherwood",
      recordingMbid: "mbid-1",
      spotifyTrackIds: ["lbAnchor001", "lbAnchor002"],
      trackName: "Weightless",
    });
    fetchTrackMetadata.mockResolvedValue(metadata());

    const result = await resolveAnchorFree("mb_rec-1");

    expect(result).toEqual({
      anchored: true,
      apifyBudgetRemaining: 300,
      apifyEligible: false,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "anchored",
      source: "listenbrainz",
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: "isrc",
    });

    expect(searchDeezerCandidates).not.toHaveBeenCalled();
    const state = await anchorState("mb_rec-1");
    expect(text(state.uri)).toBe("spotify:track:lbAnchor001");
    expect(state.attempted).not.toBeNull();

    expect(fetchTrackMetadata).toHaveBeenCalledTimes(1);
    expect(fetchTrackMetadata).toHaveBeenCalledWith("lbAnchor001");
  });

  it("anchors a no-ISRC row via the folded artist + title + ±3s search triple", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: "mbid-2",
      title: "Dribble",
      trackId: "mb_search",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Muffler",
      recordingMbid: "mbid-2",
      spotifyTrackIds: ["lbDribble"],
      trackName: "Dribble",
    });
    fetchTrackMetadata.mockResolvedValue(
      metadata({
        artists: ["Muffler"],
        durationMs: 201_000,
        isrc: null,
        spotifyArtistIds: ["sp-muffler"],
        title: "Dribble",
        trackId: "lbDribble",
      }),
    );

    const result = await resolveAnchorFree("mb_search");

    expect(result).toEqual({
      anchored: true,
      apifyBudgetRemaining: 300,
      apifyEligible: false,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "anchored",
      source: "listenbrainz",
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: "search",
    });
    expect(text((await anchorState("mb_search")).uri)).toBe("spotify:track:lbDribble");
  });
});

describe("resolveAnchorFree — a candidate that FAILS verification is never stamped", () => {
  it("leaves the row un-anchored AND un-stamped (the Apify fallback keeps its turn)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: "ROWISRC00001",
      mbid: "mbid-3",
      title: "Dribble",
      trackId: "mb_wrong",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Muffler",
      recordingMbid: "mbid-3",
      spotifyTrackIds: ["lbWrong"],
      trackName: "Dribble",
    });
    fetchTrackMetadata.mockResolvedValue(
      metadata({
        artists: ["Muffler"],
        durationMs: 203_500,
        isrc: "OTHERISRC999",
        title: "Dribble",
        trackId: "lbWrong",
      }),
    );

    const result = await resolveAnchorFree("mb_wrong");

    expect(result).toEqual({
      anchored: false,
      apifyBudgetRemaining: 299,
      apifyEligible: true,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "gate-rejected",
      source: null,
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: null,
    });
    const state = await anchorState("mb_wrong");
    expect(state.uri).toBeNull();

    expect(state.attempted).toBeNull();
  });

  it("counts a durationless ListenBrainz candidate without changing its gate rejection", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: "mbid-durationless",
      title: "Dribble",
      trackId: "mb_durationless",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Muffler",
      recordingMbid: "mbid-durationless",
      spotifyTrackIds: ["lbDurationless"],
      trackName: "Dribble",
    });
    fetchTrackMetadata.mockResolvedValue(
      metadata({
        artists: ["Muffler"],
        durationMs: undefined,
        isrc: null,
        title: "Dribble",
        trackId: "lbDurationless",
      }),
    );

    const result = await resolveAnchorFree("mb_durationless");

    expect(result.freeDurationMsOmitted).toBe(1);
    expect(result.listenbrainzOutcome).toBe("gate-rejected");
    expect(result.anchored).toBe(false);
    expect((await anchorState("mb_durationless")).attempted).toBeNull();
  });
});

describe("resolveAnchorFree — the zero-Spotify-call misses", () => {
  it("returns a clean miss with NO vendor call when the row has no recording MBID", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ mbid: null, trackId: "mb_nombid" });

    const result = await resolveAnchorFree("mb_nombid");

    expect(result).toEqual({
      anchored: false,
      apifyBudgetRemaining: 299,
      apifyEligible: true,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-mbid",
      source: null,
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: null,
    });
    expect(lookupSpotifyIdsByMbid).not.toHaveBeenCalled();
    expect(fetchTrackMetadata).not.toHaveBeenCalled();
    expect((await anchorState("mb_nombid")).attempted).toBeNull();
  });

  it("returns a clean miss with NO Spotify call when ListenBrainz has no mapping", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ mbid: "mbid-x", trackId: "mb_lbmiss" });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_lbmiss");

    expect(result).toEqual({
      anchored: false,
      apifyBudgetRemaining: 299,
      apifyEligible: true,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-map",
      source: null,
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: null,
    });
    expect(fetchTrackMetadata).not.toHaveBeenCalled();
    expect((await anchorState("mb_lbmiss")).attempted).toBeNull();
  });

  it("reports a mapped ListenBrainz row whose Spotify id list is empty", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ mbid: "mbid-empty", trackId: "mb_lbempty" });
    lookupSpotifyIdsByMbid.mockResolvedValue({ outcome: "empty-ids" });

    const result = await resolveAnchorFree("mb_lbempty");

    expect(result.listenbrainzOutcome).toBe("empty-ids");
    expect(result.anchored).toBe(false);
    expect(fetchTrackMetadata).not.toHaveBeenCalled();
    expect((await anchorState("mb_lbempty")).attempted).toBeNull();
  });

  it("reports a ListenBrainz request/response failure separately from a clean no-map", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ mbid: "mbid-failed", trackId: "mb_lbfailed" });
    lookupSpotifyIdsByMbid.mockResolvedValue({ outcome: "request-threw" });

    const result = await resolveAnchorFree("mb_lbfailed");

    expect(result.listenbrainzOutcome).toBe("request-failed");
    expect(result.anchored).toBe(false);
    expect(fetchTrackMetadata).not.toHaveBeenCalled();
    expect((await anchorState("mb_lbfailed")).attempted).toBeNull();
  });

  it("returns a clean miss (never throws, never stamps) when the Spotify read fails", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ mbid: "mbid-y", trackId: "mb_sperr" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: null,
      recordingMbid: "mbid-y",
      spotifyTrackIds: ["lbErr"],
      trackName: null,
    });
    fetchTrackMetadata.mockRejectedValue(new Error("Spotify API request failed: 429"));

    const result = await resolveAnchorFree("mb_sperr");

    expect(result).toEqual({
      anchored: false,
      apifyBudgetRemaining: 299,
      apifyEligible: true,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "metadata-failed",
      source: null,
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,

      spotifyThrottled: true,
      stamped: false,
      verifiedBy: null,
    });
    expect((await anchorState("mb_sperr")).attempted).toBeNull();
  });
});

describe("resolveAnchorFree — slice 3: the Apify kill-flag (out-of-budget → graceful state)", () => {
  const NON_FRIDAY = new Date("2026-07-22T12:00:00Z");

  it("flag OFF ⇒ a FULL free-rung miss is STAMPED (backs off) and reports apifyEnabled:false", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "ROWISRC00001", mbid: null, trackId: "mb_apify_off" });

    const result = await resolveAnchorFree("mb_apify_off", NON_FRIDAY);

    expect(result).toEqual({
      anchored: false,

      apifyBudgetRemaining: 300,
      apifyEligible: true,
      apifyEnabled: false,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-mbid",
      source: null,
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,
      spotifyThrottled: false,
      stamped: true,
      verifiedBy: null,
    });
    const state = await anchorState("mb_apify_off");
    expect(state.uri).toBeNull();

    expect(state.attempted).not.toBeNull();
  });

  it("flag ON (default) ⇒ the SAME full miss is NOT stamped and reports apifyEnabled:true (unchanged)", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorApifyEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC00001", mbid: null, trackId: "mb_apify_on" });

    const result = await resolveAnchorFree("mb_apify_on", NON_FRIDAY);

    expect(result).toEqual({
      anchored: false,
      apifyBudgetRemaining: 299,
      apifyEligible: true,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-mbid",
      source: null,
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: null,
    });

    expect((await anchorState("mb_apify_on")).attempted).toBeNull();
  });

  it("flag OFF but a ListenBrainz HIT is never re-stamped (a hit already wrote the anchor + attempt)", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "gbcjy1300173", mbid: "mbid-hit", trackId: "mb_apify_off_hit" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Etherwood",
      recordingMbid: "mbid-hit",
      spotifyTrackIds: ["lbAnchor001"],
      trackName: "Weightless",
    });
    fetchTrackMetadata.mockResolvedValue(metadata());

    const result = await resolveAnchorFree("mb_apify_off_hit", NON_FRIDAY);

    expect(result).toEqual({
      anchored: true,
      apifyBudgetRemaining: 300,
      apifyEligible: false,
      apifyEnabled: false,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "anchored",
      source: "listenbrainz",
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: "isrc",
    });
    const state = await anchorState("mb_apify_off_hit");
    expect(text(state.uri)).toBe("spotify:track:lbAnchor001");
    expect(state.attempted).not.toBeNull();
  });
});

describe("resolveAnchorFree — the pre-anchor Deezer ISRC-recovery rung", () => {
  it("recovers a verified ISRC into an empty row, then anchors via the exact-ISRC rung", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: "mbid-dz",
      title: "Dribble",
      trackId: "mb_dz",
    });
    searchDeezerCandidates.mockResolvedValue([
      { artistName: "Muffler", durationMs: 201_000, isrc: "GBTESTDZ0001", title: "Dribble" },
    ]);
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Muffler",
      recordingMbid: "mbid-dz",
      spotifyTrackIds: ["lbDz"],
      trackName: "Dribble",
    });
    fetchTrackMetadata.mockResolvedValue(
      metadata({
        artists: ["Muffler"],
        durationMs: 201_000,
        isrc: "GBTESTDZ0001",
        title: "Dribble",
        trackId: "lbDz",
      }),
    );

    const result = await resolveAnchorFree("mb_dz");

    expect(result).toEqual({
      anchored: true,
      apifyBudgetRemaining: 300,
      apifyEligible: false,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: true,
      listenbrainzOutcome: "anchored",
      source: "listenbrainz",
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: "isrc",
    });
    const state = await anchorState("mb_dz");

    expect(text(state.isrc)).toBe("GBTESTDZ0001");
    expect(text(state.uri)).toBe("spotify:track:lbDz");
  });

  it("does NOT recover when the Deezer hit fails the fold+duration verification (stays ISRC-less → fuzzy)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: "mbid-dzbad",
      title: "Dribble",
      trackId: "mb_dzbad",
    });

    searchDeezerCandidates.mockResolvedValue([
      { artistName: "Muffler", durationMs: 203_500, isrc: "GBWRONGDZ001", title: "Dribble" },
    ]);
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_dzbad");

    expect(result).toEqual({
      anchored: false,
      apifyBudgetRemaining: 299,
      apifyEligible: true,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "no-map",
      source: null,
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: null,
    });
    const state = await anchorState("mb_dzbad");
    expect(state.isrc).toBeNull();
    expect(state.attempted).toBeNull();
  });

  it("never overwrites a row that already carries an ISRC (recovery is skipped)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: "EXISTINGISRC",
      mbid: "mbid-dzhas",
      title: "Dribble",
      trackId: "mb_dzhas",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_dzhas");

    expect(result.isrcRecoveredByDeezer).toBe(false);

    expect(searchDeezerCandidates).not.toHaveBeenCalled();
    expect(text((await anchorState("mb_dzhas")).isrc)).toBe("EXISTINGISRC");
  });

  it("degrades cleanly to the normal waterfall on a Deezer outage (empty result)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: "mbid-dzout",
      title: "Dribble",
      trackId: "mb_dzout",
    });

    searchDeezerCandidates.mockResolvedValue([]);
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Muffler",
      recordingMbid: "mbid-dzout",
      spotifyTrackIds: ["lbDzOut"],
      trackName: "Dribble",
    });
    fetchTrackMetadata.mockResolvedValue(
      metadata({
        artists: ["Muffler"],
        durationMs: 201_000,
        isrc: null,
        title: "Dribble",
        trackId: "lbDzOut",
      }),
    );

    const result = await resolveAnchorFree("mb_dzout");

    expect(result).toEqual({
      anchored: true,
      apifyBudgetRemaining: 300,
      apifyEligible: false,
      apifyEnabled: true,
      apifyIneligibleReason: null,
      freeDurationMsOmitted: 0,
      isrcRecoveredByDeezer: false,
      listenbrainzOutcome: "anchored",
      source: "listenbrainz",
      spotifyIsrcAsked: false,
      spotifySearchDone: false,
      spotifySearchEnabled: false,
      spotifyThrottled: false,
      stamped: false,
      verifiedBy: "search",
    });
    expect(searchDeezerCandidates).toHaveBeenCalledTimes(1);
    expect(text((await anchorState("mb_dzout")).isrc)).toBeFalsy();
    expect((await anchorState("mb_dzout")).isrcRecoveryAttemptedAt).toBeNull();
  });
});

describe("resolveAnchorFree — Deezer hits supplied by the box", () => {
  it("verifies box-supplied hits and writes the recovered ISRC, without asking Deezer itself", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_ok",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_box_ok", new Date(), {
      deezerCandidates: [
        { artistName: "Muffler", durationMs: 201_000, isrc: "GBBOXDZ00001", title: "Dribble" },
      ],
    });

    expect(result.isrcRecoveredByDeezer).toBe(true);
    const state = await anchorState("mb_box_ok");
    expect(text(state.isrc)).toBe("GBBOXDZ00001");
    expect(state.isrcRecoveryAttemptedAt).not.toBeNull();

    expect(searchDeezerCandidates).not.toHaveBeenCalled();
  });

  it("keeps the verified hit's Deezer id with the rung that cleared", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_dzid",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    await resolveAnchorFree("mb_box_dzid", new Date(), {
      deezerCandidates: [
        {
          artistName: "Muffler",
          deezerTrackId: "3135556",
          durationMs: 201_000,
          isrc: "GBBOXDZ00003",
          title: "Dribble",
        },
      ],
    });

    const state = await anchorState("mb_box_dzid");

    expect(text(state.deezerTrackId)).toBe("3135556");
    expect(text(state.deezerVerifiedBy)).toBe("search");
    expect(state.deezerVerifiedAt).not.toBeNull();

    expect(state.deezerAttemptedAt).not.toBeNull();
    expect(Number(state.deezerAttempts)).toBe(1);
    expect(text(state.deezerDoneAt)).toBe(text(state.deezerVerifiedAt));
    expect(Number(state.deezerFailures)).toBe(0);
  });

  it("keeps NO Deezer id off a hit that failed the gate", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_dzbad",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    await resolveAnchorFree("mb_box_dzbad", new Date(), {
      deezerCandidates: [
        {
          artistName: "Muffler",
          deezerTrackId: "3135557",
          durationMs: 200_000,
          isrc: "GBWRONGVER02",
          title: "Dribble (Calibre Remix)",
        },
      ],
    });

    const state = await anchorState("mb_box_dzbad");

    expect(state.deezerTrackId).toBeNull();
    expect(state.deezerVerifiedBy).toBeNull();
    expect(state.deezerVerifiedAt).toBeNull();
    expect(state.isrcRecoveryAttemptedAt).not.toBeNull();

    expect(state.deezerAttemptedAt).not.toBeNull();
    expect(Number(state.deezerAttempts)).toBe(1);
    expect(state.deezerDoneAt).toBeNull();
    expect(Number(state.deezerFailures)).toBe(0);
  });

  it("settles only the recovery ledger when the box supplied a clean-empty list", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_dzempty",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    await resolveAnchorFree("mb_box_dzempty", new Date(), { deezerCandidates: [] });

    const state = await anchorState("mb_box_dzempty");

    expect(state.deezerAttemptedAt).toBeNull();
    expect(Number(state.deezerAttempts)).toBe(0);
    expect(state.deezerDoneAt).toBeNull();
    expect(state.isrcRecoveryAttemptedAt).not.toBeNull();
  });

  it("recovers the ISRC from a hit an older box sent without an id, and keeps no link", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_dznone",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_box_dznone", new Date(), {
      deezerCandidates: [
        { artistName: "Muffler", durationMs: 200_000, isrc: "GBBOXDZ00004", title: "Dribble" },
      ],
    });

    const state = await anchorState("mb_box_dznone");

    expect(result.isrcRecoveredByDeezer).toBe(true);
    expect(text(state.isrc)).toBe("GBBOXDZ00004");
    expect(state.deezerTrackId).toBeNull();

    expect(state.deezerAttemptedAt).toBeNull();
    expect(Number(state.deezerAttempts)).toBe(0);
    expect(state.deezerDoneAt).toBeNull();
  });

  it("refuses a box-supplied hit that fails the gate — the box cannot bypass verification", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_bad",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_box_bad", new Date(), {
      deezerCandidates: [
        { artistName: "Etherwood", durationMs: 200_000, isrc: "GBWRONGART01", title: "Dribble" },

        {
          artistName: "Muffler",
          durationMs: 200_000,
          isrc: "GBWRONGVER01",
          title: "Dribble (Calibre Remix)",
        },

        { artistName: "Muffler", durationMs: 240_000, isrc: "GBWRONGDUR01", title: "Dribble" },
      ],
    });

    expect(result.isrcRecoveredByDeezer).toBe(false);
    expect((await anchorState("mb_box_bad")).isrc).toBeNull();
    expect(searchDeezerCandidates).not.toHaveBeenCalled();
  });

  it("never overwrites an existing ISRC with a box-supplied one (the server owns the ISRC-less gate)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: "EXISTINGISRC",
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_has",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_box_has", new Date(), {
      deezerCandidates: [
        { artistName: "Muffler", durationMs: 200_000, isrc: "GBBOXDZ00002", title: "Dribble" },
      ],
    });

    expect(result.isrcRecoveredByDeezer).toBe(false);
    expect(text((await anchorState("mb_box_has")).isrc)).toBe("EXISTINGISRC");
  });

  it("an EMPTY supplied list means the box searched and found nothing — the Worker does not re-ask", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_empty",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_box_empty", new Date(), { deezerCandidates: [] });

    expect(result.isrcRecoveredByDeezer).toBe(false);
    expect((await anchorState("mb_box_empty")).isrc).toBeNull();

    expect(searchDeezerCandidates).not.toHaveBeenCalled();
  });

  it("falls back to searching Deezer itself when no hits are supplied (the certify path, unchanged)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      mbid: null,
      title: "Dribble",
      trackId: "mb_box_absent",
    });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);
    searchDeezerCandidates.mockResolvedValue([
      { artistName: "Muffler", durationMs: 200_500, isrc: "GBSELFDZ0001", title: "Dribble" },
    ]);

    const result = await resolveAnchorFree("mb_box_absent");

    expect(result.isrcRecoveredByDeezer).toBe(true);
    expect(searchDeezerCandidates).toHaveBeenCalledTimes(1);
    expect(text((await anchorState("mb_box_absent")).isrc)).toBe("GBSELFDZ0001");
  });
});

async function anchorAttempts(trackId: string): Promise<null | number> {
  const result = await db.execute({
    args: [trackId],
    sql: "select spotify_anchor_attempts from tracks where track_id = ?",
  });
  const value = result.rows[0]?.spotify_anchor_attempts;

  return value === null || value === undefined ? null : Number(value);
}

describe("resolveAnchorFree — an attempt is charged only for a real ask", () => {
  const NON_FRIDAY = new Date("2026-07-22T12:00:00Z");

  it("a ListenBrainz-only miss with NO capable rung armed PARKS the row without charging it", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "ROWISRC00001", mbid: "mbid-unmapped", trackId: "mb_lb_only" });
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_lb_only", NON_FRIDAY);

    expect(result.listenbrainzOutcome).toBe("no-map");
    expect(result.stamped).toBe(true);

    expect((await anchorState("mb_lb_only")).attempted).not.toBeNull();

    expect(await anchorAttempts("mb_lb_only")).toBeNull();
  });

  it("the same row is parked outside the box's ask window too — a deferral of disarmed rungs defers nothing", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");

    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "ROWISRC00002", mbid: null, trackId: "mb_deferred_off" });

    const result = await resolveAnchorFree("mb_deferred_off", NON_FRIDAY, { spotifySearch: false });

    expect(result.stamped).toBe(true);
    expect((await anchorState("mb_deferred_off")).attempted).not.toBeNull();
    expect(await anchorAttempts("mb_deferred_off")).toBeNull();
  });

  it("but a deferral with the search flag ON keeps the row's turn — a later tick really will ask", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorApifyEnabled(false);
    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: "ROWISRC00003", mbid: null, trackId: "mb_deferred_on" });

    const result = await resolveAnchorFree("mb_deferred_on", NON_FRIDAY, { spotifySearch: false });

    expect(result.spotifySearchEnabled).toBe(true);
    expect(result.stamped).toBe(false);
    expect((await anchorState("mb_deferred_on")).attempted).toBeNull();
    expect(await anchorAttempts("mb_deferred_on")).toBeNull();
  });

  it("a row whose ListenBrainz read YIELDED to the breaker is neither parked nor charged", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");
    const { recordSpotifyThrottle, SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES } =
      await import("./spotify-anchor-breaker");

    await setAnchorApifyEnabled(false);
    await seedCatalogue({ isrc: "ROWISRC00004", mbid: "mbid-yield", trackId: "mb_yielded" });
    lookupSpotifyIdsByMbid.mockResolvedValue({
      artistName: "Etherwood",
      recordingMbid: "mbid-yield",
      spotifyTrackIds: ["lbAnchor001"],
      trackName: "Weightless",
    });

    for (let index = 0; index < SPOTIFY_ANCHOR_BREAKER_MAX_FAILURES; index += 1) {
      await recordSpotifyThrottle(NON_FRIDAY.getTime());
    }

    const result = await resolveAnchorFree("mb_yielded", NON_FRIDAY);

    expect(result.listenbrainzOutcome).toBe("yielded-on-breaker");
    expect(result.stamped).toBe(false);
    expect((await anchorState("mb_yielded")).attempted).toBeNull();
    expect(await anchorAttempts("mb_yielded")).toBeNull();
  });

  it("a miss AFTER the Spotify search rungs ran is parked AND charged — that ask was real", async () => {
    const { resolveAnchorFree } = await import("./anchor");
    const { setAnchorApifyEnabled } = await import("./anchor-apify");
    const { setAnchorSpotifySearchEnabled } = await import("./anchor-spotify-search");

    await setAnchorApifyEnabled(false);
    await setAnchorSpotifySearchEnabled(true);
    await seedCatalogue({ isrc: null, mbid: null, trackId: "mb_searched" });

    const result = await resolveAnchorFree("mb_searched", NON_FRIDAY);

    expect(result.spotifySearchDone).toBe(true);
    expect(result.stamped).toBe(true);
    expect((await anchorState("mb_searched")).attempted).not.toBeNull();
    expect(await anchorAttempts("mb_searched")).toBe(1);
  });
});

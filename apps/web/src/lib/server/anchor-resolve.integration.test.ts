import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb } from "./integration-db";

// THE FREE RUNG (`resolveAnchorFree`), against the REAL schema. Its guarantees are statements about
// SQL + the reuse of the anchor gate: on a ListenBrainz hit it fetches ONE candidate's metadata and
// runs it through the SAME verification `anchorTrack` uses, writing the anchor only on a hard match,
// and — crucially — it NEVER stamps a miss (so the Apify fallback still gets its turn on the row).
// The ListenBrainz client and the single Spotify metadata read are the two vendor edges, so they are
// mocked; the database + the verification gate + the stamping are the real thing.

let db: Client;

const lookupSpotifyIdsByMbid = vi.fn();
const fetchTrackMetadata = vi.fn();
const searchDeezerCandidates = vi.fn();

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

vi.mock("./listenbrainz", () => ({
  lookupSpotifyIdsByMbid: (...args: unknown[]) => lookupSpotifyIdsByMbid(...args),
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

/** A libSQL cell → string. */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Insert an UN-ANCHORED catalogue row, optionally carrying a MusicBrainz recording MBID. */
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

/** The anchor + attempt-stamp state of a row, for the assertions. */
async function anchorState(
  trackId: string,
): Promise<{ attempted: unknown; isrc: unknown; uri: unknown }> {
  const row = await db.execute({
    args: [trackId],
    sql: "select spotify_uri, spotify_anchor_attempted_at, isrc from tracks where track_id = ?",
  });

  return {
    attempted: row.rows[0]?.spotify_anchor_attempted_at,
    isrc: row.rows[0]?.isrc,
    uri: row.rows[0]?.spotify_uri,
  };
}

/** A full TrackMetadata for the mocked single by-id Spotify read. */
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
  // Deezer misses by default (the client never throws — an outage IS an empty list), so the
  // pre-anchor recovery rung is a no-op and the pre-Deezer waterfall behaviour is what's asserted.
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
      isrcRecoveredByDeezer: false,
      source: "listenbrainz",
      spotifySearchDone: false,
      verifiedBy: "isrc",
    });
    // The row already carried an ISRC, so the Deezer recovery rung is skipped entirely.
    expect(searchDeezerCandidates).not.toHaveBeenCalled();
    const state = await anchorState("mb_rec-1");
    expect(text(state.uri)).toBe("spotify:track:lbAnchor001");
    expect(state.attempted).not.toBeNull();

    // ONLY the FIRST id's metadata was fetched — the free rung's whole Spotify footprint is one GET.
    expect(fetchTrackMetadata).toHaveBeenCalledTimes(1);
    expect(fetchTrackMetadata).toHaveBeenCalledWith("lbAnchor001");
  });

  it("anchors a no-ISRC row via the folded artist + title + ±2s search triple", async () => {
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
      isrcRecoveredByDeezer: false,
      source: "listenbrainz",
      spotifySearchDone: false,
      verifiedBy: "search",
    });
    expect(text((await anchorState("mb_search")).uri)).toBe("spotify:track:lbDribble");
  });
});

describe("resolveAnchorFree — a candidate that FAILS verification is never stamped", () => {
  it("leaves the row un-anchored AND un-stamped (the Apify fallback keeps its turn)", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    // The row's ISRC and the candidate's differ, AND the candidate's duration is 3s off — so neither
    // the ISRC rung nor the search triple can verify it. It is a genuine miss.
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
      isrcRecoveredByDeezer: false,
      source: null,
      spotifySearchDone: false,
      verifiedBy: null,
    });
    const state = await anchorState("mb_wrong");
    expect(state.uri).toBeNull();
    // THE KEY GUARANTEE: a free-rung miss does NOT stamp the re-ask backoff.
    expect(state.attempted).toBeNull();
  });
});

describe("resolveAnchorFree — the zero-Spotify-call misses", () => {
  it("returns a clean miss with NO vendor call when the row has no recording MBID", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    await seedCatalogue({ mbid: null, trackId: "mb_nombid" });

    const result = await resolveAnchorFree("mb_nombid");

    expect(result).toEqual({
      anchored: false,
      isrcRecoveredByDeezer: false,
      source: null,
      spotifySearchDone: false,
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
      isrcRecoveredByDeezer: false,
      source: null,
      spotifySearchDone: false,
      verifiedBy: null,
    });
    expect(fetchTrackMetadata).not.toHaveBeenCalled();
    expect((await anchorState("mb_lbmiss")).attempted).toBeNull();
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
      isrcRecoveredByDeezer: false,
      source: null,
      spotifySearchDone: false,
      verifiedBy: null,
    });
    expect((await anchorState("mb_sperr")).attempted).toBeNull();
  });
});

describe("resolveAnchorFree — the pre-anchor Deezer ISRC-recovery rung", () => {
  it("recovers a verified ISRC into an empty row, then anchors via the exact-ISRC rung", async () => {
    const { resolveAnchorFree } = await import("./anchor");

    // An ISRC-LESS crawler row. Deezer holds the real ISRC; its search hit matches the row's folded
    // identity + duration (±2s), so it is trusted. The recovered ISRC then equals the ListenBrainz
    // candidate's own metadata ISRC, so the row anchors through the EXACT-ISRC rung (not fuzzy).
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
      isrcRecoveredByDeezer: true,
      source: "listenbrainz",
      spotifySearchDone: false,
      verifiedBy: "isrc",
    });
    const state = await anchorState("mb_dz");
    // The recovered ISRC was persisted, and it drove the anchor.
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
    // A hit whose duration is 3s off the row (> the ±2s bar) — a wrong recording. It must be refused,
    // so its ISRC is never trusted and the row stays ISRC-less.
    searchDeezerCandidates.mockResolvedValue([
      { artistName: "Muffler", durationMs: 203_500, isrc: "GBWRONGDZ001", title: "Dribble" },
    ]);
    lookupSpotifyIdsByMbid.mockResolvedValue(null);

    const result = await resolveAnchorFree("mb_dzbad");

    expect(result).toEqual({
      anchored: false,
      isrcRecoveredByDeezer: false,
      source: null,
      spotifySearchDone: false,
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
    // The recovery rung is gated on an EMPTY ISRC, so Deezer is never even asked.
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
    // The Deezer client swallows an outage into an empty list (it never throws), so recovery is a
    // no-op and the row anchors exactly as it would have without this rung — via the search triple.
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
      isrcRecoveredByDeezer: false,
      source: "listenbrainz",
      spotifySearchDone: false,
      verifiedBy: "search",
    });
    expect(searchDeezerCandidates).toHaveBeenCalledTimes(1);
    expect(text((await anchorState("mb_dzout")).isrc)).toBeFalsy();
  });
});

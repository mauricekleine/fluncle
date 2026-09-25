import { type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as Client | undefined }));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: async () => holder.db };
});

const vendors = vi.hoisted(() => ({
  addTrackToPlaylist: vi.fn(),
  discogsResolveRelease: vi.fn(),
  enrichFromDeezer: vi.fn(),
  fetchTrackMetadata: vi.fn(),
  lookupIsrcFromDeezer: vi.fn(),
}));

vi.mock("./spotify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./spotify")>();

  return {
    ...actual,
    addTrackToPlaylist: vendors.addTrackToPlaylist,
    fetchTrackMetadata: vendors.fetchTrackMetadata,
  };
});

vi.mock("./deezer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./deezer")>();

  return {
    ...actual,
    enrichFromDeezer: vendors.enrichFromDeezer,
    lookupIsrcFromDeezer: vendors.lookupIsrcFromDeezer,
  };
});

vi.mock("./discogs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discogs")>();

  return { ...actual, discogsResolveRelease: vendors.discogsResolveRelease };
});

import { createIntegrationDb } from "./integration-db";
import { publishTrack } from "./publish";
import { ApiError } from "./spotify";

let db: Client;

const SPOTIFY_URL = "https://open.spotify.com/track/1a2b3c4d5e6f7g8h9i0j1k";
const TRACK_ID = "1a2b3c4d5e6f7g8h9i0j1k";

beforeEach(async () => {
  db = await createIntegrationDb();
  holder.db = db;

  vendors.fetchTrackMetadata.mockReset();
  vendors.lookupIsrcFromDeezer.mockReset();
  vendors.enrichFromDeezer.mockReset();
  vendors.discogsResolveRelease.mockReset();
  vendors.addTrackToPlaylist.mockReset();

  vendors.fetchTrackMetadata.mockResolvedValue({
    album: "Blue Lights in the Basement",
    artists: ["Etherwood"],
    durationMs: 300_000,
    isrc: "GBCJY1300173",
    spotifyArtistIds: ["artist-1"],
    spotifyUri: `spotify:track:${TRACK_ID}`,
    spotifyUrl: SPOTIFY_URL,
    title: "Weightless",
    trackId: TRACK_ID,
  });
  vendors.lookupIsrcFromDeezer.mockResolvedValue(undefined);
  vendors.enrichFromDeezer.mockResolvedValue({});
  vendors.discogsResolveRelease.mockResolvedValue({ masterId: 55, releaseId: 6_414_598 });
  vendors.addTrackToPlaylist.mockRejectedValue(new ApiError("fixture_stop", "stop here", 400));
});

afterEach(() => db.close());

async function publishAndRead(): Promise<Record<string, unknown>> {
  await expect(publishTrack(SPOTIFY_URL, { note: "a note" })).rejects.toThrow(/stop here/);

  const result = await db.execute({
    args: [TRACK_ID],
    sql: `select isrc, isrc_attempted_at, in_release_id, in_master_id,
                 backfill_discogs_attempted_at, backfill_discogs_attempts,
                 backfill_discogs_done_at, backfill_discogs_failures,
                 spotify_anchored_at, spotify_anchor_attempted_at,
                 spotify_anchor_source, spotify_anchor_verified_by,
                 deezer_track_id, deezer_verified_at, deezer_verified_by,
                 backfill_deezer_attempted_at, backfill_deezer_attempts,
                 backfill_deezer_done_at, backfill_deezer_failures
          from tracks where track_id = ?`,
  });
  const row = result.rows[0];

  if (!row) {
    throw new Error("publish wrote no track row");
  }

  return row as unknown as Record<string, unknown>;
}

describe("publishTrack — the identity-ledger stamps", () => {
  it("stamps both looks when both land", async () => {
    const row = await publishAndRead();
    expect(vendors.addTrackToPlaylist).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.execute({
          args: [TRACK_ID],
          sql: "select normalized_isrc from track_duplicate_keys where track_id = ?",
        })
      ).rows,
    ).toEqual([{ normalized_isrc: "GBCJY1300173" }]);

    expect(row.isrc).toBe("GBCJY1300173");
    expect(row.isrc_attempted_at).not.toBeNull();
    expect(row.in_release_id).toBe(6_414_598);
    expect(row.in_master_id).toBe(55);
    expect(row.backfill_discogs_attempted_at).not.toBeNull();
    expect(row.backfill_discogs_done_at).not.toBeNull();
    expect(Number(row.backfill_discogs_attempts)).toBe(1);
    expect(Number(row.backfill_discogs_failures)).toBe(0);
  });

  it("rolls back the track and finding when duplicate-key maintenance fails", async () => {
    await db.execute(`create trigger reject_publish_key before insert on track_duplicate_keys
      begin select raise(abort, 'duplicate key rejected'); end`);

    await expect(publishTrack(SPOTIFY_URL, { note: "a note" })).rejects.toThrow(
      /duplicate key rejected/,
    );

    for (const table of ["tracks", "findings", "track_duplicate_keys"]) {
      const result = await db.execute({
        args: [TRACK_ID],
        sql: `select track_id from ${table} where track_id = ?`,
      });
      expect(result.rows).toEqual([]);
    }
    expect(vendors.addTrackToPlaylist).not.toHaveBeenCalled();
  });

  it("is born ANCHORED, with `publish` provenance and the hit time stamped", async () => {
    const row = await publishAndRead();

    expect(row.spotify_anchored_at).not.toBeNull();
    expect(row.spotify_anchor_source).toBe("publish");
    expect(row.spotify_anchor_verified_by).toBe("publish");
    expect(row.spotify_anchor_attempted_at).toBeNull();
  });

  it("stamps the ISRC attempt on a CLEAN MISS — Spotify omitted it and Deezer had none either", async () => {
    vendors.fetchTrackMetadata.mockResolvedValue({
      artists: ["Etherwood"],
      durationMs: 300_000,
      spotifyArtistIds: ["artist-1"],
      spotifyUri: `spotify:track:${TRACK_ID}`,
      spotifyUrl: SPOTIFY_URL,
      title: "Weightless",
      trackId: TRACK_ID,
    });

    const row = await publishAndRead();

    expect(vendors.lookupIsrcFromDeezer).toHaveBeenCalledTimes(1);
    expect(row.isrc).toBeNull();
    expect(row.isrc_attempted_at).not.toBeNull();
  });

  it("keeps the by-ISRC enrichment's Deezer id once the duration confirms it", async () => {
    vendors.enrichFromDeezer.mockResolvedValue({ deezerTrackId: "3135556", label: "Med School" });

    const row = await publishAndRead();

    expect(row.deezer_track_id).toBe("3135556");
    expect(row.deezer_verified_by).toBe("isrc");
    expect(row.deezer_verified_at).not.toBeNull();
    expect(vendors.enrichFromDeezer).toHaveBeenCalledWith("GBCJY1300173", 300_000);
  });

  it("keeps nothing when neither read produced a gated id", async () => {
    const row = await publishAndRead();

    expect(row.deezer_track_id).toBeNull();
    expect(row.deezer_verified_at).toBeNull();
    expect(row.deezer_verified_by).toBeNull();
  });

  it("stamps NO Deezer attempt ledger at publish — neither read can report a conclusion", async () => {
    const row = await publishAndRead();

    expect(row.backfill_deezer_attempted_at).toBeNull();
    expect(Number(row.backfill_deezer_attempts)).toBe(0);
    expect(row.backfill_deezer_done_at).toBeNull();
    expect(Number(row.backfill_deezer_failures)).toBe(0);
  });

  it("prefers the by-name hit that cleared artist, title, AND length", async () => {
    vendors.fetchTrackMetadata.mockResolvedValue({
      artists: ["Etherwood"],
      durationMs: 300_000,
      spotifyArtistIds: ["artist-1"],
      spotifyUri: `spotify:track:${TRACK_ID}`,
      spotifyUrl: SPOTIFY_URL,
      title: "Weightless",
      trackId: TRACK_ID,
    });
    vendors.lookupIsrcFromDeezer.mockResolvedValue({
      artistName: "Etherwood",
      deezerTrackId: "916424",
      durationMs: 300_000,
      isrc: "GBCJY1300173",
      title: "Weightless",
    });
    vendors.enrichFromDeezer.mockResolvedValue({ deezerTrackId: "3135556" });

    const row = await publishAndRead();

    expect(row.isrc).toBe("GBCJY1300173");
    expect(row.deezer_track_id).toBe("916424");
    expect(row.deezer_verified_by).toBe("search");
  });

  it("refuses a by-name hit that is a different recording, and still takes its ISRC", async () => {
    vendors.fetchTrackMetadata.mockResolvedValue({
      artists: ["Etherwood"],
      durationMs: 300_000,
      spotifyArtistIds: ["artist-1"],
      spotifyUri: `spotify:track:${TRACK_ID}`,
      spotifyUrl: SPOTIFY_URL,
      title: "Weightless",
      trackId: TRACK_ID,
    });
    vendors.lookupIsrcFromDeezer.mockResolvedValue({
      artistName: "Etherwood",
      deezerTrackId: "916424",
      durationMs: 300_000,
      isrc: "GBCJY1300173",
      title: "Weightless (Lung Remix)",
    });
    vendors.enrichFromDeezer.mockResolvedValue({});

    const row = await publishAndRead();

    expect(row.isrc).toBe("GBCJY1300173");
    expect(row.deezer_track_id).toBeNull();
    expect(row.deezer_verified_by).toBeNull();
  });

  it("records a Discogs look that found nothing as attempted-but-not-done", async () => {
    vendors.discogsResolveRelease.mockResolvedValue({});

    const row = await publishAndRead();

    expect(row.in_release_id).toBeNull();
    expect(row.backfill_discogs_attempted_at).not.toBeNull();
    expect(Number(row.backfill_discogs_attempts)).toBe(1);
    expect(row.backfill_discogs_done_at).toBeNull();
  });

  it("leaves the Discogs record UNTOUCHED when the vendor throttled us — that is not an answer", async () => {
    vendors.discogsResolveRelease.mockResolvedValue({ rateLimited: true });

    const row = await publishAndRead();

    expect(row.in_release_id).toBeNull();
    expect(row.backfill_discogs_attempted_at).toBeNull();
    expect(row.backfill_discogs_done_at).toBeNull();
    expect(Number(row.backfill_discogs_attempts)).toBe(0);
    expect(row.isrc_attempted_at).not.toBeNull();
  });
});

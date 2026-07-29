// The PUBLISH path's identity-ledger stamps (RFC dnb-identity-graph, Unit 1 items 1–2), proven
// against the REAL migrated schema on an in-memory libSQL engine.
//
// A finding is born from two concluded looks — Spotify's `external_ids` (with the Deezer fallback
// behind it) for the ISRC, and a Discogs release resolve — and both must be written down in the
// SAME insert that records their answers. This is an INTEGRATION test because the thing that can
// break is the insert itself: `publishTrack`'s tracks statement is a positional column/arg list,
// and nothing else in the suite executes it, so a misaligned stamp would ship silently and only
// surface the next time the operator added a banger.
//
// The vendors are mocked at their module boundaries (there is no network). The publish is driven
// only as far as the tracks+findings batch: the Spotify playlist add is made to fail, which throws
// AFTER the rows are written — so the assertions read exactly what the insert laid down.

import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

// `ApiError` and `parseSpotifyTrackUrl` stay REAL — the publish path's control flow is built on
// them, and a fake would test the fake.
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
  // The publish stops here, after the rows are written — everything asserted below is already in.
  vendors.addTrackToPlaylist.mockRejectedValue(new Error("stop here"));
});

/** Drive the publish to its (deliberate) Spotify failure and read back the row it laid down. */
async function publishAndRead(): Promise<Record<string, unknown>> {
  await expect(publishTrack(SPOTIFY_URL, { note: "a note" })).rejects.toThrow();

  const result = await db.execute({
    args: [TRACK_ID],
    sql: `select isrc, isrc_attempted_at, in_release_id, in_master_id,
                 backfill_discogs_attempted_at, backfill_discogs_attempts,
                 backfill_discogs_done_at, backfill_discogs_failures,
                 spotify_anchored_at, spotify_anchor_attempted_at,
                 spotify_anchor_source, spotify_anchor_verified_by
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

    expect(row.isrc).toBe("GBCJY1300173");
    expect(row.isrc_attempted_at).not.toBeNull();
    expect(row.in_release_id).toBe(6_414_598);
    expect(row.in_master_id).toBe(55);
    expect(row.backfill_discogs_attempted_at).not.toBeNull();
    expect(row.backfill_discogs_done_at).not.toBeNull();
    expect(Number(row.backfill_discogs_attempts)).toBe(1);
    expect(Number(row.backfill_discogs_failures)).toBe(0);
  });

  it("is born ANCHORED — the hit time stamped, the last-attempt stamp left null", async () => {
    // A finding's Spotify id came from the operator's URL and was re-read through Spotify's own
    // API, so the moment publish writes the row IS the moment the link was verified. The anchor
    // GATE never ran, so the last-attempt stamp beside it stays null rather than putting a
    // publish-born row into the re-ask backoff's reading — and the provenance pair stays null
    // because publish records no rung.
    const row = await publishAndRead();

    expect(row.spotify_anchored_at).not.toBeNull();
    expect(row.spotify_anchor_attempted_at).toBeNull();
    expect(row.spotify_anchor_source).toBeNull();
    expect(row.spotify_anchor_verified_by).toBeNull();
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

    // No ISRC anywhere — and the row says so out loud rather than staying ambiguous.
    expect(vendors.lookupIsrcFromDeezer).toHaveBeenCalledTimes(1);
    expect(row.isrc).toBeNull();
    expect(row.isrc_attempted_at).not.toBeNull();
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

    // A 429 means we never got to ask. The row stays genuinely unattempted, so a later sweep
    // still owes it a look — the opposite of the clean-miss case above.
    expect(row.in_release_id).toBeNull();
    expect(row.backfill_discogs_attempted_at).toBeNull();
    expect(row.backfill_discogs_done_at).toBeNull();
    expect(Number(row.backfill_discogs_attempts)).toBe(0);
    // The ISRC look concluded regardless — the two are independent.
    expect(row.isrc_attempted_at).not.toBeNull();
  });
});

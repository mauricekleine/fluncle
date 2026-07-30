// The PUBLISH path's identity-ledger stamps (RFC dnb-identity-graph, Unit 1 items 1–2), proven
// against the REAL migrated schema on an in-memory libSQL engine.
//
// A finding is born from two concluded looks — Spotify's `external_ids` (with the Deezer fallback
// behind it) for the ISRC, and a Discogs release resolve — plus the Deezer link those Deezer reads
// were already standing on, and all of it must be written down in the SAME insert that records
// their answers. This is an INTEGRATION test because the thing that can
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
                 spotify_anchor_source, spotify_anchor_verified_by,
                 deezer_track_id, deezer_verified_at, deezer_verified_by
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

  it("is born ANCHORED, with `publish` provenance and the hit time stamped", async () => {
    // A finding's Spotify id came from the operator's URL and was re-read through Spotify's own
    // API, so the moment publish writes the row IS the moment the link was verified, and the
    // platform's own record is the signal. These are the best-provenance links in the archive and
    // must never read `unknown-legacy`.
    const row = await publishAndRead();

    expect(row.spotify_anchored_at).not.toBeNull();
    expect(row.spotify_anchor_source).toBe("publish");
    expect(row.spotify_anchor_verified_by).toBe("publish");
    // The anchor GATE never ran, so the last-attempt stamp stays null rather than putting a
    // publish-born row into the re-ask backoff's reading.
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

    // No ISRC anywhere — and the row says so out loud rather than staying ambiguous.
    expect(vendors.lookupIsrcFromDeezer).toHaveBeenCalledTimes(1);
    expect(row.isrc).toBeNull();
    expect(row.isrc_attempted_at).not.toBeNull();
  });

  // ── THE DEEZER LINK (schema.ts § `deezer_track_id`) ─────────────────────────────────────────
  // Publish reads Deezer twice and both reads have always carried Deezer's own track id: the
  // by-name ISRC fallback, and the by-ISRC label/preview enrichment. Keeping the id is free; keeping
  // an UNVERIFIED one would put a wrong link on a public page under a recording's name, so each read
  // has its own gate and the row records which one cleared.
  it("keeps the by-ISRC enrichment's Deezer id once the duration confirms it", async () => {
    vendors.enrichFromDeezer.mockResolvedValue({ deezerTrackId: "3135556", label: "Med School" });

    const row = await publishAndRead();

    expect(row.deezer_track_id).toBe("3135556");
    expect(row.deezer_verified_by).toBe("isrc");
    expect(row.deezer_verified_at).not.toBeNull();
    // The guard lives in the client, and publish is what hands it the duration to guard with.
    expect(vendors.enrichFromDeezer).toHaveBeenCalledWith("GBCJY1300173", 300_000);
  });

  it("keeps nothing when neither read produced a gated id", async () => {
    // The default fixture: Spotify carried the ISRC (so the by-name rung never ran) and the
    // enrichment came back without an id (its duration guard did not clear). A row with no link is
    // the honest answer, and the provenance columns stay null WITH it rather than half-written.
    const row = await publishAndRead();

    expect(row.deezer_track_id).toBeNull();
    expect(row.deezer_verified_at).toBeNull();
    expect(row.deezer_verified_by).toBeNull();
  });

  it("prefers the by-name hit that cleared artist, title, AND length", async () => {
    // Spotify omits the ISRC, so the by-name rung runs and its hit clears the anchor's own identity
    // fold. That is a stronger check than the by-ISRC endpoint's duration confirm, so it wins the
    // tie and the row says `search` rather than `isrc`.
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
    // Deezer's search is fuzzy and will lead with a remix. The ISRC still lands (it gets re-checked
    // downstream by ISRC equality), but no link is kept off a hit that failed the fold — a miss is
    // always preferred to a wrong link.
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

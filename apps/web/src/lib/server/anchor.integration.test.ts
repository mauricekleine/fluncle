import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createIntegrationDb, seedTrack } from "./integration-db";

// THE SPOTIFY ANCHOR, against the REAL schema. anchorTrack's guarantees are all statements about
// SQL — the two verification rungs, the three rails, the attempt stamp, the artist link — so a
// mocked database would prove none of them. These run the actual writes against the in-memory
// libSQL database built from the generated migrations. The anchor worklist (track-work.ts
// `kind: "anchor"`) is exercised here too, since its ordering + backoff are also pure SQL.

let db: Client;

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();

  return { ...actual, getDb: () => Promise.resolve(db) };
});

const DIMS = 1024;
const NOW = "2026-07-18T00:00:00.000Z";

/** A libSQL cell → string (its value type is a union). */
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** A 1024-d zero vector — enough to make `embedding_blob is not null` true for the order test. */
function zeroVector(): number[] {
  return Array.from<number>({ length: DIMS }).fill(0);
}

/** Insert an UN-ANCHORED catalogue row (spotify_uri NULL — the anchor worklist's shape). */
async function seedUnanchored(row: {
  artists?: string[];
  durationMs?: number;
  isrc?: null | string;
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
    ],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms, isrc)
          values (?, ?, ?, ?, ?)`,
  });
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("anchorTrack — the exact-ISRC rung", () => {
  it("anchors on an ISRC match, stamps the attempt, and links the artists by stable id", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({ artists: ["Etherwood"], isrc: "GBCJY1300173", trackId: "mb_rec-1" });

    const result = await anchorTrack("mb_rec-1", [
      {
        albumImageUrl: "https://i.scdn.co/image/cover",
        artists: [{ id: "sp-etherwood", name: "Etherwood" }],
        durationMs: 261_800,
        isrc: "gbcjy1300173",
        spotifyTrackId: "spotAnchor001",
        title: "Weightless",
      },
    ]);

    expect(result).toEqual({ anchored: true, verifiedBy: "isrc" });

    const row = await db.execute(
      "select spotify_uri, spotify_url, album_image_url, spotify_anchor_attempted_at from tracks where track_id = 'mb_rec-1'",
    );
    expect(text(row.rows[0]?.spotify_uri)).toBe("spotify:track:spotAnchor001");
    expect(text(row.rows[0]?.spotify_url)).toBe("https://open.spotify.com/track/spotAnchor001");
    expect(text(row.rows[0]?.album_image_url)).toBe("https://i.scdn.co/image/cover");
    expect(row.rows[0]?.spotify_anchor_attempted_at).not.toBeNull();

    // The artist was minted (folded on the stable id) and the edge stamped — and NO finding.
    const artist = await db.execute(
      "select id from artists where spotify_artist_id = 'sp-etherwood'",
    );
    expect(artist.rows.length).toBe(1);
    const link = await db.execute({
      args: [text(artist.rows[0]?.id)],
      sql: "select 1 from track_artists where track_id = 'mb_rec-1' and artist_id = ?",
    });
    expect(link.rows.length).toBe(1);
    expect(Number((await db.execute("select count(*) as n from findings")).rows[0]?.n)).toBe(0);
  });

  it("picks the closest duration when several candidates share the ISRC (a re-press)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({ durationMs: 261_901, isrc: "GBCJY1300173", trackId: "mb_press" });

    const result = await anchorTrack("mb_press", [
      {
        artists: [],
        durationMs: 200_000,
        isrc: "GBCJY1300173",
        spotifyTrackId: "wrong-press",
        title: "Weightless",
      },
      {
        artists: [],
        durationMs: 261_500,
        isrc: "GBCJY1300173",
        spotifyTrackId: "true-press",
        title: "Weightless",
      },
    ]);

    expect(result.verifiedBy).toBe("isrc");
    const row = await db.execute("select spotify_uri from tracks where track_id = 'mb_press'");
    expect(text(row.rows[0]?.spotify_uri)).toBe("spotify:track:true-press");
  });
});

describe("anchorTrack — the verified-search rung", () => {
  it("anchors a no-ISRC row via the folded artist + title + ±2s triple", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Muffler"],
      durationMs: 200_000,
      isrc: null,
      title: "Dribble",
      trackId: "mb_search",
    });

    const result = await anchorTrack("mb_search", [
      {
        artists: [{ id: "sp-muffler", name: "Muffler" }],
        durationMs: 201_000,
        isrc: null,
        spotifyTrackId: "spotDribble",
        title: "Dribble",
      },
    ]);

    expect(result).toEqual({ anchored: true, verifiedBy: "search" });
    const row = await db.execute("select spotify_uri from tracks where track_id = 'mb_search'");
    expect(text(row.rows[0]?.spotify_uri)).toBe("spotify:track:spotDribble");
  });

  it("recovers the candidate's ISRC into an ISRC-LESS row (the MusicBrainz-gap backfill)", async () => {
    const { anchorTrack } = await import("./anchor");

    // A no-ISRC row (MusicBrainz never carried one) anchored via the search rung — the candidate
    // carries the real ISRC Spotify knows, so it fills the empty column.
    await seedUnanchored({
      artists: ["Recover Me"],
      durationMs: 200_000,
      isrc: null,
      title: "Found It",
      trackId: "mb_recover",
    });

    const result = await anchorTrack("mb_recover", [
      {
        artists: [{ name: "Recover Me" }],
        durationMs: 200_500,
        isrc: "GB1234567890",
        spotifyTrackId: "spotFound",
        title: "Found It",
      },
    ]);

    expect(result).toEqual({ anchored: true, verifiedBy: "search" });
    const row = await db.execute("select isrc from tracks where track_id = 'mb_recover'");
    expect(text(row.rows[0]?.isrc)).toBe("GB1234567890");
  });

  it("NEVER overwrites a row's existing ISRC with the candidate's (fill-empty-only)", async () => {
    const { anchorTrack } = await import("./anchor");

    // The row already carries its own ISRC; a search-verified candidate with a DIFFERENT ISRC (a
    // re-press) must anchor without clobbering the row's authoritative value.
    await seedUnanchored({
      artists: ["Keep Mine"],
      durationMs: 200_000,
      isrc: "ORIGINAL0001",
      title: "Mine",
      trackId: "mb_keep",
    });

    const result = await anchorTrack("mb_keep", [
      {
        artists: [{ name: "Keep Mine" }],
        durationMs: 200_400,
        isrc: "REPRESS00002",
        spotifyTrackId: "spotMine",
        title: "Mine",
      },
    ]);

    expect(result).toEqual({ anchored: true, verifiedBy: "search" });
    const row = await db.execute("select isrc from tracks where track_id = 'mb_keep'");
    expect(text(row.rows[0]?.isrc)).toBe("ORIGINAL0001");
  });

  it("falls through to the search rung when the row HAS an ISRC but no candidate carries it", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Artist X"],
      durationMs: 200_000,
      isrc: "COMPILATION01",
      title: "Comp Cut",
      trackId: "mb_isrc-miss",
    });

    // The candidate's ISRC is a different pressing's, so the ISRC rung misses — but the triple verifies.
    const result = await anchorTrack("mb_isrc-miss", [
      {
        artists: [{ name: "Artist X" }],
        durationMs: 199_500,
        isrc: "OTHERISRC99",
        spotifyTrackId: "spotComp",
        title: "Comp Cut",
      },
    ]);

    expect(result.verifiedBy).toBe("search");
    const row = await db.execute("select spotify_uri from tracks where track_id = 'mb_isrc-miss'");
    expect(text(row.rows[0]?.spotify_uri)).toBe("spotify:track:spotComp");
  });
});

describe("anchorTrack — a miss stamps the attempt but writes no anchor", () => {
  it("leaves spotify_uri null and stamps spotify_anchor_attempted_at (the re-ask backoff)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Muffler"],
      durationMs: 200_000,
      title: "Dribble",
      trackId: "mb_miss",
    });

    // Right title/artist but 3s off — the triple refuses it, and there is no ISRC to match.
    const result = await anchorTrack("mb_miss", [
      {
        artists: [{ name: "Muffler" }],
        durationMs: 203_500,
        spotifyTrackId: "spotFar",
        title: "Dribble",
      },
    ]);

    expect(result).toEqual({ anchored: false, verifiedBy: null });
    const row = await db.execute(
      "select spotify_uri, spotify_anchor_attempted_at from tracks where track_id = 'mb_miss'",
    );
    expect(row.rows[0]?.spotify_uri).toBeNull();
    expect(row.rows[0]?.spotify_anchor_attempted_at).not.toBeNull();
  });
});

describe("anchorTrack — the rails", () => {
  it("throws not_found for an unknown track", async () => {
    const { anchorTrack, AnchorTrackError } = await import("./anchor");

    const error = await anchorTrack("nope", []).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AnchorTrackError);
    expect((error as { reason: string }).reason).toBe("not_found");
  });

  it("throws certified for a finding (its Spotify id is its identity, not an anchor to fill)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedTrack(db, { logId: "004.7.2I", title: "Certified", trackId: "spotifyCertified001" });

    await expect(anchorTrack("spotifyCertified001", [])).rejects.toMatchObject({
      reason: "certified",
    });
  });

  it("throws already_anchored when the row already carries a spotify_uri (a race)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({ trackId: "mb_already" });
    await db.execute(
      "update tracks set spotify_uri = 'spotify:track:existing' where track_id = 'mb_already'",
    );

    await expect(anchorTrack("mb_already", [])).rejects.toMatchObject({
      reason: "already_anchored",
    });
  });
});

describe("the anchor worklist (track-work.ts kind: anchor)", () => {
  it("orders embedded rows first, then nearest_finding_score DESC, then track_id", async () => {
    const { listTrackWork } = await import("./track-work");

    // C: embedded (no score) — must lead by the first key, ahead of the higher-scored B.
    await seedUnanchored({ title: "Embedded", trackId: "mb_c-embedded" });
    await db.execute({
      args: [JSON.stringify(zeroVector())],
      sql: "update tracks set embedding_blob = vector32(?) where track_id = 'mb_c-embedded'",
    });
    // B: not embedded, high score.
    await seedUnanchored({ title: "Ranked", trackId: "mb_b-ranked" });
    await db.execute(
      "update tracks set nearest_finding_score = 0.9 where track_id = 'mb_b-ranked'",
    );
    // A: not embedded, no score — the tail.
    await seedUnanchored({ title: "Unranked", trackId: "mb_a-unranked" });

    const work = await listTrackWork({ kind: "anchor", limit: 10 });

    expect(work.map((item) => item.trackId)).toEqual([
      "mb_c-embedded",
      "mb_b-ranked",
      "mb_a-unranked",
    ]);
    // Each row carries a ready-made query so the box never builds one.
    expect(work[0]?.anchorQuery).toBe("Etherwood Embedded");
  });

  it("excludes anchored, certified, dismissed, duplicate, zero-duration, and recently-attempted rows", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedUnanchored({ trackId: "mb_ok" }); // the one that should surface
    // Already anchored.
    await seedUnanchored({ trackId: "mb_anchored" });
    await db.execute(
      "update tracks set spotify_uri = 'spotify:track:x' where track_id = 'mb_anchored'",
    );
    // Certified (a finding).
    await seedTrack(db, { logId: "001.1.1A", trackId: "spotifyFinding001" });
    await db.execute("update tracks set spotify_uri = null where track_id = 'spotifyFinding001'");
    // Dismissed.
    await seedUnanchored({ trackId: "mb_dismissed" });
    await db.execute("update tracks set dismissed_at = ? where track_id = 'mb_dismissed'", [NOW]);
    // A known duplicate of a finding.
    await seedUnanchored({ trackId: "mb_dup" });
    await db.execute("update tracks set duplicate_of_track_id = 'x' where track_id = 'mb_dup'");
    // Zero measured duration — can never clear the triple.
    await seedUnanchored({ durationMs: 0, trackId: "mb_nodur" });
    // Attempted 2 days ago — inside the 14-day backoff.
    await seedUnanchored({ trackId: "mb_recent" });
    await db.execute(
      "update tracks set spotify_anchor_attempted_at = ? where track_id = 'mb_recent'",
      [new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()],
    );

    const work = await listTrackWork({ kind: "anchor", limit: 50 });

    expect(work.map((item) => item.trackId)).toEqual(["mb_ok"]);
  });

  it("re-offers a row attempted longer ago than the backoff window", async () => {
    const { listTrackWork } = await import("./track-work");
    const { ANCHOR_REASK_AFTER_DAYS } = await import("./track-work");

    await seedUnanchored({ trackId: "mb_stale" });
    await db.execute(
      "update tracks set spotify_anchor_attempted_at = ? where track_id = 'mb_stale'",
      [new Date(Date.now() - (ANCHOR_REASK_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString()],
    );

    const work = await listTrackWork({ kind: "anchor", limit: 50 });

    expect(work.map((item) => item.trackId)).toContain("mb_stale");
  });
});

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
      "select spotify_uri, spotify_url, album_image_url, spotify_anchor_attempted_at, spotify_anchor_attempts from tracks where track_id = 'mb_rec-1'",
    );
    expect(text(row.rows[0]?.spotify_uri)).toBe("spotify:track:spotAnchor001");
    expect(text(row.rows[0]?.spotify_url)).toBe("https://open.spotify.com/track/spotAnchor001");
    expect(text(row.rows[0]?.album_image_url)).toBe("https://i.scdn.co/image/cover");
    expect(row.rows[0]?.spotify_anchor_attempted_at).not.toBeNull();
    // The retry counter moves with the stamp on a HIT too — one attempt, one bump, from a NULL start.
    expect(Number(row.rows[0]?.spotify_anchor_attempts)).toBe(1);

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
      "select spotify_uri, spotify_anchor_attempted_at, spotify_anchor_attempts from tracks where track_id = 'mb_miss'",
    );
    expect(row.rows[0]?.spotify_uri).toBeNull();
    expect(row.rows[0]?.spotify_anchor_attempted_at).not.toBeNull();
    // A NULL counter reads as zero, so the first miss lands on 1 (no `.default()` on the column).
    expect(Number(row.rows[0]?.spotify_anchor_attempts)).toBe(1);
  });

  it("ACCUMULATES the retry counter across attempts, so the cap can be reached", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Muffler"],
      durationMs: 200_000,
      title: "Dribble",
      trackId: "mb_again",
    });
    await db.execute("update tracks set spotify_anchor_attempts = 4 where track_id = 'mb_again'");

    await anchorTrack("mb_again", [
      {
        artists: [{ name: "Muffler" }],
        durationMs: 203_500,
        spotifyTrackId: "spotFar",
        title: "Dribble",
      },
    ]);

    const row = await db.execute(
      "select spotify_anchor_attempts from tracks where track_id = 'mb_again'",
    );
    expect(Number(row.rows[0]?.spotify_anchor_attempts)).toBe(5);
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

  it("RETIRES a row at the retry cap and still offers the one below it", async () => {
    const { ANCHOR_MAX_ATTEMPTS, listTrackWork } = await import("./track-work");

    // At the cap — out of the queue for good, however long ago it was last attempted.
    await seedUnanchored({ title: "Spent", trackId: "mb_capped" });
    await db.execute("update tracks set spotify_anchor_attempts = ? where track_id = 'mb_capped'", [
      ANCHOR_MAX_ATTEMPTS,
    ]);
    // One below the cap — still has a try left.
    await seedUnanchored({ title: "One Left", trackId: "mb_nearly" });
    await db.execute("update tracks set spotify_anchor_attempts = ? where track_id = 'mb_nearly'", [
      ANCHOR_MAX_ATTEMPTS - 1,
    ]);
    // Never attempted — a NULL counter must read as zero, not drop the row.
    await seedUnanchored({ title: "Fresh", trackId: "mb_null_attempts" });

    const work = await listTrackWork({ kind: "anchor", limit: 50 });
    const ids = work.map((item) => item.trackId);

    expect(ids).not.toContain("mb_capped");
    expect(ids).toContain("mb_nearly");
    expect(ids).toContain("mb_null_attempts");
  });

  it("excludes an UNANCHORABLE sole credit, and keeps a multi-artist credit that carries a real name", async () => {
    const { listTrackWork } = await import("./track-work");

    await seedUnanchored({ artists: ["Unknown Artist"], trackId: "mb_unknown" });
    await seedUnanchored({ artists: ["Various Artists"], trackId: "mb_various" });
    await seedUnanchored({ artists: ["VA"], trackId: "mb_va" });
    await seedUnanchored({ artists: ["Unknown"], trackId: "mb_bare_unknown" });
    await seedUnanchored({ artists: ["[unknown]"], trackId: "mb_bracket_unknown" });
    await seedUnanchored({ artists: ["traditional"], trackId: "mb_traditional" });
    // Case is not identity — the match folds it.
    await seedUnanchored({ artists: ["UNKNOWN ARTIST"], trackId: "mb_shouty_unknown" });
    // A real name rides along, so the row is anchorable and stays.
    await seedUnanchored({ artists: ["Unknown Artist", "Calibre"], trackId: "mb_with_calibre" });
    // A name that merely CONTAINS a placeholder word is a real artist.
    await seedUnanchored({ artists: ["Unknown Error"], trackId: "mb_real_name" });

    const work = await listTrackWork({ kind: "anchor", limit: 50 });
    const ids = work.map((item) => item.trackId);

    expect(ids.sort()).toEqual(["mb_real_name", "mb_with_calibre"]);
  });
});

// ── THE ANCHOR REVIEW ────────────────────────────────────────────────────────────────────────
// The one miss the gate writes down: a candidate that agrees on artists, base title, and duration
// but names a different version. Every guarantee here is a statement about SQL — the note is
// written, the anchor is NOT, any anchor clears it, and the operator's ruling either anchors exactly
// like a gate hit or clears the note and leaves the row's lifecycle alone — so these run against the
// real migrated schema like the rungs above.

/** The review JSON on a row, parsed (or undefined when the column is null). */
async function readReview(trackId: string) {
  const { parseAnchorReview } = await import("./anchor");
  const result = await db.execute({
    args: [trackId],
    sql: "select anchor_review_json from tracks where track_id = ?",
  });
  const raw = result.rows[0]?.anchor_review_json;

  return parseAnchorReview(typeof raw === "string" ? raw : null);
}

describe("anchorTrack — the suspected version mismatch it records on a miss", () => {
  it("records the near-match, and still refuses to anchor", async () => {
    const { anchorTrack } = await import("./anchor");

    // Our row: plain title at the REMIX's length (the MusicBrainz metadata gap).
    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      isrc: null,
      title: "Typical Description",
      trackId: "mb_mismatch",
    });

    const result = await anchorTrack("mb_mismatch", [
      {
        albumImageUrl: "https://i.scdn.co/image/remix",
        artists: [{ id: "sp-calibre", name: "Calibre" }],
        durationMs: 394_000,
        isrc: "GBCJY1300173",
        spotifyTrackId: "spotRemix001",
        title: "Typical Description (Calibre Remix)",
      },
    ]);

    // The gate is UNCHANGED: still a miss, still stamped, still un-anchored.
    expect(result).toEqual({ anchored: false, verifiedBy: null });
    const row = await db.execute(
      "select spotify_uri, spotify_anchor_attempts from tracks where track_id = 'mb_mismatch'",
    );
    expect(row.rows[0]?.spotify_uri).toBeNull();
    expect(Number(row.rows[0]?.spotify_anchor_attempts)).toBe(1);

    const review = await readReview("mb_mismatch");
    expect(review?.reason).toBe("version_mismatch");
    expect(review?.title).toBe("Typical Description");
    expect(review?.candidate.title).toBe("Typical Description (Calibre Remix)");
    expect(review?.candidate.spotifyTrackId).toBe("spotRemix001");
    expect(review?.candidate.durationMs).toBe(394_000);
    expect(review?.candidate.artists).toEqual([{ id: "sp-calibre", name: "Calibre" }]);
    // The rung is stamped so the operator can see where the suspicion came from; the box's
    // `anchor_track` POST is `apify` by default.
    expect(review?.candidate.source).toBe("apify");
  });

  it("records NOTHING on a plain miss (a duration too far out, descriptors agreeing)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Muffler"],
      durationMs: 200_000,
      title: "Dribble",
      trackId: "mb_plainmiss",
    });

    await anchorTrack("mb_plainmiss", [
      {
        artists: [{ name: "Muffler" }],
        durationMs: 203_500,
        spotifyTrackId: "spotFar",
        title: "Dribble",
      },
    ]);

    expect(await readReview("mb_plainmiss")).toBeUndefined();
  });

  it("OVERWRITES a stale review on re-detection (the newest near-match is the one worth reading)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      title: "Typical Description",
      trackId: "mb_rewrite",
    });

    for (const spotifyTrackId of ["spotOld", "spotNew"]) {
      await anchorTrack("mb_rewrite", [
        {
          artists: [{ name: "Calibre" }],
          durationMs: 394_000,
          spotifyTrackId,
          title: "Typical Description (Calibre Remix)",
        },
      ]);
    }

    expect((await readReview("mb_rewrite"))?.candidate.spotifyTrackId).toBe("spotNew");
  });

  it("CLEARS the review when the row later anchors (a note never outlives its miss)", async () => {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      isrc: null,
      title: "Typical Description",
      trackId: "mb_healed",
    });

    // Tick one: the mismatch is recorded.
    await anchorTrack("mb_healed", [
      {
        artists: [{ name: "Calibre" }],
        durationMs: 394_000,
        spotifyTrackId: "spotRemix001",
        title: "Typical Description (Calibre Remix)",
      },
    ]);
    expect(await readReview("mb_healed")).toBeDefined();

    // Tick two: a candidate clears the gate honestly, so the question is answered by the machine.
    const hit = await anchorTrack("mb_healed", [
      {
        artists: [{ name: "Calibre" }],
        durationMs: 394_200,
        spotifyTrackId: "spotPlain001",
        title: "Typical Description",
      },
    ]);

    expect(hit.anchored).toBe(true);
    expect(await readReview("mb_healed")).toBeUndefined();
  });
});

describe("resolveAnchorReview — the operator's ruling", () => {
  /** Seed a row already carrying a recorded review (one miss against the mismatch shape). */
  async function seedReviewed(trackId: string, spotifyTrackId: null | string): Promise<void> {
    const { anchorTrack } = await import("./anchor");

    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      isrc: null,
      title: "Typical Description",
      trackId,
    });
    await anchorTrack(trackId, [
      {
        albumImageUrl: "https://i.scdn.co/image/remix",
        artists: [{ id: "sp-calibre", name: "Calibre" }],
        durationMs: 394_000,
        isrc: "GBCJY1300173",
        spotifyTrackId: spotifyTrackId ?? "spotRemix001",
        title: "Typical Description (Calibre Remix)",
      },
    ]);

    // A rung with no Spotify id (a Deezer suspect, or a backfilled seed) — the informational case.
    if (spotifyTrackId === null) {
      const review = await readReview(trackId);
      const stripped = { ...review, candidate: { ...review?.candidate, spotifyTrackId: null } };

      await db.execute({
        args: [JSON.stringify(stripped), trackId],
        sql: "update tracks set anchor_review_json = ? where track_id = ?",
      });
    }
  }

  it("accepted: writes the anchor exactly like a gate hit, links the artists, and clears the review", async () => {
    const { resolveAnchorReview } = await import("./anchor");

    await seedReviewed("mb_accept", "spotRemix001");

    const result = await resolveAnchorReview("mb_accept", "accepted");
    expect(result.anchored).toBe(true);

    const row = await db.execute(
      "select spotify_uri, spotify_url, album_image_url, isrc, anchor_review_json, spotify_anchor_attempted_at, spotify_anchor_attempts from tracks where track_id = 'mb_accept'",
    );
    expect(text(row.rows[0]?.spotify_uri)).toBe("spotify:track:spotRemix001");
    expect(text(row.rows[0]?.spotify_url)).toBe("https://open.spotify.com/track/spotRemix001");
    expect(text(row.rows[0]?.album_image_url)).toBe("https://i.scdn.co/image/remix");
    // The candidate's ISRC fills the row's empty one, the same fill-empty-only recovery a hit does.
    expect(text(row.rows[0]?.isrc)).toBe("GBCJY1300173");
    expect(row.rows[0]?.anchor_review_json).toBeNull();
    expect(row.rows[0]?.spotify_anchor_attempted_at).not.toBeNull();
    // The stamp and the counter move together, always — the miss that recorded the review bumped
    // it to 1, and the accept is the second write.
    expect(Number(row.rows[0]?.spotify_anchor_attempts)).toBe(2);

    // The graph edge rides the SAME stored candidate, so an accepted anchor links like a verified one.
    const artist = await db.execute(
      "select id from artists where spotify_artist_id = 'sp-calibre'",
    );
    expect(artist.rows.length).toBe(1);
    const link = await db.execute({
      args: [text(artist.rows[0]?.id)],
      sql: "select 1 from track_artists where track_id = 'mb_accept' and artist_id = ?",
    });
    expect(link.rows.length).toBe(1);
    // And it certifies NOTHING.
    expect(Number((await db.execute("select count(*) as n from findings")).rows[0]?.n)).toBe(0);
  });

  it("dismissed: clears the review and leaves the row un-anchored on its normal lifecycle", async () => {
    const { resolveAnchorReview } = await import("./anchor");

    await seedReviewed("mb_dismiss", "spotRemix001");
    const before = await db.execute(
      "select spotify_anchor_attempts from tracks where track_id = 'mb_dismiss'",
    );

    const result = await resolveAnchorReview("mb_dismiss", "dismissed");
    expect(result.anchored).toBe(false);

    const row = await db.execute(
      "select spotify_uri, anchor_review_json, spotify_anchor_attempts from tracks where track_id = 'mb_dismiss'",
    );
    expect(row.rows[0]?.anchor_review_json).toBeNull();
    expect(row.rows[0]?.spotify_uri).toBeNull();
    // Dismissing spends no retry budget: the cap lifecycle is untouched.
    expect(Number(row.rows[0]?.spotify_anchor_attempts)).toBe(
      Number(before.rows[0]?.spotify_anchor_attempts),
    );
  });

  it("refuses to accept a candidate with no Spotify id, and keeps the review for the MB link", async () => {
    const { resolveAnchorReview } = await import("./anchor");

    await seedReviewed("mb_noid", null);

    await expect(resolveAnchorReview("mb_noid", "accepted")).rejects.toMatchObject({
      reason: "no_spotify_candidate",
    });

    const row = await db.execute(
      "select spotify_uri, anchor_review_json from tracks where track_id = 'mb_noid'",
    );
    expect(row.rows[0]?.spotify_uri).toBeNull();
    expect(row.rows[0]?.anchor_review_json).not.toBeNull();
  });

  it("throws no_review when there is nothing to rule on (a concurrent anchor cleared it)", async () => {
    const { resolveAnchorReview } = await import("./anchor");

    await seedUnanchored({ trackId: "mb_noreview" });

    await expect(resolveAnchorReview("mb_noreview", "accepted")).rejects.toMatchObject({
      reason: "no_review",
    });
  });

  it("keeps the anchor rails: not_found, certified, already_anchored", async () => {
    const { resolveAnchorReview } = await import("./anchor");

    await expect(resolveAnchorReview("nope", "accepted")).rejects.toMatchObject({
      reason: "not_found",
    });

    await seedTrack(db, { logId: "004.7.2I", title: "Certified", trackId: "spotifyCertified002" });
    await expect(resolveAnchorReview("spotifyCertified002", "accepted")).rejects.toMatchObject({
      reason: "certified",
    });

    await seedReviewed("mb_raced", "spotRemix001");
    await db.execute(
      "update tracks set spotify_uri = 'spotify:track:beat-you-to-it' where track_id = 'mb_raced'",
    );
    await expect(resolveAnchorReview("mb_raced", "accepted")).rejects.toMatchObject({
      reason: "already_anchored",
    });
  });
});

describe("listAnchorReviewRows — the attention read", () => {
  it("returns only un-anchored, non-dismissed rows carrying a review, with the evidence", async () => {
    const { anchorTrack, listAnchorReviewRows } = await import("./anchor");

    const record = async (trackId: string) => {
      await anchorTrack(trackId, [
        {
          artists: [{ id: "sp-calibre", name: "Calibre" }],
          durationMs: 394_400,
          spotifyTrackId: "spotRemix001",
          title: "Typical Description (Calibre Remix)",
        },
      ]);
    };

    // The one that should surface, with a MusicBrainz recording identity carrying the `mb_` prefix
    // history's crawler rows have.
    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      title: "Typical Description",
      trackId: "mb_queued",
    });
    await record("mb_queued");
    await db.execute(
      "update tracks set mb_recording_id = 'mb_9f0c1234-5678-90ab-cdef-1234567890ab' where track_id = 'mb_queued'",
    );

    // Reviewed, then anchored by hand — its question is over.
    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      title: "Typical Description",
      trackId: "mb_anchored_review",
    });
    await record("mb_anchored_review");
    await db.execute(
      "update tracks set spotify_uri = 'spotify:track:x' where track_id = 'mb_anchored_review'",
    );

    // Reviewed, but the operator already said "not for me".
    await seedUnanchored({
      artists: ["Calibre"],
      durationMs: 394_000,
      title: "Typical Description",
      trackId: "mb_dismissed_review",
    });
    await record("mb_dismissed_review");
    await db.execute("update tracks set dismissed_at = ? where track_id = 'mb_dismissed_review'", [
      NOW,
    ]);

    // No review at all.
    await seedUnanchored({ trackId: "mb_quiet" });

    const rows = await listAnchorReviewRows();

    expect(rows.map((row) => row.trackId)).toEqual(["mb_queued"]);
    expect(rows[0]?.title).toBe("Typical Description");
    expect(rows[0]?.artists).toEqual(["Calibre"]);
    expect(rows[0]?.candidateTitle).toBe("Typical Description (Calibre Remix)");
    expect(rows[0]?.candidateDescriptor).toBe("calibre remix");
    expect(rows[0]?.candidateArtists).toEqual(["Calibre"]);
    expect(rows[0]?.candidateSpotifyTrackId).toBe("spotRemix001");
    // Signed candidate − row, so the operator reads the direction as well as the size.
    expect(rows[0]?.deltaMs).toBe(400);
    // The `mb_` prefix is stripped so the link resolves.
    expect(rows[0]?.mbRecordingId).toBe("9f0c1234-5678-90ab-cdef-1234567890ab");
  });

  it("drops a row whose review JSON is unreadable (never a half-rendered queue row)", async () => {
    const { listAnchorReviewRows } = await import("./anchor");

    await seedUnanchored({ trackId: "mb_corrupt" });
    await db.execute(
      "update tracks set anchor_review_json = '{not json' where track_id = 'mb_corrupt'",
    );

    expect(await listAnchorReviewRows()).toEqual([]);
  });
});

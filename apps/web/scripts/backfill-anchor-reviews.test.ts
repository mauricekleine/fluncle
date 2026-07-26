import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";

import { createIntegrationDb, seedTrack } from "../src/lib/server/integration-db";
import { parseAnchorReview } from "../src/lib/server/anchor";
import { type AnchorReviewSeed, backfillAnchorReviews } from "./backfill-anchor-reviews";

// The one-off seed for rows the live gate will never revisit (they already hit the retry cap). It
// writes ONE column, so the tests that matter are the SKIPS: a row it must not touch, and the
// idempotence guard that makes a second run a no-op. Driven against the real migrated schema so the
// SQL is byte-identical to production.

let db: Client;

const seed = (trackId: string, overrides: Partial<AnchorReviewSeed["candidate"]> = {}) => ({
  candidate: {
    artists: [{ id: "sp-calibre", name: "Calibre" }],
    durationMs: 394_000,
    isrc: "GBCJY1300173",
    source: "listenbrainz" as const,
    spotifyTrackId: "spotRemix001",
    title: "Typical Description (Calibre Remix)",
    ...overrides,
  },
  track_id: trackId,
});

async function seedUnanchored(trackId: string, title = "Typical Description"): Promise<void> {
  await db.execute({
    args: [trackId, title],
    sql: `insert into tracks (track_id, title, artists_json, duration_ms)
          values (?, ?, '["Calibre"]', 394000)`,
  });
}

async function review(trackId: string) {
  const result = await db.execute({
    args: [trackId],
    sql: "select anchor_review_json from tracks where track_id = ?",
  });
  const raw = result.rows[0]?.anchor_review_json;

  return parseAnchorReview(typeof raw === "string" ? raw : null);
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("backfillAnchorReviews", () => {
  it("writes the review, reading the row's OWN title as the other half of the evidence", async () => {
    await seedUnanchored("mb_seed");

    const result = await backfillAnchorReviews(db, [seed("mb_seed")], { execute: true });

    expect(result.written).toEqual(["mb_seed"]);
    const written = await review("mb_seed");
    expect(written?.reason).toBe("version_mismatch");
    expect(written?.title).toBe("Typical Description");
    expect(written?.candidate.title).toBe("Typical Description (Calibre Remix)");
    expect(written?.candidate.spotifyTrackId).toBe("spotRemix001");
    expect(written?.candidate.source).toBe("listenbrainz");
  });

  it("DRY RUNS by default — it decides everything and writes nothing", async () => {
    await seedUnanchored("mb_dry");

    const result = await backfillAnchorReviews(db, [seed("mb_dry")]);

    expect(result.written).toEqual(["mb_dry"]);
    expect(await review("mb_dry")).toBeUndefined();
  });

  it("is IDEMPOTENT: a second run skips the row it already reviewed", async () => {
    await seedUnanchored("mb_twice");

    await backfillAnchorReviews(db, [seed("mb_twice")], { execute: true });
    const again = await backfillAnchorReviews(db, [seed("mb_twice")], { execute: true });

    expect(again.written).toEqual([]);
    expect(again.skipped).toEqual([{ reason: "already_reviewed", trackId: "mb_twice" }]);
  });

  it("skips a certified, an anchored, an unknown, and a malformed row — and says why", async () => {
    await seedTrack(db, { logId: "004.7.2I", title: "Certified", trackId: "spotifyCertified003" });
    await seedUnanchored("mb_anchored");
    await db.execute(
      "update tracks set spotify_uri = 'spotify:track:x' where track_id = 'mb_anchored'",
    );

    const result = await backfillAnchorReviews(
      db,
      [
        seed("spotifyCertified003"),
        seed("mb_anchored"),
        seed("mb_nonexistent"),
        { candidate: { title: "   " }, track_id: "mb_blank" },
      ],
      { execute: true },
    );

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([
      { reason: "certified", trackId: "spotifyCertified003" },
      { reason: "already_anchored", trackId: "mb_anchored" },
      { reason: "not_found", trackId: "mb_nonexistent" },
      { reason: "invalid", trackId: "mb_blank" },
    ]);
  });

  it("accepts bare artist-name strings, and a candidate with no Spotify id (informational)", async () => {
    await seedUnanchored("mb_loose");

    await backfillAnchorReviews(
      db,
      [seed("mb_loose", { artists: ["Calibre", "  "], spotifyTrackId: null })],
      { execute: true },
    );

    const written = await review("mb_loose");
    // A blank name is dropped; a bare string keeps its name and loses only the stable-id link.
    expect(written?.candidate.artists).toEqual([{ id: null, name: "Calibre" }]);
    expect(written?.candidate.spotifyTrackId).toBeNull();
  });
});

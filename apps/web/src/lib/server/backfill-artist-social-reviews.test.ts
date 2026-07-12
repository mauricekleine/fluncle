// The per-link review backfill, proven against the REAL migrated schema (createIntegrationDb),
// so the derivation runs against the real `artist_socials.reviewed_at` DDL. The guarantee under
// test is the migration-semantics choice: it reproduces the OLD per-artist needs-a-look truth at
// the finer grain — a link is born reviewed iff its artist was reviewed AND it predates that
// review; everything else stays fresh (null). And it is idempotent (a second run stamps nothing).
import { type Client } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";

import { backfillArtistSocialReviews } from "../../../scripts/backfill-artist-social-reviews";
import { createIntegrationDb } from "./integration-db";

let db: Client;

async function seedArtist(id: string, reviewedAt: string | null): Promise<void> {
  await db.execute({
    args: [id, `Artist ${id}`, id, reviewedAt, "t0"],
    sql: `insert into artists (id, name, slug, reviewed_at, created_at, updated_at)
          values (?, ?, ?, ?, 't0', ?)`,
  });
}

async function seedSocial(
  id: string,
  artistId: string,
  platform: string,
  createdAt: string,
): Promise<void> {
  await db.execute({
    args: [id, artistId, platform, `https://example.com/${id}`, createdAt],
    sql: `insert into artist_socials
            (id, artist_id, platform, url, source, status, created_at, updated_at)
          values (?, ?, ?, ?, 'musicbrainz', 'auto', ?, 't0')`,
  });
}

async function reviewedAtOf(id: string): Promise<string | null> {
  const result = await db.execute({
    args: [id],
    sql: `select reviewed_at from artist_socials where id = ?`,
  });

  return (result.rows[0]?.reviewed_at as string | null | undefined) ?? null;
}

beforeEach(async () => {
  db = await createIntegrationDb();
});

describe("backfillArtistSocialReviews", () => {
  it("stamps a seen link, leaves a fresh link and a never-reviewed artist's links null", async () => {
    // Reviewed artist: one link created BEFORE the review (seen), one AFTER (fresh, e.g. a Twitch
    // re-queue onto an already-reviewed artist).
    await seedArtist("reviewed", "2026-07-05T00:00:00.000Z");
    await seedSocial("seen", "reviewed", "instagram", "2026-07-01T00:00:00.000Z");
    await seedSocial("fresh", "reviewed", "twitch", "2026-07-09T00:00:00.000Z");

    // Never-reviewed artist: its links must stay fresh.
    await seedArtist("never", null);
    await seedSocial("never-link", "never", "youtube", "2026-07-01T00:00:00.000Z");

    const result = await backfillArtistSocialReviews(db);

    expect(result.stamped).toBe(1);
    expect(await reviewedAtOf("seen")).toBe("2026-07-05T00:00:00.000Z");
    expect(await reviewedAtOf("fresh")).toBeNull();
    expect(await reviewedAtOf("never-link")).toBeNull();
  });

  it("is idempotent — a second run stamps nothing", async () => {
    await seedArtist("reviewed", "2026-07-05T00:00:00.000Z");
    await seedSocial("seen", "reviewed", "instagram", "2026-07-01T00:00:00.000Z");

    expect((await backfillArtistSocialReviews(db)).stamped).toBe(1);
    expect((await backfillArtistSocialReviews(db)).stamped).toBe(0);
  });
});

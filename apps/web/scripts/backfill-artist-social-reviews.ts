#!/usr/bin/env bun
/**
 * The per-link REVIEW backfill — IDEMPOTENT, and FOLDED INTO THE DEPLOY: `deploy:cf` runs it as
 * part of `db:backfill` on every push. It seeds `artist_socials.reviewed_at` (the review stamp,
 * moved down from the artist) from the LEGACY per-artist `artists.reviewed_at`, ONCE, so the
 * operator's already-reviewed roster doesn't flood the fresh-links queue the moment the column
 * lands (it arrives NULL for every existing row, and NULL means "fresh").
 *
 * ── THE DERIVATION (the migration-semantics choice) ──────────────────────────────────────────
 * It does NOT blanket-stamp every old link reviewed. That would hide exactly the links the
 * operator wants to see — e.g. the fresh Twitch links a re-queue just inserted onto artists he
 * reviewed BEFORE Twitch existed. Instead it reproduces the OLD needs-a-look truth at the finer
 * grain: a link was "seen" iff the artist was reviewed AND the link was created at/before that
 * review. Those links are born reviewed (stamped = the artist's `reviewed_at`); everything else
 * — created after the last review, or on a never-reviewed artist — is left NULL, i.e. fresh. So
 * the queue on deploy is byte-for-byte the queue the operator already had, only now itemised by
 * link.
 *
 * Idempotent + safe on every subsequent deploy: the `reviewed_at IS NULL` guard skips a link the
 * new per-link write already stamped, and a genuinely-fresh post-deploy link (created after the
 * frozen `artists.reviewed_at`) never satisfies `created_at <= a.reviewed_at`, so it stays fresh.
 * Steady state stamps zero rows.
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ArtistSocialReviewsBackfillResult = {
  /** `artist_socials` rows this run stamped reviewed. Zero on a steady-state deploy. */
  stamped: number;
};

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an in-memory
 * database with the real migrations applied.
 */
export async function backfillArtistSocialReviews(
  client: Client,
): Promise<ArtistSocialReviewsBackfillResult> {
  const result = await client.execute({
    sql: `update artist_socials
          set reviewed_at = (
            select a.reviewed_at from artists a where a.id = artist_socials.artist_id
          )
          where reviewed_at is null
            and exists (
              select 1 from artists a
              where a.id = artist_socials.artist_id
                and a.reviewed_at is not null
                and artist_socials.created_at <= a.reviewed_at
            )`,
  });

  return { stamped: result.rowsAffected };
}

async function main(): Promise<void> {
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }

  const url = process.env.TURSO_DATABASE_URL;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required (set it in apps/web/.dev.vars)");
  }

  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(authToken ? { authToken, url } : { url });
  const result = await backfillArtistSocialReviews(client);

  console.log(`artist social reviews backfill: ${result.stamped} stamped.`);
}

if (import.meta.main) {
  await main();
}

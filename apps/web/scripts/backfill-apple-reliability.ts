#!/usr/bin/env bun
/**
 * The Apple-Music reliability CARRY — a ONE-TIME data step, gated on a `settings` marker (the
 * `labels_seeded_at` precedent), folded into the deploy: `deploy:cf` runs it as part of
 * `db:backfill`, right after `db:migrate` (which adds the `tracks.backfill_apple_music_*`
 * columns) and before `wrangler deploy`.
 *
 * WHY IT EXISTS (RFC musickit-second-authority, U1). The Apple sweep's per-row reliability
 * bookkeeping MOVED from `findings` to `tracks`, because `apple_music_url` is catalogue identity
 * and the sweep now drains catalogue rows (which have no `findings` row). Existing prod findings
 * already carry real Apple reliability state on their `findings.backfill_apple_music_*` columns —
 * a day, a week, or a "done" on ISRCs already resolved. This copies that state onto the matching
 * `tracks` row so the moved sweep RESUMES where the old one left off, instead of re-hitting every
 * already-resolved finding's ISRC on the first tick after deploy.
 *
 * ── WHY GATED ONCE, NOT EVERY DEPLOY ────────────────────────────────────────────────────────
 * After this runs, `tracks` is the authoritative store and the `findings.backfill_apple_music_*`
 * columns FREEZE (the moved sweep never writes them again). Re-running the carry unconditionally
 * would then overwrite fresh `tracks` state with stale `findings` state on every deploy. So it is
 * gated on `apple_reliability_carried_at`: it runs exactly once, ever. The `findings` columns are
 * left in place (vestigial, harmless) — their physical removal is a documented follow-up once the
 * carry has proven in production, kept out of THIS migration so the carry can still read them.
 *
 * ── IDEMPOTENT + NON-CLOBBERING ─────────────────────────────────────────────────────────────
 * Belt-and-braces even if the marker were cleared by hand: it copies ONLY onto a `tracks` row
 * whose `backfill_apple_music_attempted_at` is still null (never overwriting state the moved
 * sweep already wrote), and only from a finding that actually carries Apple state.
 *
 * Runs wherever `db:migrate` runs: the Cloudflare deploy environment provides
 * `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`; locally they come from `.dev.vars`.
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The once-ever marker: present ⇒ the Apple reliability carry has already run. */
const CARRY_MARKER_KEY = "apple_reliability_carried_at";

export type AppleReliabilityCarryResult = {
  /** True the run that actually performed the carry; false on every later (gated) run. */
  carried: boolean;
  /** `tracks` rows whose Apple reliability state this run copied across from their finding. */
  copied: number;
};

/**
 * The idempotent, gated core — takes any libSQL client so a test can drive it against an
 * in-memory database with the real migrations applied.
 */
export async function backfillAppleReliability(
  client: Client,
): Promise<AppleReliabilityCarryResult> {
  const marker = await client.execute({
    args: [CARRY_MARKER_KEY],
    sql: `select value from settings where key = ? limit 1`,
  });

  if (marker.rows.length > 0) {
    // Already carried — the moved sweep owns `tracks` now. Do nothing.
    return { carried: false, copied: 0 };
  }

  // Copy the four columns from each finding that carries Apple state onto its `tracks` row,
  // only where `tracks` has none yet. One statement, correlated by the 1:1 track_id.
  const update = await client.execute({
    sql: `update tracks
          set backfill_apple_music_attempted_at =
                (select f.backfill_apple_music_attempted_at from findings f where f.track_id = tracks.track_id),
              backfill_apple_music_attempts =
                coalesce((select f.backfill_apple_music_attempts from findings f where f.track_id = tracks.track_id), 0),
              backfill_apple_music_done_at =
                (select f.backfill_apple_music_done_at from findings f where f.track_id = tracks.track_id),
              backfill_apple_music_failures =
                coalesce((select f.backfill_apple_music_failures from findings f where f.track_id = tracks.track_id), 0)
          where backfill_apple_music_attempted_at is null
            and exists (
              select 1 from findings f
              where f.track_id = tracks.track_id
                and f.backfill_apple_music_attempted_at is not null
            )`,
  });

  await client.execute({
    args: [CARRY_MARKER_KEY, new Date().toISOString()],
    sql: `insert into settings (key, value) values (?, ?)
          on conflict (key) do nothing`,
  });

  return { carried: true, copied: update.rowsAffected };
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
  const result = await backfillAppleReliability(client);

  console.log(
    result.carried
      ? `apple reliability carry: ${result.copied} tracks carried from findings.`
      : "apple reliability carry: already done (gated), nothing to do.",
  );
}

if (import.meta.main) {
  await main();
}

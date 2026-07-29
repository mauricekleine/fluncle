#!/usr/bin/env bun
/**
 * The identity-ledger trues-up — IDEMPOTENT, and FOLDED INTO THE DEPLOY: `deploy:cf` runs it as
 * part of `db:backfill`, right after `db:migrate` lands the two columns it fills.
 *
 * ── WHY IT EXISTS (RFC dnb-identity-graph, Unit 1 items 1–2) ─────────────────────────────
 * Two attempt stamps arrived on `tracks` — `isrc_attempted_at` and the `backfill_discogs_*` set —
 * so that a MISSING identifier can say which kind of missing it is: "we looked, it is not there"
 * or "nobody has looked yet". Every fill path now stamps as it concludes, but history predates
 * them, so on the day the migration lands ~33k rows carrying a real ISRC and ~37k carrying a real
 * Discogs id would all read `unattempted` — the one reading we know for certain is false. This
 * corrects exactly that, and nothing else.
 *
 * ── WHAT IT STAMPS, AND WHAT THE STAMP MEANS ─────────────────────────────────────────────
 * ONLY rows that carry the identifier already, because a filled value is proof a path concluded.
 * A row WITHOUT the identifier is left alone: we genuinely cannot tell whether anyone ever looked,
 * and `unattempted` is the honest answer until a sweep revisits it and stamps for real.
 *
 * The stamp VALUE reads "filled by then, at the latest" — never "verified then":
 *   - a CERTIFIED row takes its finding's `added_at`, which is not an approximation at all: the
 *     publish path resolves the ISRC and the Discogs release and mints the finding in one pass, so
 *     that instant IS when the attempt concluded;
 *   - a CATALOGUE row takes this run's timestamp, because `tracks` carries no mint timestamp to
 *     borrow — the crawler's own attempt happened at some unrecorded earlier moment, and "by the
 *     time we looked" is the strongest claim the data supports.
 * Anything serving these values must present them as ATTEMPTED, never as VERIFIED (the envelope's
 * `atMeaning` carries exactly that distinction).
 *
 * ── IDEMPOTENT ───────────────────────────────────────────────────────────────────────────
 * Each statement carries an `… is null` residual, so a second run matches nothing, writes nothing,
 * and — the property that matters — can never overwrite a stamp a real attempt has since written.
 * It runs on every deploy: the first seeds history, every one after is a cheap no-op.
 *
 * Reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the environment (locally from
 * apps/web/.dev.vars), exactly like `db:migrate` and its sibling backfills.
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type IdentityLedgerBackfillResult = {
  /** Rows given a Discogs attempt record because they already carry a Discogs id. */
  discogsStamped: number;
  /** Rows given an ISRC attempt stamp because they already carry an ISRC. */
  isrcStamped: number;
};

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an in-memory DB with
 * the real migrations applied (the `backfillHasEmbedding` precedent).
 */
export async function backfillIdentityLedger(
  client: Client,
  now: string = new Date().toISOString(),
): Promise<IdentityLedgerBackfillResult> {
  // A non-empty ISRC is proof an ISRC path concluded for this row. `findings.added_at` is a PK
  // lookup on the certification half; a catalogue row has no finding, so `coalesce` falls to now.
  const isrc = await client.execute({
    args: [now],
    sql: `update tracks
          set isrc_attempted_at = coalesce(
                (select f.added_at from findings f where f.track_id = tracks.track_id),
                ?)
          where isrc is not null and trim(isrc) <> '' and isrc_attempted_at is null`,
  });

  // Same argument for Discogs: an id present means the look landed, so the row is both attempted
  // AND done. `attempts` goes to 1 — a floor, and the only count history can support.
  const discogs = await client.execute({
    args: [now, now],
    sql: `update tracks
          set backfill_discogs_attempted_at = coalesce(
                (select f.added_at from findings f where f.track_id = tracks.track_id),
                ?),
              backfill_discogs_done_at = coalesce(
                (select f.added_at from findings f where f.track_id = tracks.track_id),
                ?),
              backfill_discogs_attempts = 1
          where (in_release_id is not null or in_master_id is not null)
            and backfill_discogs_attempted_at is null`,
  });

  return { discogsStamped: discogs.rowsAffected, isrcStamped: isrc.rowsAffected };
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
  const result = await backfillIdentityLedger(client);

  console.log(
    `identity ledger: ${result.isrcStamped} ISRC attempt stamp(s) · ` +
      `${result.discogsStamped} Discogs attempt record(s).`,
  );
}

if (import.meta.main) {
  await main();
}

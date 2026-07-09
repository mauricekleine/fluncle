#!/usr/bin/env bun
/**
 * One-off operator repair: RE-QUEUE artists that resolved to ZERO socials.
 *
 * Why: the original `resolveArtistViaMb` resolved an artist's MusicBrainz MBID ONLY
 * via ISRC lookups, with no artist-name search. DnB ISRCs are frequently absent from
 * MB's index (and the walk landed on empty/wrong MBIDs), so most artists resolved to
 * 0–1 socials — yet `resolved_at` gets stamped even on an empty result, and the sweep
 * worklist keys on `resolved_at`, so those artists were NEVER retried. The resolver is
 * now name-search primary (cross-referenced by Spotify id; ISRC lookup retired), which
 * fixes NEW resolutions, but the already-stamped rows won't move until their
 * `resolved_at` is cleared. This clears it for every artist with no `artist_socials`
 * rows, dropping them back into the sweep so the fixed code re-resolves them.
 *
 * (Longer-term, `listUnresolvedArtists` also self-heals: it re-queues 0-social
 * artists whose stamp is older than 30 days. This script is the IMMEDIATE one-time
 * flush for the freshly-stamped backlog, which the 30-day window wouldn't touch yet.)
 *
 * Because it writes to PROD, it is OPERATOR-GATED: a plain run is a DRY RUN (prints
 * the count it would clear); `--confirm` performs the update. Idempotent — a re-run
 * after the sweep has filled socials clears nothing new.
 *
 * `--all` widens the target from "0-social artists" to EVERY resolved artist. Use it
 * after a resolver UPGRADE (not just a bug fix), when even artists that already have
 * a link or two should be re-resolved to pick up newly-reachable platforms — e.g. a
 * new platform in the vocabulary (Beatport) or a broadened Firecrawl backfill. It
 * preserves operator work: `persistResolution` keeps any `status='confirmed'` social
 * on re-resolution, so re-queuing a hand-curated artist never clobbers it.
 *
 * Usage:
 *   bun run apps/web/scripts/requeue-empty-artists.ts                  # dry run, 0-social only
 *   bun run apps/web/scripts/requeue-empty-artists.ts --confirm        # clear resolved_at, 0-social only
 *   bun run apps/web/scripts/requeue-empty-artists.ts --all            # dry run, EVERY resolved artist
 *   bun run apps/web/scripts/requeue-empty-artists.ts --all --confirm  # clear resolved_at, every resolved artist
 */

import { getDb, typedRows } from "../src/lib/server/db";

type EmptyArtistRow = { id: string; name: string };

// Artists that finished resolution (resolved_at stamped) but have zero socials.
const EMPTY_ONLY = `and id not in (select distinct artist_id from artist_socials)`;

const selectSql = (all: boolean) => `
  select id, name
    from artists
   where resolved_at is not null
     ${all ? "" : EMPTY_ONLY}
   order by id asc`;

const clearSql = (all: boolean) => `
  update artists
     set resolved_at = null,
         updated_at = ?
   where resolved_at is not null
     ${all ? "" : EMPTY_ONLY}`;

async function main() {
  const confirm = process.argv.includes("--confirm");
  const all = process.argv.includes("--all");
  const db = await getDb();

  const rows = typedRows<EmptyArtistRow>((await db.execute({ sql: selectSql(all) })).rows);

  const scope = all
    ? "All resolved artists (re-resolve to backfill missed links)"
    : "Resolved-but-empty artists (0 socials, resolved_at stamped)";
  console.log(`${scope}: ${rows.length}`);
  for (const row of rows) {
    console.log(`  ${row.id}  ${row.name}`);
  }

  if (rows.length === 0) {
    console.log(
      all
        ? "\nNothing to re-queue — no resolved artists."
        : "\nNothing to re-queue — every resolved artist already has socials.",
    );
    return;
  }

  if (!confirm) {
    console.log(
      `\nDRY RUN — nothing written. Re-run with ${all ? "--all --confirm" : "--confirm"} to clear resolved_at on these ${rows.length} artists.`,
    );
    return;
  }

  const result = await db.execute({ args: [new Date().toISOString()], sql: clearSql(all) });

  console.log(`\nCleared resolved_at on ${result.rowsAffected} artists — back in the sweep queue.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

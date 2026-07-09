#!/usr/bin/env bun
/**
 * One-off operator repair: RE-QUEUE artists that resolved to ZERO socials.
 *
 * Why: the original `resolveArtistViaMb` resolved an artist's MusicBrainz MBID ONLY
 * via ISRC lookups, with no artist-name-search fallback. DnB ISRCs are frequently
 * absent from MB's index, so most artists resolved to 0 socials — yet `resolved_at`
 * gets stamped even on an empty result, and the sweep worklist is
 * `resolved_at IS NULL`, so those artists were NEVER retried. The name-search
 * fallback fixes NEW resolutions, but the already-stamped rows won't move until their
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
 * Usage:
 *   bun run apps/web/scripts/requeue-empty-artists.ts            # dry run (default)
 *   bun run apps/web/scripts/requeue-empty-artists.ts --confirm  # clear resolved_at
 */

import { getDb, typedRows } from "../src/lib/server/db";

type EmptyArtistRow = { id: string; name: string };

// Artists that finished resolution (resolved_at stamped) but have zero socials.
const SELECT_EMPTY = `
  select id, name
    from artists
   where resolved_at is not null
     and id not in (select distinct artist_id from artist_socials)
   order by id asc`;

const CLEAR_EMPTY = `
  update artists
     set resolved_at = null,
         updated_at = ?
   where resolved_at is not null
     and id not in (select distinct artist_id from artist_socials)`;

async function main() {
  const confirm = process.argv.includes("--confirm");
  const db = await getDb();

  const rows = typedRows<EmptyArtistRow>((await db.execute({ sql: SELECT_EMPTY })).rows);

  console.log(`Resolved-but-empty artists (0 socials, resolved_at stamped): ${rows.length}`);
  for (const row of rows) {
    console.log(`  ${row.id}  ${row.name}`);
  }

  if (rows.length === 0) {
    console.log("\nNothing to re-queue — every resolved artist already has socials.");
    return;
  }

  if (!confirm) {
    console.log(
      `\nDRY RUN — nothing written. Re-run with --confirm to clear resolved_at on these ${rows.length} artists.`,
    );
    return;
  }

  const result = await db.execute({ args: [new Date().toISOString()], sql: CLEAR_EMPTY });

  console.log(`\nCleared resolved_at on ${result.rowsAffected} artists — back in the sweep queue.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

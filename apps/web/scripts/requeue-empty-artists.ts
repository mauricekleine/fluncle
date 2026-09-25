#!/usr/bin/env bun

import { getDb, typedRows } from "../src/lib/server/db";

type EmptyArtistRow = { id: string; name: string };

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

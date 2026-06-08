// One-time / repeatable backfill: assign Log IDs + enrichment (isrc, label,
// preview, popularity, tags) to finds that predate the enrichment pipeline.
//
// Idempotent: only touches rows missing a log_id. Reuses the exact server
// modules the publish flow uses, so backfilled coordinates + enrichment match
// what new adds produce. Run from anywhere:
//
//   bun run apps/web/scripts/backfill-log-ids.ts
//
// Reads credentials from apps/web/.dev.vars (Turso, Spotify, Firecrawl).

import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "../.dev.vars") });

const { getDb } = await import("../src/lib/server/db");
const { enrichFromDeezer } = await import("../src/lib/server/deezer");
const { resolveLogId } = await import("../src/lib/server/log-id");
const { fetchTrackMetadata } = await import("../src/lib/server/spotify");

type Row = {
  added_at: string;
  artists_json: string;
  title: string;
  track_id: string;
};

const db = await getDb();
const result = await db.execute({
  sql: `select track_id, title, artists_json, added_at
        from tracks
        where log_id is null
        order by added_at asc`,
});
const rows = result.rows as unknown as Row[];
console.log(`[backfill] ${rows.length} find(s) without a Log ID`);

for (const row of rows) {
  const artists = JSON.parse(row.artists_json) as string[];
  const line = `${artists.join(", ")} — ${row.title}`;

  try {
    const meta = await fetchTrackMetadata(row.track_id);
    const deezer = await enrichFromDeezer(meta.isrc);
    const logId = await resolveLogId(
      { foundAt: row.added_at, isrc: meta.isrc, trackId: row.track_id },
      async (candidate) => {
        const taken = await db.execute({
          args: [candidate, row.track_id],
          sql: `select 1 from tracks where log_id = ? and track_id != ? limit 1`,
        });

        return taken.rows.length > 0;
      },
    );

    await db.execute({
      args: [
        logId,
        meta.isrc ?? null,
        deezer.label ?? null,
        meta.popularity ?? null,
        deezer.previewUrl ?? null,
        row.track_id,
      ],
      sql: `update tracks
            set log_id = ?, isrc = ?, label = ?, popularity = ?, preview_url = ?
            where track_id = ?`,
    });

    const extras = [deezer.label, deezer.previewUrl ? "preview" : undefined].filter(
      (value): value is string => Boolean(value),
    );
    console.log(
      `[backfill] fluncle://${logId}  ${line}${extras.length ? `  · ${extras.join(" · ")}` : ""}`,
    );
  } catch (error) {
    console.error(`[backfill] FAILED ${line}: ${error instanceof Error ? error.message : error}`);
  }
}

console.log("[backfill] done");

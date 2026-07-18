#!/usr/bin/env bun
/**
 * The remixer-credit reconciler (RFC label-lineage-remixer, U2) — IDEMPOTENT, deploy-chained
 * (`db:backfill`), and the history catch-up behind the inline stamping.
 *
 * Going forward, `stampRemixerRoles` (artists.ts) runs at every write path that mints a
 * `track_artists` edge — publish, the crawler's name-fold link, the Spotify-anchor step — so a NEW
 * remix is credited the moment its edge exists. This script is the one-time catch-up for HISTORY:
 * a remix logged (or crawled) before the `role` column existed, whose remixer already has an
 * `artists` row linked to the track. It drains on the next deploy and then no-ops.
 *
 * The derivation is `deriveRemixerNames` (track-match.ts) — the SAME pure function the inline stamp
 * and the JSON-LD emit read, so the column and the markup agree by construction. It NEVER guesses
 * beyond an exact fold match: a remixer with no linked `artists` row leaves no row to stamp.
 *
 * Reads `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` from the environment (locally, `.dev.vars`).
 */
import { type Client, createClient } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveRemixerNames, fold } from "../src/lib/server/track-match";

export type RemixerRolesBackfillResult = {
  /** `track_artists` rows this run stamped `role='remixer'`. Zero on a steady-state deploy. */
  stamped: number;
};

// One keyset page of the worklist. A title can only carry a remix descriptor inside a
// parenthetical/bracket group or a dash suffix, so the SQL prefilter narrows the scan to exactly
// those shapes (a superset of real remixes) before the TS derivation does the exact work — the
// whole flat catalogue is never dragged into the isolate.
const PAGE = 500;

// A local JSON parse (kept off `artists.ts` so the script pulls no Worker-only deps like the
// Cloudflare env). Mirrors `parseArtistsJson`: a JSON array of name strings, else empty.
function parseArtists(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;

    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * The idempotent core, taking any libSQL client so a test can drive it against an in-memory
 * database with the real migrations applied. Keyset-paged by `track_id` over titles that plausibly
 * carry a version descriptor; per track, stamps `role='remixer'` fill-empty-only on each linked
 * artist the title names as a remixer.
 */
export async function backfillRemixerRoles(client: Client): Promise<RemixerRolesBackfillResult> {
  let stamped = 0;
  let cursor = "";

  for (;;) {
    const page = await client.execute({
      args: [cursor, PAGE],
      // A version descriptor lives only inside `(…)` / `[…]` or after a ` - ` dash suffix, so the
      // prefilter is the honest superset `splitTitle` could ever extract from — a title with none
      // of these can carry no remixer, so it never enters the isolate.
      sql: `select t.track_id, t.title, t.artists_json
            from tracks t
            where t.track_id > ?
              and (t.title like '%(%' or t.title like '%[%'
                   or t.title like '% - %' or t.title like '% – %' or t.title like '% — %')
              and exists (
                select 1 from track_artists ta where ta.track_id = t.track_id and ta.role is null
              )
            order by t.track_id asc
            limit ?`,
    });

    if (page.rows.length === 0) {
      break;
    }

    for (const row of page.rows) {
      const record = row as unknown as {
        artists_json: string | null;
        title: string | null;
        track_id: string;
      };
      cursor = record.track_id;

      const remixers = deriveRemixerNames(
        record.title ?? "",
        parseArtists(record.artists_json ?? "[]"),
      );

      if (remixers.length === 0) {
        continue;
      }

      const remixerFolds = new Set(remixers.map(fold));
      const linked = await client.execute({
        args: [record.track_id],
        sql: `select ta.artist_id, a.name
              from track_artists ta
              join artists a on a.id = ta.artist_id
              where ta.track_id = ? and ta.role is null`,
      });

      for (const linkedRow of linked.rows) {
        const artist = linkedRow as unknown as { artist_id: string; name: string };

        if (!remixerFolds.has(fold(artist.name))) {
          continue;
        }

        const result = await client.execute({
          args: [artist.artist_id, record.track_id],
          sql: `update track_artists set role = 'remixer'
                where artist_id = ? and track_id = ? and role is null`,
        });

        stamped += result.rowsAffected;
      }
    }

    if (page.rows.length < PAGE) {
      break;
    }
  }

  return { stamped };
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
  const result = await backfillRemixerRoles(client);

  console.log(`remixer roles backfill: ${result.stamped} stamped.`);
}

if (import.meta.main) {
  await main();
}

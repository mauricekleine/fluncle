#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveRemixerNames, fold } from "../src/lib/server/track-match";
import {
  batchDueWorkSourceMutation,
  DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
} from "../src/lib/server/due-work";

export type RemixerRolesBackfillResult = {
  stamped: number;
};

const PAGE = 500;

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

export async function backfillRemixerRoles(client: Client): Promise<RemixerRolesBackfillResult> {
  let stamped = 0;
  let cursor = "";

  for (;;) {
    const page = await client.execute({
      args: [cursor, PAGE],

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

        const [result] = await batchDueWorkSourceMutation(
          client,
          [
            {
              args: [artist.artist_id, record.track_id],
              sql: `update track_artists set role = 'remixer'
                    where artist_id = ? and track_id = ? and role is null`,
            },
          ],
          [
            { subjectId: record.track_id, subjectType: "track" },
            {
              subjectId: DUE_WORK_CATALOGUE_RANK_REPAIR_SUBJECT_ID,
              subjectType: "track",
            },
          ],
          { onlyIfLastSourceStatementChanged: true, producer: "backfill-remixer-role" },
        );

        stamped += result?.rowsAffected ?? 0;
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
  const client = createClient(
    authToken
      ? { authToken, concurrency: REMOTE_DB_CONCURRENCY, url }
      : { concurrency: REMOTE_DB_CONCURRENCY, url },
  );
  const result = await backfillRemixerRoles(client);

  console.log(`remixer roles backfill: ${result.stamped} stamped.`);
}

if (import.meta.main) {
  await main();
}

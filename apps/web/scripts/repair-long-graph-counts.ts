#!/usr/bin/env bun

import { createClient, type Client, type InStatement } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  catalogueTrackDurationWhere,
  publicTrackDurationWhere,
} from "../src/db/public-track-visibility";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { validReleaseDateSql } from "../src/lib/server/release-day";
import {
  HUB_COUNTS_BACKFILL_COMPLETE_VALUE,
  HUB_COUNTS_BACKFILL_MARKER_KEY,
} from "./backfill-hub-counts";

export const LONG_GRAPH_REPAIR_MARKER_KEY = "repair_long_graph_counts_v1_state";
export const LONG_GRAPH_REPAIR_COMPLETE_VALUE = "complete:v1";
export const LONG_GRAPH_REPAIR_PAGE_SIZE = 100;

type GraphEntity = "albums" | "artists" | "labels";

function hiddenTrackIdsSql(count: number): string {
  return `tracks.track_id in (${Array.from({ length: count }, () => "?").join(", ")})
    and tracks.is_catalogue = 1
    and not (${catalogueTrackDurationWhere("tracks")})
    and not exists (select 1 from findings f where f.track_id = tracks.track_id)`;
}

function entityRepairStatement(
  entity: GraphEntity,
  trackIds: readonly string[],
  today: string,
  markerValue: string,
): InStatement {
  const hidden = hiddenTrackIdsSql(trackIds.length);
  const edgeJoin =
    entity === "artists" ? "join track_artists edge on edge.track_id = tracks.track_id" : "";
  const sourceId =
    entity === "artists"
      ? "edge.artist_id"
      : entity === "albums"
        ? "tracks.album_id"
        : "tracks.label_id";
  const latestFrom =
    entity === "artists"
      ? `track_artists edge
         join tracks t on t.track_id = edge.track_id`
      : "tracks t";
  const latestSeek =
    entity === "artists"
      ? `edge.artist_id = ${entity}.id`
      : entity === "albums"
        ? `t.album_id = ${entity}.id`
        : `t.label_id = ${entity}.id`;

  return {
    args: [...trackIds, today, LONG_GRAPH_REPAIR_MARKER_KEY, markerValue],
    sql: `with lost as (
            select ${sourceId} as id, count(*) as n
            from tracks ${edgeJoin}
            where ${hidden}
            group by ${sourceId}
          )
          update ${entity}
          set renderable_track_count = max(0, renderable_track_count - lost.n),
              latest_release_date = (
                select max(t.release_date) from ${latestFrom}
                where ${latestSeek}
                  and ${validReleaseDateSql("t.release_date")}
                  and t.release_date <= ?
                  and t.dismissed_at is null
                  and t.duplicate_of_track_id is null
                  and ${publicTrackDurationWhere("t")}
              )
          from lost
          where ${entity}.id = lost.id
            and exists (select 1 from settings
                        where key = ? and value = ?)`,
  };
}

async function readMarker(client: Client, key: string): Promise<string | undefined> {
  const result = await client.execute({
    args: [key],
    sql: `select value from settings where key = ? limit 1`,
  });
  const value = result.rows[0]?.value;
  return typeof value === "string" ? value : undefined;
}

export async function repairLongGraphCounts(
  client: Client,
): Promise<{ repaired: number; skipped: boolean }> {
  if (
    (await readMarker(client, HUB_COUNTS_BACKFILL_MARKER_KEY)) ===
    HUB_COUNTS_BACKFILL_COMPLETE_VALUE
  ) {
    return { repaired: 0, skipped: true };
  }

  await client.execute({
    args: [LONG_GRAPH_REPAIR_MARKER_KEY, "running:"],
    sql: `insert into settings (key, value) values (?, ?) on conflict(key) do nothing`,
  });

  let repaired = 0;

  while (true) {
    const marker = await readMarker(client, LONG_GRAPH_REPAIR_MARKER_KEY);
    if (marker === LONG_GRAPH_REPAIR_COMPLETE_VALUE) {
      return { repaired, skipped: repaired === 0 };
    }
    if (marker === undefined || !marker.startsWith("running:")) {
      throw new Error("long graph count repair marker is invalid");
    }

    const result = await client.execute({
      args: [marker.slice("running:".length), LONG_GRAPH_REPAIR_PAGE_SIZE],
      sql: `select tracks.track_id as track_id
            from tracks
            where tracks.track_id > ? and tracks.is_catalogue = 1
              and not (${catalogueTrackDurationWhere("tracks")})
              and not exists (select 1 from findings f where f.track_id = tracks.track_id)
            order by tracks.track_id asc
            limit ?`,
    });
    const trackIds = result.rows.flatMap((row) =>
      typeof row.track_id === "string" ? [row.track_id] : [],
    );

    if (trackIds.length === 0) {
      await client.execute({
        args: [LONG_GRAPH_REPAIR_COMPLETE_VALUE, LONG_GRAPH_REPAIR_MARKER_KEY, marker],
        sql: `update settings set value = ? where key = ? and value = ?`,
      });
      continue;
    }

    const today = new Date().toISOString().slice(0, 10);
    const nextMarker = `running:${trackIds.at(-1)}`;
    const results = await client.batch(
      [
        entityRepairStatement("labels", trackIds, today, marker),
        entityRepairStatement("albums", trackIds, today, marker),
        entityRepairStatement("artists", trackIds, today, marker),
        {
          args: [nextMarker, LONG_GRAPH_REPAIR_MARKER_KEY, marker],
          sql: `update settings set value = ? where key = ? and value = ?`,
        },
      ],
      "write",
    );
    if ((results.at(-1)?.rowsAffected ?? 0) === 0) {
      continue;
    }
    repaired += trackIds.length;
  }
}

async function main(): Promise<void> {
  if (!process.env.TURSO_DATABASE_URL) {
    config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".dev.vars") });
  }
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error("TURSO_DATABASE_URL is required");
  }
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const client = createClient(
    authToken
      ? { authToken, concurrency: REMOTE_DB_CONCURRENCY, url }
      : { concurrency: REMOTE_DB_CONCURRENCY, url },
  );
  try {
    const result = await repairLongGraphCounts(client);
    console.log(`long graph count repair: ${result.repaired} track(s) processed`);
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  await main();
}

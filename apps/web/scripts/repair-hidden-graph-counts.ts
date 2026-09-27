#!/usr/bin/env bun

import { createClient, type Client, type InStatement } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicTrackWhere } from "../src/db/public-track-visibility";
import { LONG_FORM_MS, spokenWordTitleWhere } from "../src/lib/catalogue-eligibility";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { validReleaseDateSql } from "../src/lib/server/release-day";
import {
  HUB_COUNTS_BACKFILL_COMPLETE_VALUE,
  HUB_COUNTS_BACKFILL_MARKER_KEY,
  HUB_COUNTS_BACKFILL_SUPERSEDED_MARKERS,
} from "./backfill-hub-counts";

export const HIDDEN_GRAPH_REPAIR_PAGE_SIZE = 100;

export type HiddenGraphRepairPass = {
  backfillMarkers: readonly { completeValue: string; key: string }[];
  completeValue: string;
  hiddenWhere: (trackAlias: string) => string;
  markerKey: string;
  name: "long_form" | "spoken_word";
};

const CURRENT_BACKFILL_MARKER = {
  completeValue: HUB_COUNTS_BACKFILL_COMPLETE_VALUE,
  key: HUB_COUNTS_BACKFILL_MARKER_KEY,
};

export const LONG_FORM_GRAPH_REPAIR: HiddenGraphRepairPass = {
  backfillMarkers: [...HUB_COUNTS_BACKFILL_SUPERSEDED_MARKERS, CURRENT_BACKFILL_MARKER],
  completeValue: "complete:v1",
  hiddenWhere: (trackAlias) => `not (${trackAlias}.duration_ms < ${LONG_FORM_MS})`,
  markerKey: "repair_long_graph_counts_v1_state",
  name: "long_form",
};

export const SPOKEN_WORD_GRAPH_REPAIR: HiddenGraphRepairPass = {
  backfillMarkers: [CURRENT_BACKFILL_MARKER],
  completeValue: "complete:v1",
  hiddenWhere: (trackAlias) =>
    `${trackAlias}.duration_ms < ${LONG_FORM_MS} and ${spokenWordTitleWhere(trackAlias)}`,
  markerKey: "repair_spoken_word_graph_counts_v1_state",
  name: "spoken_word",
};

export const HIDDEN_GRAPH_REPAIR_PASSES = [
  LONG_FORM_GRAPH_REPAIR,
  SPOKEN_WORD_GRAPH_REPAIR,
] as const;

type GraphEntity = "albums" | "artists" | "labels";

function hiddenCatalogueTrackWhere(pass: HiddenGraphRepairPass): string {
  return `tracks.is_catalogue = 1
    and ${pass.hiddenWhere("tracks")}
    and not exists (select 1 from findings f where f.track_id = tracks.track_id)`;
}

function entityRepairStatement(
  pass: HiddenGraphRepairPass,
  entity: GraphEntity,
  trackIds: readonly string[],
  today: string,
  markerValue: string,
): InStatement {
  const hidden = `tracks.track_id in (${trackIds.map(() => "?").join(", ")})
    and ${hiddenCatalogueTrackWhere(pass)}`;
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
    args: [...trackIds, today, pass.markerKey, markerValue],
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
                  and ${publicTrackWhere("t")}
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

async function backfillAlreadyApplied(
  client: Client,
  pass: HiddenGraphRepairPass,
): Promise<boolean> {
  for (const marker of pass.backfillMarkers) {
    if ((await readMarker(client, marker.key)) === marker.completeValue) {
      return true;
    }
  }
  return false;
}

export async function repairHiddenGraphCounts(
  client: Client,
  pass: HiddenGraphRepairPass,
): Promise<{ repaired: number; skipped: boolean }> {
  if (await backfillAlreadyApplied(client, pass)) {
    return { repaired: 0, skipped: true };
  }

  await client.execute({
    args: [pass.markerKey, "running:"],
    sql: `insert into settings (key, value) values (?, ?) on conflict(key) do nothing`,
  });

  let repaired = 0;

  while (true) {
    const marker = await readMarker(client, pass.markerKey);
    if (marker === pass.completeValue) {
      return { repaired, skipped: repaired === 0 };
    }
    if (marker === undefined || !marker.startsWith("running:")) {
      throw new Error(`${pass.name} graph count repair marker is invalid`);
    }

    const result = await client.execute({
      args: [marker.slice("running:".length), HIDDEN_GRAPH_REPAIR_PAGE_SIZE],
      sql: `select tracks.track_id as track_id
            from tracks
            where tracks.track_id > ? and ${hiddenCatalogueTrackWhere(pass)}
            order by tracks.track_id asc
            limit ?`,
    });
    const trackIds = result.rows.flatMap((row) =>
      typeof row.track_id === "string" ? [row.track_id] : [],
    );

    if (trackIds.length === 0) {
      await client.execute({
        args: [pass.completeValue, pass.markerKey, marker],
        sql: `update settings set value = ? where key = ? and value = ?`,
      });
      continue;
    }

    const today = new Date().toISOString().slice(0, 10);
    const nextMarker = `running:${trackIds.at(-1)}`;
    const results = await client.batch(
      [
        entityRepairStatement(pass, "labels", trackIds, today, marker),
        entityRepairStatement(pass, "albums", trackIds, today, marker),
        entityRepairStatement(pass, "artists", trackIds, today, marker),
        {
          args: [nextMarker, pass.markerKey, marker],
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
    for (const pass of HIDDEN_GRAPH_REPAIR_PASSES) {
      const result = await repairHiddenGraphCounts(client, pass);
      console.log(`${pass.name} graph count repair: ${result.repaired} track(s) processed`);
    }
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  await main();
}

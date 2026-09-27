#!/usr/bin/env bun

import { createClient, type Client, type InStatement } from "@libsql/client";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LONG_FORM_MS, spokenWordTitleWhere } from "../src/lib/catalogue-eligibility";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { markPublicTrackSourceChangedStatements } from "../src/lib/server/public-projection-source-maintenance";
import { publicTrackSourceVersion } from "../src/lib/server/public-projections";

export const HIDDEN_TRACK_PROJECTION_REPAIR_PAGE_SIZE = 50;

export type HiddenTrackProjectionRepairPass = {
  completeValue: string;
  hiddenWhere: (trackAlias: string) => string;
  markerKey: string;
  name: "spoken_word";
};

export const SPOKEN_WORD_PROJECTION_REPAIR: HiddenTrackProjectionRepairPass = {
  completeValue: "complete:v1",
  hiddenWhere: (trackAlias) =>
    `${trackAlias}.duration_ms < ${LONG_FORM_MS} and ${spokenWordTitleWhere(trackAlias)}`,
  markerKey: "enqueue_spoken_word_projection_repairs_v1_state",
  name: "spoken_word",
};

export const HIDDEN_TRACK_PROJECTION_REPAIR_PASSES = [SPOKEN_WORD_PROJECTION_REPAIR] as const;

type HiddenTrackRow = { key: null | string; release_date: null | string; track_id: string };

async function readMarker(client: Client, key: string): Promise<string | undefined> {
  const result = await client.execute({
    args: [key],
    sql: `select value from settings where key = ? limit 1`,
  });
  const value = result.rows[0]?.value;
  return typeof value === "string" ? value : undefined;
}

export async function enqueueHiddenTrackProjectionRepairs(
  client: Client,
  pass: HiddenTrackProjectionRepairPass,
  now: Date = new Date(),
): Promise<{ enqueued: number; skipped: boolean }> {
  await client.execute({
    args: [pass.markerKey, "running:"],
    sql: `insert into settings (key, value) values (?, ?) on conflict(key) do nothing`,
  });

  let enqueued = 0;

  while (true) {
    const marker = await readMarker(client, pass.markerKey);
    if (marker === pass.completeValue) {
      return { enqueued, skipped: enqueued === 0 };
    }
    if (marker === undefined || !marker.startsWith("running:")) {
      throw new Error(`${pass.name} projection repair marker is invalid`);
    }

    const result = await client.execute({
      args: [marker.slice("running:".length), HIDDEN_TRACK_PROJECTION_REPAIR_PAGE_SIZE],
      sql: `select tracks.track_id, tracks.release_date, tracks.key
            from tracks
            where tracks.track_id > ?
              and tracks.is_catalogue = 1
              and ${pass.hiddenWhere("tracks")}
              and not exists (select 1 from findings f where f.track_id = tracks.track_id)
            order by tracks.track_id asc
            limit ?`,
    });
    const rows = result.rows.flatMap((row) =>
      typeof row.track_id === "string"
        ? [
            {
              key: typeof row.key === "string" ? row.key : null,
              release_date: typeof row.release_date === "string" ? row.release_date : null,
              track_id: row.track_id,
            } satisfies HiddenTrackRow,
          ]
        : [],
    );

    if (rows.length === 0) {
      await client.execute({
        args: [pass.completeValue, pass.markerKey, marker],
        sql: `update settings set value = ? where key = ? and value = ?`,
      });
      continue;
    }

    const nextMarker = `running:${rows.at(-1)?.track_id ?? ""}`;
    const statements: InStatement[] = [
      {
        args: [nextMarker, pass.markerKey, marker],
        sql: `update settings set value = ? where key = ? and value = ?`,
      },
      ...rows.flatMap((row) =>
        markPublicTrackSourceChangedStatements(
          row.track_id,
          publicTrackSourceVersion({ key: row.key, releaseDate: row.release_date }),
          { now },
        ),
      ),
    ];
    const results = await client.batch(statements, "write");
    if ((results[0]?.rowsAffected ?? 0) === 0) {
      continue;
    }
    enqueued += rows.length;
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
    for (const pass of HIDDEN_TRACK_PROJECTION_REPAIR_PASSES) {
      const result = await enqueueHiddenTrackProjectionRepairs(client, pass);
      console.log(`${pass.name} projection repairs: ${result.enqueued} track(s) enqueued`);
    }
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  await main();
}

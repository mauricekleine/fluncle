#!/usr/bin/env bun
/**
 * Bounded, restart-safe initialization for `artists.rankable_track_count`. The migration only adds
 * an empty defaulted column and index; this deploy backfill keyset-pages the small artist table and
 * recomputes each page through `track_artists_artist_id_idx`. Every page update and cursor advance
 * is one write transaction, so a retry either resumes after a complete page or safely repeats it.
 */
import { type Client, type ResultSet, createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import {
  MIXABLE_ARTISTS_PROJECTION_COMPLETE_VALUE,
  MIXABLE_ARTISTS_PROJECTION_STATE_KEY,
} from "../src/lib/server/mixable-artists-projection";

const PAGE_SIZE = 100;
const MAX_STABILIZATION_PASSES = 4;

type RunningState = {
  cursor: null | string;
  pass: number;
  runId: string;
  state: "running";
  version: 1;
};

export type MixableArtistsProjectionBackfillResult = {
  artists: number;
  pages: number;
  passes: number;
  skipped: boolean;
};

function parseRunningState(value: unknown): Pick<RunningState, "cursor" | "pass"> | null {
  if (typeof value !== "string" || value === MIXABLE_ARTISTS_PROJECTION_COMPLETE_VALUE) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<RunningState>;
    return parsed.version === 1 &&
      parsed.state === "running" &&
      typeof parsed.pass === "number" &&
      Number.isSafeInteger(parsed.pass) &&
      parsed.pass >= 1 &&
      typeof parsed.cursor === "string"
      ? { cursor: parsed.cursor, pass: parsed.pass }
      : null;
  } catch {
    return null;
  }
}

async function readState(client: Client): Promise<string | undefined> {
  const result = await client.execute({
    args: [MIXABLE_ARTISTS_PROJECTION_STATE_KEY],
    sql: `select value from settings where key = ? limit 1`,
  });
  const value = result.rows[0]?.["value"];
  return typeof value === "string" ? value : undefined;
}

export async function backfillMixableArtistsProjection(
  client: Client,
  options: {
    activate?: boolean;
    onPassComplete?: (pass: number) => Promise<void> | void;
    resume?: boolean;
  } = {},
): Promise<MixableArtistsProjectionBackfillResult> {
  const observed = await readState(client);
  if (options.activate !== true) {
    throw new Error("mixable artist projection activation must run after wrangler deploy");
  }
  if (observed === MIXABLE_ARTISTS_PROJECTION_COMPLETE_VALUE) {
    return { artists: 0, pages: 0, passes: 0, skipped: true };
  }
  const runId = randomUUID();
  // Production writers maintain the projection transactionally, while an out-of-band source
  // repair explicitly marks this state dirty. A complete fence therefore makes an ordinary deploy
  // a true no-op; absent, dirty, and interrupted states still reconcile before activation.
  const resumed = options.resume === true ? parseRunningState(observed) : null;
  // Resume restarts the interrupted pass from its beginning. That repeats bounded idempotent pages,
  // but preserves the pass-wide "zero corrections" proof that a mid-pass cursor alone cannot.
  let cursor: null | string = null;
  let pass = resumed?.pass ?? 1;
  let passCorrections = 0;
  let owned: RunningState = { cursor, pass, runId, state: "running", version: 1 };
  let ownedValue = JSON.stringify(owned);
  await client.execute({
    args: [MIXABLE_ARTISTS_PROJECTION_STATE_KEY, ownedValue],
    sql: `insert into settings (key, value) values (?, ?)
          on conflict(key) do update set value = excluded.value`,
  });

  let artists = 0;
  let pages = 0;

  for (;;) {
    const page: ResultSet = await client.execute({
      args: cursor === null ? [PAGE_SIZE] : [cursor, PAGE_SIZE],
      sql:
        cursor === null
          ? `select id from artists order by id asc limit ?`
          : `select id from artists where id > ? order by id asc limit ?`,
    });
    const ids = page.rows
      .map((row) => row["id"])
      .filter((id): id is string => typeof id === "string");

    if (ids.length === 0) {
      await options.onPassComplete?.(pass);
      if (pass < 2 || passCorrections > 0) {
        if (pass >= MAX_STABILIZATION_PASSES) {
          throw new Error(
            `mixable artist projection did not stabilize after ${MAX_STABILIZATION_PASSES} passes`,
          );
        }
        pass += 1;
        cursor = null;
        passCorrections = 0;
        owned = { cursor, pass, runId, state: "running", version: 1 };
        const nextPassValue = JSON.stringify(owned);
        const advanced = await client.execute({
          args: [nextPassValue, MIXABLE_ARTISTS_PROJECTION_STATE_KEY, ownedValue],
          sql: `update settings set value = ? where key = ? and value = ?`,
        });
        if ((advanced.rowsAffected ?? 0) !== 1) {
          throw new Error("mixable artist projection backfill lost ownership between passes");
        }
        ownedValue = nextPassValue;
        continue;
      }
      const completed = await client.execute({
        args: [
          MIXABLE_ARTISTS_PROJECTION_COMPLETE_VALUE,
          MIXABLE_ARTISTS_PROJECTION_STATE_KEY,
          ownedValue,
        ],
        sql: `update settings set value = ? where key = ? and value = ?`,
      });
      if ((completed.rowsAffected ?? 0) !== 1) {
        throw new Error(
          "mixable artist projection backfill lost cursor ownership before completion",
        );
      }
      return { artists, pages, passes: pass, skipped: false };
    }

    cursor = ids.at(-1) ?? cursor;
    owned = { cursor, pass, runId, state: "running", version: 1 };
    const nextOwnedValue = JSON.stringify(owned);
    const results = await client.batch(
      [
        {
          args: ids,
          sql: `with page(id) as (values ${ids.map(() => "(?)").join(", ")}),
                       truth(id, rankable) as (
                         select page.id, count(tracks.track_id)
                         from page
                         left join track_artists indexed by track_artists_artist_id_idx
                           on track_artists.artist_id = page.id
                         left join tracks on tracks.track_id = track_artists.track_id
                           and tracks.key is not null and tracks.has_embedding = 1
                         group by page.id
                       )
                update artists
                set rankable_track_count = truth.rankable
                from truth
                where artists.id = truth.id
                  and artists.rankable_track_count <> truth.rankable`,
        },
        {
          args: [nextOwnedValue, MIXABLE_ARTISTS_PROJECTION_STATE_KEY, ownedValue],
          sql: `update settings set value = ? where key = ? and value = ?`,
        },
      ],
      "write",
    );
    if ((results.at(-1)?.rowsAffected ?? 0) !== 1) {
      throw new Error("mixable artist projection backfill lost cursor ownership during a page");
    }
    passCorrections += results[0]?.rowsAffected ?? 0;
    artists += ids.length;
    pages += 1;
    ownedValue = nextOwnedValue;
  }
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
  const result = await backfillMixableArtistsProjection(client, {
    activate: process.argv.includes("--activate"),
    resume: process.argv.includes("--resume"),
  });
  console.log(
    result.skipped
      ? "mixable artist projection backfill: already complete — skipped."
      : `mixable artist projection backfill: ${result.artists} artist(s) across ${result.pages} page(s).`,
  );
}

if (import.meta.main) {
  await main();
}

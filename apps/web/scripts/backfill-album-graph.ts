#!/usr/bin/env bun

import { type Client, createClient } from "@libsql/client/web";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";
import { slugify } from "@fluncle/contracts/util/galaxy-slug";
import { randomUUID } from "node:crypto";

import { hubCountDeltaStatement } from "../src/lib/server/hub-counts";
import {
  batchDueWorkSourceMutation,
  markDueWorkSourceMaintenanceFromSelectStatements,
} from "../src/lib/server/due-work";

export type AlbumsBackfillResult = {
  linked: number;
  minted: number;
};

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

export const DISTINCT_FINDING_ALBUMS_SQL = `select tracks.album as album
      from findings cross join tracks on tracks.track_id = findings.track_id
      where tracks.album is not null and trim(tracks.album) <> ''
      group by tracks.album`;

export async function backfillAlbums(client: Client): Promise<AlbumsBackfillResult> {
  const now = new Date().toISOString();
  const result: AlbumsBackfillResult = { linked: 0, minted: 0 };

  const distinct = await client.execute({ sql: DISTINCT_FINDING_ALBUMS_SQL });

  const bySlug = new Map<string, string>();

  for (const row of distinct.rows) {
    const raw = asText(row.album).trim();
    const slug = slugify(raw);

    if (slug !== "" && !bySlug.has(slug)) {
      bySlug.set(slug, raw);
    }
  }

  for (const [slug, name] of bySlug) {
    const albumId = `alb_${randomUUID()}`;
    const [inserted] = await batchDueWorkSourceMutation(
      client,
      [
        {
          args: [albumId, name, slug, now, now],
          sql: `insert into albums (id, name, slug, created_at, updated_at)
                values (?, ?, ?, ?, ?)
                on conflict (slug) do nothing`,
        },
      ],
      [{ subjectId: albumId, subjectType: "album" }],
      { onlyIfLastSourceStatementChanged: true, producer: "backfill-album-mint" },
    );

    result.minted += inserted?.rowsAffected ?? 0;
  }

  result.linked = await linkTracksToAlbums(client);

  return result;
}

export async function linkTracksToAlbums(client: Client): Promise<number> {
  const unlinked = await client.execute({
    sql: `select album from tracks
          where album_id is null and album is not null and trim(album) <> ''
          group by album`,
  });

  let linked = 0;

  for (const row of unlinked.rows) {
    const raw = asText(row.album).trim();
    const slug = slugify(raw);

    if (slug === "") {
      continue;
    }

    const found = await client.execute({
      args: [slug],
      sql: `select id from albums where slug = ? limit 1`,
    });
    const albumId = found.rows[0]?.id;

    if (typeof albumId !== "string") {
      continue;
    }

    const census = await client.execute({
      args: [raw],
      sql: `select count(*) as n, sum(case when is_catalogue = 0 then 1 else 0 end) as cert
            from tracks
            where album_id is null and trim(album) = ?`,
    });
    const renderable = Number(census.rows[0]?.n ?? 0);

    if (renderable === 0) {
      continue;
    }

    const certified = Number(census.rows[0]?.cert ?? 0);

    const results = await client.batch(
      [
        ...markDueWorkSourceMaintenanceFromSelectStatements(
          "track",
          {
            args: [raw],
            sql: `select track_id as subject_id from tracks
                  where album_id is null and trim(album) = ?`,
          },
          { producer: "backfill-album-link" },
        ),
        {
          args: [albumId, raw],
          sql: `update tracks set album_id = ? where album_id is null and trim(album) = ?`,
        },
        hubCountDeltaStatement("albums", albumId, { certified, renderable }),
      ],
      "write",
    );

    linked += results.at(-2)?.rowsAffected ?? 0;
  }

  return linked;
}

const ITEM = process.env.FLUNCLE_TURSO_OP_ITEM;

async function readSecret(field: string): Promise<string> {
  try {
    const value = await Bun.$`op read ${`${ITEM}/${field}`}`.text();

    return value.trim();
  } catch {
    throw new Error(
      `Could not read ${field} from 1Password (${ITEM}). Unlock 1Password and enable its CLI integration, then retry.`,
    );
  }
}

async function main(): Promise<void> {
  if (!ITEM) {
    throw new Error(
      "Set FLUNCLE_TURSO_OP_ITEM to the 1Password item holding the production Turso credentials — see the ops runbook note.",
    );
  }

  const url = await readSecret("TURSO_DATABASE_URL");
  const authToken = await readSecret("TURSO_AUTH_TOKEN");

  const client = createClient({
    authToken,
    concurrency: REMOTE_DB_CONCURRENCY,
    intMode: "bigint",
    url,
  });
  const result = await backfillAlbums(client);

  console.log(`album-graph backfill: ${result.minted} minted · ${result.linked} linked.`);
}

if (import.meta.main) {
  await main();
}

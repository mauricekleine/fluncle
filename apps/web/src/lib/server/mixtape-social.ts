// Per-platform distribution state for a mixtape (the `mixtape_social_posts`
// table), one row per (mixtape, platform) — the SINGLE source of truth for a
// mixtape's listen links. Mirrors `social.ts` for findings: the CLI moves the bytes
// (the Worker can't proxy multi-GB media), the Worker records the outcome here. On a
// successful publish this flips the mixtape `distributing → published` on its first
// link; the public URL lives only on the row (the public DTO derives `externalUrls`
// from these via MIXTAPE_SELECT — no `mixtapes.*_url` columns).

import { type MixtapeSocialPostItem } from "@fluncle/contracts";
import { type MixtapeDTO } from "../mixtapes";
import { getDb, typedRows } from "./db";
import { getMixtapeById } from "./mixtapes";

export type { MixtapeSocialPostItem };

export type MixtapePlatform = "mixcloud" | "youtube";

type MixtapeSocialPostRow = {
  created_at: string;
  external_id: string | null;
  platform: string;
  published_at: string | null;
  status: string;
  updated_at: string;
  url: string | null;
};

const str = (value: string | null): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const toItem = (row: MixtapeSocialPostRow): MixtapeSocialPostItem => ({
  createdAt: row.created_at,
  externalId: str(row.external_id),
  platform: row.platform,
  publishedAt: str(row.published_at),
  status: row.status,
  updatedAt: row.updated_at,
  url: str(row.url),
});

const COLUMNS = `platform, status, external_id, url, created_at, updated_at, published_at`;

/** All platform distribution rows for a mixtape (the admin dashboard reads this). */
export async function listMixtapeSocialPosts(mixtapeId: string): Promise<MixtapeSocialPostItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [mixtapeId],
    sql: `select ${COLUMNS} from mixtape_social_posts where mixtape_id = ? order by platform`,
  });

  return typedRows<MixtapeSocialPostRow>(result.rows).map(toItem);
}

/**
 * Record a non-terminal distribution state — `uploading` when bytes start moving,
 * `failed` when a leg dies. Idempotent on (mixtape, platform); coalesces so a
 * retry never clobbers an already-recorded `external_id`/`url`/publish stamp.
 */
export async function markMixtapeDistribution(
  mixtapeId: string,
  platform: MixtapePlatform,
  status: "uploading" | "failed",
  externalId?: string,
): Promise<void> {
  const now = new Date().toISOString();
  const db = await getDb();

  await db.execute({
    args: [crypto.randomUUID(), mixtapeId, platform, status, externalId ?? null, now, now, status],
    sql: `insert into mixtape_social_posts (id, mixtape_id, platform, status, external_id, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?)
          on conflict(mixtape_id, platform) do update set
            status = ?,
            external_id = coalesce(excluded.external_id, mixtape_social_posts.external_id),
            updated_at = excluded.updated_at`,
  });

  await touchMixtape(mixtapeId, now);
}

/**
 * The terminal success path: record the platform post as `published` (its `url` is
 * the public listen link) and flip the mixtape `distributing → published` if this is
 * its first live link. Idempotent on (mixtape, platform) and on the flip — a retry
 * after a crash-before-finalize reconciles to the same state. Returns the updated
 * mixtape.
 */
export async function finalizeMixtapeDistribution(
  mixtapeId: string,
  platform: MixtapePlatform,
  result: { externalId?: string; url: string },
): Promise<MixtapeDTO> {
  const now = new Date().toISOString();
  const db = await getDb();

  await db.batch(
    [
      {
        args: [
          crypto.randomUUID(),
          mixtapeId,
          platform,
          result.externalId ?? null,
          result.url,
          now,
          now,
          now,
          result.externalId ?? null,
          result.url,
          now,
        ],
        sql: `insert into mixtape_social_posts (id, mixtape_id, platform, status, external_id, url, published_at, created_at, updated_at)
              values (?, ?, ?, 'published', ?, ?, ?, ?, ?)
              on conflict(mixtape_id, platform) do update set
                status = 'published',
                external_id = coalesce(?, mixtape_social_posts.external_id),
                url = coalesce(?, mixtape_social_posts.url),
                published_at = coalesce(mixtape_social_posts.published_at, ?),
                updated_at = excluded.updated_at`,
      },
      {
        // Flip distributing → published on the first link. A re-run leaves an
        // already-published mixtape published (the CASE is a no-op) and refreshes
        // updated_at (so the cover cache-buster moves).
        args: [now, now, mixtapeId],
        sql: `update mixtapes set
                status = case when status = 'distributing' then 'published' else status end,
                published_at = coalesce(published_at, ?),
                updated_at = ?
              where id = ?`,
      },
    ],
    "write",
  );

  return getMixtapeById(mixtapeId, { includeDrafts: true });
}

// A distribution change alters the mixtape's public surfaces (the published rows
// feed /log, RSS, llms.txt) and the on-the-fly cover's `?v=<updatedAt>` cache key,
// so it counts as a content change — bump updated_at.
async function touchMixtape(mixtapeId: string, now: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [now, mixtapeId],
    sql: `update mixtapes set updated_at = ? where id = ?`,
  });
}

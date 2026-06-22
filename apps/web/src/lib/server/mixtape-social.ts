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
import { purgeLogCache } from "./edge-cache";
import { getMixtapeById } from "./mixtapes";
import { notifyNewMixtape } from "./push";

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

  // This route runs ONCE PER PLATFORM (YouTube and Mixcloud both finalize), so a
  // naive "mixtape is published → notify" double-fires. The flip is split into two
  // statements so exactly one call can own the transition:
  //   [1] the GUARDED transition flip — `where status = 'distributing'` — whose
  //       rowsAffected is 1 only for the call that actually flipped it, 0 for the
  //       second platform (and any retry of the owner). That is the single-owner
  //       signal (the `updateSubmissionStatus` rowsAffected guard precedent).
  //   [2] an unconditional touch of published_at/updated_at, so a re-run still
  //       refreshes updated_at (the cover cache-buster) exactly as before.
  const batchResults = await db.batch(
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
        // [1] The guarded distributing → published flip. rowsAffected === 1 ONLY
        // for the call that owns the transition.
        args: [now, now, mixtapeId],
        sql: `update mixtapes set
                status = 'published',
                published_at = coalesce(published_at, ?),
                updated_at = ?
              where id = ? and status = 'distributing'`,
      },
      {
        // [2] Unconditional touch so an already-published re-run still bumps
        // updated_at (cover cache-buster), as the old CASE flip did.
        args: [now, mixtapeId],
        sql: `update mixtapes set updated_at = ? where id = ?`,
      },
    ],
    "write",
  );

  // The owning call is the one whose guarded flip changed a row.
  const ownedTransition = (batchResults[1]?.rowsAffected ?? 0) > 0;

  // A new listen link changes the published mixtape's `/log` page; drop it from cache.
  const mixtape = await getMixtapeById(mixtapeId, { includeDrafts: true });
  purgeLogCache(mixtape.logId);

  // Best-effort push to the mobile crew — ONLY on the actual distributing→published
  // transition, so the per-platform double-call fires exactly one notification.
  // Gated on EXPO_ACCESS_TOKEN (a NO-OP until configured), fire-and-forget, never
  // throws — the same side-channel discipline as the cache purge above.
  if (ownedTransition) {
    notifyNewMixtape(mixtape);
  }

  return mixtape;
}

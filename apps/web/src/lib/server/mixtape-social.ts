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

export async function listMixtapeSocialPosts(mixtapeId: string): Promise<MixtapeSocialPostItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [mixtapeId],
    sql: `select ${COLUMNS} from mixtape_social_posts where mixtape_id = ? order by platform`,
  });

  return typedRows<MixtapeSocialPostRow>(result.rows).map(toItem);
}

export async function finalizeMixtapeDistribution(
  mixtapeId: string,
  platform: MixtapePlatform,
  result: { externalId?: string; url: string },
): Promise<MixtapeDTO> {
  const now = new Date().toISOString();
  const db = await getDb();

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
        args: [now, now, mixtapeId],
        sql: `update mixtapes set
                status = 'published',
                published_at = coalesce(published_at, ?),
                updated_at = ?
              where id = ? and status = 'distributing'`,
      },
      {
        args: [now, mixtapeId],
        sql: `update mixtapes set updated_at = ? where id = ?`,
      },
    ],
    "write",
  );

  const ownedTransition = (batchResults[1]?.rowsAffected ?? 0) > 0;

  const mixtape = await getMixtapeById(mixtapeId);
  purgeLogCache(mixtape.logId);

  if (ownedTransition) {
    notifyNewMixtape(mixtape);
  }

  return mixtape;
}

import { type SocialPostItem, type SocialStatusUpdate } from "@fluncle/contracts";

export type { SocialPostItem, SocialStatusUpdate };

import { getDb, typedRow, typedRows } from "./db";
import { batchDueWorkSourceMutation } from "./due-work";

type SocialPostRow = {
  created_at: string;
  external_id: string | null;
  platform: string;
  published_at: string | null;
  scheduled_for: string | null;
  status: string;
  updated_at: string;
  url: string | null;
};

const str = (value: string | null): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const toSocialPostItem = (row: SocialPostRow): SocialPostItem => ({
  createdAt: row.created_at,
  externalId: str(row.external_id),
  platform: row.platform,
  publishedAt: str(row.published_at),
  scheduledFor: str(row.scheduled_for),
  status: row.status,
  updatedAt: row.updated_at,
  url: str(row.url),
});

const POST_COLUMNS = `platform, status, external_id, url, scheduled_for, created_at, updated_at, published_at`;

export async function listSocialPosts(trackId: string): Promise<SocialPostItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select ${POST_COLUMNS} from social_posts where track_id = ? order by platform`,
  });

  return typedRows<SocialPostRow>(result.rows).map(toSocialPostItem);
}

export async function listSocialPostsForTracks(
  trackIds: string[],
): Promise<Record<string, SocialPostItem[]>> {
  if (trackIds.length === 0) {
    return {};
  }

  const db = await getDb();
  const placeholders = trackIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: trackIds,
    sql: `select track_id, ${POST_COLUMNS} from social_posts
          where track_id in (${placeholders}) order by platform`,
  });

  const byTrack: Record<string, SocialPostItem[]> = {};

  for (const row of typedRows<SocialPostRow & { track_id: string }>(result.rows)) {
    (byTrack[row.track_id] ??= []).push(toSocialPostItem(row));
  }

  return byTrack;
}

export async function upsertPost(
  trackId: string,
  platform: string,
  status: "draft" | "scheduled" | "published",
  externalId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const publishedAt = status === "published" ? now : null;
  const db = await getDb();

  await db.execute({
    args: [crypto.randomUUID(), trackId, platform, status, externalId, publishedAt, now, now],
    sql: `insert into social_posts (id, track_id, platform, status, external_id, published_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(track_id, platform) do update set
            status = excluded.status,
            external_id = excluded.external_id,
            published_at = coalesce(excluded.published_at, social_posts.published_at),
            updated_at = excluded.updated_at`,
  });

  await touchTrack(trackId, now);
}

export async function claimPost(trackId: string, platform: string): Promise<boolean> {
  const now = new Date().toISOString();
  const db = await getDb();

  const result = await db.execute({
    args: [crypto.randomUUID(), trackId, platform, now, now],
    sql: `insert into social_posts (id, track_id, platform, status, created_at, updated_at)
          values (?, ?, ?, 'failed', ?, ?)
          on conflict(track_id, platform) do nothing`,
  });

  return result.rowsAffected > 0;
}

export async function countPushesSince(sinceIso: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [sinceIso],
    sql: `select count(*) as n from social_posts
          where platform in ('youtube', 'tiktok') and created_at >= ?`,
  });

  return typedRow<{ n: number }>(result.rows)?.n ?? 0;
}

export async function countTikTokInboxDrafts(): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select count(*) as n from social_posts
          where platform = 'tiktok' and status = 'draft'`,
  });

  return typedRow<{ n: number }>(result.rows)?.n ?? 0;
}

export async function hasPostAwaitingUrl(platform: string): Promise<boolean> {
  const liveStatuses = platform === "tiktok" ? ["draft"] : ["published", "scheduled"];
  const placeholders = liveStatuses.map(() => "?").join(", ");
  const db = await getDb();
  const result = await db.execute({
    args: [platform, ...liveStatuses],
    sql: `select 1 from social_posts
          where platform = ?
            and status in (${placeholders})
            and url is null
          limit 1`,
  });

  return result.rows.length > 0;
}

export type PostAwaitingUrl = {
  externalId: string;
  platform: string;
  status: string;
  trackId: string;
};

export async function listPostsAwaitingUrl(limit: number): Promise<PostAwaitingUrl[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [limit],
    sql: `select track_id, platform, status, external_id from social_posts
          where platform in ('youtube', 'tiktok')
            and url is null
            and external_id is not null
            and status in ('published', 'draft')
          order by created_at asc
          limit ?`,
  });

  return typedRows<{
    external_id: string;
    platform: string;
    status: string;
    track_id: string;
  }>(result.rows).map((row) => ({
    externalId: row.external_id,
    platform: row.platform,
    status: row.status,
    trackId: row.track_id,
  }));
}

export async function isUrlClaimedByOtherTrack(url: string, trackId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    args: [url, trackId],
    sql: `select 1 from social_posts
          where url = ? and track_id != ?
          limit 1`,
  });

  return result.rows.length > 0;
}

export async function recordPostUrl(
  trackId: string,
  platform: string,
  url: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const db = await getDb();
  const result = await db.execute({
    args: [url, now, trackId, platform],
    sql: `update social_posts
          set url = ?, updated_at = ?
          where track_id = ? and platform = ? and url is null`,
  });

  if (result.rowsAffected > 0) {
    await touchTrack(trackId, now);

    return true;
  }

  return false;
}

async function touchTrack(trackId: string, now: string): Promise<void> {
  const db = await getDb();

  await batchDueWorkSourceMutation(
    db,
    [
      {
        args: [now, trackId],
        sql: `update findings set updated_at = ? where track_id = ?`,
      },
    ],
    [{ subjectId: trackId, subjectType: "track" }],
    { onlyIfLastSourceStatementChanged: true, producer: "social-finding-touch" },
  );
}

export async function updateSocialStatus(
  trackId: string,
  platform: string,
  update: SocialStatusUpdate,
): Promise<boolean> {
  const now = new Date().toISOString();
  const publishedAt = update.status === "published" ? now : null;
  const db = await getDb();

  await db.execute({
    args: [
      crypto.randomUUID(),
      trackId,
      platform,
      update.status,
      update.url ?? null,
      update.scheduledFor ?? null,
      publishedAt,
      now,
      now,
      update.status,
      update.url ?? null,
      update.scheduledFor ?? null,
      publishedAt,
      now,
    ],
    sql: `insert into social_posts (id, track_id, platform, status, url, scheduled_for, published_at, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(track_id, platform) do update set
            status = ?,
            url = coalesce(?, social_posts.url),
            scheduled_for = coalesce(?, social_posts.scheduled_for),
            published_at = coalesce(?, social_posts.published_at),
            updated_at = ?`,
  });

  await touchTrack(trackId, now);

  return true;
}

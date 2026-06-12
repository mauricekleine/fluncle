// Per-platform publication state (the `social_posts` table). One row per
// (track, platform). The generic track pipeline tops out at video-in-R2; this
// tracks where that video went and its state on each platform.

import { getDb, typedRows } from "./db";

export type SocialPostItem = {
  createdAt: string;
  externalId?: string;
  platform: string;
  publishedAt?: string;
  scheduledFor?: string;
  status: string;
  updatedAt: string;
  url?: string;
};

export type SocialStatusUpdate = {
  scheduledFor?: string;
  status: "scheduled" | "published" | "failed";
  url?: string;
};

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

/** All platform posts for a track. */
export async function listSocialPosts(trackId: string): Promise<SocialPostItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select platform, status, external_id, url, scheduled_for, created_at, updated_at, published_at
          from social_posts where track_id = ? order by platform`,
  });

  return typedRows<SocialPostRow>(result.rows).map((row) => ({
    createdAt: row.created_at,
    externalId: str(row.external_id),
    platform: row.platform,
    publishedAt: str(row.published_at),
    scheduledFor: str(row.scheduled_for),
    status: row.status,
    updatedAt: row.updated_at,
    url: str(row.url),
  }));
}

/** Record (or refresh) a pushed draft for a track on a platform. */
export async function upsertDraft(
  trackId: string,
  platform: string,
  externalId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const db = await getDb();

  await db.execute({
    args: [crypto.randomUUID(), trackId, platform, externalId, now, now],
    sql: `insert into social_posts (id, track_id, platform, status, external_id, created_at, updated_at)
          values (?, ?, ?, 'draft', ?, ?, ?)
          on conflict(track_id, platform) do update set
            status = 'draft', external_id = excluded.external_id, updated_at = excluded.updated_at`,
  });

  await touchTrack(trackId, now);
}

// A social-post change alters what the track's public surfaces show (the
// tiktok_url join in TRACK_SELECT), so it counts as a content change for the
// track record too — sitemap lastmod reads tracks.updated_at.
async function touchTrack(trackId: string, now: string): Promise<void> {
  const db = await getDb();

  await db.execute({
    args: [now, trackId],
    sql: `update tracks set updated_at = ? where track_id = ?`,
  });
}

/** Update a platform post after the operator reviews/publishes in-app. Returns
 *  false if there's no post to update (no draft was pushed). */
export async function updateSocialStatus(
  trackId: string,
  platform: string,
  update: SocialStatusUpdate,
): Promise<boolean> {
  const now = new Date().toISOString();
  const publishedAt = update.status === "published" ? now : null;
  const db = await getDb();

  const result = await db.execute({
    args: [
      update.status,
      update.url ?? null,
      update.scheduledFor ?? null,
      publishedAt,
      now,
      trackId,
      platform,
    ],
    sql: `update social_posts set
            status = ?,
            url = coalesce(?, url),
            scheduled_for = coalesce(?, scheduled_for),
            published_at = coalesce(?, published_at),
            updated_at = ?
          where track_id = ? and platform = ?`,
  });

  if (result.rowsAffected > 0) {
    await touchTrack(trackId, now);
  }

  return result.rowsAffected > 0;
}

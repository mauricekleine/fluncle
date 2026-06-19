// Per-platform publication state (the `social_posts` table). One row per
// (track, platform). The generic track pipeline tops out at video-in-R2; this
// tracks where that video went and its state on each platform.

import { type SocialPostItem, type SocialStatusUpdate } from "@fluncle/contracts";

export type { SocialPostItem, SocialStatusUpdate };

import { getDb, typedRows } from "./db";

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

/** All platform posts for a track. */
export async function listSocialPosts(trackId: string): Promise<SocialPostItem[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [trackId],
    sql: `select ${POST_COLUMNS} from social_posts where track_id = ? order by platform`,
  });

  return typedRows<SocialPostRow>(result.rows).map(toSocialPostItem);
}

/**
 * All platform posts for a set of tracks, keyed by trackId — one query, no N+1.
 * The admin posting board reads this for a page of findings; tracks with no
 * posts are simply absent from the map.
 */
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

/**
 * Record (or refresh) a pushed post for a track on a platform. `draft` is the
 * TikTok inbox push; `published` is a direct post (Instagram/YouTube) that goes
 * live on the click. Published stamps `published_at`; the public `url` is filled
 * later by the operator (Postiz doesn't return it on create).
 */
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

  // Upsert: the operator may record a post that was published manually (or
  // pushed from another environment), so a prior draft row isn't guaranteed.
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

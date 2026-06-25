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

/** A published post reduced to what the publish-streak reads — the platform and the
 *  Amsterdam-bucketed day it went live. */
export type PublishedPostDay = { platform: string; publishedAt: string };

/**
 * The full set of (platform, published_at) for every published post — the input to
 * the board's publish-streak. Read straight from `social_posts`, independent of the
 * board's finding pagination, so the streak counts every qualifying day, not just
 * the loaded window. Only `published` rows with a non-null `published_at` come back.
 */
export async function listPublishedPostDays(): Promise<PublishedPostDay[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `select platform, published_at from social_posts
          where status = 'published' and published_at is not null`,
  });

  return typedRows<{ platform: string; published_at: string }>(result.rows).map((row) => ({
    platform: row.platform,
    publishedAt: row.published_at,
  }));
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

/**
 * Whether any finding is in the "pushed but no URL" state for a platform — a row
 * with a live status but a still-null `url`. The push gate reads this: Postiz
 * doesn't return the live URL on create, so we resolve it asynchronously from
 * `/missing` by matching the newest item per platform. Allowing a second push
 * while one is still awaiting its URL would make that newest-match ambiguous, so
 * the gate keeps exactly one upload pending at a time per platform.
 *
 * The "live" statuses differ by platform: a YouTube Short posts DIRECTLY
 * (`published`/`scheduled`), while a TikTok push lands as an inbox `draft` the
 * operator finishes in-app. Both can have a recoverable native id on Postiz's
 * `/missing` before their `url` is captured, so TikTok's `draft` counts here too —
 * the capture sweep flips a captured TikTok `draft` to `published`.
 */
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

/** A post the capture sweep should poll: it has a Postiz post id but no captured
 *  `url` yet. The sweep builds the permalink from `/missing` and records it. */
export type PostAwaitingUrl = {
  externalId: string;
  platform: string;
  status: string;
  trackId: string;
};

/**
 * Every post still awaiting its public URL on an auto-capturable platform —
 * `youtube`/`tiktok` rows with a Postiz post id (`external_id`) but a null `url`,
 * in a status the capture sweep handles (`published`/`draft`). The sweep polls
 * Postiz's `/missing` for each, builds the permalink from the native id, records
 * it, links the Postiz release-id, and flips a captured TikTok `draft` to
 * `published`. Oldest first so the backlog drains in order.
 */
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

/**
 * Record the live public URL on a track's platform row (the auto-resolved
 * Postiz `/missing` permalink). Best-effort: only fills an empty `url`, so a URL
 * the operator already entered manually is never clobbered. Returns false if
 * there's no matching row to fill (e.g. the post row vanished).
 */
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

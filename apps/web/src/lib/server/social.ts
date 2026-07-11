// Per-platform publication state (the `social_posts` table). One row per
// (track, platform). The generic track pipeline tops out at video-in-R2; this
// tracks where that video went and its state on each platform.

import { type SocialPostItem, type SocialStatusUpdate } from "@fluncle/contracts";

export type { SocialPostItem, SocialStatusUpdate };

import { getDb, typedRow, typedRows } from "./db";

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

/**
 * CLAIM a finding's platform slot before pushing it — the auto-advance's
 * double-publish guard (./publish-advance.ts). An `insert … on conflict do nothing`
 * against the `(track_id, platform)` unique index: exactly ONE writer can create the
 * row, so two overlapping advance ticks that both selected the same finding race here
 * and only the winner gets `true`. The loser skips without touching the network — the
 * claim is taken BEFORE any call to Postiz, so a public upload can only ever happen
 * behind a won claim.
 *
 * The claim row is written `failed` ON PURPOSE — assume the push failed until it is
 * PROVEN to have succeeded. If the Worker dies mid-push (or Postiz errors), the row is
 * already in its honest end state: `failed`, visible on the board and still in the
 * attention queue as an unposted leg, and never auto-retried (the advance only ever
 * picks findings with NO row for the platform — it fails CLOSED). A successful push
 * immediately overwrites it via `upsertPost` with the real status + Postiz id.
 *
 * Returns false when a row already existed (another tick won it, or the finding was
 * pushed manually) — the caller must then leave that finding alone.
 */
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

/**
 * How many posts were PUSHED across the auto-advance's platforms since `sinceIso` — the
 * rolling-window read its daily backstop cap is checked against. Counts every row
 * created in the window (auto-advanced or hand-pushed alike): the cap exists to bound
 * how much of the archive can hit the public feed in a day, and a manual push spends
 * from the same budget.
 */
export async function countPushesSince(sinceIso: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [sinceIso],
    sql: `select count(*) as n from social_posts
          where platform in ('youtube', 'tiktok') and created_at >= ?`,
  });

  return typedRow<{ n: number }>(result.rows)?.n ?? 0;
}

/**
 * How many TikTok inbox drafts are currently unfinished (`status = 'draft'`) — TikTok
 * caps UNPUBLISHED inbox drafts at 5 per rolling 24h and bounces the 6th
 * asynchronously (so a push "succeeds" and then silently vanishes). The auto-advance
 * holds TikTok back once the inbox is at the cap, rather than burning a push on a
 * draft TikTok will drop.
 */
export async function countTikTokInboxDrafts(): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select count(*) as n from social_posts
          where platform = 'tiktok' and status = 'draft'`,
  });

  return typedRow<{ n: number }>(result.rows)?.n ?? 0;
}

/**
 * Whether any finding is in the "pushed but no URL" state for a platform — a row
 * with a live status but a still-null `url`. The push gate reads this: Postiz
 * doesn't return the live URL on create, so we resolve it asynchronously (YouTube
 * from the auto-populated `releaseURL` on the dated `/posts` list; TikTok from the
 * newest `/missing` item). The TikTok newest-match would go ambiguous with two
 * drafts in flight, so the gate keeps exactly one upload pending at a time per
 * platform — and keeps the operator's capture queue shallow and legible.
 *
 * The "live" statuses differ by platform: a YouTube Short posts DIRECTLY
 * (`published`/`scheduled`), while a TikTok push lands as an inbox `draft` the
 * operator finishes in-app. A YouTube post carries its own auto-populated
 * `releaseURL` once published, and a TikTok `draft` has a recoverable native id on
 * `/missing`, so TikTok's `draft` counts here too — the capture sweep flips a
 * captured TikTok `draft` to `published`.
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
 * in a status the capture sweep handles (`published`/`draft`). The sweep resolves
 * each (YouTube's auto-populated `releaseURL` off the dated `/posts` list /
 * TikTok's `/missing` aweme id), records the url, links the Postiz release-id, and
 * flips a captured TikTok `draft` to `published`. Oldest first so the backlog
 * drains in order.
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
 * Whether this exact public URL is already stored on a DIFFERENT track's social
 * post. The TikTok capture builds its permalink from the @fluncle account's
 * NEWEST published aweme (`/missing`) — but while a just-pushed draft still sits
 * unpublished in the inbox, that "newest" post is the PREVIOUS track's video.
 * Recording it would wrongly attach another track's URL to this one, so the
 * sweep skips a URL already claimed elsewhere and leaves the row pending until
 * TikTok surfaces a fresh, unclaimed permalink (i.e. once the draft is actually
 * published in-app). The current track is excluded (`track_id != ?`) so its own
 * row never blocks itself.
 */
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
    sql: `update findings set updated_at = ? where track_id = ?`,
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

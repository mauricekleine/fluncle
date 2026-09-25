import { bestAlbumCoverUrl, trackMedia } from "../media";
import { parseArtistsJson } from "./artists";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRow, typedRows } from "./db";
import { readOptionalEnv } from "./env";
import { renderFollowDigestEmail, type FollowDigestRelease } from "./follow-digest-email";
import { createFollowDigestToken } from "./follow-digest-tokens";
import { sendFollowDigestEmail } from "./resend";
import { getSetting, setSetting } from "./settings";

export const FOLLOW_DIGEST_PAUSED_KEY = "follow_digest_paused";
export const FOLLOW_DIGEST_MAX_SENDS = 50;
export const FOLLOW_DIGEST_MAX_ITEMS = 30;
const SITE = "https://www.fluncle.com";

type SubscriberRow = {
  email: string;
  id: string;
  last_sent_at: string | null;
};

type ReleaseRow = {
  album_image_key: string | null;
  album_image_state: string | null;
  album_image_updated_at: string | null;
  album_image_url: string | null;
  artists_json: string;
  follow_name: string;
  log_id: string | null;
  title: string;
  track_id: string;
};

export function digestWeekKey(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
  const year = utc.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((utc.getTime() - start.getTime()) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export async function isFollowDigestPaused(): Promise<boolean> {
  return (await getSetting(FOLLOW_DIGEST_PAUSED_KEY)) === "true";
}

export async function setFollowDigestPaused(paused: boolean): Promise<void> {
  await setSetting(FOLLOW_DIGEST_PAUSED_KEY, String(paused));
}

export const FOLLOW_DIGEST_RELEASE_SQL = `with matched as (
  select tracks.track_id, tracks.title, tracks.artists_json, tracks.release_date,
    tracks.album_id, tracks.album_image_url, followed.follow_name, followed.follow_rank
  from (
    select ta.track_id, a.name as follow_name, 0 as follow_rank
    from user_watches w
    join artists a on a.id = w.entity_id and ${listedArtistWhere("a")}
    join track_artists ta on ta.artist_id = a.id
    where w.user_id = ? and w.kind = 'artist'
    union all
    select label_tracks.track_id, l.name as follow_name, 1 as follow_rank
    from user_watches w
    join labels l on l.id = w.entity_id
    join tracks label_tracks on label_tracks.label_id = l.id
      and label_tracks.release_date > ? and label_tracks.release_date <= ?
    where w.user_id = ? and w.kind = 'label'
  ) followed
  join tracks on tracks.track_id = followed.track_id
  left join findings on findings.track_id = tracks.track_id
  left join albums on albums.id = tracks.album_id
  where tracks.release_date > ? and tracks.release_date <= ?
    and (tracks.is_catalogue = 1 or findings.log_id is not null)
    and tracks.dismissed_at is null
    and tracks.duplicate_of_track_id is null
    and (findings.log_id is not null or tracks.spotify_url is not null or tracks.apple_music_url is not null)
    and (findings.log_id is not null or tracks.album_image_url is not null or albums.image_key is not null)
), ranked as (
  select *, row_number() over (
    partition by coalesce(album_id, track_id)
    order by follow_rank, release_date desc, track_id desc
  ) as release_rank from matched
)
select ranked.track_id, ranked.title, ranked.artists_json, ranked.album_image_url,
  findings.log_id, ranked.follow_name,
  albums.image_key as album_image_key, albums.image_state as album_image_state,
  albums.image_updated_at as album_image_updated_at
from ranked
left join findings on findings.track_id = ranked.track_id
left join albums on albums.id = ranked.album_id
where ranked.release_rank = 1
order by ranked.release_date desc, ranked.track_id desc limit ?`;

export async function listFollowDigestReleases(
  userId: string,
  since: string,
  today: string,
): Promise<{ items: FollowDigestRelease[]; more: boolean }> {
  const result = await (
    await getDb()
  ).execute({
    args: [userId, since, today, userId, since, today, FOLLOW_DIGEST_MAX_ITEMS + 1],
    sql: FOLLOW_DIGEST_RELEASE_SQL,
  });
  const rows = typedRows<ReleaseRow>(result.rows);
  return {
    items: rows.slice(0, FOLLOW_DIGEST_MAX_ITEMS).map((row) => ({
      artists: parseArtistsJson(row.artists_json).join(", "),
      coverUrl:
        bestAlbumCoverUrl({
          imageKey: row.album_image_key,
          imageState: row.album_image_state,
          imageUpdatedAt: row.album_image_updated_at,
          spotifyUrl: row.album_image_url,
        }) ?? (row.log_id ? trackMedia(row.log_id).coverUrl : undefined),
      followName: row.follow_name,
      href: row.log_id
        ? `${SITE}/log/${encodeURIComponent(row.log_id)}`
        : `${SITE}/track/${encodeURIComponent(row.track_id)}`,
      title: row.title,
    })),
    more: rows.length > FOLLOW_DIGEST_MAX_ITEMS,
  };
}

export type FollowDigestSendResult = {
  capped: boolean;
  considered: number;
  dryRun: boolean;
  empty: number;
  nextCursor?: string;
  ok: true;
  paused: boolean;
  sent: number;
  skipped: number;
  weekKey: string;
};

export async function sendFollowDigests(
  options: {
    cursor?: string;
    dryRun?: boolean;
    limit?: number;
    now?: Date;
  } = {},
): Promise<FollowDigestSendResult> {
  const now = options.now ?? new Date();
  const weekKey = digestWeekKey(now);
  const dryRun = options.dryRun ?? false;
  const testRecipient = await readOptionalEnv("FOLLOW_DIGEST_TEST_RECIPIENT");
  const base: FollowDigestSendResult = {
    capped: false,
    considered: 0,
    dryRun,
    empty: 0,
    ok: true,
    paused: false,
    sent: 0,
    skipped: 0,
    weekKey,
  };
  if (await isFollowDigestPaused()) {
    return { ...base, paused: true };
  }
  const limit = Math.min(
    Math.max(options.limit ?? FOLLOW_DIGEST_MAX_SENDS, 1),
    FOLLOW_DIGEST_MAX_SENDS,
  );
  const db = await getDb();
  const result = await db.execute({
    args: [options.cursor ?? "", weekKey, limit + 1],
    sql: `select u.id, u.email, d.last_sent_at
      from "user" u left join user_follow_digests d on d.user_id = u.id
      where u.id > ? and u.status = 'active' and u.email_verified = 1 and trim(u.email) <> ''
        and d.unsubscribed_at is null and (d.last_week_key is null or d.last_week_key <> ?)
        and exists (select 1 from user_watches w where w.user_id = u.id)
      order by u.id limit ?`,
  });
  const subscribers = typedRows<SubscriberRow>(result.rows);
  const selected = subscribers.slice(0, limit);
  for (const subscriber of selected) {
    base.considered += 1;
    const since = subscriber.last_sent_at
      ? subscriber.last_sent_at.slice(0, 10)
      : new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const releases = await listFollowDigestReleases(
      subscriber.id,
      since,
      now.toISOString().slice(0, 10),
    );
    if (releases.items.length === 0) {
      base.empty += 1;
      continue;
    }
    if (dryRun) {
      base.skipped += 1;
      continue;
    }
    if (await isFollowDigestPaused()) {
      base.paused = true;
      break;
    }
    const currentState = await db.execute({
      args: [subscriber.id],
      sql: `select last_week_key, unsubscribed_at from user_follow_digests where user_id = ? limit 1`,
    });
    const state = typedRow<{ last_week_key: string | null; unsubscribed_at: string | null }>(
      currentState.rows,
    );
    if (state?.unsubscribed_at || state?.last_week_key === weekKey) {
      base.skipped += 1;
      continue;
    }
    if (base.sent > 0) {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    const unsubscribeUrl = `${SITE}/api/v1/follow-digest/unsubscribe?token=${encodeURIComponent(createFollowDigestToken(subscriber.id, "unsubscribe"))}`;
    const manageUrl = `${SITE}/follows?token=${encodeURIComponent(createFollowDigestToken(subscriber.id, "manage"))}`;
    const email = renderFollowDigestEmail({
      items: releases.items,
      manageUrl,
      more: releases.more,
      unsubscribeUrl,
    });
    await sendFollowDigestEmail({
      ...email,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      idempotencyKey: `follow-digest/${testRecipient ? "test/" : ""}${subscriber.id}/${weekKey}`,
      to: testRecipient ?? subscriber.email,
    });
    if (!testRecipient) {
      const sentAt = now.toISOString();
      await db.execute({
        args: [subscriber.id, weekKey, sentAt, releases.items.length, sentAt],
        sql: `insert into user_follow_digests
        (user_id, last_week_key, last_sent_at, last_release_count, updated_at)
        values (?, ?, ?, ?, ?)
        on conflict(user_id) do update set
          last_week_key = excluded.last_week_key,
          last_sent_at = excluded.last_sent_at,
          last_release_count = excluded.last_release_count,
          updated_at = excluded.updated_at
        where user_follow_digests.unsubscribed_at is null`,
      });
    }
    base.sent += 1;
    if (testRecipient) {
      break;
    }
  }
  if (testRecipient && base.sent > 0) {
    return base;
  }
  if (subscribers.length > limit) {
    base.nextCursor = selected.at(-1)?.id;
    base.capped = true;
  }
  return base;
}

export async function isFollowDigestSubscribed(userId: string): Promise<boolean> {
  const result = await (
    await getDb()
  ).execute({
    args: [userId],
    sql: `select unsubscribed_at from user_follow_digests where user_id = ? limit 1`,
  });

  return typedRow<{ unsubscribed_at: string | null }>(result.rows)?.unsubscribed_at == null;
}

export async function setFollowDigestSubscription(
  userId: string,
  subscribed: boolean,
  now: Date = new Date(),
): Promise<void> {
  const timestamp = now.toISOString();
  const db = await getDb();
  await db.execute({
    args: [userId, subscribed ? null : timestamp, timestamp, userId],
    sql: `insert into user_follow_digests (user_id, unsubscribed_at, updated_at)
      select ?, ?, ? where exists (select 1 from "user" where id = ? and status = 'active')
      on conflict(user_id) do update set
        unsubscribed_at = excluded.unsubscribed_at, updated_at = excluded.updated_at
      where (excluded.unsubscribed_at is null and user_follow_digests.unsubscribed_at is not null)
         or (excluded.unsubscribed_at is not null and user_follow_digests.unsubscribed_at is null)`,
  });
}

export async function listDigestFollows(userId: string): Promise<{
  follows: { id: string; kind: "artist" | "label"; name: string; slug: string }[];
  ok: true;
  subscribed: boolean;
}> {
  const db = await getDb();
  const [state, follows] = await Promise.all([
    db.execute({
      args: [userId],
      sql: `select unsubscribed_at from user_follow_digests where user_id = ? limit 1`,
    }),
    db.execute({
      args: [userId],
      sql: `select w.id, w.kind, coalesce(a.name, l.name) as name,
          coalesce(a.slug, l.slug) as slug
        from user_watches w
        left join artists a on w.kind = 'artist' and a.id = w.entity_id and ${listedArtistWhere("a")}
        left join labels l on w.kind = 'label' and l.id = w.entity_id
        where w.user_id = ? order by w.created_at desc`,
    }),
  ]);
  const row = typedRow<{ unsubscribed_at: string | null }>(state.rows);
  return {
    follows: typedRows<{
      id: string;
      kind: "artist" | "label";
      name: string | null;
      slug: string | null;
    }>(follows.rows).filter(
      (follow): follow is { id: string; kind: "artist" | "label"; name: string; slug: string } =>
        Boolean(follow.name && follow.slug),
    ),
    ok: true,
    subscribed: row?.unsubscribed_at == null,
  };
}

export async function deleteDigestFollow(userId: string, id: string): Promise<boolean> {
  const result = await (
    await getDb()
  ).execute({
    args: [userId, id],
    sql: `delete from user_watches where user_id = ? and id = ?`,
  });
  return result.rowsAffected > 0;
}

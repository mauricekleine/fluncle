import { bestAlbumCoverUrl, trackMedia } from "../media";
import { randomUUID } from "node:crypto";
import { parseArtistsJson } from "./artists";
import { listedArtistWhere } from "./artist-visibility";
import { getDb, typedRow, typedRows } from "./db";
import { readOptionalEnv } from "./env";
import { renderFollowDigestEmail, type FollowDigestRelease } from "./follow-digest-email";
import {
  createFollowDigestToken,
  FollowDigestRecipientUnavailableError,
} from "./follow-digest-tokens";
import { readResendSender, ResendDeliveryError, sendFollowDigestEmail } from "./resend";
import { getSetting, setSetting } from "./settings";

export const FOLLOW_DIGEST_PAUSED_KEY = "follow_digest_paused";
export const FOLLOW_DIGEST_MAX_SENDS = 50;
export const FOLLOW_DIGEST_MAX_ITEMS = 30;
export const FOLLOW_DIGEST_MAX_FOLLOWS = 200;
const FOLLOW_DIGEST_WINDOW_DAYS = 28;
const CLAIM_GRACE_MS = 2 * 60_000;
const RESEND_IDEMPOTENCY_MS = 24 * 60 * 60_000;
const MAX_SEND_ATTEMPTS = 3;
const SITE = "https://www.fluncle.com";

type SubscriberRow = {
  id: string;
};

type DeliveryPayload = Parameters<typeof sendFollowDigestEmail>[0];

type DeliveryRow = {
  attempts: number;
  claimed_at: string;
  id: string;
  payload_json: string;
  release_count: number;
  status: "claimed" | "failed" | "sent" | "unknown";
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
    tracks.album_id, tracks.album_image_url, coalesce(a.name, l.name) as follow_name,
    case when w.kind = 'artist' then 0 else 1 end as follow_rank
  from tracks indexed by tracks_release_date_idx
  cross join (
    select kind, entity_id from user_watches
    where user_id = ? order by created_at desc, id desc limit ${FOLLOW_DIGEST_MAX_FOLLOWS}
  ) w
  left join artists a on w.kind = 'artist' and a.id = w.entity_id and ${listedArtistWhere("a")}
  left join labels l on w.kind = 'label' and l.id = w.entity_id
  left join findings on findings.track_id = tracks.track_id
  left join albums on albums.id = tracks.album_id
  where tracks.release_date > ? and tracks.release_date <= ?
    and ((w.kind = 'label' and l.id is not null and tracks.label_id = l.id)
      or (w.kind = 'artist' and a.id is not null and exists (
        select 1 from track_artists ta
        where ta.track_id = tracks.track_id and ta.artist_id = a.id
      )))
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
  const windowStart = new Date(`${today}T00:00:00.000Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - FOLLOW_DIGEST_WINDOW_DAYS);
  const boundedSince =
    since > windowStart.toISOString().slice(0, 10) ? since : windowStart.toISOString().slice(0, 10);
  const result = await (
    await getDb()
  ).execute({
    args: [userId, boundedSince, today, FOLLOW_DIGEST_MAX_ITEMS + 1],
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
  failed: number;
  nextCursor?: string;
  ok: true;
  paused: boolean;
  sent: number;
  skipped: number;
  unknown: number;
  weekKey: string;
};

async function eligibleSubscriber(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  weekKey: string,
): Promise<{ email: string; last_sent_at: string | null } | undefined> {
  const result = await db.execute({
    args: [userId, weekKey],
    sql: `select u.email, d.last_sent_at from "user" u
      left join user_follow_digests d on d.user_id = u.id
      where u.id = ? and u.status = 'active' and u.email_verified = 1
        and trim(u.email) <> '' and d.unsubscribed_at is null
        and (d.last_week_key is null or d.last_week_key <> ?)
        and exists (select 1 from user_watches w where w.user_id = u.id)
      limit 1`,
  });
  return typedRow<{ email: string; last_sent_at: string | null }>(result.rows);
}

async function deliveryFor(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  weekKey: string,
): Promise<DeliveryRow | undefined> {
  const result = await db.execute({
    args: [userId, weekKey],
    sql: `select id, status, payload_json, release_count, claimed_at, attempts
      from follow_digest_deliveries where user_id = ? and week_key = ? limit 1`,
  });
  return typedRow<DeliveryRow>(result.rows);
}

async function setDeliveryStatus<Status extends "failed" | "unknown">(
  db: Awaited<ReturnType<typeof getDb>>,
  id: string,
  status: Status,
  now: Date,
  error: string | null,
): Promise<Status | "skipped"> {
  const result = await db.execute({
    args: [status, error, now.toISOString(), id, "claimed"],
    sql: `update follow_digest_deliveries set status = ?, last_error = ?, updated_at = ?
      where id = ? and status = ?`,
  });
  return result.rowsAffected > 0 ? status : "skipped";
}

async function completedDeliveryOutcome(
  db: Awaited<ReturnType<typeof getDb>>,
  id: string,
  rowsAffected: number,
): Promise<"sent" | "skipped"> {
  if (rowsAffected > 0) {
    return "sent";
  }
  const result = await db.execute({
    args: [id],
    sql: `select status from follow_digest_deliveries where id = ? limit 1`,
  });
  return result.rows.length === 0 ? "sent" : "skipped";
}

async function sendClaimedDelivery(
  db: Awaited<ReturnType<typeof getDb>>,
  delivery: DeliveryRow,
  userId: string,
  weekKey: string,
  now: Date,
  testRecipient: boolean,
): Promise<"failed" | "sent" | "skipped"> {
  const payload = JSON.parse(delivery.payload_json) as DeliveryPayload;
  let attempts = delivery.attempts;
  const allowance = Math.max(1, MAX_SEND_ATTEMPTS - attempts);
  for (let retry = 0; retry < allowance; retry += 1) {
    attempts += 1;
    await db.execute({
      args: [now.toISOString(), delivery.id],
      sql: `update follow_digest_deliveries set attempts = attempts + 1, updated_at = ?
        where id = ? and status = 'claimed'`,
    });
    let response: Awaited<ReturnType<typeof sendFollowDigestEmail>>;
    try {
      response = await sendFollowDigestEmail(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient =
        error instanceof TypeError ||
        (error instanceof ResendDeliveryError &&
          (error.upstreamStatus === 429 || error.upstreamStatus >= 500));
      if (transient && retry + 1 < allowance) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** retry));
        continue;
      }
      return setDeliveryStatus(db, delivery.id, "failed", now, message);
    }
    const sentAt = now.toISOString();
    if (testRecipient) {
      const completed = await db.execute({
        args: [response.id, sentAt, sentAt, delivery.id],
        sql: `update follow_digest_deliveries set status = 'sent', resend_id = ?, sent_at = ?, updated_at = ?
          where id = ? and status <> 'sent'`,
      });
      return completedDeliveryOutcome(db, delivery.id, completed.rowsAffected);
    } else {
      const completed = await db.batch(
        [
          {
            args: [response.id, sentAt, sentAt, delivery.id],
            sql: `update follow_digest_deliveries set status = 'sent', resend_id = ?, sent_at = ?, updated_at = ?
              where id = ? and status <> 'sent'`,
          },
          {
            args: [weekKey, sentAt, delivery.release_count, sentAt, delivery.id, userId],
            sql: `insert into user_follow_digests
              (user_id, last_week_key, last_sent_at, last_release_count, updated_at)
              select u.id, ?, ?, ?, ? from "user" u
              join follow_digest_deliveries f on f.user_id = u.id and f.id = ? and f.status = 'sent'
              where u.id = ? and u.status = 'active'
              on conflict(user_id) do update set
                last_week_key = excluded.last_week_key,
                last_sent_at = excluded.last_sent_at,
                last_release_count = excluded.last_release_count,
                updated_at = excluded.updated_at
              where user_follow_digests.unsubscribed_at is null
                and (user_follow_digests.last_week_key is null
                  or user_follow_digests.last_week_key <> excluded.last_week_key)`,
          },
        ],
        "write",
      );
      return completedDeliveryOutcome(db, delivery.id, completed[0]?.rowsAffected ?? 0);
    }
  }
  return "failed";
}

async function recoverClaimedDelivery(
  db: Awaited<ReturnType<typeof getDb>>,
  delivery: DeliveryRow,
  userId: string,
  weekKey: string,
  now: Date,
  dryRun: boolean,
  testRecipient: string | undefined,
): Promise<"failed" | "sent" | "skipped" | "unknown"> {
  if (dryRun || delivery.status !== "claimed") {
    return "skipped";
  }
  const eligible = await eligibleSubscriber(db, userId, weekKey);
  if (!eligible) {
    return setDeliveryStatus(db, delivery.id, "unknown", now, "Recipient is no longer eligible");
  }
  const age = now.getTime() - new Date(delivery.claimed_at).getTime();
  if (age < CLAIM_GRACE_MS) {
    return "skipped";
  }
  if (age >= RESEND_IDEMPOTENCY_MS) {
    return setDeliveryStatus(db, delivery.id, "unknown", now, "Resend idempotency window elapsed");
  }
  const payload = JSON.parse(delivery.payload_json) as DeliveryPayload;
  if (payload.to !== (testRecipient ?? eligible.email)) {
    return setDeliveryStatus(
      db,
      delivery.id,
      "unknown",
      now,
      "Recipient address changed after claim",
    );
  }
  return sendClaimedDelivery(db, delivery, userId, weekKey, now, Boolean(testRecipient));
}

async function recipientTokens(
  userId: string,
): Promise<{ manage: string; unsubscribe: string } | undefined> {
  try {
    const [unsubscribe, manage] = await Promise.all([
      createFollowDigestToken(userId, "unsubscribe"),
      createFollowDigestToken(userId, "manage"),
    ]);
    return { manage, unsubscribe };
  } catch (error) {
    if (error instanceof FollowDigestRecipientUnavailableError) {
      return undefined;
    }
    throw error;
  }
}

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
    failed: 0,
    ok: true,
    paused: false,
    sent: 0,
    skipped: 0,
    unknown: 0,
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
  const deliveryWeekKey = testRecipient ? `test/${weekKey}` : weekKey;
  const result = await db.execute({
    args: [deliveryWeekKey, options.cursor ?? "", weekKey, limit + 1],
    sql: `select u.id
      from "user" u left join user_follow_digests d on d.user_id = u.id
      left join follow_digest_deliveries f on f.user_id = u.id and f.week_key = ?
      where u.id > ? and (f.status = 'claimed' or (
        f.id is null and u.status = 'active' and u.email_verified = 1 and trim(u.email) <> ''
        and d.unsubscribed_at is null and (d.last_week_key is null or d.last_week_key <> ?)
        and exists (select 1 from user_watches w where w.user_id = u.id)))
      order by u.id limit ?`,
  });
  const subscribers = typedRows<SubscriberRow>(result.rows);
  const selected = subscribers.slice(0, limit);
  for (const subscriber of selected) {
    base.considered += 1;
    if (await isFollowDigestPaused()) {
      base.paused = true;
      break;
    }
    const existing = await deliveryFor(db, subscriber.id, deliveryWeekKey);
    if (existing) {
      const outcome = await recoverClaimedDelivery(
        db,
        existing,
        subscriber.id,
        weekKey,
        now,
        dryRun,
        testRecipient,
      );
      base[outcome] += 1;
      if (testRecipient && outcome === "sent") {
        break;
      }
      continue;
    }
    const eligible = await eligibleSubscriber(db, subscriber.id, weekKey);
    if (!eligible) {
      base.skipped += 1;
      continue;
    }
    const since = eligible.last_sent_at
      ? eligible.last_sent_at.slice(0, 10)
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
    const fresh = await eligibleSubscriber(db, subscriber.id, weekKey);
    if (!fresh) {
      base.skipped += 1;
      continue;
    }
    if (base.sent > 0) {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    const tokens = await recipientTokens(subscriber.id);
    if (!tokens) {
      base.skipped += 1;
      continue;
    }
    const unsubscribeUrl = `${SITE}/api/v1/follow-digest/unsubscribe?token=${encodeURIComponent(tokens.unsubscribe)}`;
    const manageUrl = `${SITE}/follows?token=${encodeURIComponent(tokens.manage)}`;
    const email = renderFollowDigestEmail({
      items: releases.items,
      manageUrl,
      more: releases.more,
      unsubscribeUrl,
    });
    const id = randomUUID();
    const idempotencyKey = `follow-digest/${testRecipient ? "test/" : ""}${subscriber.id}/${weekKey}/${id}`;
    const payload: DeliveryPayload = {
      ...email,
      from: await readResendSender(),
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      idempotencyKey,
      to: testRecipient ?? fresh.email,
    };
    const claimedAt = now.toISOString();
    const claim = await db.execute({
      args: [
        id,
        deliveryWeekKey,
        idempotencyKey,
        JSON.stringify(payload),
        releases.items.length,
        claimedAt,
        claimedAt,
        subscriber.id,
        fresh.email,
        weekKey,
        deliveryWeekKey,
      ],
      sql: `insert into follow_digest_deliveries
        (id, user_id, week_key, status, idempotency_key, payload_json, release_count, claimed_at, updated_at)
        select ?, u.id, ?, 'claimed', ?, ?, ?, ?, ?
        from "user" u left join user_follow_digests d on d.user_id = u.id
        where u.id = ? and u.email = ? and u.status = 'active' and u.email_verified = 1
          and trim(u.email) <> '' and d.unsubscribed_at is null
          and (d.last_week_key is null or d.last_week_key <> ?)
          and exists (select 1 from user_watches w where w.user_id = u.id)
          and not exists (select 1 from follow_digest_deliveries f where f.user_id = u.id and f.week_key = ?)
        on conflict(user_id, week_key) do nothing`,
    });
    if (claim.rowsAffected === 0) {
      base.skipped += 1;
      continue;
    }
    const outcome = await sendClaimedDelivery(
      db,
      {
        attempts: 0,
        claimed_at: claimedAt,
        id,
        payload_json: JSON.stringify(payload),
        release_count: releases.items.length,
        status: "claimed",
      },
      subscriber.id,
      weekKey,
      now,
      Boolean(testRecipient),
    );
    base[outcome] += 1;
    if (testRecipient && outcome === "sent") {
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

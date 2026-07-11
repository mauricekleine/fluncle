// The clip drip-feed schedule store + the global kill switch (clip-drip-feed RFC §3/§5).
//
// This is the ACTIVE schedule for `mixtape_clip_social_posts`, not passive tracking:
// creating a clip auto-enrols a `scheduled` row whose `scheduled_for` is a jittered
// ~24h after the queue tail, and the drip cron drains the due rows through Postiz.
// Mirrors `mixtape-social.ts` (getDb + typedRow/typedRows, validate-and-throw), but the
// scheduling arithmetic (`computeNextDripSlot`) is a PURE, DB-free core so it unit-tests
// without a database.
//
// The kill switch rides the lean `settings` KV table (a single `clip_drip_paused` key),
// so pausing halts every future post while the schedule stays intact. `getSetting`/
// `setSetting` (./settings.ts) are the reusable KV primitives underneath — the same pair
// the render → publish auto-advance's switch rides.

import { getDb, typedRow, typedRows } from "./db";
import { getSetting, setSetting } from "./settings";

// Instagram is the only drip platform today (the enum leaves room to grow).
export const CLIP_DRIP_PLATFORM = "instagram" as const;

// The kill-switch key in the `settings` KV.
export const CLIP_DRIP_PAUSED_KEY = "clip_drip_paused";

// The jittered daily cadence: a clip's slot is the queue tail + a random gap in
// [23h, 25h]. The jitter keeps post times drifting so the feed never reads as a bot
// posting at the same wall-clock minute every day (RFC §1, decision 3).
const HOUR_MS = 60 * 60 * 1000;
export const DRIP_MIN_GAP_MS = 23 * HOUR_MS;
export const DRIP_MAX_GAP_MS = 25 * HOUR_MS;

export type ClipSocialStatus = "failed" | "posted" | "scheduled";

/** A `mixtape_clip_social_posts` row as the store reads it back. */
export type ClipSocialPost = {
  caption?: string;
  clipId: string;
  createdAt: string;
  platform: string;
  postedUrl?: string;
  postizId?: string;
  scheduledFor: string;
  status: ClipSocialStatus;
  updatedAt: string;
};

type ClipSocialPostRow = {
  caption: string | null;
  clip_id: string;
  created_at: string;
  platform: string;
  posted_url: string | null;
  postiz_id: string | null;
  scheduled_for: string;
  status: string;
  updated_at: string;
};

const str = (value: string | null): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function rowToPost(row: ClipSocialPostRow): ClipSocialPost {
  return {
    caption: str(row.caption),
    clipId: row.clip_id,
    createdAt: row.created_at,
    platform: row.platform,
    postedUrl: str(row.posted_url),
    postizId: str(row.postiz_id),
    scheduledFor: row.scheduled_for,
    status: row.status as ClipSocialStatus,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = `clip_id, platform, status, scheduled_for, postiz_id, posted_url, caption, created_at, updated_at`;

/**
 * Compute a clip's drip slot — PURE, so it unit-tests without a DB. The base is the
 * later of `now` and the queue tail (the latest `scheduled_for` still ahead of now); if
 * nothing is ahead of now the base is `now`. Add a random gap in [23h, 25h] (rolled once
 * via `randomFn`), so consecutive clips chain ~daily with real jitter. Returns an ISO
 * string.
 */
export function computeNextDripSlot(
  latestScheduledForIso: string | undefined,
  nowMs: number,
  randomFn: () => number = Math.random,
): string {
  const tailMs = latestScheduledForIso ? Date.parse(latestScheduledForIso) : Number.NaN;

  // The tail only extends the chain when it is BOTH a valid timestamp AND still ahead of
  // now; a past/absent/malformed tail bases the slot off `now`.
  const base = Number.isFinite(tailMs) && tailMs > nowMs ? tailMs : nowMs;
  const gap = DRIP_MIN_GAP_MS + randomFn() * (DRIP_MAX_GAP_MS - DRIP_MIN_GAP_MS);

  return new Date(base + Math.round(gap)).toISOString();
}

/**
 * The next drip slot for a new clip: read the current queue tail (the max `scheduled_for`
 * among `scheduled` rows) and chain a jittered ~24h off it (or off `now` if the queue is
 * empty / drained). One roll of the jitter at insert (RFC §3).
 */
export async function nextDripSlot(): Promise<string> {
  const db = await getDb();
  const result = await db.execute({
    args: [CLIP_DRIP_PLATFORM],
    sql: `select max(scheduled_for) as tail
          from mixtape_clip_social_posts
          where platform = ? and status = 'scheduled'`,
  });
  const row = typedRow<{ tail: string | null }>(result.rows);

  return computeNextDripSlot(row?.tail ?? undefined, Date.now());
}

/**
 * Enrol (or re-schedule) a clip's IG drip row: insert a `scheduled` row, or on conflict
 * (clip, instagram) re-point its `scheduled_for`/`caption` and reset it to `scheduled`.
 * Idempotent per clip — the auto-queue-on-create AND the operator's schedule-override
 * both funnel through this. Resetting the status lets the operator re-arm a `failed` (or
 * already-`posted`) row by re-scheduling it.
 */
export async function upsertClipPost(input: {
  caption?: string;
  clipId: string;
  scheduledFor: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const db = await getDb();

  await db.execute({
    args: [
      crypto.randomUUID(),
      input.clipId,
      CLIP_DRIP_PLATFORM,
      input.scheduledFor,
      input.caption ?? null,
      now,
      now,
      input.scheduledFor,
      input.caption ?? null,
      now,
    ],
    sql: `insert into mixtape_clip_social_posts
            (id, clip_id, platform, status, scheduled_for, postiz_id, posted_url, caption, created_at, updated_at)
          values (?, ?, ?, 'scheduled', ?, null, null, ?, ?, ?)
          on conflict(clip_id, platform) do update set
            status = 'scheduled',
            scheduled_for = ?,
            caption = ?,
            postiz_id = null,
            posted_url = null,
            updated_at = ?`,
  });
}

/**
 * Flip a clip post's status (and optionally its Postiz id / permalink). The drip op calls
 * this `posted` on a successful push (with the `postizId`) or `failed` on an error.
 */
export async function setClipPostStatus(
  clipId: string,
  status: ClipSocialStatus,
  fields: { postedUrl?: string; postizId?: string } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const db = await getDb();

  await db.execute({
    args: [
      status,
      fields.postizId ?? null,
      fields.postedUrl ?? null,
      now,
      clipId,
      CLIP_DRIP_PLATFORM,
    ],
    sql: `update mixtape_clip_social_posts set
            status = ?,
            postiz_id = coalesce(?, postiz_id),
            posted_url = coalesce(?, posted_url),
            updated_at = ?
          where clip_id = ? and platform = ?`,
  });
}

/** A due drip row the cron should post: its clip is `done` and its slot has arrived. */
export type DueClipPost = {
  caption?: string;
  clipId: string;
  scheduledFor: string;
};

/**
 * The scheduled rows whose slot has arrived AND whose clip is cut (`done`), oldest slot
 * first, bounded by `limit`. A `pending` clip (video not yet ready) is held back — the
 * cut lands, then the next tick posts it. Only `scheduled` rows are selected, so a
 * `posted` row never re-fires (idempotent) and a `failed` row stays put until the
 * operator re-schedules it.
 */
export async function dueClipPosts(options: { limit: number }): Promise<DueClipPost[]> {
  if (options.limit <= 0) {
    return [];
  }

  const now = new Date().toISOString();
  const db = await getDb();
  const result = await db.execute({
    args: [now, options.limit],
    sql: `select p.clip_id, p.scheduled_for, p.caption
          from mixtape_clip_social_posts p
          join mixtape_clips c on c.id = p.clip_id
          where p.platform = 'instagram'
            and p.status = 'scheduled'
            and p.scheduled_for <= ?
            and c.status = 'done'
          order by p.scheduled_for asc
          limit ?`,
  });

  return typedRows<{ caption: string | null; clip_id: string; scheduled_for: string }>(
    result.rows,
  ).map((row) => ({
    caption: str(row.caption),
    clipId: row.clip_id,
    scheduledFor: row.scheduled_for,
  }));
}

/**
 * How many due rows are waiting RIGHT NOW (ignoring any per-tick / 24h budget) — so the
 * drip op can report `skippedCapped` (the backlog the cap deferred to a later tick).
 */
export async function countDueClipPosts(): Promise<number> {
  const now = new Date().toISOString();
  const db = await getDb();
  const result = await db.execute({
    args: [now],
    sql: `select count(*) as n
          from mixtape_clip_social_posts p
          join mixtape_clips c on c.id = p.clip_id
          where p.platform = 'instagram'
            and p.status = 'scheduled'
            and p.scheduled_for <= ?
            and c.status = 'done'`,
  });

  return typedRow<{ n: number }>(result.rows)?.n ?? 0;
}

/** How many IG posts went out since `sinceIso` — the rolling-window read the drip op's
 *  24h Meta cap is checked against (a `posted` row's `updated_at` is its post time). */
export async function countRecentPostedInWindow(sinceIso: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    args: [sinceIso],
    sql: `select count(*) as n
          from mixtape_clip_social_posts
          where platform = 'instagram' and status = 'posted' and updated_at >= ?`,
  });

  return typedRow<{ n: number }>(result.rows)?.n ?? 0;
}

/** A posted clip row whose live IG permalink hasn't been captured yet. */
export type UnlinkedClipPost = { clipId: string; postizId: string };

/**
 * Posted clip rows still missing their `posted_url` — `status = 'posted'`, a Postiz id
 * present, but no captured permalink. Instagram publishes the Reel asynchronously, so its
 * permalink lands a tick AFTER the push; the drip tick's capture pass resolves each of
 * these off Postiz's dated `/posts` list and back-fills the URL (mirrors the YouTube/TikTok
 * social-capture sweep). Oldest first so the backlog drains in order.
 */
export async function postedClipPostsAwaitingUrl(): Promise<UnlinkedClipPost[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [CLIP_DRIP_PLATFORM],
    sql: `select clip_id, postiz_id
          from mixtape_clip_social_posts
          where platform = ?
            and status = 'posted'
            and postiz_id is not null
            and posted_url is null
          order by updated_at asc`,
  });

  return typedRows<{ clip_id: string; postiz_id: string }>(result.rows).map((row) => ({
    clipId: row.clip_id,
    postizId: row.postiz_id,
  }));
}

/** Every clip post (optionally narrowed to a set of clip ids) — the CLI `clips list`
 *  merges these onto the clip rows to show each clip's drip state. Newest slot first. */
export async function listClipPosts(clipIds?: string[]): Promise<ClipSocialPost[]> {
  const db = await getDb();

  if (clipIds && clipIds.length === 0) {
    return [];
  }

  const where = clipIds ? `where clip_id in (${clipIds.map(() => "?").join(", ")})` : "";
  const result = await db.execute({
    args: clipIds ?? [],
    sql: `select ${COLUMNS} from mixtape_clip_social_posts ${where} order by scheduled_for desc`,
  });

  return typedRows<ClipSocialPostRow>(result.rows).map(rowToPost);
}

/** One clip's IG drip row, or undefined if it was never scheduled. */
export async function getClipPost(clipId: string): Promise<ClipSocialPost | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [clipId, CLIP_DRIP_PLATFORM],
    sql: `select ${COLUMNS} from mixtape_clip_social_posts where clip_id = ? and platform = ? limit 1`,
  });
  const row = typedRow<ClipSocialPostRow>(result.rows);

  return row ? rowToPost(row) : undefined;
}

/**
 * Take a clip off the drip queue — delete its `scheduled` row (the operator's "unschedule"
 * on the clip card). Idempotent: a missing row is a no-op. Only removes an un-posted row, so
 * an already-`posted` clip keeps its permalink record (unscheduling is for the queue, not
 * for un-recording a live post).
 */
export async function deleteClipPost(clipId: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    args: [clipId, CLIP_DRIP_PLATFORM],
    sql: `delete from mixtape_clip_social_posts
          where clip_id = ? and platform = ? and status <> 'posted'`,
  });
}

// --- The kill switch (on the shared `settings` KV — see ./settings.ts) ---------------

/** Whether the clip drip-feed is paused (the kill switch). Unset ⇒ not paused. */
export async function isDripPaused(): Promise<boolean> {
  return (await getSetting(CLIP_DRIP_PAUSED_KEY)) === "true";
}

/** Pause / resume the clip drip-feed (the kill switch). Pausing keeps the schedule
 *  intact; the drip op no-ops while paused and the drip resumes when cleared. */
export async function setDripPaused(paused: boolean): Promise<void> {
  await setSetting(CLIP_DRIP_PAUSED_KEY, paused ? "true" : "false");
}

import { type ClipSocialPost, type ClipSocialStatus } from "@fluncle/contracts";
import { getDb, typedRow, typedRows } from "./db";
import { getSetting, setSetting } from "./settings";

export type { ClipSocialPost, ClipSocialStatus };

export const CLIP_DRIP_PLATFORM = "instagram" as const;

const CLIP_DRIP_PAUSED_KEY = "clip_drip_paused";

const HOUR_MS = 60 * 60 * 1000;
export const DRIP_MIN_GAP_MS = 23 * HOUR_MS;
export const DRIP_MAX_GAP_MS = 25 * HOUR_MS;

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

export function computeNextDripSlot(
  latestScheduledForIso: string | undefined,
  nowMs: number,
  randomFn: () => number = Math.random,
): string {
  const tailMs = latestScheduledForIso ? Date.parse(latestScheduledForIso) : Number.NaN;

  const base = Number.isFinite(tailMs) && tailMs > nowMs ? tailMs : nowMs;
  const gap = DRIP_MIN_GAP_MS + randomFn() * (DRIP_MAX_GAP_MS - DRIP_MIN_GAP_MS);

  return new Date(base + Math.round(gap)).toISOString();
}

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

export type DueClipPost = {
  clipId: string;
  scheduledFor: string;
};

export async function dueClipPosts(options: { limit: number }): Promise<DueClipPost[]> {
  if (options.limit <= 0) {
    return [];
  }

  const now = new Date().toISOString();
  const db = await getDb();
  const result = await db.execute({
    args: [now, options.limit],
    sql: `select p.clip_id, p.scheduled_for
          from mixtape_clip_social_posts p
          join mixtape_clips c on c.id = p.clip_id
          where p.platform = 'instagram'
            and p.status = 'scheduled'
            and p.scheduled_for <= ?
            and c.status = 'done'
          order by p.scheduled_for asc
          limit ?`,
  });

  return typedRows<{ clip_id: string; scheduled_for: string }>(result.rows).map((row) => ({
    clipId: row.clip_id,
    scheduledFor: row.scheduled_for,
  }));
}

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

export type UnlinkedClipPost = { clipId: string; postizId: string };

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

export async function getClipPost(clipId: string): Promise<ClipSocialPost | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [clipId, CLIP_DRIP_PLATFORM],
    sql: `select ${COLUMNS} from mixtape_clip_social_posts where clip_id = ? and platform = ? limit 1`,
  });
  const row = typedRow<ClipSocialPostRow>(result.rows);

  return row ? rowToPost(row) : undefined;
}

export async function deleteClipPost(clipId: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    args: [clipId, CLIP_DRIP_PLATFORM],
    sql: `delete from mixtape_clip_social_posts
          where clip_id = ? and platform = ? and status <> 'posted'`,
  });
}

export async function isDripPaused(): Promise<boolean> {
  return (await getSetting(CLIP_DRIP_PAUSED_KEY)) !== "false";
}

export async function setDripPaused(paused: boolean): Promise<void> {
  await setSetting(CLIP_DRIP_PAUSED_KEY, paused ? "true" : "false");
}

import { FOUND_BASE } from "../media";
import { getDb, typedRows } from "./db";
import { getSetting, setSetting } from "./settings";

export const PUBLISH_ADVANCE_PAUSED_KEY = "publish_advance_paused";

export const ADVANCE_PLATFORMS = ["youtube", "tiktok"] as const;
export type AdvancePlatform = (typeof ADVANCE_PLATFORMS)[number];

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const ADVANCE_SETTLE_MS = 6 * HOUR_MS;

export const ADVANCE_PER_TICK_CAP = 1;

export const ADVANCE_DAILY_PUSH_CAP = 4;

export const TIKTOK_INBOX_DRAFT_CAP = 5;

export const REQUIRED_BUNDLE_FILES = [
  "footage.mp4",
  "footage.social.mp4",
  "composition.tsx",
  "props.json",
  "render.json",
] as const;

export async function isPublishAdvancePaused(): Promise<boolean> {
  return (await getSetting(PUBLISH_ADVANCE_PAUSED_KEY)) !== "false";
}

export async function setPublishAdvancePaused(paused: boolean): Promise<void> {
  await setSetting(PUBLISH_ADVANCE_PAUSED_KEY, paused ? "true" : "false");
}

export type AdvanceCandidate = {
  logId: string;
  pending: AdvancePlatform[];
  title: string;
  trackId: string;
  videoSquaredAt: string;
};

type CandidateRow = {
  log_id: string;
  title: string;
  tiktok_posted: number;
  track_id: string;
  video_squared_at: string;
  youtube_posted: number;
};

export async function advanceCandidates(options: {
  limit: number;
  nowMs: number;
}): Promise<AdvanceCandidate[]> {
  if (options.limit <= 0) {
    return [];
  }

  const cutoff = new Date(options.nowMs - ADVANCE_SETTLE_MS).toISOString();
  const db = await getDb();
  const result = await db.execute({
    args: [cutoff, options.limit],
    sql: `select t.track_id, t.log_id, t.title, t.video_squared_at,
                 (yt.track_id is not null) as youtube_posted,
                 (tk.track_id is not null) as tiktok_posted
          from (findings join tracks on tracks.track_id = findings.track_id) t
          left join social_posts yt on yt.track_id = t.track_id and yt.platform = 'youtube'
          left join social_posts tk on tk.track_id = t.track_id and tk.platform = 'tiktok'
          where t.log_id is not null
            and t.video_url is not null
            and t.video_squared_at is not null
            and t.video_squared_at <= ?
            and (yt.track_id is null or tk.track_id is null)
          order by t.video_squared_at asc
          limit ?`,
  });

  return typedRows<CandidateRow>(result.rows).map((row) => {
    const pending: AdvancePlatform[] = [];

    if (!row.youtube_posted) {
      pending.push("youtube");
    }

    if (!row.tiktok_posted) {
      pending.push("tiktok");
    }

    return {
      logId: row.log_id,
      pending,
      title: row.title,
      trackId: row.track_id,
      videoSquaredAt: row.video_squared_at,
    };
  });
}

export async function bundleGaps(logId: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const results = await Promise.all(
    REQUIRED_BUNDLE_FILES.map(async (file): Promise<string | undefined> => {
      try {
        const response = await fetchFn(`${FOUND_BASE}/${encodeURIComponent(logId)}/${file}`, {
          method: "HEAD",
        });

        return response.ok ? undefined : file;
      } catch {
        return file;
      }
    }),
  );

  return results.filter((file): file is string => typeof file === "string");
}

export type AdvanceHold =
  | "bundle_incomplete"
  | "daily_cap"
  | "no_caption"
  | "tiktok_inbox_full"
  | "youtube_url_pending";

export type AdvancePush = {
  externalId: string;
  logId: string;
  platform: AdvancePlatform;
  status: "draft" | "published";
  trackId: string;
};

export type AdvanceHeld = {
  missing?: string[];
  platform: AdvancePlatform;
  reason: AdvanceHold;
  trackId: string;
};

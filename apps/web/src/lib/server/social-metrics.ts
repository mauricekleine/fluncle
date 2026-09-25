import { getDb, typedRows } from "./db";
import { readOptionalEnv } from "./env";
import { readSocialReferrers, type SocialReferralsResult } from "./demand";
import { logEvent } from "./log";
import { getPostizPostAnalytics, type PostAnalyticsResult, type SocialPostMetrics } from "./postiz";
import { collectOwnTikTokVideos, extractTiktokVideoId, type TikTokVideoMetrics } from "./tiktok";
import {
  collectYouTubeVideoMetrics,
  extractYoutubeVideoId,
  type YouTubeVideoMetrics,
} from "./youtube";

const DAY_MS = 24 * 60 * 60 * 1000;

export const YOUTUBE_VIDEO_BUDGET = 200;

export const SNAPSHOT_BUDGET = 25;

export const RECENT_WINDOW_DAYS = 14;

const POSTIZ_ANALYTICS_DAYS = 7;

export type SnapshotCandidate = {
  externalId: string;

  lastSnapshotAt: null | string;
  platform: string;
  publishedAt: null | string;
  trackId: string;
};

type UnconfiguredSnapshotSummary = {
  configured: false;

  failed: 0;

  fetched: null;
  inserted: null;
  matched: null;
  skipped: null;
};

type FailedSnapshotSummary = {
  configured: null;

  failed: 1;

  fetched: null;
  inserted: null;
  matched: null;
  skipped: null;
};

type MeasuredSnapshotSummary = {
  configured: true;

  failed: 0;
  fetched: number;
  inserted: number;
  matched: number;
  skipped: number;
};

export type TikTokSnapshotSummary =
  | FailedSnapshotSummary
  | MeasuredSnapshotSummary
  | UnconfiguredSnapshotSummary;

export type YouTubeSnapshotSummary =
  | FailedSnapshotSummary
  | MeasuredSnapshotSummary
  | UnconfiguredSnapshotSummary;

function unconfiguredSnapshotSummary(): UnconfiguredSnapshotSummary {
  return {
    configured: false,
    failed: 0,
    fetched: null,
    inserted: null,
    matched: null,
    skipped: null,
  };
}

function failedSnapshotSummary(): FailedSnapshotSummary {
  return {
    configured: null,
    failed: 1,
    fetched: null,
    inserted: null,
    matched: null,
    skipped: null,
  };
}

export type RecordSocialMetricsSummary = {
  budget: number;

  configured: boolean;

  day: string;

  eligible: number;

  failed: number;

  inserted: number;

  missing: number;

  polled: number;

  referrals: SocialReferralsResult;

  tiktok: TikTokSnapshotSummary;

  youtube: YouTubeSnapshotSummary;
};

export type RecordSocialMetricsOptions = {
  collectTikTokVideos?: () => Promise<null | TikTokVideoMetrics[]>;

  fetchAnalytics?: (postId: string) => Promise<PostAnalyticsResult>;

  collectYouTubeVideos?: (videoIds: string[]) => Promise<null | YouTubeVideoMetrics[]>;

  now?: Date;

  readReferrers?: () => Promise<SocialReferralsResult>;
};

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function selectSnapshotTargets(
  candidates: SnapshotCandidate[],
  nowMs: number,
  budget = SNAPSHOT_BUDGET,
): SnapshotCandidate[] {
  const cutoff = nowMs - RECENT_WINDOW_DAYS * DAY_MS;
  const publishedMs = (post: SnapshotCandidate): number =>
    post.publishedAt ? Date.parse(post.publishedAt) : Number.NEGATIVE_INFINITY;
  const isRecent = (post: SnapshotCandidate): boolean => publishedMs(post) >= cutoff;

  const recent = candidates.filter(isRecent).sort((a, b) => publishedMs(b) - publishedMs(a));
  const tail = candidates
    .filter((post) => !isRecent(post))
    .sort((a, b) => {
      const rank = (value: null | string): number =>
        value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
      const byLast = rank(a.lastSnapshotAt) - rank(b.lastSnapshotAt);

      return byLast !== 0 ? byLast : publishedMs(b) - publishedMs(a);
    });

  const chosen = recent.slice(0, budget);

  if (chosen.length < budget) {
    chosen.push(...tail.slice(0, budget - chosen.length));
  }

  return chosen;
}

async function listSnapshotCandidates(): Promise<SnapshotCandidate[]> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select sp.track_id, sp.platform, sp.external_id, sp.published_at,
                 (select max(sm.captured_at) from social_metrics sm
                    where sm.external_id = sp.external_id and sm.source = 'postiz') as last_snapshot_at
          from social_posts sp
          where sp.status = 'published'
            and sp.external_id is not null
            and sp.platform in ('tiktok', 'youtube')`,
  });

  return typedRows<{
    external_id: string;
    last_snapshot_at: null | string;
    platform: string;
    published_at: null | string;
    track_id: string;
  }>(result.rows).map((row) => ({
    externalId: row.external_id,
    lastSnapshotAt: row.last_snapshot_at,
    platform: row.platform,
    publishedAt: row.published_at,
    trackId: row.track_id,
  }));
}

async function appendSnapshot(
  candidate: SnapshotCandidate,
  metrics: SocialPostMetrics,
  now: Date,
): Promise<boolean> {
  const db = await getDb();
  const iso = now.toISOString();
  const result = await db.execute({
    args: [
      crypto.randomUUID(),
      candidate.trackId,
      candidate.externalId,
      candidate.platform,
      iso,
      utcDay(now),
      metrics.views,
      metrics.likes,
      metrics.comments,
      metrics.shares,
      metrics.impressions,
      metrics.saves,
      metrics.watchTimeSeconds,
      metrics.averageViewPercentage,
      iso,
    ],
    sql: `insert into social_metrics
            (id, track_id, external_id, platform, source, captured_at, captured_day,
             views, likes, comments, shares, impressions, saves, watch_time_seconds,
             average_view_percentage, created_at)
          values (?, ?, ?, ?, 'postiz', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(external_id, source, captured_day) do nothing`,
  });

  return result.rowsAffected > 0;
}

async function listTikTokPosts(): Promise<Array<{ trackId: string; url: string }>> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select track_id, url from social_posts
          where platform = 'tiktok' and status = 'published' and url is not null`,
  });

  return typedRows<{ track_id: string; url: string }>(result.rows).map((row) => ({
    trackId: row.track_id,
    url: row.url,
  }));
}

async function appendTikTokSnapshot(
  trackId: string,
  video: TikTokVideoMetrics,
  now: Date,
): Promise<boolean> {
  const db = await getDb();
  const iso = now.toISOString();
  const result = await db.execute({
    args: [
      crypto.randomUUID(),
      trackId,
      video.id,
      "tiktok",
      iso,
      utcDay(now),
      video.views,
      video.likes,
      video.comments,
      video.shares,
      iso,
    ],
    sql: `insert into social_metrics
            (id, track_id, external_id, platform, source, captured_at, captured_day,
             views, likes, comments, shares, created_at)
          values (?, ?, ?, ?, 'tiktok_display', ?, ?, ?, ?, ?, ?, ?)
          on conflict(external_id, source, captured_day) do nothing`,
  });

  return result.rowsAffected > 0;
}

async function snapshotTikTokVideos(
  collect: () => Promise<null | TikTokVideoMetrics[]>,
  now: Date,
): Promise<TikTokSnapshotSummary> {
  const videos = await collect();

  if (videos === null) {
    return unconfiguredSnapshotSummary();
  }

  const summary: MeasuredSnapshotSummary = {
    configured: true,
    failed: 0,
    fetched: 0,
    inserted: 0,
    matched: 0,
    skipped: 0,
  };
  summary.fetched = videos.length;

  const trackByVideoId = new Map<string, string>();

  for (const post of await listTikTokPosts()) {
    const videoId = extractTiktokVideoId(post.url);

    if (videoId) {
      trackByVideoId.set(videoId, post.trackId);
    }
  }

  for (const video of videos) {
    const trackId = trackByVideoId.get(video.id);

    if (!trackId) {
      summary.skipped += 1;

      continue;
    }

    summary.matched += 1;

    if (await appendTikTokSnapshot(trackId, video, now)) {
      summary.inserted += 1;
    }
  }

  return summary;
}

async function listYouTubePosts(): Promise<Array<{ trackId: string; url: string }>> {
  const db = await getDb();
  const result = await db.execute({
    args: [],
    sql: `select track_id, url from social_posts
          where platform = 'youtube' and status = 'published' and url is not null
          order by published_at desc`,
  });

  return typedRows<{ track_id: string; url: string }>(result.rows).map((row) => ({
    trackId: row.track_id,
    url: row.url,
  }));
}

async function appendYouTubeSnapshot(
  trackId: string,
  video: YouTubeVideoMetrics,
  now: Date,
): Promise<boolean> {
  const db = await getDb();
  const iso = now.toISOString();
  const result = await db.execute({
    args: [
      crypto.randomUUID(),
      trackId,
      video.id,
      "youtube",
      iso,
      utcDay(now),
      video.views,
      video.likes,
      video.comments,
      video.averageViewPercentage,
      video.averageViewDurationSeconds,
      video.watchTimeSeconds,
      iso,
    ],
    sql: `insert into social_metrics
            (id, track_id, external_id, platform, source, captured_at, captured_day,
             views, likes, comments, average_view_percentage, average_view_duration_seconds,
             watch_time_seconds, created_at)
          values (?, ?, ?, ?, 'youtube_analytics', ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(external_id, source, captured_day) do nothing`,
  });

  return result.rowsAffected > 0;
}

async function snapshotYouTubeVideos(
  collect: (videoIds: string[]) => Promise<null | YouTubeVideoMetrics[]>,
  now: Date,
): Promise<YouTubeSnapshotSummary> {
  const trackByVideoId = new Map<string, string>();
  const orderedIds: string[] = [];
  let skipped = 0;

  for (const post of await listYouTubePosts()) {
    const videoId = extractYoutubeVideoId(post.url);

    if (!videoId) {
      skipped += 1;

      continue;
    }

    if (trackByVideoId.has(videoId)) {
      continue;
    }

    trackByVideoId.set(videoId, post.trackId);
    orderedIds.push(videoId);
  }

  const videoIds = orderedIds.slice(0, YOUTUBE_VIDEO_BUDGET);
  const videos = await collect(videoIds);

  if (videos === null) {
    return unconfiguredSnapshotSummary();
  }

  const summary: MeasuredSnapshotSummary = {
    configured: true,
    failed: 0,
    fetched: videos.length,
    inserted: 0,
    matched: videoIds.length,
    skipped,
  };

  for (const video of videos) {
    const trackId = trackByVideoId.get(video.id);

    if (!trackId) {
      continue;
    }

    if (await appendYouTubeSnapshot(trackId, video, now)) {
      summary.inserted += 1;
    }
  }

  return summary;
}

export async function recordSocialMetrics(
  options: RecordSocialMetricsOptions = {},
): Promise<RecordSocialMetricsSummary> {
  const now = options.now ?? new Date();
  const fetchAnalytics =
    options.fetchAnalytics ??
    ((postId: string) => getPostizPostAnalytics(postId, POSTIZ_ANALYTICS_DAYS));
  const readReferrers = options.readReferrers ?? (() => readSocialReferrers({ now }));
  const collectTikTokVideos = options.collectTikTokVideos ?? (() => collectOwnTikTokVideos());
  const collectYouTubeVideos =
    options.collectYouTubeVideos ??
    ((videoIds: string[]) => collectYouTubeVideoMetrics(videoIds, { now }));

  let referrals: SocialReferralsResult;

  try {
    referrals = await readReferrers();
  } catch (error) {
    logEvent("warn", "social-metrics.referrers-failed", { error });
    referrals = {
      arrivals: [],
      configured: false,
      total: 0,
      window: { end: utcDay(now), start: utcDay(now) },
    };
  }

  const summary: RecordSocialMetricsSummary = {
    budget: SNAPSHOT_BUDGET,
    configured: true,
    day: utcDay(now),
    eligible: 0,
    failed: 0,
    inserted: 0,
    missing: 0,
    polled: 0,
    referrals,
    tiktok: unconfiguredSnapshotSummary(),
    youtube: unconfiguredSnapshotSummary(),
  };

  const key = await readOptionalEnv("POSTIZ_API_KEY");

  if (!key) {
    summary.configured = false;
  } else {
    const candidates = await listSnapshotCandidates();

    summary.eligible = candidates.length;

    const targets = selectSnapshotTargets(candidates, now.getTime());

    for (const target of targets) {
      summary.polled += 1;

      let result: PostAnalyticsResult;

      try {
        result = await fetchAnalytics(target.externalId);
      } catch (error) {
        summary.failed += 1;
        logEvent("warn", "social-metrics.post-read-failed", {
          error,
          externalId: target.externalId,
          platform: target.platform,
        });

        continue;
      }

      if (result.kind === "missing") {
        summary.missing += 1;

        continue;
      }

      if (await appendSnapshot(target, result.metrics, now)) {
        summary.inserted += 1;
      }
    }
  }

  try {
    summary.tiktok = await snapshotTikTokVideos(collectTikTokVideos, now);
  } catch (error) {
    summary.tiktok = failedSnapshotSummary();
    logEvent("warn", "social-metrics.tiktok-failed", { error });
  }

  try {
    summary.youtube = await snapshotYouTubeVideos(collectYouTubeVideos, now);
  } catch (error) {
    summary.youtube = failedSnapshotSummary();
    logEvent("warn", "social-metrics.youtube-failed", { error });
  }

  return summary;
}

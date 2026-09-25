import { getDb, typedRows } from "./db";
import { parseArtistsJson } from "./artists";
import { clampSnapshotWindow } from "./snapshot-window";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReachSource = "csv" | "postiz" | "tiktok_display" | "youtube_analytics";
export type ReachPlatform = "tiktok" | "youtube";
export type ReachAxis = "plateSubject" | "structure";

export type ReachSeriesPoint = { day: string; views: number };

export type ReachPostRow = {
  artists: string[];
  averageViewDurationSeconds: null | number;
  averageViewPercentage: null | number;
  capturedDay: string;
  comments: null | number;
  dailyViewVelocity: null | number;
  externalId: string;
  likes: null | number;
  logId: null | string;
  plateSubject: null | string;
  platform: ReachPlatform;
  publishedAt: null | string;
  shares: null | number;
  snapshotCount: number;
  source: ReachSource;
  series: ReachSeriesPoint[];
  structure: null | string;
  title: null | string;
  trackId: string;
  url: null | string;
  velocityDaySpan: null | number;
  velocityViewsDelta: null | number;
  views: null | number;
  watchTimeSeconds: null | number;
};

export type ReachPivotCell = {
  count: number;
  meanRetention: null | number;
  meanViews: number;
  medianViews: number;
  platform: ReachPlatform;
  retentionCount: number;
  value: string;
};

export type ReachPivot = { axis: ReachAxis; cells: ReachPivotCell[] };

export type SocialMetricsBoard = {
  pivots: { plateSubject: ReachPivot; structure: ReachPivot };
  posts: ReachPostRow[];
  totalPosts: number;
  windowDays: number;
};

export function dayGap(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T00:00:00.000Z`);
  const to = Date.parse(`${toDay}T00:00:00.000Z`);

  return Math.round((to - from) / DAY_MS);
}

export function dailyViewVelocity(input: {
  latestDay: string;
  latestViews: null | number;
  prevDay: null | string;
  prevViews: null | number;
}): {
  dailyViewVelocity: null | number;
  velocityDaySpan: null | number;
  velocityViewsDelta: null | number;
} {
  if (input.prevViews === null || input.prevDay === null || input.latestViews === null) {
    return { dailyViewVelocity: null, velocityDaySpan: null, velocityViewsDelta: null };
  }

  const span = Math.max(dayGap(input.prevDay, input.latestDay), 1);
  const delta = input.latestViews - input.prevViews;

  return { dailyViewVelocity: delta / span, velocityDaySpan: span, velocityViewsDelta: delta };
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const high = sorted[mid] ?? 0;

  if (sorted.length % 2 !== 0) {
    return high;
  }

  return ((sorted[mid - 1] ?? 0) + high) / 2;
}

type PivotUnit = {
  plateSubject: null | string;
  platform: ReachPlatform;
  retention: null | number;
  structure: null | string;
  views: null | number;
};

function dedupePerPost(posts: ReachPostRow[]): PivotUnit[] {
  const groups = new Map<string, ReachPostRow[]>();

  for (const post of posts) {
    const key = `${post.trackId}:${post.platform}`;
    const rows = groups.get(key) ?? [];

    rows.push(post);
    groups.set(key, rows);
  }

  const units: PivotUnit[] = [];

  for (const rows of groups.values()) {
    const first = rows[0];

    if (!first) {
      continue;
    }

    const nativeViews = rows.find(
      (row) =>
        (row.source === "youtube_analytics" || row.source === "tiktok_display") &&
        row.views !== null,
    );
    const anyViews = rows.find((row) => row.views !== null);
    const withRetention = rows.find(
      (row) => row.source === "youtube_analytics" && row.averageViewPercentage !== null,
    );
    const viewsRow = nativeViews ?? anyViews;

    units.push({
      plateSubject: first.plateSubject,
      platform: first.platform,
      retention: withRetention ? withRetention.averageViewPercentage : null,
      structure: first.structure,
      views: viewsRow ? viewsRow.views : null,
    });
  }

  return units;
}

function pivotBy(units: PivotUnit[], axis: ReachAxis): ReachPivot {
  const cells = new Map<
    string,
    {
      platform: ReachPlatform;
      postCount: number;
      retentions: number[];
      value: string;
      views: number[];
    }
  >();

  for (const unit of units) {
    const raw = axis === "structure" ? unit.structure : unit.plateSubject;
    const value = raw ?? "—";
    const key = `${unit.platform}:${value}`;
    const cell = cells.get(key) ?? {
      platform: unit.platform,
      postCount: 0,
      retentions: [],
      value,
      views: [],
    };

    cell.postCount += 1;

    if (unit.views !== null) {
      cell.views.push(unit.views);
    }

    if (unit.retention !== null) {
      cell.retentions.push(unit.retention);
    }

    cells.set(key, cell);
  }

  const list: ReachPivotCell[] = [...cells.values()]
    .map((cell) => ({
      count: cell.postCount,
      meanRetention: cell.retentions.length > 0 ? mean(cell.retentions) : null,
      meanViews: mean(cell.views),
      medianViews: median(cell.views),
      platform: cell.platform,
      retentionCount: cell.retentions.length,
      value: cell.value,
    }))
    .sort(
      (a, b) =>
        a.platform.localeCompare(b.platform) || b.count - a.count || a.value.localeCompare(b.value),
    );

  return { axis, cells: list };
}

export function buildPivots(posts: ReachPostRow[]): {
  plateSubject: ReachPivot;
  structure: ReachPivot;
} {
  const units = dedupePerPost(posts);

  return { plateSubject: pivotBy(units, "plateSubject"), structure: pivotBy(units, "structure") };
}

const BOARD_SQL = `
  with ranked as (
    select
      sm.external_id, sm.source, sm.platform, sm.track_id,
      sm.captured_day, sm.views, sm.likes, sm.comments, sm.shares,
      sm.average_view_percentage, sm.average_view_duration_seconds, sm.watch_time_seconds,
      row_number() over (partition by sm.external_id, sm.source order by sm.captured_day desc) as rn,
      lag(sm.views) over (partition by sm.external_id, sm.source order by sm.captured_day) as prev_views,
      lag(sm.captured_day) over (partition by sm.external_id, sm.source order by sm.captured_day) as prev_day,
      count(*) over (partition by sm.external_id, sm.source) as snapshot_count
    from social_metrics sm
  )
  select
    r.external_id, r.source, r.platform, r.track_id,
    r.captured_day, r.views, r.likes, r.comments, r.shares,
    r.average_view_percentage, r.average_view_duration_seconds, r.watch_time_seconds,
    r.prev_views, r.prev_day, r.snapshot_count,
    t.title, t.artists_json, f.video_structure, f.video_plate_subject,
    f.log_id,
    sp.published_at, sp.url
  from ranked r
  left join tracks t on t.track_id = r.track_id
  left join findings f on f.track_id = r.track_id
  left join social_posts sp on sp.track_id = r.track_id and sp.platform = r.platform
  where r.rn = 1
  order by
    coalesce(
      case
        when r.prev_views is null or r.prev_day is null or r.views is null then null
        else (r.views - r.prev_views) * 1.0 / max(julianday(r.captured_day) - julianday(r.prev_day), 1.0)
      end,
      -1e18
    ) desc,
    coalesce(r.views, -1) desc
`;

const SERIES_SQL = `
  select external_id, source, captured_day, views
  from social_metrics
  where captured_day >= ?
  order by external_id, source, captured_day asc
`;

type BoardDbRow = {
  artists_json: null | string;
  average_view_duration_seconds: null | number;
  average_view_percentage: null | number;
  captured_day: string;
  comments: null | number;
  external_id: string;
  likes: null | number;
  log_id: null | string;
  platform: ReachPlatform;
  prev_day: null | string;
  prev_views: null | number;
  published_at: null | string;
  shares: null | number;
  snapshot_count: number;
  source: ReachSource;
  title: null | string;
  track_id: string;
  url: null | string;
  video_plate_subject: null | string;
  video_structure: null | string;
  views: null | number;
  watch_time_seconds: null | number;
};

type SeriesDbRow = {
  captured_day: string;
  external_id: string;
  source: ReachSource;
  views: null | number;
};

function seriesKey(externalId: string, source: string): string {
  return `${externalId}:${source}`;
}

export async function getSocialMetricsBoard(windowDays?: number): Promise<SocialMetricsBoard> {
  const window = clampSnapshotWindow(windowDays);
  const db = await getDb();

  const sinceDay = new Date(Date.now() - window * DAY_MS).toISOString().slice(0, 10);

  const [boardResult, seriesResult] = await Promise.all([
    db.execute({ args: [], sql: BOARD_SQL }),
    db.execute({ args: [sinceDay], sql: SERIES_SQL }),
  ]);

  const seriesByKey = new Map<string, ReachSeriesPoint[]>();

  for (const row of typedRows<SeriesDbRow>(seriesResult.rows)) {
    const key = seriesKey(row.external_id, row.source);
    const points = seriesByKey.get(key) ?? [];

    points.push({ day: row.captured_day, views: row.views ?? 0 });
    seriesByKey.set(key, points);
  }

  const posts: ReachPostRow[] = typedRows<BoardDbRow>(boardResult.rows).map((row) => {
    const velocity = dailyViewVelocity({
      latestDay: row.captured_day,
      latestViews: row.views,
      prevDay: row.prev_day,
      prevViews: row.prev_views,
    });

    return {
      artists: row.artists_json ? parseArtistsJson(row.artists_json) : [],
      averageViewDurationSeconds: row.average_view_duration_seconds,
      averageViewPercentage: row.average_view_percentage,
      capturedDay: row.captured_day,
      comments: row.comments,
      dailyViewVelocity: velocity.dailyViewVelocity,
      externalId: row.external_id,
      likes: row.likes,
      logId: row.log_id,
      plateSubject: row.video_plate_subject,
      platform: row.platform,
      publishedAt: row.published_at,
      series: seriesByKey.get(seriesKey(row.external_id, row.source)) ?? [],
      shares: row.shares,
      snapshotCount: row.snapshot_count,
      source: row.source,
      structure: row.video_structure,
      title: row.title,
      trackId: row.track_id,
      url: row.url,
      velocityDaySpan: velocity.velocityDaySpan,
      velocityViewsDelta: velocity.velocityViewsDelta,
      views: row.views,
      watchTimeSeconds: row.watch_time_seconds,
    };
  });

  return { pivots: buildPivots(posts), posts, totalPosts: posts.length, windowDays: window };
}

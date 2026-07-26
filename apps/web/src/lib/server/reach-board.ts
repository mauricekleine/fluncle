// The /admin/reach board — the pivot board over the append-only social-metrics ledger
// (`social_metrics`). The read half of the per-post performance loop whose WRITE sibling is
// `record_social_metrics` (social-metrics.ts): that op APPENDS one snapshot row per (post,
// source, UTC day); this module reads the ledger back as a board that answers the operator's
// real questions — which posts are moving RIGHT NOW, and which creative axes (video structure,
// plate subject) actually perform.
//
// ── WHAT A "POST ROW" IS ──────────────────────────────────────────────────────────────────
// The ledger's natural grain is (external_id, source): the unique index is
// `(external_id, source, captured_day)`, so each (external_id, source) is ONE daily time
// series. A board row is therefore one series' LATEST snapshot — and a single YouTube post can
// carry two series (a `postiz` one and a native `youtube_analytics` one), which is deliberate:
// the native source is the one that carries retention, and showing both keeps the numbers
// honest rather than silently picking one. Each row is tagged with its `source` so the operator
// reads which numbers came from where.
//
// ── AGGREGATED IN SQL (the scale rule) ──────────────────────────────────────────────────────
// The heavy reduction over the GROWING ledger is done in SQL, never in the isolate (AGENTS.md
// database rules): a single window-function pass reduces every series to its latest row plus the
// previous day's view count (`lag`), and the RANKING (by day-over-day view velocity) is an
// `order by` in the same query. The isolate only ever handles the already-bounded per-post
// result (one row per series — bounded by how many posts Fluncle has published, not by the
// ledger's day count) and a windowed slice of raw day-points for the sparklines (the
// platform-stats.ts precedent — bounded by `windowDays`). Velocity is then re-derived for the
// DTO by the pure `dailyViewVelocity` helper below, off the same components the SQL ranks by, so
// the displayed number and the sort order can never disagree.
//
// ── THE PIVOTS ──────────────────────────────────────────────────────────────────────────────
// Two pivots — platform × video-structure and platform × plate-subject — computed by the pure
// `buildPivots` helper over the (bounded) per-post rows. Because a post can appear twice (two
// sources), the pivot first DEDUPES to one unit per (track, platform), preferring the native
// source's view count and lifting retention from the `youtube_analytics` series, so a YouTube
// post is never double-counted. Each cell carries its post COUNT so a small-n cell reads as
// small-n rather than pretending a one-post average is a trend.

import { getDb, typedRows } from "./db";
import { parseArtistsJson } from "./artists";
import { clampSnapshotWindow } from "./snapshot-window";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The ledger's snapshot sources. Mirrors the `social_metrics.source` enum. */
export type ReachSource = "csv" | "postiz" | "tiktok_display" | "youtube_analytics";
/** The publishable platforms. Mirrors the `social_metrics.platform` enum. */
export type ReachPlatform = "tiktok" | "youtube";
/** The two persisted creative axes a video is placed on (both live on `tracks`). */
export type ReachAxis = "plateSubject" | "structure";

/** One day-point in a post's view series — the sparkline's raw data. */
export type ReachSeriesPoint = { day: string; views: number };

/** One board row: a post's LATEST snapshot for one source, its velocity, and its creative axes. */
export type ReachPostRow = {
  artists: string[];
  averageViewDurationSeconds: null | number;
  /** Retention — average % of the video watched (0–100). Present only on `youtube_analytics`. */
  averageViewPercentage: null | number;
  /** The UTC day of the latest snapshot in this series. */
  capturedDay: string;
  comments: null | number;
  /** Day-over-day view velocity (views/day since the previous snapshot); null with < 2 snapshots. */
  dailyViewVelocity: null | number;
  externalId: string;
  likes: null | number;
  logId: null | string;
  plateSubject: null | string;
  platform: ReachPlatform;
  publishedAt: null | string;
  shares: null | number;
  /** How many daily snapshots this series holds (1 = a lone point, so no velocity yet). */
  snapshotCount: number;
  source: ReachSource;
  /** The bounded view series for the sparkline (oldest-first, inside the window). */
  series: ReachSeriesPoint[];
  structure: null | string;
  title: null | string;
  trackId: string;
  url: null | string;
  /** The days between the two snapshots the velocity was measured over (≥ 1); null with < 2. */
  velocityDaySpan: null | number;
  /** The raw view delta between the two snapshots; null with < 2 snapshots. */
  velocityViewsDelta: null | number;
  views: null | number;
  watchTimeSeconds: null | number;
};

/** One pivot cell — the (platform, axis-value) group's summary. */
export type ReachPivotCell = {
  /** Posts in this cell (the small-n signal). */
  count: number;
  meanRetention: null | number;
  meanViews: number;
  medianViews: number;
  platform: ReachPlatform;
  /** Posts in this cell that carried a retention reading (`meanRetention`'s n). */
  retentionCount: number;
  /** The axis value, or "—" for a post with no value on this axis. */
  value: string;
};

/** One pivot — an axis and its cells (sorted platform, then count desc). */
export type ReachPivot = { axis: ReachAxis; cells: ReachPivotCell[] };

/** The whole board, in one payload. */
export type SocialMetricsBoard = {
  pivots: { plateSubject: ReachPivot; structure: ReachPivot };
  posts: ReachPostRow[];
  totalPosts: number;
  windowDays: number;
};

// ── Pure helpers (unit-tested in reach-board.test.ts) ──────────────────────────────────────

/** Whole-day gap between two UTC `yyyy-mm-dd` days. */
export function dayGap(fromDay: string, toDay: string): number {
  const from = Date.parse(`${fromDay}T00:00:00.000Z`);
  const to = Date.parse(`${toDay}T00:00:00.000Z`);

  return Math.round((to - from) / DAY_MS);
}

/**
 * Day-over-day view velocity: the latest snapshot's views minus the previous snapshot's,
 * NORMALISED per day so a gap between snapshots (a missed daily tick) never inflates the rate.
 * Null on a lone point (no previous snapshot) or a missing view number, so a post with one
 * snapshot reads as "no velocity yet" rather than a fake zero.
 */
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

  // At least one day, even if two snapshots somehow share a day, so we never divide by zero.
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

/** One deduped post for the pivots — one entry per (track, platform), native views preferred. */
type PivotUnit = {
  plateSubject: null | string;
  platform: ReachPlatform;
  retention: null | number;
  structure: null | string;
  views: null | number;
};

/**
 * Collapse the per-source board rows to one unit per (track, platform) so a post with both a
 * `postiz` and a native series is counted ONCE. The view number prefers the native source (the
 * platform's own count), falling back to any source that reported views; retention is lifted from
 * the `youtube_analytics` series when present. Deterministic regardless of row order.
 */
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

/** Group the deduped units by (platform, axis value) into pivot cells. */
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
    // Platform first (tiktok before youtube), then the biggest cells, then value for stability.
    .sort(
      (a, b) =>
        a.platform.localeCompare(b.platform) || b.count - a.count || a.value.localeCompare(b.value),
    );

  return { axis, cells: list };
}

/** Build both pivots from the (bounded) per-post rows. Pure — the tested aggregation entry point. */
export function buildPivots(posts: ReachPostRow[]): {
  plateSubject: ReachPivot;
  structure: ReachPivot;
} {
  const units = dedupePerPost(posts);

  return { plateSubject: pivotBy(units, "plateSubject"), structure: pivotBy(units, "structure") };
}

// ── The SQL reads ───────────────────────────────────────────────────────────────────────────

// Reduce every (external_id, source) series to its LATEST snapshot plus the previous day's view
// count (via `lag`) and the series length (via `count() over`), then keep only the latest row of
// each series and RANK by day-over-day view velocity — all in SQL. `julianday()` on the stored
// `yyyy-mm-dd` day gives the gap in days so a missed tick can't inflate the rate; the velocity is
// coalesced to a large negative sort key so lone points (no previous snapshot) fall to the end.
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
    t.title, t.artists_json, t.video_structure, t.video_plate_subject,
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

// The bounded sparkline series — every day-point inside the window, ordered so a per-series walk
// in the isolate is a single pass. Bounded by `windowDays`, never a scan of the whole ledger.
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

/** The (external_id, source) key both reads share, so a series attaches to its board row. */
function seriesKey(externalId: string, source: string): string {
  return `${externalId}:${source}`;
}

/**
 * Read the whole board in two bounded reads: the per-series latest+velocity rows (ranked in SQL)
 * and the windowed sparkline points. Velocity is re-derived per row by the pure helper (off the
 * same components the SQL ranked by), and the pivots are built from the bounded per-post rows.
 */
export async function getSocialMetricsBoard(windowDays?: number): Promise<SocialMetricsBoard> {
  const window = clampSnapshotWindow(windowDays);
  const db = await getDb();

  const sinceDay = new Date(Date.now() - window * DAY_MS).toISOString().slice(0, 10);

  const [boardResult, seriesResult] = await Promise.all([
    db.execute({ args: [], sql: BOARD_SQL }),
    db.execute({ args: [sinceDay], sql: SERIES_SQL }),
  ]);

  // Group the windowed points by series so each board row carries its own sparkline.
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

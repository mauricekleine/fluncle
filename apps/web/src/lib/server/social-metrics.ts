// THE SOCIAL-METRICS SNAPSHOT — the server side of the per-post performance ledger
// (`social_metrics`). A daily on-box trigger fires the agent-tier `record_social_metrics` op; this
// module does the work Worker-side (the box holds no Postiz key). For each PUBLISHED `social_posts`
// row it reads Postiz's per-post analytics and APPENDS today's numbers, one row per (post, source,
// UTC day). Append-only by design (velocity matters — deltas across days), idempotent per day (the
// `(external_id, source, captured_day)` unique index → INSERT … ON CONFLICT DO NOTHING).
//
// ── THE THROTTLE BUDGET (why ≤25 posts/run) ─────────────────────────────────────────────────────
// Postiz caps the public API at 30 requests/hour. Each snapshotted post costs ONE request
// (`GET /analytics/post/:id`); nothing else in this op calls Postiz. So the run is capped at
// SNAPSHOT_BUDGET = 25 Postiz requests, leaving ~5/hour of headroom for the reach cron + any manual
// call. The 25 are spent deterministically: EVERY post published within the last RECENT_WINDOW_DAYS
// (= 14) days first — that is the hot window where day-over-day velocity is worth measuring — then
// any leftover budget on a ROLLING TAIL of older posts, chosen least-recently-snapshotted first
// (a post never snapshotted, or snapshotted longest ago, wins). The tail therefore cycles through
// the whole archive over successive runs without ever exceeding the budget, and the selection is a
// pure function of DB state + the clock, so it is deterministic and re-runnable.
//
// The SA referrers read (the site-side half of reach — who clicked THROUGH from a social post) rides
// along as a best-effort observability block: it is one Simple-Analytics request (NOT Postiz, so it
// spends none of the budget), stored nowhere, and a failed/unprovisioned read never fails the run.

import { getDb, typedRows } from "./db";
import { readOptionalEnv } from "./env";
import { readSocialReferrers, type SocialReferralsResult } from "./demand";
import { logEvent } from "./log";
import { getPostizPostAnalytics, type PostAnalyticsResult, type SocialPostMetrics } from "./postiz";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The per-run Postiz request cap. One request per snapshotted post; Postiz caps at 30/hour, so 25
 *  leaves headroom for the reach cron + a manual call. */
export const SNAPSHOT_BUDGET = 25;

/** The hot window: every post published within this many days is snapshotted every run (velocity
 *  matters most while a post is fresh). Older posts share the leftover budget as a rolling tail. */
export const RECENT_WINDOW_DAYS = 14;

/** The look-back the per-post Postiz analytics query uses. We only ever take the LATEST daily point
 *  (the current cumulative total), so the window length only needs to reach today — 7 is Postiz's
 *  own default and the cheapest honest value. */
const POSTIZ_ANALYTICS_DAYS = 7;

/** A publishable post the snapshot may measure — the join of `social_posts` (published, with a
 *  Postiz id) and its last recorded snapshot instant (null = never snapshotted). */
export type SnapshotCandidate = {
  externalId: string;
  /** The most recent `social_metrics.captured_at` for this post+source, or null when never taken. */
  lastSnapshotAt: null | string;
  platform: string;
  publishedAt: null | string;
  trackId: string;
};

/** The per-run summary — the JSON line the box sweep echoes and the /status marker carries. */
export type RecordSocialMetricsSummary = {
  /** The per-run Postiz request budget this run honoured. */
  budget: number;
  /** True when `POSTIZ_API_KEY` is set and the Postiz half ran; false = a clean no-op on that half. */
  configured: boolean;
  /** The UTC day (yyyy-mm-dd) this run's snapshots are keyed on. */
  day: string;
  /** Total PUBLISHED posts with a Postiz id (the pool the budget selects from). */
  eligible: number;
  /** Posts whose Postiz read errored — skipped, never failing the batch. */
  failed: number;
  /** Snapshot rows actually appended (a same-day re-run lands 0 — idempotent by day). */
  inserted: number;
  /** Posts Postiz reported as `{ missing: true }` (release-id unresolved) — skipped cleanly. */
  missing: number;
  /** Posts actually read from Postiz this run (≤ budget). */
  polled: number;
  /** The site-side reach block: social→site arrivals from Simple Analytics (best-effort). */
  referrals: SocialReferralsResult;
};

/** The tunable + injectable effects — so the whole run is unit-testable with zero real network. */
export type RecordSocialMetricsOptions = {
  /** The per-post analytics reader; defaults to the real Postiz call. */
  fetchAnalytics?: (postId: string) => Promise<PostAnalyticsResult>;
  /** Anchors the clock (the day key + the recent window); defaults to `new Date()`. */
  now?: Date;
  /** The SA referrers reader; defaults to the real Simple-Analytics call. Injected for tests. */
  readReferrers?: () => Promise<SocialReferralsResult>;
};

/** `YYYY-MM-DD` in UTC — the day component of the idempotency key. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The deterministic budget: pick at most `budget` posts to snapshot this run. EVERY post published
 * within the recent window first (newest first), then the leftover budget on a rolling tail of older
 * posts chosen least-recently-snapshotted first (never-snapshotted wins, then oldest snapshot; ties
 * broken by newest published). Pure — a function of the candidate set + the clock alone.
 */
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
      // Least-recently-snapshotted first — a never-snapshotted post (null) sorts to the front.
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

/** Every publishable post + its last snapshot instant — the pool `selectSnapshotTargets` picks
 *  from. Published `social_posts` rows with a Postiz id, on the auto-measured platforms. The
 *  left-join subselect reads the last snapshot per post through the `(external_id, source, …)`
 *  unique index, so it is bounded, not a scan of the growing ledger. */
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

/** Append one post's snapshot. INSERT … ON CONFLICT DO NOTHING on the per-day unique index, so a
 *  same-day re-run is a no-op. Returns true when a row actually landed. */
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

/**
 * One snapshot tick. Reads the SA referrers block (best-effort), then — if Postiz is configured —
 * selects up to `SNAPSHOT_BUDGET` posts and appends each one's current metrics. Per-post reads are
 * isolated: a `{ missing: true }` post is skipped as `missing`, a thrown read is skipped as
 * `failed`, and neither ever aborts the batch. Unconfigured (no `POSTIZ_API_KEY`) the Postiz half
 * is a clean no-op (`configured: false`) — the referrers block still runs.
 */
export async function recordSocialMetrics(
  options: RecordSocialMetricsOptions = {},
): Promise<RecordSocialMetricsSummary> {
  const now = options.now ?? new Date();
  const fetchAnalytics =
    options.fetchAnalytics ??
    ((postId: string) => getPostizPostAnalytics(postId, POSTIZ_ANALYTICS_DAYS));
  const readReferrers = options.readReferrers ?? (() => readSocialReferrers({ now }));

  // The site-side reach block — best-effort, never fails the run. Its own configured flag reports
  // whether the SA key was present.
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
  };

  const key = await readOptionalEnv("POSTIZ_API_KEY");

  if (!key) {
    summary.configured = false;

    return summary;
  }

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

  return summary;
}

#!/usr/bin/env bun
// social-metrics-sweep.ts — the bun orchestrator behind the SOCIAL-METRICS SNAPSHOT cron
// (`fluncle-social-metrics`), scheduled by a rave-02 HOST systemd timer (../social-metrics-timer/).
//
// WHY THIS EXISTS. Fluncle pushes each finding's video to TikTok + YouTube (social_posts), but it
// never recorded how those posts PERFORMED — so per-video reach was invisible and velocity
// (day-over-day growth) unknowable. This daily tick fires the AGENT-tier `record_social_metrics` op
// and the Worker appends one per-post snapshot per (post, source, UTC day) from Postiz's per-post
// analytics — append-only by design (velocity), idempotent per day. It also carries the SA
// social→site referrer arrivals (the site-side half of reach) for observability.
//
// LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (social-metrics-sweep.sh) the host
// timer docker-execs — see that file's header for the wire-up and ../social-metrics-timer/README.md
// for the operator runbook.
//
// ── THE TICK ───────────────────────────────────────────────────────────────────────────────────
//   POST /api/v1/admin/social/metrics/record with the box's AGENT token, a bare trigger (no body). The
//   Worker selects ≤25 published posts (the Postiz 30/hour cap), reads each one's per-post analytics,
//   and APPENDS today's numbers (a re-fired tick the same day lands `inserted: 0` — idempotent).
//
// THE BOX DEPENDS ON NO NEW CLI COMMAND. The baked `fluncle` CLI is a PINNED release, so this sweep
// calls the oRPC HTTP endpoint DIRECTLY with the agent token (the funnel-snapshot / reach precedent),
// never a `fluncle admin …` subcommand a pin might not carry. No new secret either — the Postiz key
// (and the SA key) live Worker-side, so the box is a bare trigger.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

// ── Config (env; the shared ~/.fluncle-secrets.env supplies the secrets on the box) ──

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const log = (message: string) => console.error(`[social-metrics-sweep] ${message}`);

// ── Types ────────────────────────────────────────────────────────────────────

/** What `record_social_metrics` returns (only the headline fields this sweep echoes). */
export type RecordSocialMetricsResponse = {
  configured?: boolean;
  day?: string;
  eligible?: number;
  failed?: number;
  inserted?: number;
  missing?: number;
  ok?: boolean;
  polled?: number;
  referrals?: { total?: number };
  tiktok?: {
    configured?: boolean | null;
    failed?: number;
    fetched?: null | number;
    inserted?: null | number;
    matched?: null | number;
  };
  youtube?: {
    configured?: boolean | null;
    failed?: number;
    fetched?: null | number;
    inserted?: null | number;
    matched?: null | number;
  };
};

/** One tick's honest summary — the JSON line the /status prober reads. */
export type SocialMetricsSummary = {
  /** Units read across the independent Postiz, TikTok, and YouTube arms. */
  checked: null | number;
  configured: boolean | null;
  day: null | string;
  /** Run-level failure count. Per-post failures remain in `failed`. */
  errors: number;
  error: null | string;
  eligible: null | number;
  /** Post reads and independent platform arms that faulted while the run continued. */
  failed: null | number;
  inserted: null | number;
  missing: null | number;
  ok: boolean;
  polled: null | number;
  /** Snapshot rows successfully appended across all three arms this tick. */
  produced: null | number;
  referralArrivals: null | number;
  /** Whether the TikTok arm was configured and connected; false is a clean no-op. */
  tiktokConfigured: boolean | null;
  /** One when the isolated TikTok arm faulted, else zero. */
  tiktokFailed: null | number;
  /** TikTok videos fetched from the Display API this tick. */
  tiktokFetched: null | number;
  /** TikTok Display-API rows appended this tick (the `tiktok_display` source). */
  tiktokInserted: null | number;
  /** TikTok videos matched to a published post this tick. */
  tiktokMatched: null | number;
  /** YouTube videos fetched from the Data API this tick. */
  youtubeFetched: null | number;
  /** Whether the YouTube arm was configured and connected; false is a clean no-op. */
  youtubeConfigured: boolean | null;
  /** One when the isolated YouTube arm faulted, else zero. */
  youtubeFailed: null | number;
  /** YouTube Analytics rows appended this tick (the `youtube_analytics` source). */
  youtubeInserted: null | number;
  /** YouTube videos matched to a published post this tick. */
  youtubeMatched: null | number;
};

/** The injected effects — so the tick's outcome mapping is provable with a stub (no network). */
export type SocialMetricsDeps = {
  log: (message: string) => void;
  record: () => Promise<RecordSocialMetricsResponse>;
};

function responseCount(value: null | number | undefined): null | number {
  return typeof value === "number" ? value : null;
}

/** An unconfigured arm contributes no work; a failed arm makes the aggregate count unknown. */
function armCount(
  arm: { configured?: boolean | null; failed?: number } | undefined,
  count: null | number | undefined,
): null | number {
  if (typeof count === "number") {
    return count;
  }

  return arm?.configured === false && arm.failed === 0 ? 0 : null;
}

function applySocialMetricsResponse(
  summary: SocialMetricsSummary,
  response: RecordSocialMetricsResponse,
): void {
  summary.configured = typeof response.configured === "boolean" ? response.configured : null;
  summary.day = response.day ?? null;
  summary.eligible = typeof response.eligible === "number" ? response.eligible : null;
  summary.tiktokConfigured =
    typeof response.tiktok?.configured === "boolean" ? response.tiktok.configured : null;
  summary.tiktokFailed = responseCount(response.tiktok?.failed);
  summary.youtubeConfigured =
    typeof response.youtube?.configured === "boolean" ? response.youtube.configured : null;
  summary.youtubeFailed = responseCount(response.youtube?.failed);
  const postizFailed = responseCount(response.failed);
  summary.failed =
    postizFailed !== null && summary.tiktokFailed !== null && summary.youtubeFailed !== null
      ? postizFailed + summary.tiktokFailed + summary.youtubeFailed
      : null;
  summary.inserted = typeof response.inserted === "number" ? response.inserted : null;
  summary.missing = typeof response.missing === "number" ? response.missing : null;
  summary.polled = typeof response.polled === "number" ? response.polled : null;
  summary.referralArrivals =
    typeof response.referrals?.total === "number" ? response.referrals.total : null;
  summary.tiktokFetched = responseCount(response.tiktok?.fetched);
  summary.tiktokInserted = responseCount(response.tiktok?.inserted);
  summary.tiktokMatched = responseCount(response.tiktok?.matched);
  summary.youtubeFetched = responseCount(response.youtube?.fetched);
  summary.youtubeInserted = responseCount(response.youtube?.inserted);
  summary.youtubeMatched = responseCount(response.youtube?.matched);
  const tiktokChecked = armCount(response.tiktok, response.tiktok?.fetched);
  const youtubeChecked = armCount(response.youtube, response.youtube?.fetched);
  const tiktokProduced = armCount(response.tiktok, response.tiktok?.inserted);
  const youtubeProduced = armCount(response.youtube, response.youtube?.inserted);
  summary.checked =
    summary.polled !== null && tiktokChecked !== null && youtubeChecked !== null
      ? summary.polled + tiktokChecked + youtubeChecked
      : null;
  summary.produced =
    summary.inserted !== null && tiktokProduced !== null && youtubeProduced !== null
      ? summary.inserted + tiktokProduced + youtubeProduced
      : null;
}

// ── One tick, with injected effects ──────────────────────────────────────────

export async function runSocialMetricsTick(deps: SocialMetricsDeps): Promise<SocialMetricsSummary> {
  const summary: SocialMetricsSummary = {
    checked: null,
    configured: null,
    day: null,
    eligible: null,
    error: null,
    errors: 0,
    failed: null,
    inserted: null,
    missing: null,
    ok: true,
    polled: null,
    produced: null,
    referralArrivals: null,
    tiktokConfigured: null,
    tiktokFailed: null,
    tiktokFetched: null,
    tiktokInserted: null,
    tiktokMatched: null,
    youtubeConfigured: null,
    youtubeFailed: null,
    youtubeFetched: null,
    youtubeInserted: null,
    youtubeMatched: null,
  };

  try {
    const response = await deps.record();

    applySocialMetricsResponse(summary, response);

    if (response.ok !== true) {
      summary.ok = false;
      summary.errors = 1;
      summary.error = "record_social_metrics did not return ok";

      return summary;
    }
  } catch (error) {
    summary.ok = false;
    summary.errors = 1;
    summary.error = error instanceof Error ? error.message : String(error);
    deps.log(`snapshot failed: ${summary.error}`);
  }

  return summary;
}

// ── The real (box-side) effect ─────────────────────────────────────────────────

async function recordSocialMetrics(): Promise<RecordSocialMetricsResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/social/metrics/record`, {
    body: JSON.stringify({}),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(
      `record_social_metrics failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  return (await res.json()) as RecordSocialMetricsResponse;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(
      JSON.stringify({
        checked: null,
        errors: 1,
        ok: false,
        produced: null,
        reason: "missing_api_token",
      }),
    );
    process.exit(1);
  }

  const summary = await runSocialMetricsTick({ log, record: recordSocialMetrics });

  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`social-metrics-sweep failed: ${message}`);
    console.log(
      JSON.stringify({
        checked: null,
        error: message,
        errors: 1,
        ok: false,
        produced: null,
        reason: "social_metrics_failed",
      }),
    );
    process.exit(1);
  });
}

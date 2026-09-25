#!/usr/bin/env bun

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const log = (message: string) => console.error(`[social-metrics-sweep] ${message}`);

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

export type SocialMetricsSummary = {
  checked: null | number;
  configured: boolean | null;
  day: null | string;

  errors: number;
  error: null | string;
  eligible: null | number;

  failed: null | number;
  inserted: null | number;
  missing: null | number;
  ok: boolean;
  polled: null | number;

  produced: null | number;
  referralArrivals: null | number;

  tiktokConfigured: boolean | null;

  tiktokFailed: null | number;

  tiktokFetched: null | number;

  tiktokInserted: null | number;

  tiktokMatched: null | number;

  youtubeFetched: null | number;

  youtubeConfigured: boolean | null;

  youtubeFailed: null | number;

  youtubeInserted: null | number;

  youtubeMatched: null | number;
};

export type SocialMetricsDeps = {
  log: (message: string) => void;
  record: () => Promise<RecordSocialMetricsResponse>;
};

function responseCount(value: null | number | undefined): null | number {
  return typeof value === "number" ? value : null;
}

function armCount(
  arm: { configured?: boolean | null; failed?: number } | undefined,
  count: null | number | undefined,
): null | number {
  if (typeof count === "number") {
    return count;
  }

  return arm?.configured === false && arm.failed === 0 ? 0 : null;
}

function sumKnownCounts(...counts: Array<null | number>): null | number {
  return counts.every((count) => count !== null)
    ? counts.reduce<number>((total, count) => total + (count ?? 0), 0)
    : null;
}

function totalSocialMetricFailures(
  summary: SocialMetricsSummary,
  postizFailed: null | number,
): null | number {
  return postizFailed !== null && summary.tiktokFailed !== null && summary.youtubeFailed !== null
    ? postizFailed + summary.tiktokFailed + summary.youtubeFailed
    : null;
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
  summary.failed = totalSocialMetricFailures(summary, postizFailed);
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
  summary.checked = sumKnownCounts(summary.polled, tiktokChecked, youtubeChecked);
  summary.produced = sumKnownCounts(summary.inserted, tiktokProduced, youtubeProduced);
}

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

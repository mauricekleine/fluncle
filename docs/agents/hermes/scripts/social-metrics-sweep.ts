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
//   POST /api/admin/social/metrics/record with the box's AGENT token, a bare trigger (no body). The
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
};

/** One tick's honest summary — the JSON line the /status prober reads. */
export type SocialMetricsSummary = {
  configured: boolean | null;
  day: null | string;
  error: null | string;
  inserted: null | number;
  missing: null | number;
  ok: boolean;
  polled: null | number;
  referralArrivals: null | number;
};

/** The injected effects — so the tick's outcome mapping is provable with a stub (no network). */
export type SocialMetricsDeps = {
  log: (message: string) => void;
  record: () => Promise<RecordSocialMetricsResponse>;
};

// ── One tick, with injected effects ──────────────────────────────────────────

export async function runSocialMetricsTick(deps: SocialMetricsDeps): Promise<SocialMetricsSummary> {
  const summary: SocialMetricsSummary = {
    configured: null,
    day: null,
    error: null,
    inserted: null,
    missing: null,
    ok: true,
    polled: null,
    referralArrivals: null,
  };

  try {
    const response = await deps.record();

    if (response.ok !== true) {
      summary.ok = false;
      summary.error = "record_social_metrics did not return ok";

      return summary;
    }

    summary.day = response.day ?? null;
    summary.configured = typeof response.configured === "boolean" ? response.configured : null;
    summary.inserted = typeof response.inserted === "number" ? response.inserted : null;
    summary.polled = typeof response.polled === "number" ? response.polled : null;
    summary.missing = typeof response.missing === "number" ? response.missing : null;
    summary.referralArrivals =
      typeof response.referrals?.total === "number" ? response.referrals.total : null;
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    deps.log(`snapshot failed: ${summary.error}`);
  }

  return summary;
}

// ── The real (box-side) effect ─────────────────────────────────────────────────

async function recordSocialMetrics(): Promise<RecordSocialMetricsResponse> {
  const res = await fetch(`${API_BASE_URL}/api/admin/social/metrics/record`, {
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
    console.log(JSON.stringify({ ok: false, reason: "missing_api_token" }));
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
    console.log(JSON.stringify({ error: message, ok: false, reason: "social_metrics_failed" }));
    process.exit(1);
  });
}

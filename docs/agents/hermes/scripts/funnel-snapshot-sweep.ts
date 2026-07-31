#!/usr/bin/env bun
// funnel-snapshot-sweep.ts — the bun orchestrator behind the CATALOGUE-FUNNEL SNAPSHOT cron
// (`fluncle-funnel-snapshot`), scheduled by a rave-02 HOST systemd timer (../funnel-snapshot-timer/).
//
// WHY THIS EXISTS. The catalogue pipeline (crawl → anchor → capture → analyze/embed → rec-eligible
// → certified) is operated blind: live counts are cheap, but the growth-per-day charts need history
// nobody records (there is no `anchored_at`, no per-day ledger). So a daily tick fires the AGENT-tier
// `record_catalogue_snapshot` op and the Worker persists one idempotent row per UTC day. The page
// (/admin/funnel) reads it back. See docs/admin-shell.md.
//
// LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (funnel-snapshot-sweep.sh) the host
// timer docker-execs — see that file's header for the wire-up and ../funnel-snapshot-timer/README.md
// for the operator runbook.
//
// ── THE TICK ───────────────────────────────────────────────────────────────────────────────────
//   POST /api/v1/admin/funnel/snapshot with the box's AGENT token, a bare trigger (no body). The Worker
//   computes every stage total + queue depth + frontier count through the SAME predicates the sweeps
//   run and UPSERTS one row for the UTC day (a re-fired tick overwrites, never doubles a bar).
//
// THE BOX DEPENDS ON NO NEW CLI COMMAND. The baked `fluncle` CLI is a PINNED release, so this sweep
// calls the oRPC HTTP endpoint DIRECTLY with the agent token (the anchor-sweep / verify-captures
// precedent), never a `fluncle admin …` subcommand a pin might not carry. No new secret either —
// every count is computed Worker-side, so the box is a bare trigger like the reach cron.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

// ── Config (env; the shared ~/.fluncle-secrets.env supplies the secrets on the box) ──

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const log = (message: string) => console.error(`[funnel-snapshot-sweep] ${message}`);

// ── Types ────────────────────────────────────────────────────────────────────

/** The counts the snapshot row carries (only the headline fields this sweep echoes). */
export type SnapshotRow = {
  certified?: number;
  crawled?: number;
  day?: string;
  recEligible?: number;
};

/** What `record_catalogue_snapshot` returns. */
export type RecordSnapshotResponse = { ok?: boolean; snapshot?: SnapshotRow };

/** One tick's honest summary — the JSON line the /status prober reads. */
export type FunnelSnapshotSummary = {
  certified: null | number;
  checked: null | number;
  crawled: null | number;
  day: null | string;
  error: null | string;
  errors: number;
  ok: boolean;
  produced: null | number;
  recEligible: null | number;
};

/** The injected effects — so the tick's outcome mapping is provable with a stub (no network). */
export type FunnelSnapshotDeps = {
  log: (message: string) => void;
  record: () => Promise<RecordSnapshotResponse>;
};

// ── One tick, with injected effects ──────────────────────────────────────────

export async function runFunnelSnapshotTick(
  deps: FunnelSnapshotDeps,
): Promise<FunnelSnapshotSummary> {
  const summary: FunnelSnapshotSummary = {
    certified: null,
    checked: null,
    crawled: null,
    day: null,
    error: null,
    errors: 0,
    ok: true,
    produced: null,
    recEligible: null,
  };

  try {
    const response = await deps.record();
    const snapshot = response.snapshot;

    if (response.ok !== true || !snapshot) {
      // The one scheduled snapshot operation returned, so it was checked, but no persisted
      // snapshot was proven.
      summary.checked = 1;
      summary.errors = 1;
      summary.ok = false;
      summary.produced = 0;
      summary.error = "record_catalogue_snapshot did not return a snapshot";

      return summary;
    }

    summary.checked = 1;
    summary.produced = 1;
    summary.day = snapshot.day ?? null;
    summary.crawled = typeof snapshot.crawled === "number" ? snapshot.crawled : null;
    summary.certified = typeof snapshot.certified === "number" ? snapshot.certified : null;
    summary.recEligible = typeof snapshot.recEligible === "number" ? snapshot.recEligible : null;
  } catch (error) {
    // With no response, the driver cannot know whether the Worker looked at or persisted the
    // snapshot. Null preserves that uncertainty instead of laundering it into a measured zero.
    summary.checked = null;
    summary.errors = 1;
    summary.ok = false;
    summary.produced = null;
    summary.error = error instanceof Error ? error.message : String(error);
    deps.log(`snapshot failed: ${summary.error}`);
  }

  return summary;
}

// ── The real (box-side) effect ─────────────────────────────────────────────────

async function recordSnapshot(): Promise<RecordSnapshotResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/funnel/snapshot`, {
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
      `record_catalogue_snapshot failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  return (await res.json()) as RecordSnapshotResponse;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/** A pre-work credential gate made no work measurement; null distinguishes it from a real no-op. */
export function missingApiTokenSummary() {
  return {
    checked: null,
    errors: 1,
    ok: false,
    produced: null,
    reason: "missing_api_token",
  } as const;
}

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(JSON.stringify(missingApiTokenSummary()));
    process.exit(1);
  }

  const summary = await runFunnelSnapshotTick({ log, record: recordSnapshot });

  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`funnel-snapshot-sweep failed: ${message}`);
    console.log(
      JSON.stringify({
        checked: null,
        error: message,
        errors: 1,
        ok: false,
        produced: null,
        reason: "funnel_snapshot_failed",
      }),
    );
    process.exit(1);
  });
}

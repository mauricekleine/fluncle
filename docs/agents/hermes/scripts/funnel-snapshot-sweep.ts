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
// ── A MISSED DAY IS A PERMANENT HOLE, so the tick is defended on three levels ───────────────────
//   These counts are cumulative live readings with no per-day ledger behind them: a firing that
//   never lands leaves a gap in the growth charts that nothing can reconstruct later. So:
//     1. IN-TICK RETRY (here) — three attempts on a rising backoff, which covers the transient
//        Worker 5xx while the snapshot's full-table scan contends with another sweep.
//     2. A SECOND TIMER FIRING (../funnel-snapshot-timer/) later the SAME UTC day, which covers a
//        database-admission yield: the runner skips the payload entirely, so no in-process retry
//        can help and only another firing can. The per-day upsert makes the extra run a no-op.
//     3. THE WORKER'S GRACE WINDOW — a run in the first hours of a UTC day whose PREVIOUS day has
//        no row fills that day too (funnel.ts § SNAPSHOT_CATCHUP_GRACE_HOURS), which covers a box
//        that slept through 23:45 and caught up after midnight. The response names every day it
//        healed and this sweep echoes it as `backfilled` / `backfilledDays`, so a patched hole is
//        still visible in the run ledger rather than silently papered over.
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
export type RecordSnapshotResponse = {
  backfilledDays?: string[];
  ok?: boolean;
  snapshot?: SnapshotRow;
};

/** One tick's honest summary — the JSON line the /status prober reads. */
export type FunnelSnapshotSummary = {
  /** UTC days the Worker healed on this tick (a missed snapshot filled inside its grace window). */
  backfilled: number;
  backfilledDays: string[];
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
  /** Injected so the retry ladder is provable without spending real wall-clock in a test. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * THE IN-TICK RETRY LADDER. This cron fires ONCE for a day it can never re-take, so a single
 * transient Worker fault is a permanent hole in the growth series. Three attempts on a rising
 * backoff cost nothing on a healthy night and cover the failure that actually happens: a 5xx while
 * the snapshot's full-table scan contends with another sweep. A run that exhausts the ladder still
 * reports honestly — the retry is a second chance, never a way to hide a failure.
 */
const RECORD_ATTEMPTS = 3;
const RECORD_BACKOFF_MS = [5_000, 20_000];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── One tick, with injected effects ──────────────────────────────────────────

export async function runFunnelSnapshotTick(
  deps: FunnelSnapshotDeps,
): Promise<FunnelSnapshotSummary> {
  const summary: FunnelSnapshotSummary = {
    backfilled: 0,
    backfilledDays: [],
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
  const sleep = deps.sleep ?? wait;

  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt += 1) {
    const last = attempt === RECORD_ATTEMPTS;

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

        if (last) {
          return summary;
        }

        await sleep(RECORD_BACKOFF_MS[attempt - 1] ?? 0);
        continue;
      }

      const backfilledDays = Array.isArray(response.backfilledDays) ? response.backfilledDays : [];

      return {
        ...summary,
        backfilled: backfilledDays.length,
        backfilledDays,
        certified: typeof snapshot.certified === "number" ? snapshot.certified : null,
        checked: 1,
        crawled: typeof snapshot.crawled === "number" ? snapshot.crawled : null,
        day: snapshot.day ?? null,
        error: null,
        errors: 0,
        ok: true,
        produced: 1,
        recEligible: typeof snapshot.recEligible === "number" ? snapshot.recEligible : null,
      };
    } catch (error) {
      // With no response, the driver cannot know whether the Worker looked at or persisted the
      // snapshot. Null preserves that uncertainty instead of laundering it into a measured zero.
      summary.checked = null;
      summary.errors = 1;
      summary.ok = false;
      summary.produced = null;
      summary.error = error instanceof Error ? error.message : String(error);
      deps.log(`snapshot failed (attempt ${attempt}/${RECORD_ATTEMPTS}): ${summary.error}`);

      if (last) {
        return summary;
      }

      await sleep(RECORD_BACKOFF_MS[attempt - 1] ?? 0);
    }
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

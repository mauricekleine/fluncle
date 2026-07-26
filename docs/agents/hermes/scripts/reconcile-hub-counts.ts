#!/usr/bin/env bun
// reconcile-hub-counts.ts — the bun orchestrator behind the HUB-COUNTS RECONCILIATION cron
// (`fluncle-reconcile-hub-counts`), scheduled by a rave-02 HOST systemd timer
// (../reconcile-hub-counts-timer/).
//
// WHY THIS EXISTS. `labels`, `albums` and `artists` each carry `renderable_track_count` +
// `certified_finding_count`, maintained as DELTAS by every edge-writing path — because
// recompute-from-truth measured 27,400 ms at 150k hosted against ~200 ms for the delta form
// (docs/db-scale-backlog Wave 2 keystone 2). That trade takes on one debt: a maintained counter
// DRIFTS, silently. Three ways, none of them fixable from inside the write side — a missed write
// path, a non-atomic bulk op, or an OUT-OF-BAND write (the operator's catalogue-prune skill
// deletes tracks straight out of the database; no server-side track-delete path exists at all).
//
// KEYSTONE 2'S OWN ROLLOUT PROVED THE NEED ON DAY ONE (2026-07-26): the deploy-window skew
// between the one-time backfill and the first delta-maintained writes left 44 artists, 3 albums
// and 1 label reading wrong until a manual reconcile. This tick IS that manual reconcile, nightly.
//
// THE AUDIT TRAIL IS THE POINT. A non-zero `corrected` is a SIGNAL, not noise — it means a write
// path is leaking. So the tick logs the per-table numbers on every run and journalctl on the box
// holds the history:
//
//   [reconcile-hub-counts] AUDIT corrected=48 labels=1 albums=3 artists=44 tookMs=1150
//
// and the machine-readable last stdout line (also the /status prober's run output):
//
//   {"albums":3,"artists":44,"corrected":48,"elapsedMs":1204,"labels":1,"ok":true,"tookMs":1150}
//
// Read the history with:  journalctl -u fluncle-reconcile-hub-counts.service | grep AUDIT
//
// LIVE-INTENT. Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (reconcile-hub-counts.sh) the host
// timer docker-execs — see that file's header for the wire-up and
// ../reconcile-hub-counts-timer/README.md for the operator runbook.
//
// ── THE TICK ───────────────────────────────────────────────────────────────────────────────────
//   POST /api/v1/admin/hub-counts/reconcile with the box's AGENT token, a bare trigger (no body).
//   The Worker does ALL the work in SQL: per table, one grouped `UPDATE … FROM (… GROUP BY fk)`
//   guarded by a counts-DIFFER predicate (so `rowsAffected` is the corrected-row count, exactly),
//   plus a small zero-truth pass for an entity whose last track vanished out of band. The box
//   holds no computation authority — it triggers, reads the numbers back, and logs them.
//
// THE BOX DEPENDS ON NO NEW CLI COMMAND. The baked `fluncle` CLI is a PINNED release, so this
// sweep calls the oRPC HTTP endpoint DIRECTLY with the agent token (the funnel-snapshot /
// anchor-sweep precedent), never a `fluncle admin …` subcommand a pin might not carry. No new
// secret either — every statement runs Worker-side, so the box is a bare trigger.
//
// The pure tick is exported + unit-tested in reconcile-hub-counts.test.ts; `main()` is guarded
// behind `import.meta.main` so importing this module for the tests is side-effect free (no network).
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

// ── Config (env; the shared ~/.fluncle-secrets.env supplies the secrets on the box) ──

const API_BASE_URL = process.env.FLUNCLE_API_BASE_URL ?? "https://www.fluncle.com";
const API_TOKEN = process.env.FLUNCLE_API_TOKEN ?? "";

const log = (message: string) => console.error(`[reconcile-hub-counts] ${message}`);

// ── Types — only the fields we consume from the op ────────────────────────────

/** One table's outcome as the op returns it (an object, so it can grow). */
export type ReconcileTableResult = { corrected?: number };

/** What `reconcile_hub_counts` returns. */
export type ReconcileHubCountsResponse = {
  albums?: ReconcileTableResult;
  artists?: ReconcileTableResult;
  labels?: ReconcileTableResult;
  ok?: boolean;
  tookMs?: number;
};

/** One tick's honest summary — the JSON line the /status prober reads, and the drift audit. */
export type ReconcileHubCountsSummary = {
  albums: null | number;
  artists: null | number;
  /** The three tables' corrected rows added up — null when the tick could not read them. */
  corrected: null | number;
  error: null | string;
  labels: null | number;
  ok: boolean;
  /** Server-side wall clock for the SQL pass (distinct from the tick's own elapsedMs). */
  tookMs: null | number;
};

/** The injected effects — so the tick's outcome mapping is provable with a stub (no network). */
export type ReconcileHubCountsDeps = {
  log: (message: string) => void;
  reconcile: () => Promise<ReconcileHubCountsResponse>;
};

/** Read one table's `corrected`, tolerating a field the op did not send. */
function correctedOf(table: ReconcileTableResult | undefined): null | number {
  return typeof table?.corrected === "number" ? table.corrected : null;
}

// ── One tick, with injected effects ──────────────────────────────────────────

export async function runReconcileHubCountsTick(
  deps: ReconcileHubCountsDeps,
): Promise<ReconcileHubCountsSummary> {
  const summary: ReconcileHubCountsSummary = {
    albums: null,
    artists: null,
    corrected: null,
    error: null,
    labels: null,
    ok: true,
    tookMs: null,
  };

  try {
    const response = await deps.reconcile();

    if (response.ok !== true) {
      summary.ok = false;
      summary.error = "reconcile_hub_counts did not ack";

      return summary;
    }

    summary.labels = correctedOf(response.labels);
    summary.albums = correctedOf(response.albums);
    summary.artists = correctedOf(response.artists);
    summary.tookMs = typeof response.tookMs === "number" ? response.tookMs : null;

    const perTable = [summary.labels, summary.albums, summary.artists];
    summary.corrected = perTable.every((value) => value !== null)
      ? perTable.reduce((total, value) => (total ?? 0) + (value ?? 0), 0)
      : null;

    // THE AUDIT LINE. Emitted on EVERY tick — a run of zeroes is the evidence the counters are
    // healthy, and a non-zero reading is the evidence a write path is leaking. Both belong in the
    // journal, so this is never conditional on drift being found.
    deps.log(
      `AUDIT corrected=${summary.corrected ?? "?"} labels=${summary.labels ?? "?"} ` +
        `albums=${summary.albums ?? "?"} artists=${summary.artists ?? "?"} ` +
        `tookMs=${summary.tookMs ?? "?"}`,
    );
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    deps.log(`reconcile failed: ${summary.error}`);
  }

  return summary;
}

// ── The real (box-side) effect ─────────────────────────────────────────────────

async function postReconcile(): Promise<ReconcileHubCountsResponse> {
  const res = await fetch(`${API_BASE_URL}/api/v1/admin/hub-counts/reconcile`, {
    body: JSON.stringify({}),
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    // The whole pass measured 19.3s at 150k hosted as three correlated statements and the grouped
    // shape is cheaper; a generous ceiling so a slow night reports honestly instead of aborting.
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(
      `reconcile_hub_counts failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
    );
  }

  return (await res.json()) as ReconcileHubCountsResponse;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const started = Date.now();

  if (!API_TOKEN) {
    console.log(JSON.stringify({ ok: false, reason: "missing_api_token" }));
    process.exit(1);
  }

  const summary = await runReconcileHubCountsTick({ log, reconcile: postReconcile });

  console.log(JSON.stringify({ ...summary, elapsedMs: Date.now() - started }));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`reconcile-hub-counts failed: ${message}`);
    console.log(JSON.stringify({ error: message, ok: false, reason: "reconcile_failed" }));
    process.exit(1);
  });
}

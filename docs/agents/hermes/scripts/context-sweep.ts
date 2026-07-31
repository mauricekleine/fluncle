#!/usr/bin/env bun
// context-sweep.ts — the bun orchestrator behind the `--no-agent` context-note cron
// (`fluncle-context-note`).
//
// LIVE. Version-controlled source; the repo is canonical and the box is a
// deploy target (fluncle-hermes-operator skill). Invoked by the bash wrapper
// (context-sweep.sh) the cron runner execs on a schedule — see that file's header
// for the `host-timer` wire-up and ../cron/README.md for the cron model.
//
// THE WORKER-PACED MODEL. The box holds NO Firecrawl key (the Worker does), and the
// note-distilling LLM (Haiku, #129) moved Worker-side too. So the actual work — the
// Firecrawl search, the Haiku distill, the quiet `context_note` write — happens IN
// THE WORKER; this box driver just TRIGGERS it, one small bounded batch per tick via
// the `fluncle` CLI. Pure trigger, zero LLM tokens on the box. (This replaces the old
// full-agent context-note cron, which spent a whole Sonnet session just to drain a
// queue and POST per finding — pure harness tax, ~37k prompt tokens to emit ~200.)
//
// The loop, idempotent by construction (the queue is `hasContext=false`, oldest
// first, and the Worker is idempotent per finding on `context:${logId}`, so a finding
// that already has notes is a no-op), fast no-op when the queue is empty:
//
//   1. `fluncle admin tracks context --queue --json`  → the worklist (findings
//      missing field notes; status-aware via #129's context_status, oldest-first).
//   2. per finding (bounded batch): `fluncle admin tracks context <id> --json` →
//      triggers the Worker (Firecrawl + Haiku distill + the quiet context_note write).
//      Record pass/fail per finding; one finding's failure never aborts the sweep.
//
// THE OCCASIONAL WIDEN PASS (`RETRY_EMPTY=1` or `--retry-empty`): the routine sweep's
// queue read (step 1) EXCLUDES finds the prior pass confirmed empty
// (`context_status = 'empty'`) so the every-tick cron never re-burns Firecrawl + the
// distil LLM on a hopeless find. This flag widens the worklist to ALSO re-pick those
// empties — the deliberate, rarely-run net-widening pass (e.g. a monthly retry after
// new web facts may have surfaced). OFF by default; the routine cron does NOT set it.
// See context-sweep.sh for the separate occasional cron wire-up.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config — bounded batch so a tick stays cheap and a transient failure can't
// stampede the whole queue. The queue itself is the durable worklist; anything
// not reached this tick is picked up on the next (~60m later).
// ---------------------------------------------------------------------------

const BATCH_CAP = 6; // findings triggered per tick (sane small cap)
const QUEUE_LIMIT = 50; // hard ceiling on the queue read (we only act on BATCH_CAP)

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

// The occasional widen-the-net pass. OFF for the routine cron; ON only for the
// deliberate retry-empties run via `RETRY_EMPTY=1` or a `--retry-empty` arg. When on,
// the queue read also surfaces finds the prior pass confirmed empty so the Worker
// re-attempts them; the per-finding trigger is identical either way.
const RETRY_EMPTY =
  process.env.RETRY_EMPTY === "1" ||
  process.env.RETRY_EMPTY === "true" ||
  process.argv.slice(2).includes("--retry-empty");

const log = (message: string) => console.error(`[context-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from each surface.
// ---------------------------------------------------------------------------

type QueueFinding = {
  logId?: string;
  trackId?: string;
};

type ContextResult = {
  contextNote?: string;
  logId?: string;
  skipped?: boolean;
  trackId?: string;
};

type Outcome = "filled" | "noop" | "skipped";

type ContextCounts = {
  batch: number;
  failed: number;
  filled: number;
  noop: number;
  queueRemaining: number;
};

export function buildContextSummary(
  counts: ContextCounts,
  retryEmpty: boolean,
): {
  batch: number;
  checked: number;
  errors: number;
  failed: number;
  filled: number;
  noop: number;
  ok: true;
  processed: number;
  produced: number;
  queueRemaining: number;
  retryEmpty: boolean;
} {
  return {
    ...counts,
    checked: counts.batch,
    errors: 0,
    ok: true,
    processed: counts.filled + counts.noop,
    // Only a newly written context note is production; an idempotent no-op is not.
    produced: counts.filled,
    retryEmpty,
  };
}

export function buildContextFailureSummary(error: unknown): {
  checked: null;
  error: string;
  errors: 1;
  failed: null;
  ok: false;
  produced: null;
  reason: "context_failed";
} {
  return {
    checked: null,
    error: error instanceof Error ? error.message : String(error),
    errors: 1,
    failed: null,
    ok: false,
    produced: null,
    reason: "context_failed",
  };
}

// ---------------------------------------------------------------------------
// Shell helper — synchronous, fail-loud where it matters.
// ---------------------------------------------------------------------------

function fluncleJson<T>(args: string[]): T {
  const result = spawnSync(FLUNCLE_BIN, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`failed to spawn ${FLUNCLE_BIN}: ${result.error.message}`);
  }

  const code = result.status ?? 1;
  const stdout = result.stdout ?? "";

  if (code !== 0) {
    throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${(result.stderr ?? "").trim()}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Per-finding: trigger the Worker's context fetch.
// ---------------------------------------------------------------------------

function contextOne(finding: QueueFinding): Outcome {
  const id = finding.trackId ?? finding.logId;

  if (!id) {
    log("queue item without a trackId/logId — skipping");

    return "skipped";
  }

  // Trigger the Worker: it runs the Firecrawl search, distills with Haiku, and
  // writes `context_note` QUIETLY (no `updated_at` bump). Idempotent per finding —
  // a finding that already has notes returns `skipped: true` (a no-op).
  const result = fluncleJson<ContextResult>(["admin", "tracks", "context", id]);

  if (result.skipped) {
    log(`${result.logId ?? id}: field notes already on file — no-op`);

    return "noop";
  }

  if (!result.contextNote || !result.contextNote.trim()) {
    log(`${result.logId ?? id}: no field notes turned up — stays queued`);

    return "skipped";
  }

  log(`${result.logId ?? id}: field notes gathered`);

  return "filled";
}

// ---------------------------------------------------------------------------
// Main — drain a bounded batch off the queue.
// ---------------------------------------------------------------------------

export function main(): void {
  // `context --queue --json` returns `{ ok: true, tracks: [...] }`, not a bare array.
  // `--retry-empty` (the occasional widen pass) also re-picks confirmed-empty finds;
  // the routine cron omits it, so the worklist stays narrow tick to tick.
  const response = fluncleJson<{ tracks?: QueueFinding[] }>([
    "admin",
    "tracks",
    "context",
    "--queue",
    "--limit",
    String(QUEUE_LIMIT),
    ...(RETRY_EMPTY ? ["--retry-empty"] : []),
  ]);
  const queue = response.tracks ?? [];

  const counts: ContextCounts = {
    batch: 0,
    failed: 0,
    filled: 0,
    noop: 0,
    queueRemaining: queue.length,
  };

  if (queue.length === 0) {
    console.log(JSON.stringify(buildContextSummary(counts, RETRY_EMPTY)));

    return; // fast no-op
  }

  for (const finding of queue.slice(0, BATCH_CAP)) {
    counts.batch += 1;

    try {
      const outcome = contextOne(finding);

      if (outcome === "filled") {
        counts.filled += 1;
      } else if (outcome === "noop") {
        counts.noop += 1;
      } else {
        counts.failed += 1;
      }
    } catch (error) {
      // One finding's failure must not abort the sweep — log it and move on; it
      // stays in the queue for the next tick.
      counts.failed += 1;
      log(
        `error on ${finding.trackId ?? finding.logId ?? "?"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Preserve the existing bounded-page residual as forensic detail. It is deliberately NOT
  // `queue_depth`: the queue read is capped and its predicate has no cheap covering count.
  counts.queueRemaining = Math.max(0, queue.length - counts.filled - counts.noop);
  console.log(JSON.stringify(buildContextSummary(counts, RETRY_EMPTY)));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const summary = buildContextFailureSummary(error);
    log(`context sweep failed: ${summary.error}`);
    console.log(JSON.stringify(summary));
    process.exit(1);
  }
}

#!/usr/bin/env bun
// rank-sweep.ts — the bun orchestrator behind the `--no-agent` catalogue-ranking cron
// (`fluncle-rank`). THE EAR's schedule (docs/the-ear.md).
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (rank-sweep.sh) the host
// timer execs on a schedule — see that file's header for the wire-up and
// ../cron/README.md for the cron model.
//
// ── WHY THIS TIMER LANDS WITH THE CRAWLER'S PR ────────────────────────────────
// The Ear shipped `rank_catalogue` deliberately WITHOUT a schedule, and said so:
// "a timer ranking an empty table would be a /status row that means nothing; the crawler
// is what creates rows, so its PR is where `rank_catalogue` gets its schedule." The
// crawler now exists. So does the schedule.
//
// WHAT IT DOES. One tick ranks a bounded batch of STALE catalogue rows — each against
// every embedded finding, entirely in SQL inside the Worker — storing each one's nearest
// finding, the cosine similarity to it, and (for a row with no audio yet) its
// capture-priority tier. The CLI holds no ranking logic; this driver holds even less. It
// paces, it reports, it stops.
//
// ── THE `remaining` CONTRACT, AND WHY THIS ONE LOOPS ──────────────────────────
// Unlike the crawl (whose pace is a VENDOR'S rate limit, so one pass per tick is the
// whole point), ranking is pure local SQL with no external budget to respect — the only
// cost is the box's own CPU. And it has a natural finish line: `remaining` is the count
// of rows whose stored corpus fingerprint disagrees with the live one. So this sweep
// DRAINS: it loops while `remaining > 0`, up to a hard tick budget, and stops. A crawl
// that just landed 700 rows is fully ranked by the next tick rather than in 70 minutes.
//
// SELF-HEALING, so the tick is honest either way. Staleness is a fingerprint of the
// finding corpus (`"<findings>:<embedded>"`), so logging or embedding a finding makes
// every catalogue row disagree with it and re-rank on later ticks — no invalidation call
// from the publish path, and a no-op on an unchanged archive. An idle tick is one cheap
// scoped COUNT.
//
// It certifies nothing: `rank_catalogue` writes DERIVED columns on CATALOGUE rows only
// (`tracks` with no `findings` row), so it cannot mint a coordinate, write a note, or
// touch a finding. Agent tier, agent token, no new secret. Zero LLM tokens.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config. `BATCH` is rows per CALL (the Worker clamps at 1000); `MAX_CALLS` is the tick's
// hard budget, so a tick is bounded even when the crawler has just dumped thousands of
// fresh rows in — the rest simply drains on the next tick. 250 × 8 = 2,000 rows/tick,
// which is a few seconds of SQL and comfortably inside the unit's timeout.
// ---------------------------------------------------------------------------

const BATCH = Number(process.env.FLUNCLE_RANK_BATCH ?? "250");
const MAX_CALLS = Number(process.env.FLUNCLE_RANK_MAX_CALLS ?? "8");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[rank-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from the rank summary.
// ---------------------------------------------------------------------------

type RankSummary = {
  corpus?: string;
  embeddedFindings?: number;
  findings?: number;
  ok?: boolean;
  prioritized?: number;
  // Rows whose stored corpus fingerprint still disagrees with the live one. THE
  // "run me again" signal — and it is COUNTED, never inferred from an empty batch (an
  // empty batch is not an empty backlog).
  remaining?: number;
  scored?: number;
};

// ---------------------------------------------------------------------------
// Shell helper — synchronous, fail-loud where it matters. Parse-first, so a partial
// batch is RECORDED rather than discarded as a crash (the backfill-sweep contract).
// ---------------------------------------------------------------------------

export function fluncleJson<T>(args: string[]): T {
  const result = spawnSync(FLUNCLE_BIN, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`failed to spawn ${FLUNCLE_BIN}: ${result.error.message}`);
  }

  const code = result.status ?? 1;
  const stdout = result.stdout ?? "";

  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    if (code !== 0) {
      throw new Error(`fluncle ${args.join(" ")} exited ${code}: ${(result.stderr ?? "").trim()}`);
    }

    throw new Error(`fluncle ${args.join(" ")} did not return JSON: ${stdout.slice(0, 200)}`);
  }

  if (code !== 0 && isCliErrorPayload(parsed)) {
    throw new Error(`fluncle ${args.join(" ")} failed (${parsed.code}): ${parsed.message}`);
  }

  return parsed as T;
}

// The CLI's own failure payload (`{ code, message, ok: false }`). Distinguishable from a
// rank summary, which carries no `code`/`message` pair.
function isCliErrorPayload(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

// ---------------------------------------------------------------------------
// Main — drain the stale set, bounded by MAX_CALLS.
// ---------------------------------------------------------------------------

// `main` RETURNS its summary and never exits: the process-level exit code is the
// entrypoint's job (below). That keeps the sweep importable — a `process.exit` inside it
// would tear down the test runner mid-assertion, which is exactly what it did once.
export function main(): { ok: boolean } & Record<string, unknown> {
  const summary = {
    calls: 0,
    corpus: null as null | string,
    error: null as null | string,
    ok: true,
    prioritized: 0,
    // What is still stale when the tick's budget ran out. > 0 is not a failure — it is
    // the honest "there is more, and the next tick will take it".
    remaining: 0,
    scored: 0,
  };

  try {
    for (let call = 0; call < MAX_CALLS; call += 1) {
      const tick = fluncleJson<RankSummary>([
        "admin",
        "catalogue",
        "rank",
        "--limit",
        String(BATCH),
      ]);

      summary.calls += 1;
      summary.corpus = tick.corpus ?? summary.corpus;
      summary.scored += tick.scored ?? 0;
      summary.prioritized += tick.prioritized ?? 0;
      summary.remaining = tick.remaining ?? 0;

      if (summary.remaining === 0) {
        break;
      }
    }

    if (summary.remaining > 0) {
      log(
        `tick budget spent with ${summary.remaining} row(s) still stale — the next tick takes them`,
      );
    }
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`rank sweep failed: ${summary.error}`);
  }

  console.log(JSON.stringify(summary));

  return summary;
}

// The cron runs this file directly; the guard keeps importing `main`/`fluncleJson` for the
// tests (rank-sweep.test.ts) side-effect free — and it owns the exit code, so a failing tick
// is a failing unit without `main` being able to kill its own caller.
if (import.meta.main) {
  if (!main().ok) {
    process.exit(1);
  }
}

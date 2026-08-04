#!/usr/bin/env bun
// reach-sweep.ts — the bun orchestrator behind the `--no-agent` reach cron (`fluncle-reach`).
// The daily snapshot of how far Fluncle's tentacles stretch across the web — the series behind
// the public /reach page (per-platform activation + tiers: docs/reach-tier2-activation.md).
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (reach-sweep.sh) the host
// timer execs once a day — see that file's header for the wire-up and ../reach-timer/README.md
// for the cron model.
//
// WHAT IT DOES. One tick fires `fluncle admin reach collect` ONCE. `collect` is a bare
// trigger — the WORKER owns every platform credential and does all the fetching (each
// platform best-effort: a fault is reported + logged, never fatal to the snapshot), writing one
// idempotent snapshot row per (platform, metric) keyed by `${platform}:${metric}:${yyyy-mm-dd}`
// (ON CONFLICT DO NOTHING). A same-day re-run therefore lands `inserted: 0` and is a safe
// no-op. Exactly the `catalogue rank` shape (a pacer, not an engine), minus the drain loop:
// a daily snapshot is a single call, not a paced backlog. Zero LLM tokens.
//
// It writes only internal snapshot rows via the AGENT-tier `record_platform_stats` op, so the
// box's existing agent-scoped token drives it — NO new secret, and no operator token (every
// platform secret lives Worker-side, which is the whole reason the cron is a bare trigger).
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[reach-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from the `record_platform_stats` wrapper
// (apps/cli/src/commands/admin-reach.ts → ReachCollectResult).
// ---------------------------------------------------------------------------

type ReachCollected = { metrics: string[]; platform: string };
type ReachFailed = { platform: string; reason: string };
type ReachSkipped = { kind: "empty" | "unconfigured"; platform: string; reason: string };

type ReachCollectResult = {
  collected?: ReachCollected[];
  failed?: ReachFailed[];
  inserted?: number;
  ok?: boolean;
  skipped?: ReachSkipped[];
};

// ---------------------------------------------------------------------------
// Shell helper — synchronous, fail-loud where it matters (the rank-sweep contract, minus the
// loop). Appends `--json` so the CLI emits a machine-readable wrapper; parse-first so a CLI error
// payload is surfaced as a thrown error, not swallowed.
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
// collect wrapper, which carries no `code`/`message` pair.
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
// Main — one collect, one summary line.
// ---------------------------------------------------------------------------

// `main` RETURNS its summary and never exits: the process-level exit code is the entrypoint's
// job (below), which keeps the sweep importable — a `process.exit` inside it would tear down
// the test runner mid-assertion (the rank-sweep lesson).
export function main(): { ok: boolean } & Record<string, unknown> {
  const summary = {
    checked: null as null | number,
    // Platforms that completed but measured no metrics.
    empty: null as null | number,
    error: null as null | string,
    errors: 0,
    // Per-platform fetch/parse faults; the run continued.
    failed: null as null | number,
    // How many (platform, metric) rows this snapshot actually wrote (a same-day re-run is 0).
    inserted: null as null | number,
    // How many platforms landed at least one metric this tick.
    landed: null as null | number,
    ok: true,
    produced: null as null | number,
    // Clean non-work: unconfigured plus measured-empty platforms.
    skipped: null as null | number,
    unconfigured: null as null | number,
  };

  try {
    const tick = fluncleJson<ReachCollectResult>(["admin", "reach", "collect"]);

    summary.inserted = typeof tick.inserted === "number" ? tick.inserted : null;

    if (
      Array.isArray(tick.collected) &&
      Array.isArray(tick.failed) &&
      Array.isArray(tick.skipped)
    ) {
      summary.landed = tick.collected.length;
      summary.failed = tick.failed.length;
      summary.skipped = tick.skipped.length;
      summary.empty = tick.skipped.filter((entry) => entry.kind === "empty").length;
      summary.unconfigured = tick.skipped.filter((entry) => entry.kind === "unconfigured").length;
      // Platforms are the work unit: every landed/skipped/failed platform was checked, and a landed
      // platform was successfully acted on even when an idempotent same-day write inserts 0 rows.
      // All three arrays must exist before zero is measured.
      summary.checked = summary.landed + summary.skipped + summary.failed;
      summary.produced = summary.landed;
    }

    if (tick.ok === false) {
      // The Worker reported a hard stop (not a per-platform fault, which stays inside `failed`) —
      // carry it through as a failed tick rather than a false success.
      summary.ok = false;
      summary.errors = 1;
      summary.error = "record_platform_stats returned ok:false";
      log("collect returned ok:false");
    } else if ((summary.skipped ?? 0) > 0 || (summary.failed ?? 0) > 0) {
      log(
        `${summary.landed ?? 0} platform(s) landed, ${summary.skipped ?? 0} skipped, ${summary.failed ?? 0} failed this tick`,
      );
    }
  } catch (error) {
    summary.ok = false;
    summary.errors = 1;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`reach sweep failed: ${summary.error}`);
  }

  console.log(JSON.stringify(summary));

  return summary;
}

// The cron runs this file directly; the guard keeps importing `main`/`fluncleJson` for the
// tests (reach-sweep.test.ts) side-effect free — and it owns the exit code, so a failing tick
// is a failing unit without `main` being able to kill its own caller.
if (import.meta.main) {
  if (!main().ok) {
    process.exit(1);
  }
}

#!/usr/bin/env bun
// reach-sweep.ts — the bun orchestrator behind the `--no-agent` reach cron (`fluncle-reach`).
// The daily snapshot of how far Fluncle's tentacles stretch across the web (docs/planning/
// stats-page-spike.md → the public /reach page).
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (reach-sweep.sh) the host
// timer execs once a day — see that file's header for the wire-up and ../reach-timer/README.md
// for the cron model.
//
// WHAT IT DOES. One tick fires `fluncle admin reach collect` ONCE. `collect` is a bare
// trigger — the WORKER owns every platform credential and does all the fetching (each
// platform best-effort: a 401 skips + logs, never fails the snapshot), writing one
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
// Types — only the fields we consume from the `record_platform_stats` envelope
// (apps/cli/src/commands/admin-reach.ts → ReachCollectResult).
// ---------------------------------------------------------------------------

type ReachCollected = { metrics: string[]; platform: string };
type ReachSkipped = { platform: string; reason: string };

type ReachCollectResult = {
  collected?: ReachCollected[];
  inserted?: number;
  ok?: boolean;
  skipped?: ReachSkipped[];
};

// ---------------------------------------------------------------------------
// Shell helper — synchronous, fail-loud where it matters (the rank-sweep contract, minus the
// loop). Appends `--json` so the CLI emits a machine envelope; parse-first so a CLI error
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
// collect envelope, which carries no `code`/`message` pair.
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
    error: null as null | string,
    // How many (platform, metric) rows this snapshot actually wrote (a same-day re-run is 0).
    inserted: 0,
    // How many platforms landed at least one metric this tick.
    landed: 0,
    ok: true,
    // How many platforms were skipped (unconfigured, or a best-effort fetch fault) — honest,
    // not a failure: a platform whose key isn't held yet simply doesn't snapshot today.
    skipped: 0,
  };

  try {
    const tick = fluncleJson<ReachCollectResult>(["admin", "reach", "collect"]);

    summary.inserted = tick.inserted ?? 0;
    summary.landed = tick.collected?.length ?? 0;
    summary.skipped = tick.skipped?.length ?? 0;

    if (tick.ok === false) {
      // The Worker reported a hard stop (not a per-platform skip, which stays inside
      // `skipped`) — carry it through as a failed tick rather than a false success.
      summary.ok = false;
      summary.error = "record_platform_stats returned ok:false";
      log("collect returned ok:false");
    } else if (summary.skipped > 0) {
      log(`${summary.landed} platform(s) landed, ${summary.skipped} skipped this tick`);
    }
  } catch (error) {
    summary.ok = false;
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

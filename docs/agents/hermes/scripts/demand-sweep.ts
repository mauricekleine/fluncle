#!/usr/bin/env bun
// demand-sweep.ts — the bun orchestrator behind the `--no-agent` demand cron (`fluncle-demand`).
// The nightly demand-driven reorder of crawl/capture priority (docs/catalogue-crawler.md § Demand).
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (demand-sweep.sh) the host timer
// execs once a day — see that file's header for the wire-up and ../demand-timer/README.md for the
// cron model.
//
// WHAT IT DOES. One tick fires `fluncle admin catalogue demand` ONCE. `demand` is a bare trigger
// — the WORKER holds the Simple Analytics key and does the fetch, then rewrites two derived
// reorder columns (`tracks.demand_score` + `crawl_frontier.demand_rank`) so the capture queue and
// the crawl frontier lean toward the artists + labels real visitors looked at. RANK-ORDER ONLY: it
// reorders WITHIN a tier and never overrides the `capture_priority` veto. The rewrite is a full
// clear-then-set, so a same-window re-run lands the same columns (idempotent). Exactly the `reach
// collect` shape (a pacer, not an engine): one call, no drain loop. Zero LLM tokens.
//
// It writes only the two internal reorder columns via the AGENT-tier `record_demand` op, so the
// box's existing agent-scoped token drives it — NO new box secret (the SA key lives Worker-side,
// which is the whole reason the cron is a bare trigger). Unprovisioned Worker-side (no SA key) the
// tick returns `configured: false` and is a clean no-op — an HONEST tick, not a failure.
//
// ── THE ONE TRANSIENT RETRY ───────────────────────────────────────────────────────────────────
// Unlike `reach` this driver retries ONCE on a thrown error (a cold Worker, a blip talking to SA):
// a nightly signal that silently skips a whole day on one transient fault is worse than a second
// attempt. It is a single retry with a short backoff — never a loop — so the tick stays bounded.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

/** The backoff between the first attempt and the single retry. */
const RETRY_DELAY_MS = Number(process.env.FLUNCLE_DEMAND_RETRY_DELAY_MS ?? "5000");

const log = (message: string) => console.error(`[demand-sweep] ${message}`);

// ---------------------------------------------------------------------------
// Types — only the fields we consume from the `record_demand` envelope
// (apps/cli/src/commands/admin-catalogue.ts → RecordDemandSummary).
// ---------------------------------------------------------------------------

type RecordDemandSummary = {
  configured?: boolean;
  demandedArtists?: number;
  demandedLabels?: number;
  frontierPromoted?: number;
  pagesRead?: number;
  tracksScored?: number;
  unknownSlugs?: number;
};

type RecordDemandResponse = RecordDemandSummary & { summary?: RecordDemandSummary };

// The CLI prints the demand tick as an ENVELOPE — `{"ok":true,"summary":{…}}` — with the counts
// nested under `summary`. Unwrap it, keeping the flat read as a fallback so either shape parses
// (the rank-sweep envelope lesson).
function unwrapSummary(response: RecordDemandResponse): RecordDemandSummary {
  return response.summary ?? response;
}

// ---------------------------------------------------------------------------
// Shell helper — synchronous, fail-loud where it matters (the reach-sweep contract). Appends
// `--json` so the CLI emits a machine envelope; parse-first so a CLI error payload is surfaced as
// a thrown error, not swallowed.
// ---------------------------------------------------------------------------

export function fluncleJson<T>(args: string[]): T {
  // Read the binary at CALL time (not a module const), so a test can point FLUNCLE_BIN at a stub
  // after importing this module (the box always has it set in the wrapper's env anyway).
  const bin = process.env.FLUNCLE_BIN ?? "fluncle";
  const result = spawnSync(bin, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`failed to spawn ${bin}: ${result.error.message}`);
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

// The CLI's own failure payload (`{ code, message, ok: false }`). Distinguishable from a demand
// envelope, which carries no `code`/`message` pair.
function isCliErrorPayload(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/** A synchronous blocking sleep — the driver is synchronous (spawnSync), so the backoff is too. */
function sleepSync(ms: number): void {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

// ---------------------------------------------------------------------------
// The runner — injectable effects so the retry/summary mapping is provable with a stub (no
// network, no real spawn).
// ---------------------------------------------------------------------------

export type DemandDeps = {
  demand: () => RecordDemandResponse;
  log: (message: string) => void;
  sleep: (ms: number) => void;
};

// `runDemand` RETURNS its summary and never exits: the process-level exit code is the entrypoint's
// job (below), which keeps the sweep importable — a `process.exit` inside it would tear down the
// test runner mid-assertion (the rank-sweep lesson).
export function runDemand(deps: DemandDeps): { ok: boolean } & Record<string, unknown> {
  const summary = {
    attempts: 0,
    configured: null as boolean | null,
    demandedArtists: 0,
    demandedLabels: 0,
    error: null as null | string,
    frontierPromoted: 0,
    ok: true,
    tracksScored: 0,
  };

  // One attempt, then ONE retry on a thrown fault (a cold Worker / an SA blip) — never a loop.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    summary.attempts = attempt;

    try {
      const tick = unwrapSummary(deps.demand());

      summary.configured = tick.configured ?? null;
      summary.demandedArtists = tick.demandedArtists ?? 0;
      summary.demandedLabels = tick.demandedLabels ?? 0;
      summary.tracksScored = tick.tracksScored ?? 0;
      summary.frontierPromoted = tick.frontierPromoted ?? 0;
      summary.error = null;
      summary.ok = true;

      if (summary.configured === false) {
        deps.log("Simple Analytics not configured Worker-side — a clean no-op tick");
      }

      break;
    } catch (error) {
      summary.ok = false;
      summary.error = error instanceof Error ? error.message : String(error);

      if (attempt === 1) {
        deps.log(`demand tick failed (${summary.error}) — retrying once`);
        deps.sleep(RETRY_DELAY_MS);
      } else {
        deps.log(`demand sweep failed after retry: ${summary.error}`);
      }
    }
  }

  return summary;
}

export function main(): { ok: boolean } & Record<string, unknown> {
  const summary = runDemand({
    demand: () => fluncleJson<RecordDemandResponse>(["admin", "catalogue", "demand"]),
    log,
    sleep: sleepSync,
  });

  console.log(JSON.stringify(summary));

  return summary;
}

// The cron runs this file directly; the guard keeps importing `runDemand`/`fluncleJson` for the
// tests (demand-sweep.test.ts) side-effect free — and it owns the exit code, so a failing tick is
// a failing unit without `main` being able to kill its own caller.
if (import.meta.main) {
  if (!main().ok) {
    process.exit(1);
  }
}

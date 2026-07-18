#!/usr/bin/env bun
// frontier-refresh-sweep.ts — the bun orchestrator behind the `--no-agent` weekly
// Frontier-refresh cron (`fluncle-frontier-refresh`). E2, the public recommendation
// machine (docs/planning/ROADMAP.md § the public recommendation machine).
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (frontier-refresh-sweep.sh)
// the host timer execs weekly — see that file's header for the wire-up and
// ../cron/README.md for the cron model.
//
// WHAT IT DOES. One weekly tick re-mirrors every crew member's "Fluncle's Frontier"
// playlist from their CURRENT recommendations — the Discover-Weekly-style refresh. The
// CLI holds no sync logic; this driver holds even less. It fires ONE
// `fluncle admin frontier refresh` (the `refresh_frontier_playlists` op), which walks
// the playlists inside the Worker, respects the DEFAULT-DENY kill switch, and full-
// replaces each playlist whose recommendation set changed (skipping the unchanged ones
// via the per-row mirror hash). It prints one JSON summary line.
//
// It certifies nothing and creates no new public authority: every playlist it touches
// already exists, minted by its own owner. `refresh_frontier_playlists` is AGENT tier,
// so the box's existing agent-scoped token drives it — NO new secret. Zero LLM tokens.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[frontier-refresh-sweep] ${message}`);

/** The refresh op's summary — the fields we surface. */
type FrontierRefreshSummary = {
  editionOnly?: number;
  failed?: number;
  minted?: number;
  ok?: boolean;
  refreshed?: number;
  skipped?: number;
  switchOff?: boolean;
  total?: number;
  unchanged?: number;
};

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

function isCliErrorPayload(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

// `main` RETURNS its summary and never exits: the process-level exit code is the
// entrypoint's job below. That keeps the sweep importable (frontier-refresh-sweep.test.ts).
export function main(): { ok: boolean } & Record<string, unknown> {
  const summary = {
    editionOnly: 0,
    error: null as null | string,
    failed: 0,
    minted: 0,
    ok: true,
    refreshed: 0,
    skipped: 0,
    switchOff: false,
    total: 0,
    unchanged: 0,
  };

  try {
    const tick = fluncleJson<FrontierRefreshSummary>(["admin", "frontier", "refresh"]);

    summary.total = tick.total ?? 0;
    summary.refreshed = tick.refreshed ?? 0;
    summary.unchanged = tick.unchanged ?? 0;
    summary.minted = tick.minted ?? 0;
    summary.editionOnly = tick.editionOnly ?? 0;
    summary.skipped = tick.skipped ?? 0;
    summary.failed = tick.failed ?? 0;
    summary.switchOff = tick.switchOff ?? false;

    if (summary.switchOff) {
      log(
        `Frontier minting is paused (kill switch closed) — ${summary.editionOnly} edition(s) written, Spotify skipped`,
      );
    } else if (summary.failed > 0) {
      log(`${summary.failed} playlist(s) failed to refresh (best-effort; retried next week)`);
    }
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`frontier refresh sweep failed: ${summary.error}`);
  }

  console.log(JSON.stringify(summary));

  return summary;
}

if (import.meta.main) {
  if (!main().ok) {
    process.exit(1);
  }
}

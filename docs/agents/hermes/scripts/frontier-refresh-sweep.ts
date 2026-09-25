#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[frontier-refresh-sweep] ${message}`);

type FrontierRefreshSummary = {
  budgetPaused?: boolean;
  building?: number;
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

export function buildFrontierSummary(tick: FrontierRefreshSummary): Record<string, unknown> {
  const building = tick.building ?? 0;
  const editionOnly = tick.editionOnly ?? 0;
  const failed = tick.failed ?? 0;
  const minted = tick.minted ?? 0;
  const refreshed = tick.refreshed ?? 0;
  const skipped = tick.skipped ?? 0;
  const unchanged = tick.unchanged ?? 0;

  return {
    budgetPaused: tick.budgetPaused ?? false,
    building,

    checked: failed + building + minted + refreshed + editionOnly + unchanged + skipped,
    editionOnly,
    error: null,
    errors: 0,
    failed,
    minted,
    ok: true,
    produced: minted + refreshed + editionOnly,
    refreshed,
    skipped,
    switchOff: tick.switchOff ?? false,
    total: tick.total ?? 0,
    unchanged,
  };
}

export function buildFrontierFailureSummary(error: unknown): Record<string, unknown> {
  return {
    budgetPaused: null,
    building: null,
    checked: null,
    editionOnly: null,
    error: error instanceof Error ? error.message : String(error),
    errors: 1,
    failed: null,
    minted: null,
    ok: false,
    produced: null,
    refreshed: null,
    skipped: null,
    switchOff: null,
    total: null,
    unchanged: null,
  };
}

export function main(): { ok: boolean } & Record<string, unknown> {
  try {
    const tick = fluncleJson<FrontierRefreshSummary>(["admin", "frontier", "refresh"]);
    const summary = buildFrontierSummary(tick);

    if (tick.switchOff ?? false) {
      log(
        `Frontier minting is paused (kill switch closed) — ${tick.editionOnly ?? 0} edition(s) written, Spotify skipped`,
      );
    } else if (tick.budgetPaused ?? false) {
      log(
        `Spotify budget spent — paused after ${tick.building ?? 0} deferred; the durable cursor resumes next tick`,
      );
    } else if ((tick.failed ?? 0) > 0) {
      log(`${tick.failed ?? 0} playlist(s) failed to refresh (best-effort; retried next tick)`);
    }

    console.log(JSON.stringify(summary));

    return summary as { ok: boolean } & Record<string, unknown>;
  } catch (error) {
    const summary = buildFrontierFailureSummary(error);
    log(`frontier refresh sweep failed: ${String(summary.error)}`);
    console.log(JSON.stringify(summary));

    return summary as { ok: boolean } & Record<string, unknown>;
  }
}

if (import.meta.main) {
  if (!main().ok) {
    process.exit(1);
  }
}

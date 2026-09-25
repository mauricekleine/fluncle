#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  dueWorkRepairPendingGate,
  isDueWorkRepairPending,
  throwIfCliRepairPending,
} from "./due-work-repair-pending";

const BATCH_LIMIT = Number(process.env.FLUNCLE_RECORDING_MBIDS_LIMIT ?? "25");

const ISRC_REFRESH_LIMIT = Number(process.env.FLUNCLE_RECORDING_ISRC_REFRESH_LIMIT ?? "25");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[recording-mbids-sweep] ${message}`);

type RecordingMbidsSummary = {
  failedCount?: number;

  isrcRefreshMissedCount?: number;
  isrcRefreshedCount?: number;

  missedCount?: number;
  ok?: boolean;

  prefixStripped?: number;

  rateLimited?: boolean;
  resolvedCount?: number;
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

  throwIfCliRepairPending(`fluncle ${args.join(" ")}`, code, stdout);

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

export function runRecordingMbidsSweep() {
  const summary = {
    checked: null as number | null,
    error: null as string | null,
    errors: 0,
    failed: 0,

    isrcRefreshMissed: 0,

    isrcRefreshed: 0,

    missed: 0,
    ok: true,

    prefixStripped: 0,
    produced: null as number | null,
    resolved: 0,
    throttled: false,
  };

  try {
    const pass = fluncleJson<RecordingMbidsSummary>([
      "admin",
      "backfills",
      "recording-mbids",
      "--limit",
      String(BATCH_LIMIT),
      "--isrc-refresh-limit",
      String(ISRC_REFRESH_LIMIT),
    ]);

    summary.prefixStripped = pass.prefixStripped ?? 0;
    summary.resolved = pass.resolvedCount ?? 0;
    summary.missed = pass.missedCount ?? 0;
    summary.failed = pass.failedCount ?? 0;
    summary.isrcRefreshed = pass.isrcRefreshedCount ?? 0;
    summary.isrcRefreshMissed = pass.isrcRefreshMissedCount ?? 0;
    summary.throttled = pass.rateLimited ?? false;

    summary.checked =
      summary.prefixStripped +
      summary.resolved +
      summary.missed +
      summary.failed +
      summary.isrcRefreshed +
      summary.isrcRefreshMissed;
    summary.produced =
      summary.prefixStripped +
      summary.resolved +
      summary.missed +
      summary.isrcRefreshed +
      summary.isrcRefreshMissed;

    if (summary.throttled) {
      log("MusicBrainz throttled the pass — stopped clean; the next tick resumes.");
    }
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      log(error.message);
      summary.checked = 0;
      summary.produced = 0;

      return { ...summary, ...dueWorkRepairPendingGate(summary) };
    }

    summary.ok = false;
    summary.errors = 1;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`recording-MBID fill pass failed: ${summary.error}`);
  }

  return summary;
}

export function main(): void {
  const summary = runRecordingMbidsSweep();

  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}

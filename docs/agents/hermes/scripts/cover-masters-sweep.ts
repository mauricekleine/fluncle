#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  dueWorkRepairPendingGate,
  isDueWorkRepairPending,
  throwIfCliRepairPending,
} from "./due-work-repair-pending";

const BATCH_LIMIT = Number(process.env.FLUNCLE_COVER_MASTERS_LIMIT ?? "24");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[cover-masters-sweep] ${message}`);

type CoverMastersSummary = {
  failedCount?: number;
  noneCount?: number;
  ok?: boolean;
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

function drainKind(kind: "album" | "artist"): CoverMastersSummary {
  return fluncleJson<CoverMastersSummary>([
    "admin",
    "backfills",
    "cover-masters",
    "--kind",
    kind,
    "--limit",
    String(BATCH_LIMIT),
  ]);
}

export function main(): { ok: boolean } & Record<string, unknown> {
  const summary = {
    checked: 0,
    error: null as string | null,
    errors: 0,
    failed: 0,
    none: 0,
    ok: true,
    produced: 0,
    resolved: 0,
  };

  let repairPending = false;

  try {
    for (const kind of ["album", "artist"] as const) {
      const pass = drainKind(kind);
      summary.resolved += pass.resolvedCount ?? 0;
      summary.none += pass.noneCount ?? 0;
      summary.failed += pass.failedCount ?? 0;
    }
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      repairPending = true;
      log(error.message);
    } else {
      summary.ok = false;
      summary.errors = 1;
      summary.error = error instanceof Error ? error.message : String(error);
      log(`cover-master resolve pass failed: ${summary.error}`);
    }
  }

  summary.checked = summary.resolved + summary.none + summary.failed;
  summary.produced = summary.resolved + summary.none;

  const line = repairPending ? { ...summary, ...dueWorkRepairPendingGate(summary) } : summary;
  console.log(JSON.stringify(line));

  return line;
}

if (import.meta.main) {
  if (!main().ok) {
    process.exit(1);
  }
}

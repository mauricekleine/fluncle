#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const BATCH_LIMIT = Number(process.env.FLUNCLE_LABEL_LINEAGE_LIMIT ?? "8");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[label-lineage-sweep] ${message}`);

type LabelLineageSummary = {
  failedCount?: number;
  noneCount?: number;
  ok?: boolean;

  rateLimited?: boolean;
  resolvedCount?: number;

  unmatchedParents?: number;
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

export function runLabelLineageSweep() {
  const summary = {
    checked: null as number | null,
    error: null as string | null,
    errors: 0,
    failed: 0,
    none: 0,
    ok: true,
    produced: null as number | null,
    resolved: 0,
    throttled: false,
    unmatchedParents: 0,
  };

  try {
    const pass = fluncleJson<LabelLineageSummary>([
      "admin",
      "backfills",
      "label-lineage",
      "--limit",
      String(BATCH_LIMIT),
    ]);

    summary.resolved = pass.resolvedCount ?? 0;
    summary.none = pass.noneCount ?? 0;
    summary.failed = pass.failedCount ?? 0;
    summary.unmatchedParents = pass.unmatchedParents ?? 0;
    summary.throttled = pass.rateLimited ?? false;

    summary.checked = summary.resolved + summary.none + summary.failed;
    summary.produced = summary.resolved + summary.none;

    if (summary.throttled) {
      log("MusicBrainz throttled the pass — stopped clean; the next tick resumes.");
    }
  } catch (error) {
    summary.ok = false;
    summary.errors = 1;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`label-lineage fill pass failed: ${summary.error}`);
  }

  return summary;
}

export function main(): void {
  const summary = runLabelLineageSweep();

  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}

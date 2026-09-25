#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[reach-sweep] ${message}`);

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

export function main(): { ok: boolean } & Record<string, unknown> {
  const summary = {
    checked: null as null | number,

    empty: null as null | number,
    error: null as null | string,
    errors: 0,

    failed: null as null | number,

    inserted: null as null | number,

    landed: null as null | number,
    ok: true,
    produced: null as null | number,

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

      summary.checked = summary.landed + summary.skipped + summary.failed;
      summary.produced = summary.landed;
    }

    if (tick.ok === false) {
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

if (import.meta.main) {
  if (!main().ok) {
    process.exit(1);
  }
}

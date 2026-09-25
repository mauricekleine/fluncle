#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const RETRY_DELAY_MS = Number(process.env.FLUNCLE_DEMAND_RETRY_DELAY_MS ?? "5000");

const log = (message: string) => console.error(`[demand-sweep] ${message}`);

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

function unwrapSummary(response: RecordDemandResponse): RecordDemandSummary {
  return response.summary ?? response;
}

export function fluncleJson<T>(args: string[]): T {
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

function isCliErrorPayload(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function sleepSync(ms: number): void {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

export type DemandDeps = {
  demand: () => RecordDemandResponse;
  log: (message: string) => void;
  sleep: (ms: number) => void;
};

export function runDemand(deps: DemandDeps): { ok: boolean } & Record<string, unknown> {
  const summary = {
    attempts: 0,
    checked: null as null | number,
    configured: null as boolean | null,
    demandedArtists: 0,
    demandedLabels: 0,
    error: null as null | string,
    errors: 0,
    frontierPromoted: 0,
    ok: true,
    produced: null as null | number,
    tracksScored: 0,
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    summary.attempts = attempt;

    try {
      const tick = unwrapSummary(deps.demand());

      summary.configured = tick.configured ?? null;
      summary.demandedArtists = tick.demandedArtists ?? 0;
      summary.demandedLabels = tick.demandedLabels ?? 0;
      summary.tracksScored = tick.tracksScored ?? 0;
      summary.frontierPromoted = tick.frontierPromoted ?? 0;

      summary.checked = tick.pagesRead ?? 0;
      summary.produced = summary.demandedArtists + summary.demandedLabels;
      summary.error = null;
      summary.errors = 0;
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
        summary.errors = 1;
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

if (import.meta.main) {
  if (!main().ok) {
    process.exit(1);
  }
}

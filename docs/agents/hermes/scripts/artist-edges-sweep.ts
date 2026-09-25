#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  dueWorkRepairPendingGate,
  isDueWorkRepairPending,
  throwIfCliRepairPending,
} from "./due-work-repair-pending";

const BATCH_LIMIT = Number(process.env.FLUNCLE_ARTIST_EDGES_LIMIT ?? "100");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[artist-edges-sweep] ${message}`);

type ArtistEdgesSummary = {
  edgesWritten?: number;

  fullyMatchedCount?: number;
  ok?: boolean;

  partiallyMatchedCount?: number;

  scanned?: number;

  queueDepth?: number;

  unmatchedNames?: number;

  zeroMatchedCount?: number;
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

export function main(): { ok: boolean } & Record<string, unknown> {
  const summary: {
    checked: number;
    edgesWritten: number;
    error: string | null;
    errors: number;
    failed: number;
    fullyMatched: number;
    ok: boolean;
    partiallyMatched: number;
    produced: number;
    queue_depth?: number;
    scanned: number;
    unmatchedNames: number;
    zeroMatched: number;
  } = {
    checked: 0,
    edgesWritten: 0,
    error: null as string | null,
    errors: 0,
    failed: 0,
    fullyMatched: 0,
    ok: true,
    partiallyMatched: 0,
    produced: 0,
    scanned: 0,
    unmatchedNames: 0,
    zeroMatched: 0,
  };

  let repairPending = false;

  try {
    const pass = fluncleJson<ArtistEdgesSummary>([
      "admin",
      "backfills",
      "artist-edges",
      "--limit",
      String(BATCH_LIMIT),
    ]);

    summary.scanned = pass.scanned ?? 0;
    summary.edgesWritten = pass.edgesWritten ?? 0;
    summary.fullyMatched = pass.fullyMatchedCount ?? 0;
    summary.partiallyMatched = pass.partiallyMatchedCount ?? 0;
    summary.zeroMatched = pass.zeroMatchedCount ?? 0;
    summary.unmatchedNames = pass.unmatchedNames ?? 0;

    if (pass.queueDepth !== undefined) {
      summary.queue_depth = pass.queueDepth;
    }
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      repairPending = true;
      log(error.message);
    } else {
      summary.ok = false;
      summary.errors = 1;
      summary.error = error instanceof Error ? error.message : String(error);
      log(`track_artists graph-backfill pass failed: ${summary.error}`);
    }
  }

  summary.checked = summary.scanned;
  summary.produced = summary.scanned;

  const line = repairPending ? { ...summary, ...dueWorkRepairPendingGate(summary) } : summary;
  console.log(JSON.stringify(line));

  return line;
}

if (import.meta.main) {
  if (!main().ok) {
    process.exit(1);
  }
}

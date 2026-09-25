#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  dueWorkRepairPendingGate,
  isDueWorkRepairPending,
  throwIfCliRepairPending,
} from "./due-work-repair-pending";

const BATCH_LIMIT = Number(process.env.FLUNCLE_ARTIST_CREDITS_LIMIT ?? "40");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[artist-credits-sweep] ${message}`);

type ArtistCreditsSummary = {
  adoptedArtists?: number;

  edgesWritten?: number;

  matchedArtists?: number;

  mintedArtists?: number;
  ok?: boolean;

  rateLimited?: boolean;

  scanned?: number;

  skippedNoIdentity?: number;
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

export function main(): void {
  const summary = {
    adoptedArtists: 0,
    checked: 0,
    edgesWritten: 0,
    error: null as string | null,
    errors: 0,
    matchedArtists: 0,
    mintedArtists: 0,
    ok: true,
    produced: 0,
    rateLimited: false,
    scanned: 0,
    skippedNoIdentity: 0,
  };

  try {
    const pass = fluncleJson<ArtistCreditsSummary>([
      "admin",
      "backfills",
      "artist-credits",
      "--limit",
      String(BATCH_LIMIT),
    ]);

    summary.scanned = pass.scanned ?? 0;

    summary.checked = summary.scanned;
    summary.produced = summary.scanned;
    summary.mintedArtists = pass.mintedArtists ?? 0;
    summary.adoptedArtists = pass.adoptedArtists ?? 0;
    summary.matchedArtists = pass.matchedArtists ?? 0;
    summary.edgesWritten = pass.edgesWritten ?? 0;
    summary.skippedNoIdentity = pass.skippedNoIdentity ?? 0;
    summary.rateLimited = pass.rateLimited ?? false;
  } catch (error) {
    if (isDueWorkRepairPending(error)) {
      log(error.message);
      Object.assign(summary, dueWorkRepairPendingGate(summary));
    } else {
      summary.ok = false;
      summary.errors = 1;
      summary.error = error instanceof Error ? error.message : String(error);
      log(`MB credit-sweep pass failed: ${summary.error}`);
    }
  }

  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}

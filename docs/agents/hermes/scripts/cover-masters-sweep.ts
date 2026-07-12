#!/usr/bin/env bun
// cover-masters-sweep.ts — the bun orchestrator behind the `--no-agent` owned-cover-master resolve
// cron (`fluncle-cover-masters`), RFC musickit-second-authority U3b.
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (cover-masters-sweep.sh) the host
// timer execs on a schedule — see that file's header for the wire-up and ../cron/README.md.
//
// THE DURABLE OTHER HALF OF THE ALBUM/ARTIST COVER. The publish path + the catalogue crawl MINT
// albums and artists, each landing at `image_state='pending'`. Nothing owned their cover until
// this sweep: it gives every pending album/artist its OWN ≤1200²-capped cover master in R2
// (found.fluncle.com) instead of hotlinking a third party's bytes. One tick drains a bounded batch
// of BOTH kinds — albums first (Apple template → Cover Art Archive → Spotify floor), then artists
// (Spotify floor) — via the `fluncle` CLI. Same op, on a schedule.
//
// THE WORKER-PACED MODEL (the `fluncle-label-images` shape, verbatim). The Worker fetches each
// source image and stores the ≤1200 master; this driver just PACES it, one small bounded batch per
// kind per tick. The Worker carries the durable per-entity reliability state (`image_state` /
// `image_attempted_at` / `image_failures`) and the ≤1200 cap. It resolves only a cover's IMAGE —
// it certifies nothing and publishes nothing (agent tier, the `backfill_label_images` precedent).
// Zero LLM tokens. Pure HTTP driving.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// A small bounded batch per KIND per tick. The CLI loops the slug cursor internally up to this
// cap (or until the worklist drains); each entity is a single image GET, so the batch can be
// generous and still finish well inside the cron timeout. The publish path/crawl mint only a
// handful of new albums/artists per tick, so an hourly cadence drains with room to spare.
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

// ONE bounded batch of EACH kind. Deliberately not a loop over ticks: the `albums`/`artists`
// worklists ARE the worklist and the timer is the loop. A tick that finds everything resolved/none
// is a cheap no-op.
export function main(): void {
  const summary = {
    error: null as string | null,
    failed: 0,
    none: 0,
    ok: true,
    resolved: 0,
  };

  try {
    for (const kind of ["album", "artist"] as const) {
      const pass = drainKind(kind);
      summary.resolved += pass.resolvedCount ?? 0;
      summary.none += pass.noneCount ?? 0;
      summary.failed += pass.failedCount ?? 0;
    }
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`cover-master resolve pass failed: ${summary.error}`);
  }

  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exit(1);
  }
}

// The cron runs this file directly; the guard keeps importing `fluncleJson` for the tests
// (cover-masters-sweep.test.ts) side-effect free.
if (import.meta.main) {
  main();
}

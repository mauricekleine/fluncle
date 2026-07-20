#!/usr/bin/env bun
// label-releases-sweep.ts — the bun orchestrator behind the `--no-agent` freshness tap cron
// (`fluncle-label-releases`), D8.
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (label-releases-sweep.sh) the host
// timer execs on a schedule — see that file's header for the wire-up and ../cron/README.md.
//
// THE FRESHNESS FEED. The catalogue crawler walks MusicBrainz's graph, but MusicBrainz lags a
// release by ~2 weeks. Spotify has it on day one. So this searches every ENABLED seed label's fresh
// releases on Spotify (`label:"<name>" tag:new`, copyright-filtered), and mints the day-one
// catalogue rows the crawl has not reached yet — closing the lag cliff on /fresh. It certifies
// nothing, publishes nothing, and never widens the graph (no new labels, no artist hops): catalogue
// METADATA only.
//
// THE WORKER-PACED MODEL (the `fluncle-cover-masters` shape, verbatim). The Worker searches each
// label's fresh releases, copyright-filters the albums, and mints the deduped rows; this driver just
// PACES it, ONE bounded probe per tick. The `fluncle` CLI loops passes internally until every enabled
// label is fresh this window (or Spotify throttles). The Worker carries the durable per-label
// reliability state and reuses the publish path's Spotify OAuth. Zero LLM tokens.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// Enabled seed labels probed per PASS. The CLI loops passes internally, so this is just the
// per-pass cap (kept small so one pass stays a trickle on the shared Spotify budget). Env-tunable
// on the box for a one-off wider sweep.
const LABELS_PER_PASS = Number(process.env.FLUNCLE_LABEL_RELEASES_LABELS ?? "5");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[label-releases-sweep] ${message}`);

type LabelReleasesSummary = {
  albumsMatched?: number;
  configured?: boolean;
  failedLabels?: string[];
  labelsProbed?: number;
  newRows?: number;
  ok?: boolean;
  rateLimited?: boolean;
  skippedKnown?: number;
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

function probe(): LabelReleasesSummary {
  return fluncleJson<LabelReleasesSummary>([
    "admin",
    "backfills",
    "label-releases",
    "--limit",
    String(LABELS_PER_PASS),
  ]);
}

// ONE bounded probe per tick (the CLI loops passes internally). Deliberately not a loop over ticks:
// the enabled seed labels ARE the worklist and the daily timer is the loop. A tick that finds every
// label already fresh this window is a cheap no-op. A gone Spotify grant reports `configured:false`
// and this stays a clean success — the tap is a no-op until the operator reconnects Spotify.
export function main(): void {
  const summary = {
    albumsMatched: 0,
    error: null as string | null,
    failedLabels: 0,
    labelsProbed: 0,
    newRows: 0,
    ok: true,
    skippedKnown: 0,
  };

  try {
    const pass = probe();
    summary.labelsProbed = pass.labelsProbed ?? 0;
    summary.albumsMatched = pass.albumsMatched ?? 0;
    summary.newRows = pass.newRows ?? 0;
    summary.skippedKnown = pass.skippedKnown ?? 0;
    summary.failedLabels = pass.failedLabels?.length ?? 0;

    if (pass.configured === false) {
      log(
        "Worker Spotify grant is gone — the freshness tap is a no-op until Spotify is reconnected.",
      );
    }
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`label-releases probe failed: ${summary.error}`);
  }

  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exit(1);
  }
}

// The cron runs this file directly; the guard keeps importing `fluncleJson` for the tests
// (label-releases-sweep.test.ts) side-effect free.
if (import.meta.main) {
  main();
}

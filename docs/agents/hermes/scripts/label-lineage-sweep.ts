#!/usr/bin/env bun
// label-lineage-sweep.ts — the bun orchestrator behind the `--no-agent` label-lineage fill cron
// (`fluncle-label-lineage`), the label entity's LINEAGE half (RFC label-lineage-remixer, U1).
//
// Version-controlled source; the repo is canonical and the box is a deploy target
// (fluncle-hermes-operator skill). Invoked by the bash wrapper (label-lineage-sweep.sh) the host
// timer execs on a schedule — see that file's header for the wire-up and ../cron/README.md for the
// cron model.
//
// WHAT IT DOES. Gives each label its FOUNDING facts + its place in the imprint hierarchy from
// MusicBrainz: `life-span.begin` → `founding_date`, `area.name` → `founded_location`, and the
// `backward` `label ownership` / `imprint` label-rels → `parent_label_id` (matched to an EXISTING
// label by MBID; NEVER minted). A dedicated sweep, because the label-image sweep is terminal per
// label and a logo-resolved label would never get its lineage.
//
// THE WORKER-PACED MODEL (the `fluncle-recording-mbids` shape, verbatim). The box holds no
// MusicBrainz budget; the Worker does. So the walk happens IN THE WORKER — this driver just PACES
// it, one small bounded batch per tick via the `fluncle` CLI. The Worker carries the durable
// per-row reliability state (`lineage_state` / `lineage_attempted_at` / `lineage_failures`), the
// ~1 req/s MusicBrainz gate, and the rate-limit circuit breaker; the driver stays dumb: run one
// bounded batch, ship the summary, let the next tick resume from the durable state. It writes label
// METADATA only — it certifies nothing, mints nothing, publishes nothing. Zero LLM tokens.
//
// stdout: one JSON summary line (the cron run output). Diagnostics → stderr.

import { spawnSync } from "node:child_process";

// 10, not 25: the lineage walk costs ~TWO MusicBrainz requests per label (the lookup + its
// rels) at the shared 1 req/s, so 25 ≈ 50s blew the CLI's HTTP timeout on every tick while
// 10 ≈ 20s clears it comfortably (measured live 2026-07-18). recording-mbids keeps 25 on its
// one-call-per-row math; lineage pays double per row.
const BATCH_LIMIT = Number(process.env.FLUNCLE_LABEL_LINEAGE_LIMIT ?? "10");

const FLUNCLE_BIN = process.env.FLUNCLE_BIN ?? "fluncle";

const log = (message: string) => console.error(`[label-lineage-sweep] ${message}`);

// Only the fields we consume from the label-lineage fill summary.
type LabelLineageSummary = {
  failedCount?: number;
  noneCount?: number;
  ok?: boolean;
  // True when the pass STOPPED on the MusicBrainz rate-limit circuit breaker — a throttled tick,
  // not a drained worklist. Surfaced so the cron output reads honestly.
  rateLimited?: boolean;
  resolvedCount?: number;
  // Backward parent edges MusicBrainz named but no archive label carries by MBID.
  unmatchedParents?: number;
};

// Shell helper — synchronous, fail-loud where it matters. Same contract as the other sweeps: a
// partial batch exits 1 but still prints its JSON summary, and that summary must be RECORDED.
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

// The CLI's own failure payload (`{ code, message, ok: false }`). Distinguishable from a fill
// summary, which carries no `code`/`message` pair and keeps its counts alongside `ok`.
function isCliErrorPayload(value: unknown): value is { code: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

// Main — ONE bounded batch. Deliberately not a loop: the `labels` worklist is the worklist and the
// timer is the loop. A tick that finds every label already walked/attempted is a cheap no-op.
export function main(): void {
  const summary = {
    error: null as string | null,
    failed: 0,
    none: 0,
    ok: true,
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

    if (summary.throttled) {
      log("MusicBrainz throttled the pass — stopped clean; the next tick resumes.");
    }
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
    log(`label-lineage fill pass failed: ${summary.error}`);
  }

  console.log(JSON.stringify(summary));

  if (!summary.ok) {
    process.exit(1);
  }
}

// The cron runs this file directly; the guard keeps importing `fluncleJson` for the tests
// (label-lineage-sweep.test.ts) side-effect free.
if (import.meta.main) {
  main();
}

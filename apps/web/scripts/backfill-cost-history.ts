#!/usr/bin/env bun
/**
 * The one-time COST-01 historical estimate (RFC §7) — IDEMPOTENT, and DELIBERATELY
 * NOT wired into the deploy. It writes `source: "estimated"` rows to the
 * `cost_events` ledger so the operator gets a COMPLETE comparison on day one
 * instead of waiting weeks for a low-volume archive to accumulate. Because it
 * writes to PROD, it is OPERATOR-GATED: a plain run is a DRY RUN (prints what it
 * would write); `--confirm` performs the writes.
 *
 * What is recoverable (the same `count × avg-rate` the ledger sanctions going
 * forward, pointed backward, badged `estimated`):
 *   - Cartesia TTS — every finding with a stored `observation_script` gets a
 *     `cash` characters row (fully recoverable: the exact char count × the rate).
 *   - Render — every finding with a shipped video gets a `subsidized` `self`
 *     seconds row (box-minutes; utilization-only under Decision B, so
 *     `estimated_usd` is NULL — a fixed-plan draw, never cash).
 *   - Enrich / embed — every finding with a BPM / embedding gets a `subsidized`
 *     `self` seconds row (an average per-item duration; utilization-only).
 *
 * What stays "—": pre-instrumentation LLM authoring TOKENS (physically discarded).
 *
 * Idempotent via the SAME deterministic `costEventId` key the live emitters use, so
 * a re-run inserts nothing new (ON CONFLICT(id) DO NOTHING). The `occurredAt` is a
 * STABLE per-finding timestamp (the finding's `added_at`), so the key is stable
 * across runs.
 *
 * Usage:
 *   bun run apps/web/scripts/backfill-cost-history.ts            # dry run (default)
 *   bun run apps/web/scripts/backfill-cost-history.ts --confirm  # write to the DB
 */

import { type CostEventInput } from "@fluncle/contracts/orpc";
import { costEventId, insertCostEvents, resolveEstimatedUsd } from "../src/lib/server/costs";
import { sanitizeForCartesia } from "../src/lib/server/observation";
import { getDb } from "../src/lib/server/db";

// Average per-item durations for the utilization-only (`self`) steps. Coarse but
// honest seeds — the box-minutes/seconds a typical item drew. They only scale a
// column already fenced OUT of the cash total (Decision B), so a rough figure is
// acceptable; retune from real timings once the live capture accumulates.
const AVG_RENDER_SECONDS = 85 * 60; // an ~85-min render (render-detached.sh)
const AVG_ENRICH_SECONDS = 20; // a preview analysis pass
const AVG_EMBED_SECONDS = 8; // one MuQ embedding

type FindingRow = {
  added_at: string;
  bpm: number | null;
  embedding_json: string | null;
  log_id: string;
  observation_script: string | null;
  track_id: string;
  video_url: string | null;
};

function buildEvents(row: FindingRow): CostEventInput[] {
  const events: CostEventInput[] = [];
  // A STABLE per-finding instant so the idempotency key never drifts across runs.
  const occurredAt = row.added_at;
  const base = { logId: row.log_id, occurredAt, trackId: row.track_id };

  // Cartesia TTS — recoverable + priced (cash). The stored script's char count is
  // the exact billable quantity.
  if (row.observation_script?.trim()) {
    events.push({
      ...base,
      costBasis: "cash",
      id: costEventId({ ...base, step: "observe", unitType: "characters", vendor: "cartesia" }),
      quantity: sanitizeForCartesia(row.observation_script).length,
      source: "estimated",
      step: "observe",
      unitType: "characters",
      vendor: "cartesia",
    });
  }

  // Render box-minutes — subsidized/self, utilization-only (estimated_usd NULL).
  if (row.video_url?.trim()) {
    events.push({
      ...base,
      costBasis: "subsidized",
      id: costEventId({ ...base, step: "video", unitType: "seconds", vendor: "self" }),
      quantity: AVG_RENDER_SECONDS,
      source: "estimated",
      step: "video",
      unitType: "seconds",
      vendor: "self",
    });
  }

  // Enrich seconds — subsidized/self (a BPM means the finding was analyzed).
  if (row.bpm !== null) {
    events.push({
      ...base,
      costBasis: "subsidized",
      id: costEventId({ ...base, step: "enrich", unitType: "seconds", vendor: "self" }),
      quantity: AVG_ENRICH_SECONDS,
      source: "estimated",
      step: "enrich",
      unitType: "seconds",
      vendor: "self",
    });
  }

  // Embed seconds — subsidized/self (an embedding_json means the finding was embedded).
  if (row.embedding_json?.trim()) {
    events.push({
      ...base,
      costBasis: "subsidized",
      id: costEventId({ ...base, step: "embed", unitType: "seconds", vendor: "self" }),
      quantity: AVG_EMBED_SECONDS,
      source: "estimated",
      step: "embed",
      unitType: "seconds",
      vendor: "self",
    });
  }

  return events;
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const db = await getDb();

  const result = await db.execute({
    sql: `select tracks.track_id, findings.log_id, findings.added_at,
                 findings.observation_script, findings.video_url, tracks.bpm,
                 tracks.embedding_json
            from findings join tracks on tracks.track_id = findings.track_id
           where findings.log_id is not null`,
  });

  const events: CostEventInput[] = [];

  for (const raw of result.rows) {
    events.push(...buildEvents(raw as unknown as FindingRow));
  }

  const byStep = new Map<string, number>();
  for (const event of events) {
    byStep.set(event.step, (byStep.get(event.step) ?? 0) + 1);
  }

  console.log(`Findings scanned: ${result.rows.length}`);
  console.log(`Estimated cost rows to write: ${events.length}`);
  for (const [step, count] of [...byStep.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${step}: ${count}`);
  }

  const cashRows = events.filter((event) => event.costBasis === "cash");
  const cashUsd = cashRows.reduce((sum, event) => sum + (resolveEstimatedUsd(event) ?? 0), 0);
  console.log(
    `Recoverable CASH (Cartesia TTS): $${cashUsd.toFixed(4)} across ${cashRows.length} rows`,
  );

  if (!confirm) {
    console.log("\nDRY RUN — nothing written. Re-run with --confirm to write to the DB.");
    return;
  }

  // Idempotent: ON CONFLICT(id) DO NOTHING, so a re-run inserts nothing new.
  const inserted = await insertCostEvents(events);
  console.log(`\nWrote ${inserted} new rows (${events.length - inserted} already present).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env bun

import { type CostEventInput } from "@fluncle/contracts/orpc";
import { costEventId, insertCostEvents, resolveEstimatedUsd } from "../src/lib/server/costs";
import { sanitizeForCartesia } from "../src/lib/server/observation";
import { getDb } from "../src/lib/server/db";

const AVG_RENDER_SECONDS = 85 * 60;
const AVG_ENRICH_SECONDS = 20;
const AVG_EMBED_SECONDS = 8;

type FindingRow = {
  added_at: string;
  bpm: number | null;
  has_embedding: number;
  log_id: string;
  observation_script: string | null;
  track_id: string;
  video_url: string | null;
};

export const FINDING_COST_HISTORY_SOURCE_SQL = `select tracks.track_id, findings.log_id,
             findings.added_at, findings.observation_script, findings.video_url, tracks.bpm,
             tracks.has_embedding as has_embedding
        from findings cross join tracks on tracks.track_id = findings.track_id
       where findings.log_id is not null`;

function buildEvents(row: FindingRow): CostEventInput[] {
  const events: CostEventInput[] = [];

  const occurredAt = row.added_at;
  const base = { logId: row.log_id, occurredAt, trackId: row.track_id };

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

  if (row.has_embedding) {
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

  const result = await db.execute({ sql: FINDING_COST_HISTORY_SOURCE_SQL });

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

  const inserted = await insertCostEvents(events);
  console.log(`\nWrote ${inserted} new rows (${events.length - inserted} already present).`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

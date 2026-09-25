#!/usr/bin/env bun

import { $ } from "bun";
import { type Client, createClient } from "@libsql/client/web";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";

const LIST_LIMIT = 50;

type SeedStateSplit = { missing: number; seedState: string; total: number };

type IdentitylessLabel = { name: string; seedState: string; slug: string; trackRows: number };

function asCount(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function countBySeedState(client: Client): Promise<SeedStateSplit[]> {
  const result = await client.execute({
    sql: `select seed_state,
                 count(*) as total,
                 sum(case when mb_label_id is null then 1 else 0 end) as missing
          from labels
          group by seed_state
          order by seed_state`,
  });

  return result.rows.map((row) => ({
    missing: asCount(row["missing"]),
    seedState: asText(row["seed_state"]),
    total: asCount(row["total"]),
  }));
}

async function listIdentitylessLabels(client: Client, limit: number): Promise<IdentitylessLabel[]> {
  const result = await client.execute({
    args: [limit],
    sql: `select l.slug as slug,
                 l.name as name,
                 l.seed_state as seed_state,
                 (select count(*) from tracks t where t.label_id = l.id) as track_rows
          from labels l
          where l.mb_label_id is null
          order by track_rows desc, l.slug
          limit ?`,
  });

  return result.rows.map((row) => ({
    name: asText(row["name"]),
    seedState: asText(row["seed_state"]),
    slug: asText(row["slug"]),
    trackRows: asCount(row["track_rows"]),
  }));
}

const ITEM = process.env.FLUNCLE_TURSO_OP_ITEM;

async function readSecret(field: string): Promise<string> {
  try {
    const value = await $`op read ${`${ITEM}/${field}`}`.text();

    return value.trim();
  } catch {
    throw new Error(
      `Could not read ${field} from 1Password (${ITEM}). Unlock 1Password and enable its CLI integration, then retry.`,
    );
  }
}

export function parseListLimit(argv: string[]): number {
  const raw = argv[0];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : LIST_LIMIT;
}

async function main(): Promise<void> {
  if (!ITEM) {
    throw new Error(
      "Set FLUNCLE_TURSO_OP_ITEM to the 1Password item holding the production Turso credentials — see the ops runbook note.",
    );
  }

  const limit = parseListLimit(process.argv.slice(2));
  const url = await readSecret("TURSO_DATABASE_URL");
  const authToken = await readSecret("TURSO_AUTH_TOKEN");

  const client = createClient({
    authToken,
    concurrency: REMOTE_DB_CONCURRENCY,
    intMode: "bigint",
    url,
  });

  const splits = await countBySeedState(client);
  const rows = await listIdentitylessLabels(client, limit);
  const missing = splits.reduce((sum, split) => sum + split.missing, 0);
  const total = splits.reduce((sum, split) => sum + split.total, 0);

  console.log("Labels with no mb_label_id (read-only, production):\n");

  for (const split of splits) {
    console.log(`  ${split.seedState.padEnd(10)} ${split.missing} of ${split.total}`);
  }

  console.log(`  ${"all".padEnd(10)} ${missing} of ${total}\n`);
  console.log(`Heaviest ${Math.min(limit, rows.length)} by stored tracks:\n`);

  for (const row of rows) {
    console.log(
      `  ${String(row.trackRows).padStart(7)}  ${row.slug.padEnd(40)} ${row.seedState.padEnd(10)} ${row.name}`,
    );
  }

  if (rows.length === 0) {
    console.log("  none — every label carries its MusicBrainz identity.");
  }
}

if (import.meta.main) {
  await main();
}

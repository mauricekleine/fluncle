#!/usr/bin/env bun
/**
 * THE IDENTITY-LESS LABEL READOUT — operator-run, READ-ONLY, by hand. NOT in the deploy chain,
 * and NEVER a write: every statement is a `select`.
 *
 * IT HITS PRODUCTION TURSO. Run it on the operator machine:
 *   `bun run --cwd apps/web scripts/count-labels-without-mbid.ts`
 *
 * Production credentials are never read from `.dev.vars` (in this repo that points at the tiny
 * LOCAL per-worktree dev DB, so it would report a meaningless local count). They are read at run
 * time from 1Password — point `FLUNCLE_TURSO_OP_ITEM` at the item that holds the production Turso
 * credentials (the same var + item `db-pull-prod.ts` and `count-catalogue-public-entities.ts` use)
 * — so `op` must be unlocked, and that biometric unlock IS the human-in-the-loop gate on prod.
 *
 * WHY IT EXISTS. A `labels` row without `mb_label_id` carries no identity: nothing tells it apart
 * from its namesakes (the namesake class, packages/skills/fluncle-catalogue-prune traps), so the
 * operator ruling on it and the research pass preparing that ruling are both guessing, and
 * `reseed-label.ts` refuses it outright. The WRITE paths no longer create such a row
 * (lib/server/labels.ts, `ensureLabel`'s identity gate), but the rows that predate the gate are
 * still there. This is the readout that says how many, in which seed states, and which ones carry
 * enough stored tracks to be worth resolving by hand — the evidence the operator decides on before
 * anybody proposes a `mb_label_id not null` constraint, which those rows would fail.
 *
 * WHAT IT REPORTS:
 *   · the count of identity-less rows per `seed_state`, beside that state's total;
 *   · every identity-less row's slug with its stored-track count (`tracks.label_id`), heaviest
 *     first, so the resolve order is by how much archive hangs off each one.
 *
 * Pass a positive integer to change how many rows the listing shows (default {@link LIST_LIMIT});
 * the counts are always whole-table.
 */
import { $ } from "bun";
import { type Client, createClient } from "@libsql/client/web";
import { REMOTE_DB_CONCURRENCY } from "../src/lib/database-concurrency";

/** How many identity-less rows the listing prints unless the operator asks for more. */
const LIST_LIMIT = 50;

/** One seed state's split between identified and identity-less rows. */
type SeedStateSplit = { missing: number; seedState: string; total: number };

/** One identity-less row, as the listing prints it. */
type IdentitylessLabel = { name: string; seedState: string; slug: string; trackRows: number };

/** Coerce a libSQL scalar count cell (number | bigint) to a JS number. */
function asCount(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

/** Coerce a libSQL TEXT cell to a string — these columns are TEXT, always strings. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The counts, in ONE grouped aggregate over `labels`: per seed state, how many rows there are and
 * how many of them carry no `mb_label_id`. A table scan of the label dimension (tens of thousands
 * of rows at catalogue scale), never a join to `tracks`.
 */
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

/**
 * The listing: identity-less rows with how many stored tracks point at each, heaviest first. The
 * count is a correlated aggregate over the indexed `tracks.label_id` pointer (`tracks_label_id_idx`),
 * one seek per identity-less label rather than a scan of `tracks`, and the outer `limit` bounds how
 * many of those seeks run.
 */
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

/** Read one field of the prod-Turso 1Password item, exactly as `db-pull-prod.ts` does. */
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

/** The listing size: the first positional argument when it is a positive integer, else the default. */
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
  // intMode:"bigint" keeps large catalogue counts exact; `asCount` already narrows bigint → number.
  const client = createClient({
    authToken,
    concurrency: REMOTE_DB_CONCURRENCY,
    intMode: "bigint",
    url,
  });

  // Sequential, so one connection is the whole budget: two reads, and the listing's correlated
  // aggregate is the expensive one — there is nothing to win by overlapping them.
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

#!/usr/bin/env bun
/**
 * One-off back-migration: recover the spoken observation SCRIPT onto the row.
 *
 * Every finding that already has a rendered observation (`observation_audio_url`
 * set) also has its script text in the R2 artifact `<log-id>/observation.json`
 * (field `text`) — but findings rendered before the `observation_script` column
 * existed have a NULL/empty column. This fills them: for each such finding it
 * fetches the public `found.fluncle.com/<log-id>/observation.json`, reads `text`,
 * and writes it to `observation_script` (a QUIET write — it touches no public
 * surface, so it must not move `updated_at`/lastmod; this script writes the column
 * directly and never touches `updated_at`).
 *
 * Idempotent + batched + safe to re-run:
 *   - Only picks rows WHERE observation_audio_url IS NOT NULL
 *       AND (observation_script IS NULL OR trim(observation_script) = '').
 *     A re-run skips everything it already filled.
 *   - Writes one row at a time; a single fetch/parse failure is logged and skipped,
 *     never aborts the batch (re-run to retry the stragglers).
 *
 * Credentials: by default this targets PRODUCTION Turso, read at run time from
 * 1Password (the `Turso Production Credentials` item in the Fluncle vault) exactly
 * like db-pull-prod.ts — so `op` must be unlocked. To target the local worktree DB
 * instead (a dry verification), pass `--local`: it reads TURSO_* from .dev.vars.
 *
 * Flags:
 *   --local       Use the worktree's local .dev.vars DB instead of production.
 *   --dry-run     Read + report what WOULD be written, write nothing.
 *   --limit <n>   Process at most n findings (default: all).
 *
 * Run (from apps/web):
 *   bun run scripts/backfill-observation-script.ts            # production (op unlocked)
 *   bun run scripts/backfill-observation-script.ts --dry-run  # production, no writes
 *   bun run scripts/backfill-observation-script.ts --local    # local worktree DB
 */
import { $ } from "bun";
import { config } from "dotenv";
import { createClient } from "@libsql/client/web";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FOUND_BASE = "https://found.fluncle.com";
const ITEM = "op://Fluncle/Turso Production Credentials";

const args = new Set(process.argv.slice(2));
const useLocal = args.has("--local");
const dryRun = args.has("--dry-run");

function parseLimit(): number {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--limit");

  if (index === -1) {
    return Number.POSITIVE_INFINITY;
  }

  const raw = argv[index + 1];
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--limit needs a positive integer, got ${raw ?? "(nothing)"}`);
  }

  return value;
}

async function readProdSecret(field: string): Promise<string> {
  try {
    const value = await $`op read ${`${ITEM}/${field}`}`.text();

    return value.trim();
  } catch {
    throw new Error(
      `Could not read ${field} from 1Password (${ITEM}). Unlock 1Password and enable its CLI integration, then retry — or pass --local to use the worktree DB.`,
    );
  }
}

async function resolveCredentials(): Promise<{ authToken: string; url: string }> {
  if (useLocal) {
    const configDir = dirname(fileURLToPath(import.meta.url));

    config({ path: join(configDir, "..", ".dev.vars") });

    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url) {
      throw new Error("TURSO_DATABASE_URL is required in apps/web/.dev.vars for --local");
    }

    // A local libSQL dev server typically needs no auth token; default to "".
    return { authToken: authToken ?? "", url };
  }

  const [url, authToken] = await Promise.all([
    readProdSecret("TURSO_DATABASE_URL"),
    readProdSecret("TURSO_AUTH_TOKEN"),
  ]);

  return { authToken, url };
}

type Candidate = { logId: string; trackId: string };

/** The `text` from a finding's R2 observation.json, or null if unreachable/empty. */
async function fetchScript(logId: string): Promise<string | null> {
  const url = `${FOUND_BASE}/${encodeURIComponent(logId)}/observation.json`;

  let response: Response;

  try {
    response = await fetch(url);
  } catch (error) {
    console.warn(`  ! ${logId}: fetch failed (${String(error)})`);

    return null;
  }

  if (!response.ok) {
    console.warn(`  ! ${logId}: ${url} → ${response.status}`);

    return null;
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch (error) {
    console.warn(`  ! ${logId}: invalid JSON (${String(error)})`);

    return null;
  }

  const text =
    typeof payload === "object" && payload !== null
      ? (payload as { text?: unknown }).text
      : undefined;

  if (typeof text !== "string" || !text.trim()) {
    console.warn(`  ! ${logId}: observation.json has no \`text\` field`);

    return null;
  }

  return text.trim();
}

const limit = parseLimit();
const { authToken, url } = await resolveCredentials();
const client = createClient({ authToken, url });

console.log(
  `Backfilling observation_script on ${useLocal ? "LOCAL" : "PRODUCTION"} (${dryRun ? "dry-run" : "writing"})…`,
);

// The findings that have a rendered observation but no stored script yet. Both the
// NULL and the empty-string cases are picked, so a re-run after a partial pass
// finishes the stragglers.
const result = await client.execute(
  `select track_id, log_id from tracks
   where observation_audio_url is not null
     and log_id is not null
     and (observation_script is null or trim(observation_script) = '')
   order by added_at asc`,
);

const candidates: Candidate[] = result.rows
  .map((row) => ({
    logId: (row as Record<string, unknown>).log_id as string,
    trackId: (row as Record<string, unknown>).track_id as string,
  }))
  .slice(0, Number.isFinite(limit) ? limit : undefined);

console.log(`Found ${candidates.length} finding(s) needing a transcript backfill.`);

let written = 0;
let skipped = 0;

for (const { logId, trackId } of candidates) {
  const script = await fetchScript(logId);

  if (script === null) {
    skipped += 1;
    continue;
  }

  if (dryRun) {
    console.log(`  • ${logId}: would write ${script.length} chars`);
    written += 1;
    continue;
  }

  // Quiet write: observation_script ONLY — no updated_at touch (the transcript moves
  // no public surface). Guarded again in SQL so a concurrent run can't double-write.
  await client.execute({
    args: [script, trackId],
    sql: `update tracks set observation_script = ?
          where track_id = ?
            and (observation_script is null or trim(observation_script) = '')`,
  });

  console.log(`  ✓ ${logId}: wrote ${script.length} chars`);
  written += 1;
}

console.log(
  `Done. ${dryRun ? "Would write" : "Wrote"} ${written}, skipped ${skipped} (no recoverable transcript).`,
);

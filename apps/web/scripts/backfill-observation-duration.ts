#!/usr/bin/env bun
/**
 * One-off: recompute `observation_duration_ms` from each finding's stored alignment.
 *
 * Why: the radio segment length IS this duration (radio-schedule.ts), but the
 * `/observe` route used to fall back to the 30s TARGET whenever the box cron didn't
 * pass a probed `durationMs` — which it never does (no ffprobe). So every read was
 * clamped to 30s while real reads run 35–50s, cutting the back third at the seam. The
 * route is fixed forward (it now derives the length from the alignment), but the rows
 * already written carry the wrong 30000. This recomputes them from the truth that is
 * already stored — the alignment's last word — so the existing reads stop being cut.
 * No TTS vendor, no re-render: pure arithmetic over data we already have.
 *
 * Mirrors `observationDurationFromAlignment` in src/lib/server/observation.ts (kept
 * in sync by hand — this script can't import Worker code that pulls `cloudflare:workers`).
 *
 * Production credentials are read at run time from 1Password (the same item
 * `db:pull-prod` uses), so `op` must be unlocked. DRY-RUN by default — prints the diff
 * and writes nothing. Pass `--apply` to commit the UPDATEs.
 */
import { $ } from "bun";
import { createClient } from "@libsql/client/web";

// Keep in sync with OBSERVATION_TAIL_PAD_MS in src/lib/server/observation.ts.
const OBSERVATION_TAIL_PAD_MS = 1200;

const ITEM = "op://Fluncle/Turso Production Credentials";
const APPLY = process.argv.includes("--apply");

async function readSecret(field: string): Promise<string> {
  try {
    return (await $`op read ${`${ITEM}/${field}`}`.text()).trim();
  } catch {
    throw new Error(
      `Could not read ${field} from 1Password (${ITEM}). Unlock 1Password and enable its CLI integration, then retry.`,
    );
  }
}

/** The real length (ms) = the alignment's last word end + the tail pad. */
function durationFromAlignmentJson(json: string): number | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  const words = (parsed as { words?: { endMs?: unknown }[] }).words;

  if (!Array.isArray(words) || words.length === 0) {
    return undefined;
  }

  let lastEndMs = 0;

  for (const word of words) {
    const endMs = typeof word.endMs === "number" ? word.endMs : 0;

    if (endMs > lastEndMs) {
      lastEndMs = endMs;
    }
  }

  return lastEndMs > 0 ? lastEndMs + OBSERVATION_TAIL_PAD_MS : undefined;
}

const url = await readSecret("TURSO_DATABASE_URL");
const authToken = await readSecret("TURSO_AUTH_TOKEN");
const client = createClient({ authToken, url });

const result = await client.execute(
  `SELECT track_id, log_id, observation_duration_ms, observation_alignment_json
     FROM tracks
    WHERE observation_alignment_json IS NOT NULL`,
);

type Change = { logId: string; newMs: number; oldMs: number; trackId: string };
const changes: Change[] = [];
let unchanged = 0;
let unparseable = 0;

for (const row of result.rows) {
  const trackId = row.track_id as string;
  const logId = (row.log_id as string | null) ?? trackId;
  const oldMs = (row.observation_duration_ms as number | null) ?? 0;
  const newMs = durationFromAlignmentJson(row.observation_alignment_json as string);

  if (newMs === undefined) {
    unparseable += 1;
    continue;
  }

  // Only rewrite a meaningful change (guard against churning rows already correct).
  if (Math.abs(newMs - oldMs) < 250) {
    unchanged += 1;
    continue;
  }

  changes.push({ logId, newMs, oldMs, trackId });
}

changes.sort((a, b) => b.newMs - b.oldMs - (a.newMs - a.oldMs));

console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} — observation duration backfill`);
console.log(
  `${result.rows.length} observations · ${changes.length} to fix · ${unchanged} already correct · ${unparseable} no usable alignment\n`,
);

for (const change of changes) {
  const deltaSec = ((change.newMs - change.oldMs) / 1000).toFixed(1);
  console.log(
    `  ${change.logId.padEnd(10)} ${String(change.oldMs).padStart(6)}ms → ${String(change.newMs).padStart(6)}ms  (+${deltaSec}s)`,
  );
}

if (!APPLY) {
  console.log(`\nDry-run only. Re-run with --apply to write these ${changes.length} updates.`);
  process.exit(0);
}

let written = 0;

for (const change of changes) {
  await client.execute({
    args: [change.newMs, change.trackId],
    sql: "UPDATE tracks SET observation_duration_ms = ? WHERE track_id = ?",
  });
  written += 1;
}

console.log(`\nWrote ${written} updates to production.`);

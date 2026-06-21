#!/usr/bin/env bun
/**
 * THROWAWAY one-time migration for the two-master video layout (docs/video-variants.md).
 *
 * Step 1 of the cutover: for every finding that has a video, R2-copy
 * `<log-id>/footage.mp4` → `<log-id>/footage.social.mp4` (no re-render). Today's
 * `footage.mp4` is already exactly the social cut's spec (portrait, baked text,
 * audio), so the social cut is a free server-side rename — the bytes never leave
 * R2 (an S3 `x-amz-copy-source` PUT copies inside the bucket).
 *
 * This does NOT touch `footage.mp4` and does NOT set the `video_squared_at`
 * signal: the copy alone doesn't make `footage.mp4` square. The square is rendered
 * + uploaded per-track later (step 3, the catalogue backfill), which stamps the
 * signal. So after this script the catalogue has a `footage.social.mp4` everywhere
 * but still serves the legacy layout until each square lands.
 *
 * Server-side only, idempotent, best-effort, `--dry-run`. Reads PRODUCTION
 * credentials at run time from 1Password (Turso for the finding list, R2 S3 keys
 * for the copy) — a deliberate, human-in-the-loop step; `op` must be unlocked, and
 * `FLUNCLE_1PASSWORD_ENV_ITEM` must be exported (same item `.dev.vars.tpl` reads
 * the R2 keys from).
 *
 *   bun run scripts/migrate-footage-social.ts --dry-run
 *   bun run scripts/migrate-footage-social.ts
 *
 * DO NOT RUN as part of a build — the orchestrator runs it once, by hand, against
 * the catalogue before the consumer slice deploys.
 */
import { $ } from "bun";
import { createClient } from "@libsql/client/web";
import { AwsClient } from "aws4fetch";

const TURSO_ITEM = "op://Fluncle/Turso Production Credentials";
const BUCKET = "fluncle-videos";
// The R2 account (the literal `.dev.vars.tpl` bakes in); env-overridable.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID?.trim() || "0651fd3b33d9e0b2fe72a5f13e5cf65d";
const dryRun = process.argv.includes("--dry-run");

async function opRead(reference: string): Promise<string> {
  try {
    return (await $`op read ${reference}`.text()).trim();
  } catch {
    throw new Error(
      `Could not read ${reference} from 1Password. Unlock 1Password + enable its CLI integration, then retry.`,
    );
  }
}

const envItem = process.env.FLUNCLE_1PASSWORD_ENV_ITEM?.trim();
if (!envItem) {
  console.error(
    "Missing FLUNCLE_1PASSWORD_ENV_ITEM (the Fluncle env 1Password item path). Export it, then retry.",
  );
  process.exit(1);
}

const log = (message: string) => console.error(`[migrate-footage-social] ${message}`);

// 1. The findings to migrate: every coordinate-bearing finding with a video.
const url = await opRead(`${TURSO_ITEM}/TURSO_DATABASE_URL`);
const authToken = await opRead(`${TURSO_ITEM}/TURSO_AUTH_TOKEN`);
const db = createClient({ authToken, url });
const result = await db.execute(
  "select log_id from tracks where log_id is not null and video_url is not null order by added_at asc",
);
const logIds = result.rows
  .map((row) => (row as { log_id: string | null }).log_id)
  .filter((value): value is string => Boolean(value));
log(`${logIds.length} finding(s) with a video to consider`);

// 2. R2 S3 client (same keys the Worker presigns with; same prod bucket).
const accessKeyId = await opRead(`op://${envItem}/R2_ACCESS_KEY_ID`);
const secretAccessKey = await opRead(`op://${envItem}/R2_SECRET_ACCESS_KEY`);
const client = new AwsClient({
  accessKeyId,
  region: "auto",
  secretAccessKey,
  service: "s3",
});
const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const objectUrl = (key: string): string =>
  `${endpoint}/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;

async function exists(key: string): Promise<boolean> {
  const response = await client.fetch(objectUrl(key), { method: "HEAD" });
  return response.ok;
}

let copied = 0;
let skipped = 0;
let missingSource = 0;
let failed = 0;

for (const logId of logIds) {
  const sourceKey = `${logId}/footage.mp4`;
  const targetKey = `${logId}/footage.social.mp4`;

  try {
    if (await exists(targetKey)) {
      skipped++;
      continue;
    }

    if (!(await exists(sourceKey))) {
      // A row with a video_url whose footage.mp4 didn't survive the trip — log it,
      // never fail the run (best-effort).
      missingSource++;
      log(`no source footage.mp4 for ${logId} — skipping`);
      continue;
    }

    if (dryRun) {
      log(`DRY-RUN would copy ${sourceKey} → ${targetKey}`);
      copied++;
      continue;
    }

    // Server-side copy inside R2: x-amz-copy-source names the source object; the
    // bytes never traverse this script. Preserve the source content type.
    const response = await client.fetch(objectUrl(targetKey), {
      headers: {
        "x-amz-copy-source": `/${BUCKET}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
      },
      method: "PUT",
    });

    if (!response.ok) {
      failed++;
      log(`copy failed for ${logId}: ${response.status} ${response.statusText}`);
      continue;
    }

    copied++;
    log(`copied ${sourceKey} → ${targetKey}`);
  } catch (error) {
    failed++;
    log(`error for ${logId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

log(
  `done${dryRun ? " (DRY-RUN)" : ""}: copied ${copied}, already-present ${skipped}, missing-source ${missingSource}, failed ${failed}`,
);

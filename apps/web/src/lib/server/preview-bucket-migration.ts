// REF-05 — migrate the archived 30s previews off the PUBLIC `fluncle-videos`
// bucket (world-served at found.fluncle.com, a copyright exposure) and into the
// PRIVATE `fluncle-source-audio` bucket, beside each finding's captured full song.
//
//   OLD (public):  analysis/previews/<logId>/<sha256>.<ext>   (VIDEOS binding)
//   NEW (private): <logId>/preview.<ext>                       (SOURCE_AUDIO binding)
//
// This runs Worker-side off the two existing bindings, so it needs NO R2
// credentials. The core is dependency-injected (the buckets + a libSQL client),
// so the whole state machine — hash verification, the copy/delete split, dry-run,
// idempotency — is provable by tests alone against fake buckets + an in-memory DB.
//
// TWO EXPLICITLY-SEPARATE PHASES, never in one pass (a copy and a public delete
// must never ride together — a botched copy would then be an irreversible leak of
// nothing):
//
//   PHASE A — COPY (default, `deletePublic: false`). For each finding still on the
//     legacy `analysis/previews/` prefix: read the public bytes, VERIFY their
//     sha256 equals the hash the old key embeds (a mismatch is skipped, never
//     copied), `put` them into the private bucket, READ THEM BACK and re-verify
//     byte length + sha256, then rewrite `tracks.preview_archive_key` to the new
//     key. The public object is left in place — Phase B removes it. `updated_at`
//     is deliberately NOT bumped (the archive writer avoids it; sitemap/log lastmod
//     tracks visible content only).
//
//   PHASE B — DELETE the public object (`deletePublic: true`). For each finding now
//     on the private scheme, CONFIRM the private copy is present first (a missing
//     private object refuses the delete), reconstruct the old public key from the
//     private bytes' sha256 (the old key embedded that hash — so the reconstruction
//     is exact and free), and delete that public object IF it still exists. A
//     born-private preview (written straight to the private bucket by the new
//     writer, never public) has no such object and is a no-op.
//
// DRY-RUN IS THE DEFAULT: it reports the counts + sample keys and touches nothing.
// BATCHED + RESUMABLE: bounded by `limit`, ordered by `track_id`, returns
// `nextCursor` + `remaining`. IDEMPOTENT: a copied finding leaves the legacy set
// (its key no longer matches the prefix) so a re-run never re-copies it; a deleted
// public object is gone so a re-run's Phase B is a clean no-op.

import { type Client } from "@libsql/client";
import { sha256Hex } from "./hash";

const LEGACY_PREFIX = "analysis/previews/";

// The one method surface the core needs off each binding — narrow STRUCTURAL types
// (not `Pick<R2Bucket, …>`) so the real `env.VIDEOS`/`env.SOURCE_AUDIO` bindings AND
// the test fakes both satisfy them: `get` only needs to yield the bytes + size the
// verification reads, and the write/delete returns are widened to `unknown` so a
// fake returning `void` is as valid as R2's `Promise<R2Object>`.
type R2GetResult = { arrayBuffer(): Promise<ArrayBuffer>; readonly size: number } | null;
type PublicBucket = {
  delete(key: string): Promise<unknown>;
  get(key: string): Promise<R2GetResult>;
};
type PrivateBucket = {
  get(key: string): Promise<R2GetResult>;
  put(
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
};

// Only `.execute` is used (individual guarded statements), so a `Pick` keeps the
// core compatible with BOTH the Worker's `@libsql/client/web` client (from getDb)
// and the node in-memory client the integration test drives.
type MigrationDb = Pick<Client, "execute">;

// A content-type fallback for the private `put` when a legacy row carries no stored
// `preview_archive_mime` (every archive writer set one, but never trust it blindly).
const EXT_CONTENT_TYPE: Record<string, string> = {
  aac: "audio/aac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
};

export type PreviewBucketMigrationInput = {
  cursor?: string;
  db: MigrationDb;
  // Phase select: false (default) copies public → private; true deletes the public
  // object for already-migrated findings. Never both in one call.
  deletePublic?: boolean;
  // Report-only when true (the DEFAULT). No `put`, no `delete`, no DB write.
  dryRun?: boolean;
  limit: number;
  // The PUBLIC bucket the legacy preview lives in (VIDEOS) — read + delete.
  publicBucket: PublicBucket;
  // The PRIVATE bucket the preview moves into (SOURCE_AUDIO) — write + readback.
  privateBucket: PrivateBucket;
};

export type PreviewBucketMigrationResult = {
  copied: Array<{ logId: string; newKey: string; oldKey: string; trackId: string }>;
  copiedCount: number;
  deletePublic: boolean;
  deleted: Array<{ oldKey: string; trackId: string }>;
  deletedCount: number;
  dryRun: boolean;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;
  // The `track_id` to resume from, or null when this batch drained the phase's set.
  nextCursor: string | null;
  // Findings still awaiting this phase beyond `nextCursor` (0 when drained).
  remaining: number;
  skipped: Array<{ reason: string; trackId: string }>;
  skippedCount: number;
};

type LegacyRow = {
  logId: string | null;
  mime: string | null;
  oldKey: string;
  trackId: string;
};

/** Coerce a libSQL scalar cell to text (these columns are TEXT — always strings). */
function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

/** Coerce a libSQL cell to a string, or null (for the nullable `log_id`/mime cells). */
function asTextOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Parse the legacy key `analysis/previews/<logId>/<sha256>.<ext>` into its hash +
 * extension. Returns null for anything that is not a well-formed legacy key (a
 * 64-hex hash and a non-empty extension), so a malformed key is skipped, never
 * mis-migrated.
 */
function parseLegacyKey(key: string): { ext: string; hash: string } | null {
  if (!key.startsWith(LEGACY_PREFIX)) {
    return null;
  }

  const filename = key.slice(key.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");

  if (dot <= 0) {
    return null;
  }

  const hash = filename.slice(0, dot);
  const ext = filename.slice(dot + 1);

  if (!/^[0-9a-f]{64}$/.test(hash) || ext.length === 0) {
    return null;
  }

  return { ext, hash };
}

/** The extension segment of a private key `<logId>/preview.<ext>`, or null. */
function extensionOf(key: string): string | null {
  const dot = key.lastIndexOf(".");

  return dot > 0 && dot < key.length - 1 ? key.slice(dot + 1) : null;
}

/** An empty result envelope for the given phase/mode. */
function emptyResult(deletePublic: boolean, dryRun: boolean): PreviewBucketMigrationResult {
  return {
    copied: [],
    copiedCount: 0,
    deletePublic,
    deleted: [],
    deletedCount: 0,
    dryRun,
    failed: [],
    failedCount: 0,
    nextCursor: null,
    remaining: 0,
    skipped: [],
    skippedCount: 0,
  };
}

/** Count the rows still matching a `where` clause (with bound args). */
async function countBeyond(db: MigrationDb, where: string, args: Array<string>): Promise<number> {
  const result = await db.execute({
    args,
    sql: `select count(*) as n from tracks where ${where}`,
  });

  return Number(result.rows[0]?.n ?? 0);
}

/** Finalize the pagination fields (nextCursor + remaining) after a batch. */
async function paginate(
  db: MigrationDb,
  result: PreviewBucketMigrationResult,
  batchSize: number,
  limit: number,
  lastTrackId: string | null,
  where: string,
): Promise<void> {
  // A full batch means there may be more; a short batch drained the set. A drained
  // phase has nothing to resume and nothing remaining.
  if (batchSize < limit || lastTrackId === null) {
    result.nextCursor = null;
    result.remaining = 0;

    return;
  }

  result.nextCursor = lastTrackId;
  result.remaining = await countBeyond(db, `${where} and track_id > ?`, [lastTrackId]);
}

/**
 * PHASE A — copy each legacy-prefixed preview from the public bucket into the
 * private bucket (hash-verified both ways), then rewrite its DB key. Leaves the
 * public object for Phase B.
 */
async function copyPreviews(
  input: PreviewBucketMigrationInput,
): Promise<PreviewBucketMigrationResult> {
  const { cursor, db, dryRun = true, limit, privateBucket, publicBucket } = input;
  const result = emptyResult(false, dryRun);

  const where = `preview_archive_key like '${LEGACY_PREFIX}%'`;
  const selectArgs: Array<string | number> = cursor ? [cursor, limit] : [limit];
  const rows = await db.execute({
    args: selectArgs,
    sql: `select track_id, log_id, preview_archive_key, preview_archive_mime
          from tracks
          where ${where}${cursor ? " and track_id > ?" : ""}
          order by track_id
          limit ?`,
  });

  const legacyRows: LegacyRow[] = rows.rows.map((row) => ({
    logId: asTextOrNull(row.log_id),
    mime: asTextOrNull(row.preview_archive_mime),
    oldKey: asText(row.preview_archive_key),
    trackId: asText(row.track_id),
  }));

  let lastTrackId: string | null = null;

  for (const row of legacyRows) {
    lastTrackId = row.trackId;
    const parsed = parseLegacyKey(row.oldKey);

    if (!parsed) {
      result.skipped.push({ reason: "unparseable_legacy_key", trackId: row.trackId });
      continue;
    }

    if (!row.logId) {
      result.skipped.push({ reason: "no_log_id", trackId: row.trackId });
      continue;
    }

    const newKey = `${row.logId}/preview.${parsed.ext}`;
    const object = await publicBucket.get(row.oldKey);

    if (!object) {
      result.skipped.push({ reason: "public_object_missing", trackId: row.trackId });
      continue;
    }

    const bytes = await object.arrayBuffer();
    const hash = await sha256Hex(bytes);

    // The old key embeds the sha256 of the bytes — a mismatch means the object is
    // not what the key claims, so NEVER copy it. Skip + report for the operator.
    if (hash !== parsed.hash) {
      result.skipped.push({ reason: "hash_mismatch", trackId: row.trackId });
      continue;
    }

    if (dryRun) {
      result.copied.push({ logId: row.logId, newKey, oldKey: row.oldKey, trackId: row.trackId });
      continue;
    }

    const contentType = row.mime ?? EXT_CONTENT_TYPE[parsed.ext] ?? "application/octet-stream";

    try {
      await privateBucket.put(newKey, bytes, { httpMetadata: { contentType } });

      // READ BACK from the private bucket and re-verify before touching the DB — a
      // silent short write must not be recorded as a successful migration.
      const readback = await privateBucket.get(newKey);

      if (!readback) {
        result.failed.push({ error: "private_readback_absent", trackId: row.trackId });
        continue;
      }

      const readbackBytes = await readback.arrayBuffer();

      if (
        readbackBytes.byteLength !== bytes.byteLength ||
        (await sha256Hex(readbackBytes)) !== hash
      ) {
        result.failed.push({ error: "private_readback_mismatch", trackId: row.trackId });
        continue;
      }

      // Rewrite the pointer, guarded on the old key so a concurrent run can't
      // double-apply. Deliberately DOES NOT bump `updated_at` (matches the archive
      // writer — internal state, not visible content).
      await db.execute({
        args: [newKey, row.trackId, row.oldKey],
        sql: `update tracks set preview_archive_key = ?
              where track_id = ? and preview_archive_key = ?`,
      });

      result.copied.push({ logId: row.logId, newKey, oldKey: row.oldKey, trackId: row.trackId });
    } catch (error) {
      result.failed.push({
        error: error instanceof Error ? error.message : String(error),
        trackId: row.trackId,
      });
    }
  }

  await paginate(db, result, legacyRows.length, limit, lastTrackId, where);
  result.copiedCount = result.copied.length;
  result.skippedCount = result.skipped.length;
  result.failedCount = result.failed.length;

  return result;
}

/**
 * PHASE B — delete the public object for each already-migrated (private-scheme)
 * finding. Refuses to delete unless the private copy is confirmed present; the old
 * public key is reconstructed from the private bytes' sha256 (the old key embedded
 * that hash), so a born-private preview with no public twin is a clean no-op.
 */
async function deletePublicPreviews(
  input: PreviewBucketMigrationInput,
): Promise<PreviewBucketMigrationResult> {
  const { cursor, db, dryRun = true, limit, privateBucket, publicBucket } = input;
  const result = emptyResult(true, dryRun);

  // Private-scheme rows only: a non-null key NOT on the legacy prefix, shaped
  // `<logId>/preview.<ext>`.
  const where = `preview_archive_key is not null
      and preview_archive_key not like '${LEGACY_PREFIX}%'
      and preview_archive_key like '%/preview.%'`;
  const selectArgs: Array<string | number> = cursor ? [cursor, limit] : [limit];
  const rows = await db.execute({
    args: selectArgs,
    sql: `select track_id, log_id, preview_archive_key
          from tracks
          where ${where}${cursor ? " and track_id > ?" : ""}
          order by track_id
          limit ?`,
  });

  const privateRows = rows.rows.map((row) => ({
    logId: asTextOrNull(row.log_id),
    newKey: asText(row.preview_archive_key),
    trackId: asText(row.track_id),
  }));

  let lastTrackId: string | null = null;

  for (const row of privateRows) {
    lastTrackId = row.trackId;

    if (!row.logId) {
      result.skipped.push({ reason: "no_log_id", trackId: row.trackId });
      continue;
    }

    const ext = extensionOf(row.newKey);

    if (!ext) {
      result.skipped.push({ reason: "unparseable_private_key", trackId: row.trackId });
      continue;
    }

    // Confirm the private copy is present BEFORE considering a delete — never delete
    // the public object for a finding whose private copy is missing.
    const privateObject = await privateBucket.get(row.newKey);

    if (!privateObject) {
      result.skipped.push({ reason: "private_copy_absent", trackId: row.trackId });
      continue;
    }

    // Reconstruct the exact old public key from the private bytes' hash (the old key
    // embedded it), so we never need to have retained the old key.
    const privateBytes = await privateObject.arrayBuffer();
    const hash = await sha256Hex(privateBytes);
    const oldKey = `${LEGACY_PREFIX}${row.logId}/${hash}.${ext}`;

    const publicObject = await publicBucket.get(oldKey);

    if (!publicObject) {
      // Born-private (never had a public twin) or already deleted — a clean no-op.
      result.skipped.push({ reason: "public_already_absent", trackId: row.trackId });
      continue;
    }

    if (dryRun) {
      result.deleted.push({ oldKey, trackId: row.trackId });
      continue;
    }

    try {
      await publicBucket.delete(oldKey);
      result.deleted.push({ oldKey, trackId: row.trackId });
    } catch (error) {
      result.failed.push({
        error: error instanceof Error ? error.message : String(error),
        trackId: row.trackId,
      });
    }
  }

  await paginate(db, result, privateRows.length, limit, lastTrackId, where);
  result.deletedCount = result.deleted.length;
  result.skippedCount = result.skipped.length;
  result.failedCount = result.failed.length;

  return result;
}

/**
 * Run one bounded pass of the preview-bucket migration. Copies by default; deletes
 * the public object when `deletePublic` is set. Dry-run (report-only) by default.
 */
export async function migratePreviewArchive(
  input: PreviewBucketMigrationInput,
): Promise<PreviewBucketMigrationResult> {
  return input.deletePublic ? deletePublicPreviews(input) : copyPreviews(input);
}

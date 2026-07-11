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
// idempotency, the prefix sweep — is provable by tests alone against fake buckets
// + an in-memory DB.
//
// THREE modes (`mode`), never overlapping:
//
//   "copy" (default) — for each finding still on the legacy `analysis/previews/`
//     prefix: read the public bytes, VERIFY their sha256 equals the hash the old
//     key embeds (a mismatch is skipped, never copied), `put` them into the private
//     bucket, READ THEM BACK and re-verify byte length + sha256, then rewrite
//     `tracks.preview_archive_key`. The public object is LEFT for the delete sweep.
//     `updated_at` is deliberately NOT bumped (the archive writer avoids it).
//     Batched by DB `track_id` cursor.
//
//   "delete" — the PUBLIC-PREFIX SWEEP. This is authoritative over the PREFIX, not
//     over the DB rows: the old archive writer only ever `put`, never deleted a
//     superseded object, so re-archiving a finding whose bytes differed left the
//     prior `analysis/previews/<logId>/<oldHash>.<ext>` ORPHANED in the public
//     bucket, referenced by no row. A row-driven delete cannot see those. So this
//     mode (a) REFUSES entirely while ANY legacy-prefixed DB row is still uncopied
//     (finish "copy" first), then (b) `list`s the public bucket under
//     `analysis/previews/` and deletes EVERY object there — but only after
//     confirming the finding (`<logId>`) has a PRESENT private copy. An object whose
//     logId has no private copy is SKIPPED and reported loudly (`private_copy_absent`),
//     never deleted. Batched by the R2 `list` cursor.
//
//   "verify" — READ-ONLY proof. `list`s `analysis/previews/` and returns the object
//     count (`remaining`) + a sample of keys (`sampleKeys`). Mutates nothing. This is
//     the operator's proof the prefix is empty BEFORE and AFTER the CDN purge.
//
// DRY-RUN IS THE DEFAULT for "copy"/"delete": reports the counts + sample keys and
// touches nothing. IDEMPOTENT: a copied finding leaves the legacy set; a deleted
// object is gone so a re-swept page is a clean no-op.

import { type Client } from "@libsql/client";
import { sha256Hex } from "./hash";

const LEGACY_PREFIX = "analysis/previews/";
// Bound as a SQL PARAMETER (never interpolated) — the repo parameterizes its
// queries, and this keeps the pattern injection-proof by construction.
const LEGACY_LIKE = `${LEGACY_PREFIX}%`;

// The audio extensions an archived preview can carry — used to find a finding's
// private copy when a superseded orphan's extension differs from the current one
// (a re-resolve from a different source can change the container).
const PRIVATE_EXTS = ["mp3", "m4a", "aac"] as const;

// R2 `list` returns at most 1000 keys per page; the sweep never asks for more.
const R2_LIST_MAX = 1000;

export type MigrationMode = "copy" | "delete" | "verify";

// The narrow STRUCTURAL bucket surfaces the core needs (not `Pick<R2Bucket, …>`) so
// the real `env.VIDEOS`/`env.SOURCE_AUDIO` bindings AND the test fakes both satisfy
// them: `get` only needs to yield the bytes + size the verification reads, `list`
// the keys + cursor, and the write/delete returns are widened to `unknown` so a fake
// returning `void` is as valid as R2's `Promise<R2Object>`.
type R2GetResult = { arrayBuffer(): Promise<ArrayBuffer>; readonly size: number } | null;
type R2ListResult = { cursor?: string; objects: Array<{ key: string }>; truncated: boolean };
type PublicBucket = {
  delete(key: string): Promise<unknown>;
  get(key: string): Promise<R2GetResult>;
  list(options: { cursor?: string; limit?: number; prefix: string }): Promise<R2ListResult>;
};
type PrivateBucket = {
  get(key: string): Promise<R2GetResult>;
  // Metadata-only existence probe (R2 `head` fetches no body). The sweep's presence
  // check never reads the bytes — it only needs to know a private copy EXISTS — so it
  // uses `head`, not a full `get`, to keep each probe a single cheap round-trip.
  head(key: string): Promise<{ readonly size: number } | null>;
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
  // Report-only when true (the DEFAULT). No `put`, no `delete`, no DB write.
  dryRun?: boolean;
  limit: number;
  // Phase select: "copy" (default) public → private; "delete" the public-prefix
  // sweep; "verify" the read-only prefix count.
  mode?: MigrationMode;
  publicBucket: PublicBucket;
  privateBucket: PrivateBucket;
};

export type PreviewBucketMigrationResult = {
  // Non-null when the phase REFUSED to run (e.g. the delete sweep with legacy rows
  // still uncopied); the reason string. When set, no listing/mutation happened.
  blocked: string | null;
  copied: Array<{ logId: string; newKey: string; oldKey: string; trackId: string }>;
  copiedCount: number;
  // For "delete": each deleted (or, in dry-run, would-delete) public object. The
  // `trackId` carries the finding's `logId` here (the sweep is object-driven).
  deleted: Array<{ oldKey: string; trackId: string }>;
  deletedCount: number;
  dryRun: boolean;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;
  mode: MigrationMode;
  // The resume cursor — the DB `track_id` for "copy", the R2 `list` cursor for
  // "delete" — or null when this phase's set is drained. Always null for "verify".
  nextCursor: string | null;
  // "copy": legacy DB rows still to copy beyond the cursor. "delete"/"verify": the
  // AUTHORITATIVE count of objects still under `analysis/previews/` (from the LIST).
  remaining: number;
  // "verify": a sample of the keys still under the prefix (the operator's proof).
  sampleKeys: string[];
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

/**
 * Parse a PUBLIC object key `analysis/previews/<logId>/<file>.<ext>` into its
 * `logId` + extension. Unlike `parseLegacyKey` this does NOT require a 64-hex hash:
 * ANY object under the prefix is a legacy public preview that must not exist, so the
 * sweep parses it as long as it has a `<logId>/<file>.<ext>` shape.
 */
function parsePublicKey(key: string): { ext: string; logId: string } | null {
  if (!key.startsWith(LEGACY_PREFIX)) {
    return null;
  }

  const rest = key.slice(LEGACY_PREFIX.length);
  const slash = rest.indexOf("/");

  if (slash <= 0) {
    return null;
  }

  const logId = rest.slice(0, slash);
  const filename = rest.slice(slash + 1);
  const dot = filename.lastIndexOf(".");

  if (dot <= 0) {
    return null;
  }

  const ext = filename.slice(dot + 1);

  if (ext.length === 0) {
    return null;
  }

  return { ext, logId };
}

/** An empty result envelope for the given mode/dry-run. */
function emptyResult(mode: MigrationMode, dryRun: boolean): PreviewBucketMigrationResult {
  return {
    blocked: null,
    copied: [],
    copiedCount: 0,
    deleted: [],
    deletedCount: 0,
    dryRun,
    failed: [],
    failedCount: 0,
    mode,
    nextCursor: null,
    remaining: 0,
    sampleKeys: [],
    skipped: [],
    skippedCount: 0,
  };
}

/** Count the legacy-prefixed DB rows (optionally only those beyond a cursor). */
async function countLegacyRows(db: MigrationDb, afterCursor?: string): Promise<number> {
  const result = await db.execute({
    args: afterCursor === undefined ? [LEGACY_LIKE] : [LEGACY_LIKE, afterCursor],
    sql: `select count(*) as n from findings join tracks on tracks.track_id = findings.track_id
          where tracks.preview_archive_key like ?${
            afterCursor === undefined ? "" : " and tracks.track_id > ?"
          }`,
  });

  return Number(result.rows[0]?.n ?? 0);
}

/**
 * Count every object currently under `analysis/previews/` (keys only — no bodies),
 * paginating the R2 `list` cursor to the end. Cheap (metadata) and authoritative;
 * used for the `verify` count and the `delete` sweep's post-batch `remaining`. An
 * optional `sample` collects the first N keys for `verify`'s operator proof.
 */
async function countPrefix(
  publicBucket: PublicBucket,
  sample?: { max: number },
): Promise<{ count: number; sampleKeys: string[] }> {
  let count = 0;
  const sampleKeys: string[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await publicBucket.list({ cursor, limit: R2_LIST_MAX, prefix: LEGACY_PREFIX });
    count += page.objects.length;

    if (sample) {
      for (const object of page.objects) {
        if (sampleKeys.length < sample.max) {
          sampleKeys.push(object.key);
        }
      }
    }

    if (!page.truncated || !page.cursor) {
      break;
    }

    cursor = page.cursor;
  }

  return { count, sampleKeys };
}

// How many objects' private-copy presence to probe at once. The old sweep did a
// serial `get` per candidate extension, per object (up to 4 round-trips × every
// object in a page), which timed the Worker out at the default page size. Probing
// in bounded-concurrency chunks keeps the fan-out fast without unbounding it.
const PRESENCE_CONCURRENCY = 10;

/**
 * Whether a finding has a PRESENT private preview copy, tolerant of a container
 * change between a superseded orphan and the current preview: probe the orphan's own
 * extension AND the other known audio extensions. Each probe is a metadata-only
 * `head` (never a body-reading `get`) and they run CONCURRENTLY (`Promise.all`) — the
 * check only needs truthiness, so it fans the whole unique-extension set out at once.
 */
async function hasPrivateCopy(
  privateBucket: PrivateBucket,
  logId: string,
  preferredExt: string,
): Promise<boolean> {
  const exts = [...new Set([preferredExt, ...PRIVATE_EXTS])];
  const heads = await Promise.all(exts.map((ext) => privateBucket.head(`${logId}/preview.${ext}`)));

  return heads.some((head) => head !== null);
}

/**
 * "copy" — copy each legacy-prefixed preview from the public bucket into the private
 * bucket (hash-verified both ways), then rewrite its DB key. Leaves the public
 * object for the "delete" sweep.
 */
async function copyPreviews(
  input: PreviewBucketMigrationInput,
): Promise<PreviewBucketMigrationResult> {
  const { cursor, db, dryRun = true, limit, privateBucket, publicBucket } = input;
  const result = emptyResult("copy", dryRun);

  const rows = await db.execute({
    args: cursor === undefined ? [LEGACY_LIKE, limit] : [LEGACY_LIKE, cursor, limit],
    sql: `select tracks.track_id, findings.log_id, tracks.preview_archive_key,
                 tracks.preview_archive_mime
          from findings join tracks on tracks.track_id = findings.track_id
          where tracks.preview_archive_key like ?${
            cursor === undefined ? "" : " and tracks.track_id > ?"
          }
          order by tracks.track_id
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

  // A full batch means there may be more; a short batch drained the set.
  if (legacyRows.length < limit || lastTrackId === null) {
    result.nextCursor = null;
    result.remaining = 0;
  } else {
    result.nextCursor = lastTrackId;
    result.remaining = await countLegacyRows(db, lastTrackId);
  }

  result.copiedCount = result.copied.length;
  result.skippedCount = result.skipped.length;
  result.failedCount = result.failed.length;

  return result;
}

/**
 * "delete" — the PUBLIC-PREFIX SWEEP. Refuses while any legacy DB row is still
 * uncopied, then lists one page under `analysis/previews/` and deletes every object
 * whose finding has a present private copy; an object with no private copy is
 * skipped + reported (`private_copy_absent`), never deleted. `remaining` is the
 * authoritative count still under the prefix (from the LIST), NOT a row count.
 */
async function sweepPublicPrefix(
  input: PreviewBucketMigrationInput,
): Promise<PreviewBucketMigrationResult> {
  const { cursor, db, dryRun = true, limit, privateBucket, publicBucket } = input;
  const result = emptyResult("delete", dryRun);

  // REFUSAL GATE — never delete a public object while any finding is still on the
  // legacy prefix (its private copy is not yet guaranteed). Finish "copy" first.
  const legacyRows = await countLegacyRows(db);

  if (legacyRows > 0) {
    result.blocked = "legacy_rows_uncopied";
    result.remaining = legacyRows;

    return result;
  }

  const page = await publicBucket.list({
    cursor,
    limit: Math.min(limit, R2_LIST_MAX),
    prefix: LEGACY_PREFIX,
  });

  // Parse each object once, then resolve every finding's private-copy PRESENCE in
  // bounded-concurrency chunks — the safety gate that delete a public object ONLY
  // when its finding has a present private copy (a true orphan, a superseded hash,
  // resolves to the finding's CURRENT private copy, the correct "migrated" signal).
  // A serial probe-per-object here timed the Worker out at the default page size.
  // The array stays PAGE-ORDERED so `deleted`/`skipped`/`failed` are deterministic.
  const parsedObjects = page.objects.map((object) => ({
    key: object.key,
    parsed: parsePublicKey(object.key),
  }));
  const present: boolean[] = Array.from({ length: parsedObjects.length }, () => false);

  for (let start = 0; start < parsedObjects.length; start += PRESENCE_CONCURRENCY) {
    const chunk = parsedObjects.slice(start, start + PRESENCE_CONCURRENCY);
    const probed = await Promise.all(
      chunk.map((entry) =>
        entry.parsed === null
          ? Promise.resolve(false)
          : hasPrivateCopy(privateBucket, entry.parsed.logId, entry.parsed.ext),
      ),
    );

    for (let index = 0; index < probed.length; index += 1) {
      present[start + index] = probed[index] ?? false;
    }
  }

  for (let index = 0; index < parsedObjects.length; index += 1) {
    const entry = parsedObjects[index];

    if (!entry) {
      continue;
    }

    if (entry.parsed === null) {
      result.skipped.push({ reason: "unparseable_public_key", trackId: entry.key });
      continue;
    }

    if (present[index] !== true) {
      result.skipped.push({ reason: "private_copy_absent", trackId: entry.parsed.logId });
      continue;
    }

    if (dryRun) {
      result.deleted.push({ oldKey: entry.key, trackId: entry.parsed.logId });
      continue;
    }

    try {
      await publicBucket.delete(entry.key);
      result.deleted.push({ oldKey: entry.key, trackId: entry.parsed.logId });
    } catch (error) {
      result.failed.push({
        error: error instanceof Error ? error.message : String(error),
        trackId: entry.parsed.logId,
      });
    }
  }

  result.nextCursor = page.truncated && page.cursor ? page.cursor : null;
  // Authoritative remaining: re-walk the WHOLE prefix (keys only) via countPrefix
  // after this batch. Acceptable because the prefix SHRINKS as the sweep deletes, so
  // the recount converges to 0 across successive batches rather than growing work.
  result.remaining = (await countPrefix(publicBucket)).count;
  result.deletedCount = result.deleted.length;
  result.skippedCount = result.skipped.length;
  result.failedCount = result.failed.length;

  return result;
}

/**
 * "verify" — READ-ONLY proof: count every object still under `analysis/previews/`
 * and return a sample of keys. Mutates nothing. The operator's before/after proof
 * around the CDN purge.
 */
async function verifyPrefix(
  input: PreviewBucketMigrationInput,
): Promise<PreviewBucketMigrationResult> {
  const result = emptyResult("verify", true);
  const { count, sampleKeys } = await countPrefix(input.publicBucket, { max: 20 });
  result.remaining = count;
  result.sampleKeys = sampleKeys;

  return result;
}

/**
 * Run one bounded pass of the preview-bucket migration in the requested `mode`
 * ("copy" by default). Dry-run (report-only) by default for the mutating modes.
 */
export async function migratePreviewArchive(
  input: PreviewBucketMigrationInput,
): Promise<PreviewBucketMigrationResult> {
  if (input.mode === "verify") {
    return verifyPrefix(input);
  }

  if (input.mode === "delete") {
    return sweepPublicPrefix(input);
  }

  return copyPreviews(input);
}

import { type Client } from "@libsql/client";
import { sha256Hex } from "./hash";

const LEGACY_PREFIX = "analysis/previews/";

const LEGACY_LIKE = `${LEGACY_PREFIX}%`;

const PRIVATE_EXTS = ["mp3", "m4a", "aac"] as const;

const R2_LIST_MAX = 1000;

export type MigrationMode = "copy" | "delete" | "verify";

type R2GetResult = { arrayBuffer(): Promise<ArrayBuffer>; readonly size: number } | null;
type R2ListResult = { cursor?: string; objects: Array<{ key: string }>; truncated: boolean };
type PublicBucket = {
  delete(key: string): Promise<unknown>;
  get(key: string): Promise<R2GetResult>;
  list(options: { cursor?: string; limit?: number; prefix: string }): Promise<R2ListResult>;
};
type PrivateBucket = {
  get(key: string): Promise<R2GetResult>;

  head(key: string): Promise<{ readonly size: number } | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
};

type MigrationDb = Pick<Client, "execute">;

const EXT_CONTENT_TYPE: Record<string, string> = {
  aac: "audio/aac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
};

export type PreviewBucketMigrationInput = {
  cursor?: string;
  db: MigrationDb;

  dryRun?: boolean;
  limit: number;

  mode?: MigrationMode;
  publicBucket: PublicBucket;
  privateBucket: PrivateBucket;
};

export type PreviewBucketMigrationResult = {
  blocked: string | null;
  copied: Array<{ logId: string; newKey: string; oldKey: string; trackId: string }>;
  copiedCount: number;

  deleted: Array<{ oldKey: string; trackId: string }>;
  deletedCount: number;
  dryRun: boolean;
  failed: Array<{ error: string; trackId: string }>;
  failedCount: number;
  mode: MigrationMode;

  nextCursor: string | null;

  remaining: number;

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

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

function asTextOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

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

const PRESENCE_CONCURRENCY = 10;

async function hasPrivateCopy(
  privateBucket: PrivateBucket,
  logId: string,
  preferredExt: string,
): Promise<boolean> {
  const exts = [...new Set([preferredExt, ...PRIVATE_EXTS])];
  const heads = await Promise.all(exts.map((ext) => privateBucket.head(`${logId}/preview.${ext}`)));

  return heads.some((head) => head !== null);
}

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

async function sweepPublicPrefix(
  input: PreviewBucketMigrationInput,
): Promise<PreviewBucketMigrationResult> {
  const { cursor, db, dryRun = true, limit, privateBucket, publicBucket } = input;
  const result = emptyResult("delete", dryRun);

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

  result.remaining = (await countPrefix(publicBucket)).count;
  result.deletedCount = result.deleted.length;
  result.skippedCount = result.skipped.length;
  result.failedCount = result.failed.length;

  return result;
}

async function verifyPrefix(
  input: PreviewBucketMigrationInput,
): Promise<PreviewBucketMigrationResult> {
  const result = emptyResult("verify", true);
  const { count, sampleKeys } = await countPrefix(input.publicBucket, { max: 20 });
  result.remaining = count;
  result.sampleKeys = sampleKeys;

  return result;
}

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

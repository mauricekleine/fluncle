import { getDb } from "./db";
import { ApiError } from "./spotify";

export type PreviewArchiveTrack = {
  logId?: string;
  trackId: string;
};

export type PreviewArchiveInput = {
  bucket: Pick<R2Bucket, "put">;
  bytes: ArrayBuffer;
  mime: string;
  now?: Date;
  source: string;
  track: PreviewArchiveTrack;
};

export type PreviewArchiveMetadata = {
  archivedAt: string;
  key: string;
  mime: string;
  source: string;
};

type DbClient = Awaited<ReturnType<typeof getDb>>;

type ArchiveRow = {
  log_id: string | null;
  preview_archive_key: string | null;
  preview_archive_mime: string | null;
  preview_archive_source: string | null;
  preview_archived_at: string | null;
  track_id: string;
};

const mimeToExtension: Record<string, string> = {
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/x-m4a": "m4a",
};

export function normalizePreviewMime(value: string): string | undefined {
  const mime = value.split(";")[0]?.trim().toLowerCase();

  if (!mime) {
    return undefined;
  }

  if (mime === "audio/mpeg" || mime === "audio/mp3") {
    return "audio/mpeg";
  }

  if (mime === "audio/mp4" || mime === "audio/x-m4a" || mime === "audio/m4a") {
    return "audio/mp4";
  }

  if (mime === "audio/aac") {
    return "audio/aac";
  }

  return undefined;
}

export function previewExtensionForMime(mime: string): string {
  const normalized = normalizePreviewMime(mime);

  if (!normalized) {
    throw new ApiError("invalid_preview_mime", `Unsupported preview MIME type: ${mime}`, 400);
  }

  return mimeToExtension[normalized] ?? "bin";
}

export async function buildPreviewArchiveKey({
  bytes,
  logId,
  mime,
}: {
  bytes: ArrayBuffer;
  logId: string;
  mime: string;
}): Promise<string> {
  const hash = await sha256Hex(bytes);
  const extension = previewExtensionForMime(mime);

  return `analysis/previews/${logId}/${hash}.${extension}`;
}

export async function archivePreviewForTrack(
  input: PreviewArchiveInput,
  db?: DbClient,
): Promise<PreviewArchiveMetadata> {
  const client = db ?? (await getDb());
  const logId = input.track.logId?.trim();

  if (!logId) {
    throw new ApiError(
      "no_log_id",
      "Track has no Log ID; every operator-only archive path needs a coordinate.",
      400,
    );
  }

  const source = input.source.trim().slice(0, 80);

  if (!source) {
    throw new ApiError("invalid_preview_source", "preview source must be a non-empty string", 400);
  }

  const mime = normalizePreviewMime(input.mime);

  if (!mime) {
    throw new ApiError("invalid_preview_mime", `Unsupported preview MIME type: ${input.mime}`, 400);
  }

  if (input.bytes.byteLength === 0) {
    throw new ApiError("empty_preview", "preview archive upload was empty", 400);
  }

  const key = await buildPreviewArchiveKey({ bytes: input.bytes, logId, mime });
  const archivedAt = (input.now ?? new Date()).toISOString();

  await input.bucket.put(key, input.bytes, {
    httpMetadata: { contentType: mime },
  });

  // Operator-only archive metadata is internal analysis state. Do not bump
  // updated_at: public sitemap/log lastmod should reflect visible content only.
  await client.execute({
    args: [key, source, mime, archivedAt, input.track.trackId],
    sql: `update tracks
      set preview_archive_key = ?,
          preview_archive_source = ?,
          preview_archive_mime = ?,
          preview_archived_at = ?
      where track_id = ?`,
  });

  return { archivedAt, key, mime, source };
}

export async function getPreviewArchiveMetadata(
  idOrLogId: string,
): Promise<(PreviewArchiveMetadata & { logId?: string; trackId: string }) | undefined> {
  const db = await getDb();
  const result = await db.execute({
    args: [idOrLogId, idOrLogId],
    sql: `select track_id, log_id, preview_archive_key, preview_archive_source,
            preview_archive_mime, preview_archived_at
          from tracks
          where track_id = ? or log_id = ?
          limit 1`,
  });
  const row = result.rows[0] as unknown as ArchiveRow | undefined;

  if (!row) {
    return undefined;
  }

  if (
    !row.preview_archive_key ||
    !row.preview_archive_source ||
    !row.preview_archive_mime ||
    !row.preview_archived_at
  ) {
    return {
      archivedAt: "",
      key: "",
      logId: row.log_id ?? undefined,
      mime: "",
      source: "",
      trackId: row.track_id,
    };
  }

  return {
    archivedAt: row.preview_archived_at,
    key: row.preview_archive_key,
    logId: row.log_id ?? undefined,
    mime: row.preview_archive_mime,
    source: row.preview_archive_source,
    trackId: row.track_id,
  };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

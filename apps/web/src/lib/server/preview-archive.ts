import { getDb, typedRow } from "./db";
import { ApiError } from "./spotify";

type PreviewArchiveTrack = {
  logId?: string;
  trackId: string;
};

export type PreviewArchiveInput = {
  bucket: Pick<R2Bucket, "delete" | "put">;
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

// Every extension the archive can write. When a re-archive changes the extension
// (e.g. an mp3 replaced by an m4a), the `<logId>/preview.<ext>` key overwrites in
// place for the SAME extension but strands the old sibling — so after a successful
// put we sweep the other-extension siblings for this finding.
const knownPreviewExtensions = ["aac", "bin", "m4a", "mp3"] as const;

function normalizePreviewMime(value: string): string | undefined {
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

function previewExtensionForMime(mime: string): string {
  const normalized = normalizePreviewMime(mime);

  if (!normalized) {
    throw new ApiError("invalid_preview_mime", `Unsupported preview MIME type: ${mime}`, 400);
  }

  return mimeToExtension[normalized] ?? "bin";
}

/**
 * The ceiling for a preview-archive body. A 30s clip at a generous 320kbps is ~1.2MB; a full
 * song is 5-10MB+. 3MB cleanly separates them, so this rejects a full song without ever
 * rejecting a legitimate high-bitrate preview.
 */
const PREVIEW_MAX_BYTES = 3_000_000;

// The archived preview lives beside the finding's full song in the PRIVATE
// source-audio bucket, at a stable per-finding key. `preview` cannot collide with
// a full-song filename (a 64-hex sha256), and dropping the content hash means a
// re-archive overwrites in place instead of orphaning the previous object.
export function buildPreviewArchiveKey({ logId, mime }: { logId: string; mime: string }): string {
  const extension = previewExtensionForMime(mime);

  return `${logId}/preview.${extension}`;
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

  // ENFORCE the rail rather than merely documenting it: this slot holds ONE official 30s
  // preview, never a full song (audio-source policy — captured full audio is internal-only
  // and lives in the private source-audio bucket under `source_audio_key`). A full song is
  // an order of magnitude larger than any 30s clip: at a generous 320kbps a 30s preview is
  // ~1.2MB, so anything past PREVIEW_MAX_BYTES is not a preview. Reject loudly — the analyzer
  // that fed this was pointed at the wrong audio, and a silently-archived full song is
  // indistinguishable from a real preview once it lands.
  if (input.bytes.byteLength > PREVIEW_MAX_BYTES) {
    throw new ApiError(
      "preview_too_large",
      `preview archive is ${(input.bytes.byteLength / 1_000_000).toFixed(1)}MB — the slot takes a 30s preview (max ${PREVIEW_MAX_BYTES / 1_000_000}MB), never a full song. Captured full audio belongs in the private source-audio bucket, not here.`,
      400,
    );
  }

  const key = buildPreviewArchiveKey({ logId, mime });
  const extension = previewExtensionForMime(mime);
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

  // Sweep stale siblings LAST — the DB must never point at an object we've deleted.
  // The key no longer carries a content hash, so a same-extension re-archive overwrites
  // in place, but a changed extension would strand the old `<logId>/preview.<other-ext>`
  // object. Deleting only AFTER the DB commit means: a failed put/DB-write leaves the row
  // pointing at an object that still exists (recoverable), and a failed sweep only leaves
  // a harmless orphan the next archive cleans up. Never delete the extension we just wrote.
  const staleSiblings = knownPreviewExtensions
    .filter((ext) => ext !== extension)
    .map((ext) => `${logId}/preview.${ext}`);

  await Promise.all(staleSiblings.map((siblingKey) => input.bucket.delete(siblingKey)));

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
  const row = typedRow<ArchiveRow>(result.rows);

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

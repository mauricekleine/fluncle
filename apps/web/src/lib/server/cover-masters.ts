import { appleArtworkUrl } from "./apple-music";
import { getDb, typedRows } from "./db";
import { markDueWorkSourceMaintenanceFromSelectStatements } from "./due-work";
import { isDueWorkCutoverEnabled, readPromotedDueWorkPage } from "./due-work-cutover";
import { encodeDueWorkOrder } from "./due-work-order";
import { logEvent } from "./log";
import { albumCoverAtSize } from "../media";

export type CoverMasterKind = "album" | "artist";

const MAX_BATCH = 24;

const COOLDOWN_MS = 6 * 60 * 60 * 1000;

const MAX_FAILURES = 5;

export const OWNED_MASTER_MAX_PX = 1200;

const OWNED_MASTER_CACHE_CONTROL = "public, max-age=604800, immutable";

const MAX_IMAGE_BYTES = 5_000_000;

const MIME_EXTENSION: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function extensionForMime(mime: string): string {
  return MIME_EXTENSION[mime] ?? "img";
}

export function coverMasterKey(kind: CoverMasterKind, slug: string, mime: string): string {
  const prefix = kind === "album" ? "albums" : "artists";

  return `${prefix}/${slug}.${extensionForMime(mime)}`;
}

export function readImageSize(bytes: ArrayBuffer): { height: number; width: number } | undefined {
  const view = new DataView(bytes);
  const len = view.byteLength;

  if (len < 24) {
    return undefined;
  }

  if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    return { height: view.getUint32(20), width: view.getUint32(16) };
  }

  if (view.getUint32(0) === 0x47494638) {
    return { height: view.getUint16(8, true), width: view.getUint16(6, true) };
  }

  if (view.getUint16(0) === 0xffd8) {
    let offset = 2;

    while (offset + 9 < len) {
      if (view.getUint8(offset) !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = view.getUint8(offset + 1);

      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }

      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }

      offset += 2 + view.getUint16(offset + 2);
    }

    return undefined;
  }

  if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const fourcc = view.getUint32(12);

    if (fourcc === 0x56503820 && len >= 30) {
      return {
        height: view.getUint16(28, true) & 0x3fff,
        width: view.getUint16(26, true) & 0x3fff,
      };
    }

    if (fourcc === 0x5650384c && len >= 25) {
      const b0 = view.getUint8(21);
      const b1 = view.getUint8(22);
      const b2 = view.getUint8(23);
      const b3 = view.getUint8(24);

      return {
        height: ((((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6)) & 0x3fff) + 1,
        width: ((((b1 & 0x3f) << 8) | b0) & 0x3fff) + 1,
      };
    }

    if (fourcc === 0x56503858 && len >= 30) {
      const w = view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16);
      const h = view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16);

      return { height: h + 1, width: w + 1 };
    }
  }

  return undefined;
}

type FetchedImage = { bytes: ArrayBuffer; mime: string };

export async function downloadCappedImage(url: string): Promise<FetchedImage | undefined> {
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status >= 500 || response.status === 429) {
      throw new Error(`transient source error ${response.status} from ${new URL(url).hostname}`);
    }

    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.startsWith("image/")) {
    return undefined;
  }

  const bytes = await response.arrayBuffer();

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    return undefined;
  }

  const size = readImageSize(bytes);

  if (size && Math.max(size.width, size.height) > OWNED_MASTER_MAX_PX) {
    return undefined;
  }

  return { bytes, mime: contentType.split(";")[0]?.trim() || "image/jpeg" };
}

export function appleCoverMasterUrl(
  template: string | null,
  width: number | null,
  height: number | null,
): string | undefined {
  if (!template || !width || !height || width <= 0 || height <= 0) {
    return undefined;
  }

  return appleArtworkUrl(
    { height, urlTemplate: template, width },
    OWNED_MASTER_MAX_PX,
    OWNED_MASTER_MAX_PX,
  );
}

const CAA_URL_RE = /^https?:\/\/coverartarchive\.org\/release\/[^/]+\/front(?:-\d+)?$/i;
const SPOTIFY_IMAGE_HOST = "https://i.scdn.co/image/";

export function caaCoverMasterUrl(coverUrl: string | null): string | undefined {
  if (!coverUrl || !CAA_URL_RE.test(coverUrl)) {
    return undefined;
  }

  return coverUrl.replace(/\/front(?:-\d+)?$/i, "/front-1200");
}

export function spotifyCoverMasterUrl(imageUrl: string | null): string | undefined {
  if (!imageUrl || !imageUrl.startsWith(SPOTIFY_IMAGE_HOST)) {
    return undefined;
  }

  return albumCoverAtSize(imageUrl, "large");
}

export type CoverMasterSource = "apple" | "coverart" | "spotify";

type ResolveOutcome =
  | { imageKey: string; kind: "resolved"; source: CoverMasterSource }
  | { kind: "none" }
  | { error: string; kind: "failed" };

export type CoverMastersResult = {
  dryRun: boolean;

  kind: CoverMasterKind;

  requeued: string[];
  requeuedCount: number;

  resolved: string[];
  resolvedCount: number;

  none: string[];
  noneCount: number;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;

  nextCursor: string | null;

  rateLimited: boolean;
};

type AlbumWorkRow = {
  artwork_height: number | null;
  artwork_url_template: string | null;
  artwork_width: number | null;

  cover_url: string | null;
  image_failures: number;
  slug: string;
};

type ArtistWorkRow = {
  image_failures: number;
  image_url: string | null;
  slug: string;
};

function coverMasterContinuation(
  cursor: string | undefined,
): { sortKey: string; subjectId: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  return {
    sortKey: encodeDueWorkOrder([{ direction: "asc", kind: "text", value: cursor }]),
    subjectId: cursor,
  };
}

function restoreCoverMasterOrder<Row extends { slug: string }>(
  rows: Row[],
  subjectIds: readonly string[],
): Row[] {
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  return subjectIds.flatMap((slug) => {
    const row = bySlug.get(slug);
    return row === undefined ? [] : [row];
  });
}

async function listProjectedAlbums(
  limit: number,
  cursor: string | undefined,
): Promise<AlbumWorkRow[]> {
  const db = await getDb();
  const page = await readPromotedDueWorkPage(db, "album.cover-master", {
    continuation: coverMasterContinuation(cursor),
    limit,
  });

  if (page.subjectIds.length === 0) {
    return [];
  }

  const placeholders = page.subjectIds.map(() => "?").join(", ");
  const cover = `(select t.album_image_url from tracks t
                   where t.album_id = albums.id and t.album_image_url is not null limit 1) as cover_url`;
  const result = await db.execute({
    args: page.subjectIds,
    sql: `select slug, artwork_url_template, artwork_width, artwork_height, image_failures, ${cover}
          from albums
          where slug in (${placeholders})`,
  });

  return restoreCoverMasterOrder(typedRows<AlbumWorkRow>(result.rows), page.subjectIds);
}

async function listProjectedArtists(
  limit: number,
  cursor: string | undefined,
): Promise<ArtistWorkRow[]> {
  const db = await getDb();
  const page = await readPromotedDueWorkPage(db, "artist.cover-master", {
    continuation: coverMasterContinuation(cursor),
    limit,
  });

  if (page.subjectIds.length === 0) {
    return [];
  }

  const placeholders = page.subjectIds.map(() => "?").join(", ");
  const result = await db.execute({
    args: page.subjectIds,
    sql: `select slug, image_url, image_failures
          from artists
          where slug in (${placeholders})`,
  });

  return restoreCoverMasterOrder(typedRows<ArtistWorkRow>(result.rows), page.subjectIds);
}

async function listPendingAlbums(
  limit: number,
  cursor: string | undefined,
): Promise<AlbumWorkRow[]> {
  const db = await getDb();
  const cooldownBefore = new Date(Date.now() - COOLDOWN_MS).toISOString();
  const cover = `(select t.album_image_url from tracks t
                   where t.album_id = albums.id and t.album_image_url is not null limit 1) as cover_url`;

  const result = await db.execute({
    args: cursor ? [cooldownBefore, cursor, limit] : [cooldownBefore, limit],
    sql: cursor
      ? `select slug, artwork_url_template, artwork_width, artwork_height, image_failures, ${cover}
         from albums
         where image_state = 'pending'
           and (image_attempted_at is null or image_attempted_at < ?)
           and slug > ?
         order by slug asc limit ?`
      : `select slug, artwork_url_template, artwork_width, artwork_height, image_failures, ${cover}
         from albums
         where image_state = 'pending'
           and (image_attempted_at is null or image_attempted_at < ?)
         order by slug asc limit ?`,
  });

  return typedRows<AlbumWorkRow>(result.rows);
}

async function listPendingArtists(
  limit: number,
  cursor: string | undefined,
): Promise<ArtistWorkRow[]> {
  const db = await getDb();
  const cooldownBefore = new Date(Date.now() - COOLDOWN_MS).toISOString();

  const result = await db.execute({
    args: cursor ? [cooldownBefore, cursor, limit] : [cooldownBefore, limit],
    sql: cursor
      ? `select slug, image_url, image_failures
         from artists
         where image_state = 'pending' and image_url is not null
           and (image_attempted_at is null or image_attempted_at < ?)
           and slug > ?
         order by slug asc limit ?`
      : `select slug, image_url, image_failures
         from artists
         where image_state = 'pending' and image_url is not null
           and (image_attempted_at is null or image_attempted_at < ?)
         order by slug asc limit ?`,
  });

  return typedRows<ArtistWorkRow>(result.rows);
}

async function markResolved(
  kind: CoverMasterKind,
  slug: string,
  imageKey: string,
  source: CoverMasterSource,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const table = kind === "album" ? "albums" : "artists";

  await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        kind,
        {
          args: [slug],
          sql: `select id as subject_id from ${table} where slug = ?`,
        },
        { producer: "cover-master-resolved" },
      ),
      {
        args: [imageKey, source, now, now, now, slug],
        sql: `update ${table}
              set image_key = ?, image_source = ?, image_state = 'resolved', image_failures = 0,
                  image_attempted_at = ?, image_updated_at = ?, updated_at = ?
              where slug = ?`,
      },
    ],
    "write",
  );
}

async function markNone(kind: CoverMasterKind, slug: string): Promise<void> {
  const db = await getDb();
  const table = kind === "album" ? "albums" : "artists";

  await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        kind,
        {
          args: [slug],
          sql: `select id as subject_id from ${table} where slug = ?`,
        },
        { producer: "cover-master-none" },
      ),
      {
        args: [new Date().toISOString(), slug],
        sql: `update ${table}
              set image_state = 'none', image_failures = 0, image_attempted_at = ?
              where slug = ?`,
      },
    ],
    "write",
  );
}

async function recordFailure(
  kind: CoverMasterKind,
  slug: string,
  priorFailures: number,
): Promise<void> {
  const db = await getDb();
  const table = kind === "album" ? "albums" : "artists";
  const failures = priorFailures + 1;
  const giveUp = failures >= MAX_FAILURES;

  await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        kind,
        {
          args: [slug],
          sql: `select id as subject_id from ${table} where slug = ?`,
        },
        { producer: "cover-master-failure" },
      ),
      {
        args: [failures, giveUp ? "none" : "pending", new Date().toISOString(), slug],
        sql: `update ${table}
              set image_failures = ?, image_state = ?, image_attempted_at = ?
              where slug = ?`,
      },
    ],
    "write",
  );
}

async function requeueTerminalNone(
  kind: CoverMasterKind,
  limit: number,
  dryRun: boolean,
): Promise<string[]> {
  const db = await getDb();
  const table = kind === "album" ? "albums" : "artists";

  const selected = await db.execute({
    args: [limit],
    sql: `select slug from ${table}
          where image_state = 'none'
          order by slug asc limit ?`,
  });
  const slugs = typedRows<{ slug: string }>(selected.rows).map((row) => row.slug);

  if (dryRun || slugs.length === 0) {
    return slugs;
  }

  const placeholders = slugs.map(() => "?").join(", ");

  await db.batch(
    [
      ...markDueWorkSourceMaintenanceFromSelectStatements(
        kind,
        {
          args: slugs,
          sql: `select id as subject_id from ${table} where slug in (${placeholders})`,
        },
        { producer: "cover-master-requeue" },
      ),
      {
        args: slugs,
        sql: `update ${table}
              set image_state = 'pending', image_failures = 0, image_attempted_at = null
              where slug in (${placeholders})`,
      },
    ],
    "write",
  );
  logEvent("info", "cover-masters.requeued", { count: slugs.length, kind });

  return slugs;
}

async function storeMaster(
  bucket: Pick<R2Bucket, "put">,
  kind: CoverMasterKind,
  slug: string,
  image: FetchedImage,
): Promise<string> {
  const key = coverMasterKey(kind, slug, image.mime);

  await bucket.put(key, image.bytes, {
    httpMetadata: { cacheControl: OWNED_MASTER_CACHE_CONTROL, contentType: image.mime },
  });

  return key;
}

async function tryRung(
  bucket: Pick<R2Bucket, "put">,
  kind: CoverMasterKind,
  slug: string,
  url: string | undefined,
  source: CoverMasterSource,
): Promise<ResolveOutcome | undefined> {
  if (!url) {
    return undefined;
  }

  const image = await downloadCappedImage(url);

  if (!image) {
    return undefined;
  }

  const imageKey = await storeMaster(bucket, kind, slug, image);

  return { imageKey, kind: "resolved", source };
}

async function resolveOneAlbum(
  row: AlbumWorkRow,
  bucket: Pick<R2Bucket, "put">,
): Promise<ResolveOutcome> {
  try {
    return (
      (await tryRung(
        bucket,
        "album",
        row.slug,
        appleCoverMasterUrl(row.artwork_url_template, row.artwork_width, row.artwork_height),
        "apple",
      )) ??
      (await tryRung(bucket, "album", row.slug, caaCoverMasterUrl(row.cover_url), "coverart")) ??
      (await tryRung(
        bucket,
        "album",
        row.slug,
        spotifyCoverMasterUrl(row.cover_url),
        "spotify",
      )) ?? {
        kind: "none",
      }
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: "failed" };
  }
}

async function resolveOneArtist(
  row: ArtistWorkRow,
  bucket: Pick<R2Bucket, "put">,
): Promise<ResolveOutcome> {
  try {
    return (
      (await tryRung(
        bucket,
        "artist",
        row.slug,
        spotifyCoverMasterUrl(row.image_url),
        "spotify",
      )) ?? {
        kind: "none",
      }
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: "failed" };
  }
}

export async function resolveCoverMasters(
  bucket: Pick<R2Bucket, "put">,
  kind: CoverMasterKind,
  limit: number,
  dryRun: boolean,
  cursor?: string,
  retryNone = false,
): Promise<CoverMastersResult> {
  const batchLimit = Math.max(1, Math.min(limit, MAX_BATCH));
  let requeued: string[] = [];
  let rows: AlbumWorkRow[] | ArtistWorkRow[];

  if (retryNone) {
    requeued = await requeueTerminalNone(kind, batchLimit, dryRun);
    rows =
      kind === "album"
        ? await listPendingAlbums(batchLimit, cursor)
        : await listPendingArtists(batchLimit, cursor);
  } else if (await isDueWorkCutoverEnabled()) {
    rows =
      kind === "album"
        ? await listProjectedAlbums(batchLimit, cursor)
        : await listProjectedArtists(batchLimit, cursor);
  } else {
    rows =
      kind === "album"
        ? await listPendingAlbums(batchLimit, cursor)
        : await listPendingArtists(batchLimit, cursor);
  }

  const resolved: string[] = [];
  const none: string[] = [];
  const failed: Array<{ error: string; slug: string }> = [];

  if (dryRun) {
    for (const row of rows) {
      resolved.push(row.slug);
    }
  } else {
    for (const row of rows) {
      const outcome =
        kind === "album"
          ? await resolveOneAlbum(row as AlbumWorkRow, bucket)
          : await resolveOneArtist(row as ArtistWorkRow, bucket);

      if (outcome.kind === "resolved") {
        await markResolved(kind, row.slug, outcome.imageKey, outcome.source);
        logEvent("info", "cover-masters.resolved", {
          imageKey: outcome.imageKey,
          kind,
          slug: row.slug,
          source: outcome.source,
        });
        resolved.push(row.slug);
        continue;
      }

      if (outcome.kind === "none") {
        await markNone(kind, row.slug);
        none.push(row.slug);
        continue;
      }

      await recordFailure(kind, row.slug, row.image_failures);
      failed.push({ error: outcome.error, slug: row.slug });
    }
  }

  const lastSlug = rows.at(-1)?.slug ?? null;
  const nextCursor = rows.length < batchLimit ? null : lastSlug;

  return {
    dryRun,
    failed,
    failedCount: failed.length,
    kind,
    nextCursor,
    none,
    noneCount: none.length,
    rateLimited: false,
    requeued,
    requeuedCount: requeued.length,
    resolved,
    resolvedCount: resolved.length,
  };
}

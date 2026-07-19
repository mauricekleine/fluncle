// The owned-cover-master resolve sweep (RFC musickit-second-authority, U3b): give every ALBUM
// and every ARTIST its OWN 1200²-capped cover derivative in our R2 (found.fluncle.com), instead
// of hotlinking a third party's bytes forever. The `labels` image-state-machine, cloned onto two
// more entities and generalised over a `kind`, so both drain through one op, one CLI leg, and one
// box cron.
//
// ── THE SOURCE LADDER (per decision A) ────────────────────────────────────────────────────────
//   ALBUM:
//     1. Apple's STORED artwork template (`albums.artwork_url_template`, written by U1) —
//        substituted to ≤1200 on its longest side (native-clamped by `appleArtworkUrl`). Apple's
//        `{w}x{h}` template serves the requested size directly, so THE SUBSTITUTION IS THE
//        DOWNSCALE: no local resize, and the 3000² original is never fetched or stored (the
//        REF-05 line). `image_source = 'apple'`.
//     2. Cover Art Archive by MB release — the crawler stores a `coverartarchive.org/.../front-500`
//        URL on catalogue rows; we request `front-1200` (CAA's own ≤1200 thumbnail). `'coverart'`.
//     3. Spotify's 640 — the stored `tracks.album_image_url` (i.scdn.co) at its largest prefix.
//        The floor. `'spotify'`.
//   ARTIST:
//     1. Spotify's largest profile image (the stored `artists.image_url`). The floor and, today,
//        the only rung (an Apple artist-artwork template is the future higher-res source decision
//        A leaves room for). `'spotify'`.
//
// Every rung requests a size-controlled (≤1200) rendition from the source, so a stored master is
// ≤1200 by construction; a byte-level dimension read (`readImageSize`) is the belt-and-suspenders
// that REJECTS anything larger before the R2 put (the decision-A cap, made structural — no code
// path can write an un-downscaled original). The 3000² Apple original stays render-time-only
// (U3a's `artworkMaxUrl`), never persisted.
//
// ── WORKER-PACED, IDEMPOTENT, SELF-DRAINING (the `label-images.ts` discipline, verbatim) ───────
// One bounded, slug-cursored pass per tick over the `pending` worklist. Per-entity reliability
// lives on the row (`image_state`/`image_attempted_at`/`image_failures`): a resolved/none entity
// is terminal and skipped forever; a transient failure backs off on a cooldown and retries; a
// persistent one gives up (→ `none`, the raw-URL floor). Idempotent by construction — a second
// run over a fully-resolved archive fetches nothing. Served via Cloudflare Images (media.ts).

import { appleArtworkUrl } from "./apple-music";
import { getDb, typedRows } from "./db";
import { logEvent } from "./log";
import { albumCoverAtSize } from "../media";

/** The two entities that own a cover master. Albums have a 3-rung ladder; artists have one. */
export type CoverMasterKind = "album" | "artist";

// One bounded pass handles at most this many eligible rows. Each row is a single image GET
// against a public CDN (Apple/CAA/Spotify artwork — NOT a rate-limited metadata vendor), so the
// cap can be generous; the crawler mints only a handful of new albums/artists per tick, so the
// worklist drains in a couple of hourly ticks and a full-archive pass is a cheap no-op.
const MAX_BATCH = 24;

// An entity attempted within this window is skipped (the cooldown floor between two attempts on
// the SAME row). Only a `pending` row that hit a transient failure ever carries a recent
// `image_attempted_at`; a resolved/none row is terminal and excluded regardless.
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

// After this many consecutive failures a row GIVES UP (→ `image_state = 'none'`, the raw-URL
// floor), so a persistently-failing entity is never retried forever.
const MAX_FAILURES = 5;

// The decision-A cap: a stored master is ≤ this on its longest side. Every source is REQUESTED at
// this size, and a byte read enforces it before the put — the two together make "no un-downscaled
// original in R2" structural rather than aspirational.
export const OWNED_MASTER_MAX_PX = 1200;

// The owned master caches hard at the edge (a cover rarely changes; a re-resolve only happens on
// a deliberate operator reset), like every other found asset. The `?v=<image_updated_at>` bust
// (media.ts) re-keys the Cloudflare Images rendition when the bytes DO change.
const OWNED_MASTER_CACHE_CONTROL = "public, max-age=604800, immutable";

// Cap a downloaded image (mirrors the label-logo ceiling) — protects the isolate from a rogue
// multi-MB source before the dimension read even runs.
const MAX_IMAGE_BYTES = 5_000_000;

// content-type → file extension for the R2 key. Unknown image types get a neutral extension.
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

/** The R2 key an entity's owned cover master is stored at (world-readable, found.fluncle.com). */
export function coverMasterKey(kind: CoverMasterKind, slug: string, mime: string): string {
  const prefix = kind === "album" ? "albums" : "artists";

  return `${prefix}/${slug}.${extensionForMime(mime)}`;
}

// ── The ≤1200 dimension guard (structural cap enforcement) ─────────────────────────────────────

/**
 * Read an image's intrinsic pixel size from its header bytes, for the common raster formats our
 * sources emit (JPEG/PNG/GIF/WebP). Returns undefined for an unrecognised container — in which
 * case the caller TRUSTS the requested size (every rung asks the source for a ≤1200 rendition, so
 * a parse miss cannot smuggle a 3000² original through: the URL is the primary guard, this is the
 * verification). Pure and synchronous — no allocation beyond a DataView over the passed buffer.
 */
export function readImageSize(bytes: ArrayBuffer): { height: number; width: number } | undefined {
  const view = new DataView(bytes);
  const len = view.byteLength;

  if (len < 24) {
    return undefined;
  }

  // PNG — 89 50 4E 47 0D 0A 1A 0A, then the IHDR chunk (width u32 BE @16, height @20).
  if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    return { height: view.getUint32(20), width: view.getUint32(16) };
  }

  // GIF — "GIF8", then logical-screen width/height as u16 LITTLE-endian @6/@8.
  if (view.getUint32(0) === 0x47494638) {
    return { height: view.getUint16(8, true), width: view.getUint16(6, true) };
  }

  // JPEG — FF D8, then scan the marker segments for a Start-Of-Frame (SOFn) that carries dims.
  if (view.getUint16(0) === 0xffd8) {
    let offset = 2;

    while (offset + 9 < len) {
      if (view.getUint8(offset) !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = view.getUint8(offset + 1);

      // SOF0..SOF15 carry frame dims, EXCEPT DHT(C4)/JPG(C8)/DAC(CC) which are not frames.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }

      // Standalone markers (RSTn/SOI/EOI) carry no length; everything else does (u16 @+2).
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }

      offset += 2 + view.getUint16(offset + 2);
    }

    return undefined;
  }

  // WebP — "RIFF"...."WEBP", then a VP8/VP8L/VP8X chunk.
  if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const fourcc = view.getUint32(12);

    if (fourcc === 0x56503820 && len >= 30) {
      // "VP8 " (lossy): 14-bit width/height (LE) at 26/28, masked to drop the scale bits.
      return {
        height: view.getUint16(28, true) & 0x3fff,
        width: view.getUint16(26, true) & 0x3fff,
      };
    }

    if (fourcc === 0x5650384c && len >= 25) {
      // "VP8L" (lossless): 14-bit dims packed into 4 bytes at offset 21 (LE), each minus one.
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
      // "VP8X" (extended): 24-bit canvas width-1 @24 and height-1 @27, both LE.
      const w = view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16);
      const h = view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16);

      return { height: h + 1, width: w + 1 };
    }
  }

  return undefined;
}

/** The bytes + mime of a fetched image, once it has cleared the cap. */
type FetchedImage = { bytes: ArrayBuffer; mime: string };

/**
 * Download a ≤1200-requested source URL → its bytes + mime, or undefined on any miss (non-image,
 * empty, oversized bytes, oversized DIMENSIONS, or a non-OK response). The dimension rejection is
 * the structural cap: a source that returns something larger than we asked never reaches R2.
 */
export async function downloadCappedImage(url: string): Promise<FetchedImage | undefined> {
  const response = await fetch(url);

  if (!response.ok) {
    // A retryable status is an OUTAGE, not an answer: during the 2026-07-19 archive.org 503 wave
    // every walked CAA-only album fell through this `undefined` into terminal `none` — a transient
    // outage converted into a permanent give-up. Throw instead, so the caller's catch lands the
    // row `failed` (cooldown + retry, give-up only past MAX_FAILURES). A 404 stays a definitive
    // miss: the source genuinely has no cover.
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

  // The decision-A cap, enforced on the bytes. A parse miss (undefined) trusts the requested
  // size; a parse HIT larger than the cap is rejected — no un-downscaled original is ever stored.
  if (size && Math.max(size.width, size.height) > OWNED_MASTER_MAX_PX) {
    return undefined;
  }

  return { bytes, mime: contentType.split(";")[0]?.trim() || "image/jpeg" };
}

// ── The source-URL builders (each requests a ≤1200 rendition — the downscale is the URL) ────────

/**
 * Apple's stored `{w}x{h}` template substituted to ≤1200 on its longest side. `appleArtworkUrl`
 * clamps to the artwork's native size, so a smaller original is never upscaled and a 3000²
 * original is downscaled BY APPLE (the elegant, no-local-resize path). Undefined when the album
 * carries no template or its stored dimensions are unusable.
 */
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

/**
 * Upgrade a stored Cover Art Archive front-cover URL to its ≤1200 thumbnail (`front-1200`), or
 * undefined when the URL is not a CAA front cover. CAA's own resizer serves ≤1200, so this is a
 * source-side downscale with no local resize.
 */
export function caaCoverMasterUrl(coverUrl: string | null): string | undefined {
  if (!coverUrl || !CAA_URL_RE.test(coverUrl)) {
    return undefined;
  }

  return coverUrl.replace(/\/front(?:-\d+)?$/i, "/front-1200");
}

/**
 * A stored Spotify album-art (or artist-avatar) URL at its LARGEST rendition (640, `i.scdn.co`
 * prefix swap). Undefined when the URL is not a Spotify image. `albumCoverAtSize` is the
 * pure prefix-swap already used across the app; 640 ≤ 1200 so the cap holds trivially.
 */
export function spotifyCoverMasterUrl(imageUrl: string | null): string | undefined {
  if (!imageUrl || !imageUrl.startsWith(SPOTIFY_IMAGE_HOST)) {
    return undefined;
  }

  return albumCoverAtSize(imageUrl, "large");
}

// ── The per-entity resolve outcome + the pass result ────────────────────────────────────────────

export type CoverMasterSource = "apple" | "coverart" | "spotify";

type ResolveOutcome =
  | { imageKey: string; kind: "resolved"; source: CoverMasterSource }
  | { kind: "none" }
  | { error: string; kind: "failed" };

export type CoverMastersResult = {
  dryRun: boolean;
  // The `kind` this pass drained — `album` or `artist`.
  kind: CoverMasterKind;
  // Slugs re-queued from terminal `none` back to `pending` this call, before the pass ran — the
  // `retry=none` operator heal (empty when retry was not requested). In a dry run, what WOULD
  // requeue without writing.
  requeued: string[];
  requeuedCount: number;
  // Slugs given an owned master this pass (or, in a dry run, the eligible worklist).
  resolved: string[];
  resolvedCount: number;
  // Slugs with no usable source anywhere — floored to the raw URL (terminal `image_state='none'`).
  none: string[];
  noneCount: number;
  failed: Array<{ error: string; slug: string }>;
  failedCount: number;
  // The slug cursor to resume from, or null once the worklist is drained.
  nextCursor: string | null;
  // Kept for CLI/contract symmetry with the label-images sweep — image CDNs are not throttled the
  // way MB/Discogs are, so this pass never trips it, but the shape stays uniform for the driver.
  rateLimited: boolean;
};

// ── DB: the worklists ────────────────────────────────────────────────────────────────────────

type AlbumWorkRow = {
  artwork_height: number | null;
  artwork_url_template: string | null;
  artwork_width: number | null;
  // A representative track's stored cover (Spotify i.scdn.co, or a crawled CAA front URL).
  cover_url: string | null;
  image_failures: number;
  slug: string;
};

type ArtistWorkRow = {
  image_failures: number;
  image_url: string | null;
  slug: string;
};

/**
 * One bounded page of the ALBUM worklist: `pending` albums not cooling down, slug-cursored. A
 * representative `cover_url` is pulled from any track on the album (the Spotify/CAA floor); the
 * Apple template rides on the album row itself. A resolved/none album is terminal and never
 * selected.
 */
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

/**
 * One bounded page of the ARTIST worklist: `pending` artists that ALREADY carry a source
 * (`image_url is not null`) and are not cooling down, slug-cursored. An imageless artist stays
 * pending (unselected) until the Spotify backfill fills its `image_url` — never marked `none`
 * for merely lacking a source yet.
 */
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

// ── DB: the state-machine writes (per table) ────────────────────────────────────────────────────

async function markResolved(
  kind: CoverMasterKind,
  slug: string,
  imageKey: string,
  source: CoverMasterSource,
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const table = kind === "album" ? "albums" : "artists";

  // A resolved master IS a visible change to the picture, so bump `updated_at` (the sitemap
  // lastmod) AND `image_updated_at` (the `?v` rendition-cache bust — media.ts).
  await db.execute({
    args: [imageKey, source, now, now, now, slug],
    sql: `update ${table}
          set image_key = ?, image_source = ?, image_state = 'resolved', image_failures = 0,
              image_attempted_at = ?, image_updated_at = ?, updated_at = ?
          where slug = ?`,
  });
}

async function markNone(kind: CoverMasterKind, slug: string): Promise<void> {
  const db = await getDb();
  const table = kind === "album" ? "albums" : "artists";

  await db.execute({
    args: [new Date().toISOString(), slug],
    sql: `update ${table}
          set image_state = 'none', image_failures = 0, image_attempted_at = ?
          where slug = ?`,
  });
}

/**
 * Record a failed attempt: bump the failure streak + the attempt stamp (drives the cooldown
 * backoff). Past MAX_FAILURES the row GIVES UP (→ `none`). Touches only the reliability columns.
 */
async function recordFailure(
  kind: CoverMasterKind,
  slug: string,
  priorFailures: number,
): Promise<void> {
  const db = await getDb();
  const table = kind === "album" ? "albums" : "artists";
  const failures = priorFailures + 1;
  const giveUp = failures >= MAX_FAILURES;

  await db.execute({
    args: [failures, giveUp ? "none" : "pending", new Date().toISOString(), slug],
    sql: `update ${table}
          set image_failures = ?, image_state = ?, image_attempted_at = ?
          where slug = ?`,
  });
}

/**
 * The `retry=none` operator heal: re-queue a bounded, slug-ordered batch of the kind's TERMINAL
 * `none` rows back to `pending` so the next pass walks the ladder again — for the class where a
 * cover went `none` historically (every source was down or absent then) but a source EXISTS now
 * (a fresh Apple template, or a recovered Cover Art Archive). Kind-scoped (`albums` xor `artists`,
 * never both) and `image_state = 'none'`-scoped, so a `resolved` or `pending` row is never touched.
 * Resets `image_failures` to 0 and clears `image_attempted_at`, making each re-queued row
 * immediately eligible (no cooldown wait) for the same-call pass that follows. A dry run reads the
 * batch it WOULD requeue and writes nothing. Returns the re-queued slugs (in slug order).
 */
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

  await db.execute({
    args: slugs,
    sql: `update ${table}
          set image_state = 'pending', image_failures = 0, image_attempted_at = null
          where slug in (${placeholders})`,
  });
  logEvent("info", "cover-masters.requeued", { count: slugs.length, kind });

  return slugs;
}

// ── The per-entity resolve (the ladder) ──────────────────────────────────────────────────────

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

/** Try one source URL: download it (capped) and store it, or return undefined to fall through. */
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

/** Resolve ONE album's master up the ladder Apple → CAA → Spotify, or floor to `none`. */
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

/** Resolve ONE artist's master — the Spotify floor (the only rung today), or `none`. */
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

// ── The pass ────────────────────────────────────────────────────────────────────────────────

/**
 * One bounded, idempotent pass of the owned-cover-master resolve sweep for `kind`. `bucket` is
 * the world-served R2 (`env.VIDEOS`, behind found.fluncle.com); the handler injects it (tests
 * inject a fake). A dry run reports the eligible worklist without any fetch or write.
 *
 * When `retryNone` is set, a bounded batch of the kind's terminal `none` rows is FIRST re-queued to
 * `pending` (see `requeueTerminalNone`) and then the same pass runs, so an operator burn heals the
 * historically-floored rows in one call. A dry run reports what WOULD requeue without writing.
 */
export async function resolveCoverMasters(
  bucket: Pick<R2Bucket, "put">,
  kind: CoverMasterKind,
  limit: number,
  dryRun: boolean,
  cursor?: string,
  retryNone = false,
): Promise<CoverMastersResult> {
  const batchLimit = Math.max(1, Math.min(limit, MAX_BATCH));
  const requeued = retryNone ? await requeueTerminalNone(kind, batchLimit, dryRun) : [];
  const rows =
    kind === "album"
      ? await listPendingAlbums(batchLimit, cursor)
      : await listPendingArtists(batchLimit, cursor);

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

  // Drained when the page came back short of the cap.
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

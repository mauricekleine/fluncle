import { env } from "cloudflare:workers";
import { r2PublicUrl } from "@fluncle/contracts/util";
import { FOUND_BASE } from "../media";
import {
  buildFrontierCoverHtml,
  FRONTIER_COVER_MAX_JPEG_BYTES,
  FRONTIER_COVER_PX,
} from "./frontier-cover-html";
import {
  type FrontierCoverUpload,
  listFrontierCoverTargets,
  putFrontierCover,
} from "./frontier-playlist";
import { logEvent } from "./log";

// THE COVER, RENDERED IN THE WORKER (E2, the public recommendation machine). The Satori twin
// of the Remotion master lives in frontier-cover-html.ts (pure markup); this module is the
// Worker-only orchestration around it: raster → JPEG → upload. It is deliberately NOT imported
// by frontier-playlist.ts (which the Node operator script + vitest both import) — it pulls in
// `workers-og` (a yoga/WASM module heavy to evaluate and broken under the vitest resolver, the
// mixtape-cover precedent) and `cloudflare:workers`, so the mint handler + the backfill op
// reach it through a LAZY `await import("../frontier-cover")` to keep the `./orpc` graph clean.
//
// ── WHY A ROUND-TRIP THROUGH R2 + CLOUDFLARE IMAGES ──────────────────────────
// Satori (via workers-og) rasterises to PNG only; Spotify's playlist-image endpoint wants a
// Base64 JPEG ≤256KB. There is no in-Worker JPEG encoder in the dependency set, and adding one
// (a WASM encoder + a PNG decoder to feed it) would be a heavier, less-proven path than the one
// the repo already runs for the cover ladder: a Cloudflare Images transform. The transform
// reads a source URL, so the composited PNG is staged briefly on the world-served R2
// (env.VIDEOS, behind found.fluncle.com) under a unique key, transformed to a 640² JPEG in one
// `cf.image`-optioned subrequest, then the staging object is evicted. Everything is
// BEST-EFFORT: a render/transform/upload miss NEVER fails the mint and leaves the row's
// `cover_uploaded_at` NULL, so the backfill op retries it for free.
//
// THE `cf.image` FORM IS LOAD-BEARING. The first ship used a `/cdn-cgi/image/…/<source>` URL —
// the shape the cover ladder serves to BROWSERS — and every in-Worker call failed
// `transform_404` while the identical URL transformed fine from outside (measured in prod,
// 2026-07-18). A Worker subrequest to its own zone bypasses the edge front-door where the
// `/cdn-cgi/image/` path is intercepted, so the literal path reached R2 as a key and 404'd.
// `fetch(source, { cf: { image: {…} } })` is the documented in-Worker invocation; same knobs.
// This leg still cannot be proven under vitest (no Cloudflare Images); the orchestration around
// injected seams is (frontier-cover.test.ts), and every miss now LOGS its concrete reason. An
// alternative all-in-Worker path (resvg raw pixels → a WASM JPEG encoder) remains the noted
// fallback if the transform proves flaky in prod.

/** The composited-PNG rasteriser seam — injected in tests so `workers-og` never loads there. */
export type FrontierRasterize = (html: string) => Promise<Uint8Array>;

/** The Cloudflare-Images transform fetch seam — narrowed to the single call we make, so a test
 * fake need not carry the full `typeof fetch` shape (`preconnect` et al.). The global `fetch`
 * satisfies it. The transform rides the `cf.image` REQUEST OPTIONS, not a `/cdn-cgi/image/…`
 * URL: a Worker subrequest to its own zone bypasses the edge front-door where that URL path is
 * intercepted, so the literal path reaches R2 and 404s (measured in prod, 2026-07-18 —
 * `transform_404` on every mint-fire while the same URL transformed fine from outside). The
 * `cf`-options form is the documented in-Worker invocation and takes the same knobs. */
export type TransformFetch = (
  url: string,
  init: { cf: { image: RequestInitCfPropertiesImage } },
) => Promise<Response>;

/**
 * The minimal R2 surface the cover staging uses — put + delete. A structural subset (rather than
 * `Pick<R2Bucket, …>`) so both the real `env.VIDEOS` and a plain test fake satisfy it without the
 * full overloaded `R2Bucket.put` signatures leaking into the seam.
 */
export type CoverStagingBucket = {
  delete: (key: string) => Promise<unknown>;
  put: (
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: R2PutOptions,
  ) => Promise<unknown>;
};

/** Raster the Satori markup to a PNG via workers-og (lazy — see the module header). */
async function defaultRasterize(html: string): Promise<Uint8Array> {
  const { ImageResponse } = await import("workers-og");
  const { brandFonts } = await import("./satori-render");

  // The cover is Oxanium-only (brand mark + a numeral), so brandFonts() suffices — matching the
  // Remotion master's single-face lockup. PNG is workers-og's raster format.
  const response = new ImageResponse(html, {
    fonts: brandFonts(),
    format: "png",
    height: FRONTIER_COVER_PX,
    width: FRONTIER_COVER_PX,
  });

  return new Uint8Array(await response.arrayBuffer());
}

/** The rendered cover as a Base64 JPEG, or a best-effort failure reason. */
export type FrontierCoverJpeg = { jpegBase64: string; ok: true } | { ok: false; reason: string };

/**
 * Render one Frontier cover for a crew number to a Base64 JPEG ≤192KB, IN THE WORKER.
 *
 * Best-effort: any miss returns `{ ok: false, reason }`, never throws. The `bucket`,
 * `rasterize`, and `transformFetch` seams are injectable so the orchestration is unit-testable
 * without workers-og or Cloudflare Images (the render leg is prod-only — see the module header).
 */
export async function renderFrontierCoverJpeg(opts: {
  bucket?: CoverStagingBucket;
  crewNumber: null | number;
  rasterize?: FrontierRasterize;
  transformFetch?: TransformFetch;
}): Promise<FrontierCoverJpeg> {
  const bucket = opts.bucket ?? env.VIDEOS;
  const rasterize = opts.rasterize ?? defaultRasterize;
  const doFetch = opts.transformFetch ?? fetch;
  // A unique key per render: the transform caches on the full source URL, so a fresh key is a
  // guaranteed cache MISS (no stale/negatively-cached rendition), and two concurrent mints never
  // collide on one staging object.
  const stagingKey = `frontier-covers/staging/${crypto.randomUUID()}.png`;

  try {
    const png = await rasterize(buildFrontierCoverHtml({ crewNumber: opts.crewNumber }));

    // Stage the composited PNG on the world-served R2 so Cloudflare Images (same-zone source
    // only) can read it. Short cache — it is deleted immediately after the transform.
    await bucket.put(stagingKey, png, {
      httpMetadata: { cacheControl: "public, max-age=60", contentType: "image/png" },
    });

    // One transform: downscale-to-640 (a no-op here — already 640²) + JPEG at quality 80, via
    // the `cf.image` request options — the in-Worker invocation (see the seam's header for why
    // a `/cdn-cgi/image/…` URL cannot work from a Worker subrequest). The `?v` cache-bust rides
    // the source so the edge never serves a stale rendition of a reused… key path (the key is
    // already unique; the bust is belt-and-braces).
    const source = `${r2PublicUrl(FOUND_BASE, stagingKey)}?v=${Date.now()}`;

    const response = await doFetch(source, {
      cf: {
        image: {
          fit: "cover",
          format: "jpeg",
          height: FRONTIER_COVER_PX,
          quality: 80,
          width: FRONTIER_COVER_PX,
        },
      },
    });

    if (!response.ok) {
      // Log the reason here as well as returning it — the drain's counts collapse every miss
      // into `failed`, so without this line a prod-only transform fault is undiagnosable.
      logEvent("warn", "frontier.cover-render-failed", {
        reason: `transform_${response.status}`,
        stagingKey,
      });

      return { ok: false, reason: `transform_${response.status}` };
    }

    const jpeg = await response.arrayBuffer();

    if (jpeg.byteLength > FRONTIER_COVER_MAX_JPEG_BYTES) {
      // The render blew the Spotify ceiling — refuse rather than push a too-large image. A
      // design change is the only way here (a 640² q80 dark cover is far under), so it is loud.
      logEvent("warn", "frontier.cover-render-failed", {
        bytes: jpeg.byteLength,
        reason: `cover_too_large_${jpeg.byteLength}`,
      });

      return { ok: false, reason: `cover_too_large_${jpeg.byteLength}` };
    }

    return { jpegBase64: Buffer.from(jpeg).toString("base64"), ok: true };
  } catch (error) {
    logEvent("warn", "frontier.cover-render-failed", { error });

    return { ok: false, reason: error instanceof Error ? error.message : "unknown" };
  } finally {
    // Always evict the staging object — a leaked temp is harmless but noisy. Best-effort.
    try {
      await bucket.delete(stagingKey);
    } catch {
      // Ignore — the object's short cacheControl bounds it anyway.
    }
  }
}

/** The one-cover render seam — injectable so the upload orchestration is testable without a raster. */
export type FrontierCoverRender = (crewNumber: null | number) => Promise<FrontierCoverJpeg>;

const defaultRender: FrontierCoverRender = (crewNumber) => renderFrontierCoverJpeg({ crewNumber });

/**
 * Render + upload one user's cover: the render leg feeds `putFrontierCover` (the shared Spotify
 * PUT + `cover_uploaded_at` stamp seam). Best-effort throughout — a render miss surfaces as
 * `{ uploaded: false, reason }`, and a missing `ugc-image-upload` scope stays a clean abstain
 * (the row keeps its NULL stamp and the backfill retries).
 */
export async function uploadFrontierCoverForUser(
  opts: { crewNumber: null | number; playlistId: string; userId: string },
  render: FrontierCoverRender = defaultRender,
): Promise<FrontierCoverUpload> {
  const rendered = await render(opts.crewNumber);

  if (!rendered.ok) {
    return { reason: rendered.reason, uploaded: false };
  }

  return putFrontierCover(opts.userId, opts.playlistId, rendered.jpegBase64);
}

/** The backfill drain's per-tick summary. */
export type FrontierCoversResult = {
  failed: number;
  missingScope: number;
  ok: true;
  rendered: number;
  targets: number;
  uploaded: number;
};

/**
 * Render + upload every cover still owing (`cover_uploaded_at IS NULL`), up to `limit` — the
 * `upload_frontier_covers` op's engine. The retry path for a cover that failed at mint (or a
 * playlist minted before this shipped): the weekly refresh cron or the operator drives it, and
 * each cover renders IN THE WORKER. Best-effort per target; the counts are the summary.
 */
export async function uploadFrontierCovers(
  limit: number,
  render: FrontierCoverRender = defaultRender,
): Promise<FrontierCoversResult> {
  const targets = await listFrontierCoverTargets(limit);

  const result: FrontierCoversResult = {
    failed: 0,
    missingScope: 0,
    ok: true,
    rendered: 0,
    targets: targets.length,
    uploaded: 0,
  };

  for (const target of targets) {
    const rendered = await render(target.crewNumber);

    if (!rendered.ok) {
      result.failed += 1;
      continue;
    }

    result.rendered += 1;

    const upload = await putFrontierCover(target.userId, target.playlistId, rendered.jpegBase64);

    if (upload.uploaded) {
      result.uploaded += 1;
    } else if (upload.reason === "missing_scope") {
      result.missingScope += 1;
    } else {
      result.failed += 1;
    }
  }

  return result;
}

import { encode as encodeJpeg } from "jpeg-js";
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
// orchestration around it: raster → JPEG encode → upload. It is deliberately NOT imported
// by frontier-playlist.ts (which the Node operator script + vitest both import) — its default
// raster pulls in `workers-og` + our resvg wasm (worker-only modules), so the mint handler +
// the backfill op reach it through a LAZY `await import("../frontier-cover")` to keep the
// `./orpc` graph clean.
//
// ── THE WHOLE PIPELINE RUNS INSIDE THE WORKER ────────────────────────────────
// Satori (via workers-og, format "svg") → our own resvg (resvg-raster.ts, raw RGBA pixels) →
// jpeg-js (pure-JS encode, a quality ladder under Spotify's byte ceiling) → Base64. No network
// leg at all.
//
// It was not always so, and the reason is LOAD-BEARING: two shipped attempts staged the PNG on
// the world-served R2 and asked Cloudflare Images to convert it — first via a
// `/cdn-cgi/image/…/<source>` URL, then via the documented `cf.image` fetch options — and BOTH
// failed `transform_404` on every in-Worker call while the identical transforms worked from
// outside (measured in prod, 2026-07-18). A Worker's subrequest to its own zone bypasses the
// edge front-door, and that front-door is where BOTH the `/cdn-cgi/image/` interception AND the
// R2-custom-domain wiring live — so the Worker can neither invoke the transform nor even read
// `found.fluncle.com` (captions.ts's same-zone fetch degrades the same way). Do not reintroduce
// a same-zone fetch here; encode in-Worker.
//
// Everything stays BEST-EFFORT: a render/encode/upload miss NEVER fails the mint, LOGS its
// concrete reason, and leaves the row's `cover_uploaded_at` NULL so the backfill op retries.

/** A rastered cover: raw RGBA pixels + dimensions, ready for the JPEG encoder. */
export type FrontierRaster = { height: number; pixels: Uint8Array; width: number };

/** The raster seam — injected in tests so `workers-og` + the resvg wasm never load there. */
export type FrontierRasterize = (html: string) => Promise<FrontierRaster>;

/**
 * The JPEG-quality ladder. 80 is the intended look; a step down only fires if the encode blows
 * Spotify's byte ceiling (the founding art is grainy — JPEG's worst case — so q80 at 640² can
 * land close to the line depending on the stamp).
 */
const JPEG_QUALITY_LADDER = [80, 70, 60];

/** Raster the Satori markup to raw pixels: satori SVG via workers-og, pixels via our resvg. */
async function defaultRasterize(html: string): Promise<FrontierRaster> {
  const { ImageResponse } = await import("workers-og");
  const { brandFonts } = await import("./satori-render");
  const { rasterSvgToPixels } = await import("./resvg-raster");

  // The cover is Oxanium-only (brand mark + a numeral), so brandFonts() suffices — matching the
  // Remotion master's single-face lockup. "svg" hands back Satori's output un-rastered, so OUR
  // resvg (which exposes raw pixels; workers-og's bundled copy only emits PNG bytes) does the
  // one raster.
  //
  // The double await is REAL: workers-og's constructor RETURNS an async IIFE — a
  // Promise<Response> — on the svg format path (read from its dist; the png path returns a
  // streaming Response synchronously). Its types say `Response` either way, so without the
  // cast+await this throws `.text is not a function` at runtime (measured in prod, 2026-07-18).
  const response = await (new ImageResponse(html, {
    fonts: brandFonts(),
    format: "svg",
    height: FRONTIER_COVER_PX,
    width: FRONTIER_COVER_PX,
  }) as unknown as Promise<Response> | Response);

  return rasterSvgToPixels(await response.text(), FRONTIER_COVER_PX);
}

/** The rendered cover as a Base64 JPEG, or a best-effort failure reason. */
export type FrontierCoverJpeg = { jpegBase64: string; ok: true } | { ok: false; reason: string };

/**
 * Render one Frontier cover for a crew number to a Base64 JPEG ≤192KB, entirely IN THE WORKER.
 *
 * Best-effort: any miss logs and returns `{ ok: false, reason }`, never throws. The `rasterize`
 * seam is injectable so the orchestration + the real jpeg-js encode are unit-testable without
 * the wasm rasters (frontier-cover.test.ts drives the encoder with synthetic pixels).
 */
export async function renderFrontierCoverJpeg(opts: {
  crewNumber: null | number;
  rasterize?: FrontierRasterize;
}): Promise<FrontierCoverJpeg> {
  const rasterize = opts.rasterize ?? defaultRasterize;

  try {
    const raster = await rasterize(buildFrontierCoverHtml({ crewNumber: opts.crewNumber }));

    // jpeg-js wants the RGBA buffer + dims; walk the quality ladder until the encode clears
    // Spotify's ceiling. A dark 640² cover lands under at q80 almost always — the ladder is
    // insurance, not the plan.
    let bytes: Uint8Array | undefined;

    for (const quality of JPEG_QUALITY_LADDER) {
      const encoded = encodeJpeg(
        { data: raster.pixels, height: raster.height, width: raster.width },
        quality,
      );

      bytes = encoded.data;

      if (bytes.byteLength <= FRONTIER_COVER_MAX_JPEG_BYTES) {
        return { jpegBase64: Buffer.from(bytes).toString("base64"), ok: true };
      }
    }

    // Even the ladder's floor blew the ceiling — a design change is the only way from here, so
    // it is loud.
    const size = bytes?.byteLength ?? 0;

    logEvent("warn", "frontier.cover-render-failed", {
      bytes: size,
      reason: `cover_too_large_${size}`,
    });

    return { ok: false, reason: `cover_too_large_${size}` };
  } catch (error) {
    logEvent("warn", "frontier.cover-render-failed", { error });

    return { ok: false, reason: error instanceof Error ? error.message : "unknown" };
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

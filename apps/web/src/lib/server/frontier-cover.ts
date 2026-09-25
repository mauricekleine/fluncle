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

export type FrontierRaster = { height: number; pixels: Uint8Array; width: number };

export type FrontierRasterize = (html: string) => Promise<FrontierRaster>;

const JPEG_QUALITY_LADDER = [80, 70, 60];

async function defaultRasterize(html: string): Promise<FrontierRaster> {
  const { ImageResponse } = await import("workers-og");
  const { brandFonts } = await import("./satori-render");
  const { rasterSvgToPixels } = await import("./resvg-raster");

  const response = await (new ImageResponse(html, {
    fonts: brandFonts(),
    format: "svg",
    height: FRONTIER_COVER_PX,
    width: FRONTIER_COVER_PX,
  }) as unknown as Promise<Response> | Response);

  return rasterSvgToPixels(await response.text(), FRONTIER_COVER_PX);
}

export type FrontierCoverJpeg = { jpegBase64: string; ok: true } | { ok: false; reason: string };

export async function renderFrontierCoverJpeg(opts: {
  crewNumber: null | number;
  rasterize?: FrontierRasterize;
}): Promise<FrontierCoverJpeg> {
  const rasterize = opts.rasterize ?? defaultRasterize;

  try {
    const raster = await rasterize(buildFrontierCoverHtml({ crewNumber: opts.crewNumber }));

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

export type FrontierCoverRender = (crewNumber: null | number) => Promise<FrontierCoverJpeg>;

const defaultRender: FrontierCoverRender = (crewNumber) => renderFrontierCoverJpeg({ crewNumber });

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

export type FrontierCoversResult = {
  failed: number;
  missingScope: number;
  ok: true;
  rendered: number;
  targets: number;
  uploaded: number;
};

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

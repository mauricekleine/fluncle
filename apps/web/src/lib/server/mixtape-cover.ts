import { ImageResponse } from "workers-og";
import { FOUND_BASE } from "@/lib/media";
import { getMixtapeForRender } from "@/lib/server/mixtapes";
import { BRAND, brandFonts, satoriText } from "@/lib/server/satori-render";

// The on-the-fly mixtape cover render, shared by the public cover route
// (api/mixtape-cover.$logId.ts) and the YouTube finalize (which sets it as the
// custom thumbnail). Both render IN-PROCESS — the finalize must NOT HTTP-fetch the
// cover route: a Worker fetching its own origin loops to the SPA fallback (HTML,
// not the image), so the thumbnail would silently never attach.
//
// TYPE: the cover carries only brand marks — `MIXTAPE #N` and the Log ID coordinate — so
// it is Oxanium throughout, and legitimately so (DESIGN.md §3: Oxanium speaks for the brand
// and the numbers). No body face is registered here: there is no reading text to set. The
// One Box Rule is baked into the cuts (lib/server/og-fonts.ts).

const BG_BASE = `${FOUND_BASE}/mixtape`;

// `square` (1500²) is the canonical artwork used for the actual distribution
// uploads (Mixcloud/SoundCloud); never shrink it. `card` and `thumb` are
// display-only square renditions for the on-site cover slots — both reuse the
// square background and the same vmin-proportional stamp, so they read identically
// to `square` at a fraction of the bytes (a 1500² Satori PNG is ~1 MB into a 52px
// row; a 128² thumb is a few kB). `card` (640²) covers the /log plate at @2x
// (min(100%, 20rem) = 320px); `thumb` (160²) covers the feed/index rows at @2x.
const SIZES = {
  card: { background: `${BG_BASE}/bg-square.jpg`, height: 640, width: 640 },
  og: { background: `${BG_BASE}/bg-og.jpg`, height: 630, width: 1200 },
  square: { background: `${BG_BASE}/bg-square.jpg`, height: 1500, width: 1500 },
  thumb: { background: `${BG_BASE}/bg-square.jpg`, height: 160, width: 160 },
  wide: { background: `${BG_BASE}/bg-wide.jpg`, height: 720, width: 1280 },
} as const;

export type MixtapeCoverSizeKey = keyof typeof SIZES;

export function resolveCoverSize(requested: string | null | undefined): MixtapeCoverSizeKey {
  return (requested && requested in SIZES ? requested : "square") as MixtapeCoverSizeKey;
}

// One-sun palette (packages/tokens), inlined — the rendered card has no CSS vars.
const COLOR = {
  bg: "#090a0b",
  cream: "#f4ead7",
} as const;

// Inline an image as a base64 data-URI (Satori doesn't fetch remote <img>).
// Returns undefined on failure so the cover degrades to the bare ground.
async function fetchImageDataUri(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      return undefined;
    }

    const contentType = response.headers.get("content-type") ?? "image/png";
    const buffer = await response.arrayBuffer();

    return `data:${contentType};base64,${Buffer.from(buffer).toString("base64")}`;
  } catch {
    return undefined;
  }
}

/**
 * Render a published/distributing mixtape's cover at the given size, or null if no
 * such mixtape exists. The result is an ImageResponse (a Response) — the route
 * returns it directly; the finalize reads `.arrayBuffer()` for the thumbnail.
 */
export async function renderMixtapeCover(
  logId: string,
  size: MixtapeCoverSizeKey,
): Promise<ImageResponse | null> {
  const { background, height, width } = SIZES[size];

  // getMixtapeForRender (not getMixtapeByLogId) so the cover renders while a
  // mixtape is still `distributing` — the thumbnail the upload needs.
  const mixtape = await getMixtapeForRender(logId);

  if (!mixtape || mixtape.sequenceNumber === undefined) {
    return null;
  }

  const bg = await fetchImageDataUri(background);

  // Mirror the Remotion composition's lower-band typography (vmin-based), so the
  // stamped text matches mixtape-cover.tsx at every aspect.
  const vmin = Math.min(width, height) / 100;
  const titleSize = Math.round(6.4 * vmin);
  const coordSize = Math.round(3.4 * vmin);

  const title = `MIXTAPE #${mixtape.sequenceNumber}`;
  const coordinate = satoriText(logId);

  const html = `
    <div style="position:relative;display:flex;width:${width}px;height:${height}px;background:${COLOR.bg};font-family:${BRAND};overflow:hidden;">
      ${
        bg
          ? `<img src="${bg}" width="${width}" height="${height}" style="position:absolute;top:0;left:0;width:${width}px;height:${height}px;object-fit:cover;" />`
          : ""
      }
      <div style="position:relative;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;width:${width}px;height:${height}px;padding-bottom:${Math.round(height * 0.08)}px;">
        <div style="display:flex;color:${COLOR.cream};font-size:${titleSize}px;font-weight:800;letter-spacing:${Math.round(titleSize * 0.06)}px;line-height:1;text-shadow:0 2px 22px ${COLOR.bg};">${satoriText(title)}</div>
        <div style="display:flex;color:${COLOR.cream};font-size:${coordSize}px;font-weight:400;letter-spacing:${Math.round(coordSize * 0.22)}px;opacity:0.72;margin-top:${Math.round(2.4 * vmin)}px;text-shadow:0 1px 14px ${COLOR.bg};">${coordinate}</div>
      </div>
    </div>
  `;

  return new ImageResponse(html, {
    fonts: brandFonts(),
    height,
    width,
  });
}

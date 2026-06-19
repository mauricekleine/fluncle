import { createFileRoute } from "@tanstack/react-router";
import { ImageResponse, loadGoogleFont } from "workers-og";
import { FOUND_BASE } from "@/lib/media";
import { getMixtapeForRender } from "@/lib/server/mixtapes";

// On-the-fly mixtape cover, rendered on the edge with workers-og (Satori + resvg
// WASM — the same path as the per-finding OG card in og.$logId.ts). The cover is
// the shared Deep-Field background (the cosmonaut) with the only per-mixtape marks —
// "MIXTAPE #N" and the Log ID coordinate — stamped over it here. No Remotion render
// at request time, no per-mixtape upload: a published mixtape's cover simply exists
// at this URL, so publishing needs no cover step.
//
// The background is baked once (`bun run --cwd packages/media render:mixtape-bg`) and
// hosted on R2 at found.fluncle.com/mixtape/bg-<size>.jpg — fetched CROSS-ORIGIN
// below. It must NOT live on www.fluncle.com: a Worker fetching its own origin loops
// back to the SPA fallback (HTML, not the asset), which is exactly how the cover
// rendered black before. og.$logId.ts embeds the found.fluncle.com poster for the
// same reason. Re-upload after re-baking:
//   wrangler r2 object put fluncle-videos/mixtape/bg-<size>.jpg --file=… --content-type=image/jpeg --remote
//
// `?size=` picks the aspect: square (Mixcloud/SoundCloud + the /log coverImageUrl),
// og (the /log link-preview), or wide (the YouTube thumbnail). The mixtape's
// coverImageUrl points here, versioned by `?v=<updatedAt>` so an edit re-renders
// while each version stays immutable + edge-cached.

const BG_BASE = `${FOUND_BASE}/mixtape`;

const SIZES = {
  og: { background: `${BG_BASE}/bg-og.jpg`, height: 630, width: 1200 },
  square: { background: `${BG_BASE}/bg-square.jpg`, height: 1500, width: 1500 },
  wide: { background: `${BG_BASE}/bg-wide.jpg`, height: 720, width: 1280 },
} as const;

type SizeKey = keyof typeof SIZES;

// One-sun palette (packages/tokens), inlined — the rendered card has no CSS vars.
const COLOR = {
  bg: "#090a0b",
  cream: "#f4ead7",
} as const;

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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

export const Route = createFileRoute("/api/mixtape-cover/$logId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const logId = decodeURIComponent(params.logId);
        const requested = new URL(request.url).searchParams.get("size") ?? "square";
        const size = (requested in SIZES ? requested : "square") as SizeKey;
        const { background, height, width } = SIZES[size];

        // getMixtapeForRender (not getMixtapeByLogId) so the cover renders while a
        // mixtape is still `distributing` — the thumbnail the upload needs.
        const mixtape = await getMixtapeForRender(logId);

        if (!mixtape || mixtape.sequenceNumber === undefined) {
          return new Response("Not found", { status: 404 });
        }

        const bg = await fetchImageDataUri(background);

        // Mirror the Remotion composition's lower-band typography (vmin-based), so
        // the stamped text matches mixtape-cover.tsx at every aspect.
        const vmin = Math.min(width, height) / 100;
        const titleSize = Math.round(6.4 * vmin);
        const coordSize = Math.round(3.4 * vmin);

        const title = `MIXTAPE #${mixtape.sequenceNumber}`;
        const coordinate = escapeHtml(logId);

        const html = `
          <div style="position:relative;display:flex;width:${width}px;height:${height}px;background:${COLOR.bg};font-family:'Oxanium';overflow:hidden;">
            ${
              bg
                ? `<img src="${bg}" width="${width}" height="${height}" style="position:absolute;top:0;left:0;width:${width}px;height:${height}px;object-fit:cover;" />`
                : ""
            }
            <div style="position:relative;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;width:${width}px;height:${height}px;padding-bottom:${Math.round(height * 0.08)}px;">
              <div style="display:flex;color:${COLOR.cream};font-size:${titleSize}px;font-weight:800;letter-spacing:${Math.round(titleSize * 0.06)}px;line-height:1;text-shadow:0 2px 22px ${COLOR.bg};">${escapeHtml(title)}</div>
              <div style="display:flex;color:${COLOR.cream};font-size:${coordSize}px;font-weight:400;letter-spacing:${Math.round(coordSize * 0.22)}px;opacity:0.72;margin-top:${Math.round(2.4 * vmin)}px;text-shadow:0 1px 14px ${COLOR.bg};">${coordinate}</div>
            </div>
          </div>
        `;

        const [oxaniumBold, oxaniumRegular] = await Promise.all([
          loadGoogleFont({ family: "Oxanium", weight: 800 }),
          loadGoogleFont({ family: "Oxanium", weight: 400 }),
        ]);

        return new ImageResponse(html, {
          fonts: [
            { data: oxaniumBold, name: "Oxanium", style: "normal", weight: 800 },
            { data: oxaniumRegular, name: "Oxanium", style: "normal", weight: 400 },
          ],
          height,
          width,
        });
      },
    },
  },
});

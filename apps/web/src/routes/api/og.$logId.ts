import { createFileRoute } from "@tanstack/react-router";
import { ImageResponse, loadGoogleFont } from "workers-og";
import { formatDateLong } from "@/lib/format";
import { GALAXIES, galaxyForVibe } from "@/lib/galaxies";
import { spotifyAlbumImageAtSize, trackMedia } from "@/lib/media";
import { getTrackByIdOrLogId } from "@/lib/server/tracks";

// Per-finding Open Graph card (1200×630), rendered on the edge with workers-og
// (Satori + resvg WASM — confirmed running under the @cloudflare/vite-plugin
// build). The finding's own drop frame (`poster.jpg`) is the hero background,
// inlined as a data-URI (Satori doesn't fetch remote <img>); the Fluncle
// treatment sits over it — the FLUNCLE'S FINDINGS lockup, the gold Log ID, the
// Artist — Title headline, and the Found/telemetry line. The log page points
// og:image here, versioned by `?v=<updatedAt>` so a re-enriched finding re-renders
// (the response itself is immutable + edge-cached, so it renders once per version).

const WIDTH = 1200;
const HEIGHT = 630;

// The one-sun palette (packages/tokens), inlined as hex — the rendered card has
// no CSS variables.
const COLOR = {
  bg: "#090a0b",
  cream: "#f4ead7",
  gold: "#f5b800",
  stardust: "#b7ab95",
} as const;

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Fetch an image and inline it as a base64 data-URI (nodejs_compat gives us
// Buffer). Returns undefined on any failure so the card degrades to the bare
// cosmos background rather than 500ing.
async function fetchImageDataUri(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      return undefined;
    }

    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    const buffer = await response.arrayBuffer();

    return `data:${contentType};base64,${Buffer.from(buffer).toString("base64")}`;
  } catch {
    return undefined;
  }
}

export const Route = createFileRoute("/api/og/$logId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const logId = params.logId;

        const track = await getTrackByIdOrLogId(logId);

        if (!track) {
          return new Response("Not found", { status: 404 });
        }

        // The drop frame is the hero; findings without footage fall back to the
        // album cover.
        const bgSource = track.videoUrl
          ? trackMedia(track.logId ?? logId).posterUrl
          : spotifyAlbumImageAtSize(track.albumImageUrl, "large");
        const background = bgSource ? await fetchImageDataUri(bgSource) : undefined;

        const galaxy =
          track.vibeX !== undefined && track.vibeY !== undefined
            ? GALAXIES[galaxyForVibe(track.vibeX, track.vibeY)].name
            : undefined;
        const meta = [
          `Found ${formatDateLong(track.addedAt)}`,
          track.bpm ? `${Math.round(track.bpm)} BPM` : undefined,
          track.key,
          galaxy,
        ]
          .filter(Boolean)
          .join("  ·  ");

        // The card deviates from the list convention's `Artist — Title`: at
        // display size, title-led over two lines (matching the /log page's own
        // hierarchy) reads far better, especially for long remix titles.
        const title = escapeHtml(track.title);
        const artist = escapeHtml(track.artists.join(", "));

        const html = `
          <div style="position:relative;display:flex;width:${WIDTH}px;height:${HEIGHT}px;background:${COLOR.bg};font-family:'Oxanium';overflow:hidden;">
            ${
              background
                ? `<img src="${background}" width="${WIDTH}" height="${HEIGHT}" style="position:absolute;top:0;left:0;width:${WIDTH}px;height:${HEIGHT}px;object-fit:cover;" />`
                : ""
            }
            <div style="position:absolute;top:0;left:0;display:flex;width:${WIDTH}px;height:${HEIGHT}px;background:linear-gradient(105deg, rgba(9,10,11,0.94) 0%, rgba(9,10,11,0.82) 44%, rgba(9,10,11,0.30) 100%);"></div>
            <div style="position:relative;display:flex;flex-direction:column;justify-content:space-between;width:${WIDTH}px;height:${HEIGHT}px;padding:64px;">
              <div style="display:flex;color:${COLOR.stardust};font-size:26px;font-weight:600;letter-spacing:5px;text-transform:uppercase;">Fluncle's Findings</div>
              <div style="display:flex;flex-direction:column;">
                <div style="display:flex;color:${COLOR.gold};font-size:30px;font-weight:800;letter-spacing:1px;">fluncle://${logId}</div>
                <div style="display:flex;color:${COLOR.cream};font-size:62px;font-weight:800;line-height:1.04;margin-top:14px;max-width:1040px;">${title}</div>
                <div style="display:flex;color:${COLOR.stardust};font-size:34px;font-weight:500;margin-top:14px;">${artist}</div>
              </div>
              <div style="display:flex;color:${COLOR.stardust};font-size:26px;font-weight:500;">${escapeHtml(meta)}</div>
            </div>
          </div>
        `;

        const [oxaniumBold, oxaniumMedium] = await Promise.all([
          loadGoogleFont({ family: "Oxanium", weight: 800 }),
          loadGoogleFont({ family: "Oxanium", weight: 500 }),
        ]);

        return new ImageResponse(html, {
          fonts: [
            { data: oxaniumBold, name: "Oxanium", style: "normal", weight: 800 },
            { data: oxaniumMedium, name: "Oxanium", style: "normal", weight: 500 },
          ],
          height: HEIGHT,
          width: WIDTH,
        });
      },
    },
  },
});

export const serverHandlers = Route.options.server!.handlers;

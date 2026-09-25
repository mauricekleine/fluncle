import { colors } from "@fluncle/tokens";
import { createFileRoute } from "@tanstack/react-router";
import { ImageResponse } from "workers-og";
import { formatDateLong } from "@/lib/format";
import { isGalaxyMapFullyNamed } from "@/lib/server/galaxies-map";
import { albumCoverAtSize, trackMedia } from "@/lib/media";
import { requireParam } from "@/lib/server/http-errors";
import {
  BODY,
  BRAND,
  OG_CACHE_CONTROL,
  cardFonts,
  fetchImageDataUri,
  satoriText,
} from "@/lib/server/satori-render";
import { getTrackByIdOrLogId } from "@/lib/server/tracks";
import { type ApiHandlers, aliasHandlers } from "./-alias";

const WIDTH = 1200;
const HEIGHT = 630;

const COLOR = {
  bg: colors.deepField,
  cream: colors.starlightCream,
  gold: colors.eclipseGold,
  stardust: colors.stardust,
} as const;

export const serverHandlers: ApiHandlers = {
  GET: async ({ params }) => {
    const logId = requireParam(params.logId, "logId");

    const track = await getTrackByIdOrLogId(logId);

    if (!track) {
      return new Response("Not found", { status: 404 });
    }

    const bgSource = track.videoUrl
      ? trackMedia(track.logId ?? logId).posterUrl
      : albumCoverAtSize(track.albumImageUrl, "large");
    const background = bgSource ? await fetchImageDataUri(bgSource) : undefined;

    const galaxy = track.galaxy && (await isGalaxyMapFullyNamed()) ? track.galaxy.name : undefined;
    const meta = [
      `Found ${formatDateLong(track.addedAt)}`,
      track.bpm ? `${Math.round(track.bpm)} BPM` : undefined,
      track.key,
      galaxy,
    ]
      .filter(Boolean)
      .join("  ·  ");

    const title = satoriText(track.title);
    const artist = satoriText(track.artists.join(", "));

    const html = `
          <div style="position:relative;display:flex;width:${WIDTH}px;height:${HEIGHT}px;background:${COLOR.bg};font-family:${BODY};overflow:hidden;">
            ${
              background
                ? `<img src="${background}" width="${WIDTH}" height="${HEIGHT}" style="position:absolute;top:0;left:0;width:${WIDTH}px;height:${HEIGHT}px;object-fit:cover;" />`
                : ""
            }
            <div style="position:absolute;top:0;left:0;display:flex;width:${WIDTH}px;height:${HEIGHT}px;background:linear-gradient(105deg, rgba(9,10,11,0.94) 0%, rgba(9,10,11,0.82) 44%, rgba(9,10,11,0.30) 100%);"></div>
            <div style="position:relative;display:flex;flex-direction:column;justify-content:space-between;width:${WIDTH}px;height:${HEIGHT}px;padding:64px;">
              <div style="display:flex;font-family:${BRAND};color:${COLOR.stardust};font-size:26px;font-weight:800;letter-spacing:5px;text-transform:uppercase;">Fluncle's Findings</div>
              <div style="display:flex;flex-direction:column;">
                <div style="display:flex;font-family:${BRAND};color:${COLOR.gold};font-size:30px;font-weight:800;letter-spacing:1px;">fluncle://${satoriText(logId)}</div>
                <div style="display:flex;color:${COLOR.cream};font-size:62px;font-weight:700;line-height:1.04;margin-top:14px;max-width:1040px;">${title}</div>
                <div style="display:flex;color:${COLOR.stardust};font-size:34px;font-weight:400;margin-top:14px;">${artist}</div>
              </div>
              <div style="display:flex;color:${COLOR.stardust};font-size:26px;font-weight:400;">${satoriText(meta)}</div>
            </div>
          </div>
        `;

    return new ImageResponse(html, {
      fonts: cardFonts(),
      headers: { "Cache-Control": OG_CACHE_CONTROL },
      height: HEIGHT,
      width: WIDTH,
    });
  },
};

export const Route = createFileRoute("/api/og/$logId")({
  server: { handlers: aliasHandlers(serverHandlers) },
});

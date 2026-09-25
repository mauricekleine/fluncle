import { colors } from "@fluncle/tokens";
import { createFileRoute } from "@tanstack/react-router";
import { ImageResponse } from "workers-og";
import { albumCoverAtSize } from "@/lib/media";
import { parseSetParam } from "@/lib/mix-set";
import {
  BODY,
  BRAND,
  OG_CACHE_CONTROL,
  cardFonts,
  fetchImageDataUri,
  satoriText,
} from "@/lib/server/satori-render";
import { getTracksByLogIds } from "@/lib/server/tracks";

const WIDTH = 1200;
const HEIGHT = 630;

const COLOR = {
  bg: colors.deepField,
  cream: colors.starlightCream,
  gold: colors.eclipseGold,
  stardust: colors.stardust,
} as const;

export const serverHandlers = {
  GET: async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const logIds = parseSetParam(url.searchParams.get("set"));
    const byLogId = logIds.length > 0 ? await getTracksByLogIds(logIds) : {};
    const chain = logIds.flatMap((logId) => {
      const finding = byLogId[logId];

      return finding ? [finding] : [];
    });

    const covers = await Promise.all(
      chain.slice(0, 5).map((finding) => {
        const src = albumCoverAtSize(finding.albumImageUrl, "medium");

        return src ? fetchImageDataUri(src) : Promise.resolve(undefined);
      }),
    );

    const coverTiles = covers
      .map((dataUri, index) =>
        dataUri
          ? `<div style="display:flex;width:200px;height:200px;margin-left:${index === 0 ? 0 : -56}px;border:6px solid ${COLOR.bg};border-radius:16px;transform:rotate(${index % 2 === 0 ? -4 : 4}deg);overflow:hidden;"><img src="${dataUri}" width="200" height="200" style="width:200px;height:200px;object-fit:cover;" /></div>`
          : "",
      )
      .join("");

    const count = chain.length;
    const countLabel = satoriText(
      count === 0 ? "Chain a set" : `${count} ${count === 1 ? "banger" : "bangers"}, mixed clean`,
    );

    const html = `
      <div style="position:relative;display:flex;flex-direction:column;justify-content:space-between;width:${WIDTH}px;height:${HEIGHT}px;background:${COLOR.bg};font-family:${BODY};padding:64px;overflow:hidden;">
        <div style="display:flex;font-family:${BRAND};color:${COLOR.stardust};font-size:26px;font-weight:800;letter-spacing:5px;text-transform:uppercase;">A Fluncle mix</div>
        <div style="display:flex;align-items:center;">${coverTiles}</div>
        <div style="display:flex;flex-direction:column;">
          <div style="display:flex;color:${COLOR.cream};font-size:56px;font-weight:700;">${countLabel}</div>
          <div style="display:flex;color:${COLOR.gold};font-size:28px;font-weight:700;margin-top:10px;">My findings, your order.</div>
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

export const Route = createFileRoute("/api/og/set")({
  server: { handlers: serverHandlers },
});

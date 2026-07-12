import { createFileRoute } from "@tanstack/react-router";
import { ImageResponse } from "workers-og";
import { albumCoverAtSize } from "@/lib/media";
import { parseSetParam } from "@/lib/mix-set";
import { BODY, BRAND, OG_CACHE_CONTROL, cardFonts, satoriText } from "@/lib/server/satori-render";
import { getTracksByLogIds } from "@/lib/server/tracks";
import { type ApiHandlers, aliasHandlers } from "./-alias";

// The set-level Open Graph card (1200×630) for a shared `/mix` link (RFC
// mixability-engine §3.2) — a `/mix` link that unfurls as a naked URL on
// Discord/Telegram (where the crew lives) has no share step, so this is IN SCOPE. The
// chain's covers fanned across the cosmos background + the track count, in the same
// visual system as the per-finding card (`og.$logId.ts`). Rendered on the edge with
// workers-og (Satori + resvg WASM). Satori doesn't fetch remote <img>, so each cover
// is inlined as a data-URI.
//
// TYPE: same role split as the per-finding card (DESIGN.md §3, lib/server/satori-render.ts).
// The "A FLUNCLE MIX" lockup is a brand mark → Oxanium. The count line and the tagline are
// reading text → Space Grotesk, which is also the container default.

const WIDTH = 1200;
const HEIGHT = 630;

const COLOR = {
  bg: "#090a0b",
  cream: "#f4ead7",
  gold: "#f5b800",
  stardust: "#b7ab95",
} as const;

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

export const serverHandlers: ApiHandlers = {
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const logIds = parseSetParam(url.searchParams.get("set"));
    const byLogId = logIds.length > 0 ? await getTracksByLogIds(logIds) : {};
    const chain = logIds.flatMap((logId) => {
      const finding = byLogId[logId];

      return finding ? [finding] : [];
    });

    // Up to five covers fan across the card; the count names the whole set.
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
  server: { handlers: aliasHandlers(serverHandlers) },
});

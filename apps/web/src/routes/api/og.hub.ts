import { colors } from "@fluncle/tokens";
import { createFileRoute } from "@tanstack/react-router";
import { ImageResponse } from "workers-og";
import { BODY, BRAND, OG_CACHE_CONTROL, cardFonts, satoriText } from "@/lib/server/satori-render";
import { countIndexableAlbums } from "@/lib/server/albums";
import { countIndexableArtists } from "@/lib/server/artists";
import { countIndexableLabels } from "@/lib/server/labels";
import { countAllTracks } from "@/lib/server/tracks-hub";

const WIDTH = 1200;
const HEIGHT = 630;

const COLOR = {
  bg: colors.deepField,
  cream: colors.starlightCream,
  gold: colors.eclipseGold,
  stardust: colors.stardust,
} as const;

const countFormatter = new Intl.NumberFormat("en-US");

type HubCard = {
  count: () => Promise<number>;
  line: (total: number) => string;
  name: string;
};

const HUB_CARDS: Record<string, HubCard> = {
  albums: {
    count: countIndexableAlbums,
    line: (total) =>
      total > 1
        ? `${countFormatter.format(total)} drum & bass records, A to Z.`
        : "Drum & bass records, A to Z.",
    name: "Albums",
  },
  artists: {
    count: countIndexableArtists,
    line: (total) =>
      total > 1
        ? `${countFormatter.format(total)} drum & bass artists, A to Z.`
        : "Drum & bass artists, A to Z.",
    name: "Artists",
  },
  labels: {
    count: countIndexableLabels,
    line: (total) =>
      total > 1
        ? `${countFormatter.format(total)} drum & bass labels, A to Z.`
        : "Drum & bass labels, A to Z.",
    name: "Labels",
  },
  tracks: {
    count: countAllTracks,
    line: (total) =>
      total > 1
        ? `${countFormatter.format(total)} drum & bass tracks, newest first.`
        : "Drum & bass tracks, newest first.",
    name: "Tracks",
  },
};

export const serverHandlers = {
  GET: async ({ request }: { request: Request }) => {
    const url = new URL(request.url);

    const hub = url.searchParams.get("hub");
    const card = hub !== null && Object.hasOwn(HUB_CARDS, hub) ? HUB_CARDS[hub] : undefined;

    if (!card) {
      return new Response("Not Found", { status: 404 });
    }

    const total = await card.count();
    const line = satoriText(card.line(total));

    const html = `
      <div style="position:relative;display:flex;flex-direction:column;justify-content:space-between;width:${WIDTH}px;height:${HEIGHT}px;background:${COLOR.bg};font-family:${BODY};padding:64px;overflow:hidden;">
        <div style="display:flex;font-family:${BRAND};color:${COLOR.stardust};font-size:26px;font-weight:800;letter-spacing:5px;text-transform:uppercase;">Fluncle</div>
        <div style="display:flex;font-family:${BRAND};color:${COLOR.cream};font-size:150px;font-weight:800;letter-spacing:-3px;">${card.name}</div>
        <div style="display:flex;color:${COLOR.gold};font-size:40px;font-weight:700;">${line}</div>
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

export const Route = createFileRoute("/api/og/hub")({
  server: { handlers: serverHandlers },
});

import { colors } from "@fluncle/tokens";
import { createFileRoute } from "@tanstack/react-router";
import { ImageResponse } from "workers-og";
import { BODY, BRAND, OG_CACHE_CONTROL, cardFonts, satoriText } from "@/lib/server/satori-render";
import { countIndexableAlbums } from "@/lib/server/albums";
import { countIndexableArtists } from "@/lib/server/artists";
import { countIndexableLabels } from "@/lib/server/labels";
import { countAllTracks } from "@/lib/server/tracks-hub";

// The hub-level Open Graph card (1200×630) for the four entity hubs — /artists, /albums,
// /labels, /tracks — so their links stop unfurling as the one generic cover. The hub's
// name over its live held count, in the same visual system as the per-finding card
// (`og.$logId.ts`) and the set card (`og.set.ts`). Rendered on the edge with workers-og
// (Satori + resvg WASM).
//
// COPY IS STRUCTURAL: every word on the card already ships on the hub's own page — the
// masthead's H1 word and its count line (each hub route's `mastheadLine` /
// `tracksMastheadLine`), mirrored verbatim below. Nothing here is a new public string,
// which is what keeps this card outside the copywriting gate.
//
// TYPE: same role split as the other cards (DESIGN.md §3, lib/server/satori-render.ts).
// The "Fluncle" lockup is a brand mark and the hub's H1 renders in Oxanium on the page
// itself (`.log-coordinate`) → Oxanium for both. The count line is reading text → Space
// Grotesk, which is also the container default.

const WIDTH = 1200;
const HEIGHT = 630;

const COLOR = {
  bg: colors.deepField,
  cream: colors.starlightCream,
  gold: colors.eclipseGold,
  stardust: colors.stardust,
} as const;

const countFormatter = new Intl.NumberFormat("en-US");

/**
 * One hub's card fuel: the H1 word the page leads with, its count read, and the page's
 * own masthead line. `line` mirrors the hub route's `mastheadLine` (tracks:
 * `tracksMastheadLine` in lib/tracks-search.ts) — the count clause drops at ≤ 1 there,
 * and so it does here.
 */
type HubCard = {
  count: () => Promise<number>;
  line: (total: number) => string;
  name: string;
};

// The counts are the cheapest existing reads of the STORED per-entity counters: the three
// entity hubs ride `countIndexable…` (one `count(*)` over the entity table, gated by the
// maintained `renderable_track_count` — the same read /admin/funnel and the sitemap use),
// and /tracks rides `countAllTracks` (a bare memoized `count(*)`, the masthead's own held
// count). No aggregate over raw tracks runs here.
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

// BARE-ONLY MOUNT, SO NO `aliasHandlers`: that helper's `as never` exists only to unbind
// the phantom path coupling when ONE handler object is mounted at both /api/x and
// /api/v1/x (see ./-alias.ts). This card has no /api/v1 twin — `/api/og/hub` is the single
// mount (and a documented bare-only carve-out in orpc-coverage.test.ts) — so there is
// nothing to share, and routing the object through the cast erased TanStack's type-check
// at the mount for no benefit: a handler with the wrong shape would have compiled. The
// handlers are declared directly and mounted inline below, so the compiler checks them
// against this route's own literal path.
export const serverHandlers = {
  GET: async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    // Validate BEFORE any DB read: an unknown (or absent) hub never reaches Turso and
    // never pays the WASM raster — it is a plain 404. Own keys only: a prototype key
    // (`?hub=constructor`) must not resolve through the object literal's chain.
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

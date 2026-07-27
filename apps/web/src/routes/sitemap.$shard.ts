import { createFileRoute } from "@tanstack/react-router";
import { buildSitemapShardXml, parseShard } from "../lib/sitemap";
import { collectSitemapBag, SITEMAP_HEADERS } from "../lib/server/sitemap-data";

// `/sitemap/<kind>-<n>.xml` — one child of the sitemap index. `kind` is one per entity type:
// pages / findings / artists / labels / albums / galaxies / logbook; `n` is 1-indexed and only
// ever exceeds 1 once a kind outgrows SITEMAP_MAX_URLS.
//
// It fetches ONLY its own bag (`collectSitemapBag(kind)`), never the other six — a labels child
// has no business reading every finding to print a label list. The index's counts come from the
// same reads' aggregates (`collectSitemapIndexStats`), so a child still serves exactly what the
// index promised.
//
// The `.xml` rides INSIDE the `$shard` param (the route is `/sitemap/$shard`, not
// `/sitemap/$shard.xml`) — a `$param.xml` segment makes TanStack name the param `shard.xml`,
// which is a trap rather than a feature. `parseShard` owns the whole segment, so the URL a
// crawler sees is unchanged and every malformed one falls into the same 404.
//
// A page past the end 404s rather than serving an empty `<urlset>`: an empty urlset tells a
// crawler the URLs were REMOVED, which is a different and much worse sentence than "there is
// no such sitemap".
//
// The 404 is a bare `Response`, not `notFound()` — inside a server handler that router throw
// serializes to a 200 with a JSON body, which to a crawler is an EMPTY, VALID sitemap. The
// docs/OG/embed handlers all take the same shape for the same reason.

function notFoundResponse(): Response {
  return new Response("Not found", { status: 404 });
}

export const Route = createFileRoute("/sitemap/$shard")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const shard = parseShard(params.shard);

        if (!shard) {
          return notFoundResponse();
        }

        const bag = await collectSitemapBag(shard.kind);
        const xml = buildSitemapShardXml(shard.kind, shard.page, bag);

        return xml ? new Response(xml, { headers: SITEMAP_HEADERS }) : notFoundResponse();
      },
    },
  },
});

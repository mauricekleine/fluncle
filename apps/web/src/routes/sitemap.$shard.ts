import { createFileRoute } from "@tanstack/react-router";
import { buildSitemapShardXml, parseShard } from "../lib/sitemap";
import { collectSitemapBag, SITEMAP_HEADERS } from "../lib/server/sitemap-data";

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

        const bag = await collectSitemapBag(shard.kind, shard.page);
        const xml = buildSitemapShardXml(shard.kind, shard.page, bag);

        return xml ? new Response(xml, { headers: SITEMAP_HEADERS }) : notFoundResponse();
      },
    },
  },
});

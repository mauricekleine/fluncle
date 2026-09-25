type ServerHandlers<Ctx> = { GET: (ctx: Ctx) => Promise<Response> };

export type RenderedSitemap = {
  indexXml: string;
  shards: string[];
  xml: string;
};

export async function renderSitemap(): Promise<RenderedSitemap> {
  const index = await import("../../routes/sitemap[.]xml");
  const child = await import("../../routes/sitemap.$shard");
  const indexHandlers = index.Route.options.server?.handlers as ServerHandlers<unknown> | undefined;
  const childHandlers = child.Route.options.server?.handlers as
    | ServerHandlers<{ params: { shard: string } }>
    | undefined;

  if (!indexHandlers || !childHandlers) {
    throw new Error("the sitemap routes have no GET handler");
  }

  const indexXml = await (await indexHandlers.GET({})).text();
  const shards = [...indexXml.matchAll(/\/sitemap\/([a-z]+-\d+\.xml)</g)].map(
    (match) => match[1] ?? "",
  );
  const bodies = await Promise.all(
    shards.map(async (shard) => (await childHandlers.GET({ params: { shard } })).text()),
  );

  return { indexXml, shards, xml: bodies.join("\n") };
}

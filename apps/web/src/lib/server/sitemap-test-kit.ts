// Render the WHOLE sitemap through its real route handlers — the index, then every child the
// index advertises — and hand back the joined XML.
//
// It exists because `/sitemap.xml` is a `<sitemapindex>` and carries no `<url>` of its own, so
// "is this URL in the sitemap?" is no longer a question one handler can answer. A test that
// only reads the index would pass while a child leaked a catalogue track into the world. Both
// the certification rail and the catalogue-scale suite drive through here so neither can be
// fooled that way.

type ServerHandlers<Ctx> = { GET: (ctx: Ctx) => Promise<Response> };

export type RenderedSitemap = {
  /** The `<sitemapindex>` document itself. */
  indexXml: string;
  /** Every child the index advertised, e.g. `["pages-1.xml", "findings-1.xml"]`. */
  shards: string[];
  /** Every child's body, joined — what a crawler would end up having read. */
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

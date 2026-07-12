import { describe, expect, it } from "vitest";
import { siteUrl } from "./fluncle-links";
import {
  buildSitemapIndexXml,
  buildSitemapShardXml,
  EMPTY_SITEMAP_BAGS,
  parseShard,
  shardCount,
  SITEMAP_KINDS,
  shardPath,
  type SitemapBags,
  SITEMAP_MAX_URLS,
} from "./sitemap";

function bags(overrides: Partial<SitemapBags> = {}): SitemapBags {
  return { ...EMPTY_SITEMAP_BAGS, ...overrides };
}

// Every `<loc>` the index would ever serve: walk every kind × every one of its pages and pull
// the URLs out. This is the "what does the sitemap actually list" question the split must not
// change the answer to.
function allSitemapLocs(source: SitemapBags): string[] {
  return SITEMAP_KINDS.flatMap((kind) =>
    Array.from({ length: shardCount(kind, source) }, (_unused, page) =>
      buildSitemapShardXml(kind, page + 1, source),
    )
      .filter((xml): xml is string => Boolean(xml))
      .flatMap((xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? "")),
  );
}

const LOGS = [
  { lastmod: "2026-06-10T14:57:38.786Z", logId: "011.6.8K" },
  { lastmod: "2026-06-03T10:00:00.000Z", logId: "004.7.2I" },
];

describe("the sitemap index", () => {
  it("carries no <url> of its own — only <sitemap> children", () => {
    const xml = buildSitemapIndexXml(bags({ logs: LOGS }));

    expect(xml).toContain("<sitemapindex");
    expect(xml).not.toContain("<url>");
    expect(xml).not.toContain("<urlset");
  });

  it("lists the hubs child and the findings child", () => {
    const xml = buildSitemapIndexXml(bags({ logs: LOGS }));

    expect(xml).toContain(`<loc>${siteUrl}/sitemap/pages-1.xml</loc>`);
    expect(xml).toContain(`<loc>${siteUrl}/sitemap/findings-1.xml</loc>`);
  });

  it("omits a child for a kind with nothing in it", () => {
    // An empty <urlset> tells a crawler the URLs were REMOVED; a missing sitemap says nothing.
    const xml = buildSitemapIndexXml(bags({ logs: LOGS }));

    for (const empty of [
      "artists-1.xml",
      "labels-1.xml",
      "albums-1.xml",
      "galaxies-1.xml",
      "logbook-1.xml",
    ]) {
      expect(xml).not.toContain(empty);
    }
    // The retired `graph` bucket is gone — never advertise it.
    expect(xml).not.toContain("graph-");
  });

  it("lists a child per NON-EMPTY entity type, each on its own line", () => {
    // The whole point of the split: artists / labels / albums / galaxies are four children, not
    // one `graph`, so GSC reports each type's submitted/indexed count on its own.
    const xml = buildSitemapIndexXml(
      bags({
        albums: [{ lastmod: "2026-05-01T00:00:00.000Z", slug: "wormhole" }],
        artists: [{ lastmod: "2026-06-01T00:00:00.000Z", slug: "dimension" }],
        galaxies: [{ slug: "deep-roller" }],
        labels: [{ lastmod: "2026-04-01T00:00:00.000Z", slug: "medschool" }],
        logbook: [{ lastmod: "2026-07-04T02:11:00.000Z", sector: "036" }],
        logs: LOGS,
      }),
    );

    for (const child of [
      "pages-1.xml",
      "findings-1.xml",
      "artists-1.xml",
      "labels-1.xml",
      "albums-1.xml",
      "galaxies-1.xml",
      "logbook-1.xml",
    ]) {
      expect(xml).toContain(`<loc>${siteUrl}/sitemap/${child}</loc>`);
    }
  });

  it("dates each entity-type child from its own freshest member", () => {
    const xml = buildSitemapIndexXml(
      bags({
        artists: [
          { lastmod: "2026-06-01T00:00:00.000Z", slug: "dimension" },
          { lastmod: "2026-06-20T00:00:00.000Z", slug: "calibre" },
        ],
        labels: [{ lastmod: "2026-04-01T00:00:00.000Z", slug: "medschool" }],
      }),
    );

    // The artists child dates from its freshest artist; the labels child from its own.
    expect(xml.slice(xml.indexOf("artists-1.xml"), xml.indexOf("labels-1.xml"))).toContain(
      "<lastmod>2026-06-20T00:00:00.000Z</lastmod>",
    );
    expect(xml.slice(xml.indexOf("labels-1.xml"))).toContain(
      "<lastmod>2026-04-01T00:00:00.000Z</lastmod>",
    );
  });

  it("leaves a galaxies child undated — the lens page has no honest lastmod", () => {
    const xml = buildSitemapIndexXml(bags({ galaxies: [{ slug: "deep-roller" }] }));
    const galaxiesLine = xml.slice(xml.indexOf("galaxies-1.xml"));

    expect(galaxiesLine).toContain("galaxies-1.xml");
    // The <sitemap> block ends at the next </sitemap>; it must carry no <lastmod>.
    expect(galaxiesLine.slice(0, galaxiesLine.indexOf("</sitemap>"))).not.toContain("<lastmod>");
  });

  it("always lists the hubs child, even on an empty archive", () => {
    expect(buildSitemapIndexXml(EMPTY_SITEMAP_BAGS)).toContain("pages-1.xml");
  });

  it("dates each child from its own freshest entry, never a build stamp", () => {
    const xml = buildSitemapIndexXml(bags({ logs: LOGS }));

    expect(xml.slice(xml.indexOf("findings-1.xml"))).toContain(
      "<lastmod>2026-06-10T14:57:38.786Z</lastmod>",
    );
  });

  it("grows a SECOND child rather than breaching Google's 50,000-URL limit", () => {
    const many = Array.from({ length: SITEMAP_MAX_URLS + 1 }, (_unused, index) => ({
      lastmod: "2026-06-10T14:57:38.786Z",
      logId: `0${index}.6.8K`,
    }));
    const xml = buildSitemapIndexXml(bags({ logs: many }));

    expect(shardCount("findings", bags({ logs: many }))).toBe(2);
    expect(xml).toContain("findings-1.xml");
    expect(xml).toContain("findings-2.xml");
  });
});

describe("a child sitemap", () => {
  it("puts the static hubs in `pages`", () => {
    const xml = buildSitemapShardXml("pages", 1, bags({ logs: LOGS })) ?? "";

    for (const hub of ["/", "/log", "/logbook", "/mixtapes", "/artists", "/labels", "/albums"]) {
      expect(xml).toContain(`<loc>${siteUrl}${hub}</loc>`);
    }

    expect(xml).toContain(`<loc>${siteUrl}/about</loc>`);
    expect(xml).toContain(`<loc>${siteUrl}/privacy</loc>`);
    expect(xml).toContain(`<loc>${siteUrl}/galaxy</loc>`);
    // 10 hubs; /galaxies is gated on the map being named.
    expect(xml.match(/<loc>/g)).toHaveLength(10);
  });

  it("puts one <loc> per /log page in `findings`, and nothing else", () => {
    const xml = buildSitemapShardXml("findings", 1, bags({ logs: LOGS })) ?? "";

    expect(xml).toContain(`<loc>${siteUrl}/log/011.6.8K</loc>`);
    expect(xml).toContain(`<loc>${siteUrl}/log/004.7.2I</loc>`);
    expect(xml.match(/<loc>/g)).toHaveLength(2);
  });

  it("uses the per-finding lastmod, never a build stamp", () => {
    const xml = buildSitemapShardXml("findings", 1, bags({ logs: LOGS })) ?? "";

    expect(xml.slice(xml.indexOf("004.7.2I"))).toContain(
      "<lastmod>2026-06-03T10:00:00.000Z</lastmod>",
    );
  });

  it("gives the hubs the newest finding's lastmod", () => {
    const xml = buildSitemapShardXml("pages", 1, bags({ logs: LOGS })) ?? "";

    expect(xml.slice(0, xml.indexOf("/log<"))).toContain(
      "<lastmod>2026-06-10T14:57:38.786Z</lastmod>",
    );
  });

  it("omits lastmod entirely when there is nothing honest to say", () => {
    expect(buildSitemapShardXml("pages", 1, EMPTY_SITEMAP_BAGS)).not.toContain("<lastmod>");
  });

  it("puts artists in their OWN child, and nothing else in it", () => {
    const graphBags = bags({
      albums: [{ slug: "wormhole" }],
      artists: [{ imageLoc: "https://img/dimension.jpg", slug: "dimension" }],
      galaxies: [{ slug: "deep-roller" }],
      labels: [{ slug: "medschool" }],
    });
    const xml = buildSitemapShardXml("artists", 1, graphBags) ?? "";

    expect(xml).toContain(`<loc>${siteUrl}/artist/dimension</loc>`);
    expect(xml).toContain("<image:loc>https://img/dimension.jpg</image:loc>");
    // The artists child carries ONLY artists — no label / album / galaxy leaks across the split.
    expect(xml).not.toContain("/label/");
    expect(xml).not.toContain("/album/");
    expect(xml).not.toContain("/galaxies/");
    expect(xml.match(/<loc>/g)).toHaveLength(1);
  });

  it("puts labels, albums and galaxies each in their own child", () => {
    const graphBags = bags({
      albums: [{ slug: "wormhole" }],
      artists: [{ slug: "dimension" }],
      galaxies: [{ slug: "deep-roller" }],
      labels: [{ slug: "medschool" }],
    });

    expect(buildSitemapShardXml("labels", 1, graphBags)).toContain(
      `<loc>${siteUrl}/label/medschool</loc>`,
    );
    expect(buildSitemapShardXml("albums", 1, graphBags)).toContain(
      `<loc>${siteUrl}/album/wormhole</loc>`,
    );
    expect(buildSitemapShardXml("galaxies", 1, graphBags)).toContain(
      `<loc>${siteUrl}/galaxies/deep-roller</loc>`,
    );
    // Each entity-type child carries exactly its own one <loc>.
    for (const kind of ["labels", "albums", "galaxies"] as const) {
      expect(buildSitemapShardXml(kind, 1, graphBags)?.match(/<loc>/g)).toHaveLength(1);
    }
  });

  it("lists the /galaxies hub only once the map is named", () => {
    const dark = buildSitemapShardXml("pages", 1, EMPTY_SITEMAP_BAGS) ?? "";
    const lit =
      buildSitemapShardXml("pages", 1, bags({ galaxies: [{ slug: "deep-roller" }] })) ?? "";

    expect(dark).not.toContain(`<loc>${siteUrl}/galaxies</loc>`);
    expect(lit).toContain(`<loc>${siteUrl}/galaxies</loc>`);
  });

  it("puts one <loc> per authored sector-day in `logbook`", () => {
    const xml =
      buildSitemapShardXml(
        "logbook",
        1,
        bags({ logbook: [{ lastmod: "2026-07-04T02:11:00.000Z", sector: "036" }] }),
      ) ?? "";

    expect(xml).toContain(`<loc>${siteUrl}/logbook/036</loc>`);
    expect(xml).toContain("<lastmod>2026-07-04T02:11:00.000Z</lastmod>");
  });

  it("declares the image + video namespaces on the urlset", () => {
    const xml = buildSitemapShardXml("findings", 1, bags({ logs: LOGS })) ?? "";

    expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
  });

  it("emits an <image:image> cover per finding that carries one", () => {
    const xml =
      buildSitemapShardXml(
        "findings",
        1,
        bags({
          logs: [
            {
              imageLoc: "https://i.scdn.co/image/abc",
              lastmod: "2026-06-10T14:57:38.786Z",
              logId: "011.6.8K",
            },
          ],
        }),
      ) ?? "";

    expect(xml).toContain("<image:image>");
    expect(xml).toContain("<image:loc>https://i.scdn.co/image/abc</image:loc>");
  });

  it("emits a <video:video> block in Google's required field order", () => {
    const xml =
      buildSitemapShardXml(
        "findings",
        1,
        bags({
          logs: [
            {
              lastmod: "2026-06-10T14:57:38.786Z",
              logId: "011.6.8K",
              video: {
                contentLoc: "https://media.fluncle.com/011.6.8K/footage.mp4",
                description: "A roller.",
                thumbnailLoc: "https://media.fluncle.com/011.6.8K/cover.jpg",
                title: "Dimension — Wormhole",
              },
            },
          ],
        }),
      ) ?? "";

    expect(xml.indexOf("<video:thumbnail_loc>")).toBeLessThan(xml.indexOf("<video:title>"));
    expect(xml.indexOf("<video:title>")).toBeLessThan(xml.indexOf("<video:description>"));
    expect(xml.indexOf("<video:description>")).toBeLessThan(xml.indexOf("<video:content_loc>"));
  });

  it("XML-escapes the video title and description", () => {
    const xml =
      buildSitemapShardXml(
        "findings",
        1,
        bags({
          logs: [
            {
              lastmod: "2026-06-10T14:57:38.786Z",
              logId: "011.6.8K",
              video: {
                contentLoc: "https://media.fluncle.com/011.6.8K/footage.mp4",
                description: "A <banger> & a half",
                thumbnailLoc: "https://media.fluncle.com/011.6.8K/cover.jpg",
                title: "Culture Shock & Sub Focus",
              },
            },
          ],
        }),
      ) ?? "";

    expect(xml).toContain("<video:title>Culture Shock &amp; Sub Focus</video:title>");
    expect(xml).toContain("<video:description>A &lt;banger&gt; &amp; a half</video:description>");
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("omits image + video for a plain page (a mixtape with no set video)", () => {
    const xml =
      buildSitemapShardXml(
        "findings",
        1,
        bags({ logs: [{ lastmod: "2026-06-10T14:57:38.786Z", logId: "019.F.1A" }] }),
      ) ?? "";

    expect(xml).not.toContain("<image:image>");
    expect(xml).not.toContain("<video:video>");
  });

  it("404s (undefined) a page past the end rather than serving an empty urlset", () => {
    expect(buildSitemapShardXml("findings", 2, bags({ logs: LOGS }))).toBeUndefined();
    expect(buildSitemapShardXml("logbook", 1, EMPTY_SITEMAP_BAGS)).toBeUndefined();
  });

  it("caps a child at SITEMAP_MAX_URLS and spills the rest into the next", () => {
    const many = Array.from({ length: SITEMAP_MAX_URLS + 3 }, (_unused, index) => ({
      lastmod: "2026-06-10T14:57:38.786Z",
      logId: `0${index}.6.8K`,
    }));

    expect(buildSitemapShardXml("findings", 1, bags({ logs: many }))?.match(/<loc>/g)).toHaveLength(
      SITEMAP_MAX_URLS,
    );
    expect(buildSitemapShardXml("findings", 2, bags({ logs: many }))?.match(/<loc>/g)).toHaveLength(
      3,
    );
  });

  it("keyset-paginates a NON-findings entity type past SITEMAP_MAX_URLS too", () => {
    // Pagination is built into every kind, not just findings — an artist space that outgrows a
    // child grows a second one exactly the same way, so the machinery is proven per type.
    const manyArtists = Array.from({ length: SITEMAP_MAX_URLS + 2 }, (_unused, index) => ({
      lastmod: "2026-06-10T14:57:38.786Z",
      slug: `artist-${index}`,
    }));
    const artistBags = bags({ artists: manyArtists });

    expect(shardCount("artists", artistBags)).toBe(2);
    expect(buildSitemapShardXml("artists", 1, artistBags)?.match(/<loc>/g)).toHaveLength(
      SITEMAP_MAX_URLS,
    );
    expect(buildSitemapShardXml("artists", 2, artistBags)?.match(/<loc>/g)).toHaveLength(2);
    expect(buildSitemapShardXml("artists", 3, artistBags)).toBeUndefined();
    // The index advertises both artist children.
    const index = buildSitemapIndexXml(artistBags);
    expect(index).toContain("artists-1.xml");
    expect(index).toContain("artists-2.xml");
  });
});

describe("shard paths", () => {
  it("round-trips a path through parseShard", () => {
    expect(shardPath("findings", 2)).toBe("/sitemap/findings-2.xml");
    expect(parseShard("findings-2.xml")).toEqual({ kind: "findings", page: 2 });
  });

  it("rejects anything that is not a known kind + a 1-indexed page", () => {
    expect(parseShard("nonsense-1.xml")).toBeUndefined();
    expect(parseShard("findings.xml")).toBeUndefined();
    expect(parseShard("findings-0.xml")).toBeUndefined();
    expect(parseShard("findings-x.xml")).toBeUndefined();
    expect(parseShard("findings-1")).toBeUndefined();
    expect(parseShard("../../etc/passwd")).toBeUndefined();
  });
});

describe("the URL set is preserved across the split", () => {
  // A fully-populated archive: one member of every kind, so the union covers every path shape.
  const FULL = bags({
    albums: [{ slug: "wormhole" }],
    artists: [{ slug: "dimension" }],
    galaxies: [{ slug: "deep-roller" }],
    labels: [{ slug: "medschool" }],
    logbook: [{ lastmod: "2026-07-04T02:11:00.000Z", sector: "036" }],
    logs: LOGS,
  });

  it("emits exactly the union of static hubs + findings + every graph entity + logbook", () => {
    // The diff proof: splitting the old `graph` child into artists/labels/albums/galaxies must
    // not add or drop a single URL. This is the whole known URL space, spelled out.
    const expected = new Set([
      // pages (the static hubs — /galaxies is lit because the map is named here)
      `${siteUrl}/`,
      `${siteUrl}/log`,
      `${siteUrl}/logbook`,
      `${siteUrl}/mixtapes`,
      `${siteUrl}/artists`,
      `${siteUrl}/labels`,
      `${siteUrl}/albums`,
      `${siteUrl}/about`,
      `${siteUrl}/privacy`,
      `${siteUrl}/galaxy`,
      `${siteUrl}/galaxies`,
      // findings
      `${siteUrl}/log/011.6.8K`,
      `${siteUrl}/log/004.7.2I`,
      // the graph entities, now each in its own child
      `${siteUrl}/artist/dimension`,
      `${siteUrl}/label/medschool`,
      `${siteUrl}/album/wormhole`,
      `${siteUrl}/galaxies/deep-roller`,
      // logbook
      `${siteUrl}/logbook/036`,
    ]);

    const locs = allSitemapLocs(FULL);

    // No duplicates, and the set matches exactly — nothing lost, nothing doubled.
    expect(locs).toHaveLength(expected.size);
    expect(new Set(locs)).toEqual(expected);
  });

  it("keeps every graph entity's <loc> that the single `graph` child used to carry", () => {
    // The four per-entity children, unioned, are exactly what a `graph` bucket held — the four
    // entity URLs, no more, no less.
    const graphLocs = (["artists", "labels", "albums", "galaxies"] as const).flatMap((kind) => {
      const xml = buildSitemapShardXml(kind, 1, FULL) ?? "";

      return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? "");
    });

    expect(new Set(graphLocs)).toEqual(
      new Set([
        `${siteUrl}/artist/dimension`,
        `${siteUrl}/label/medschool`,
        `${siteUrl}/album/wormhole`,
        `${siteUrl}/galaxies/deep-roller`,
      ]),
    );
  });
});

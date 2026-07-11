import { describe, expect, it } from "vitest";
import { siteUrl } from "./fluncle-links";
import {
  buildSitemapIndexXml,
  buildSitemapShardXml,
  EMPTY_SITEMAP_BAGS,
  parseShard,
  shardCount,
  shardPath,
  type SitemapBags,
  SITEMAP_MAX_URLS,
} from "./sitemap";

function bags(overrides: Partial<SitemapBags> = {}): SitemapBags {
  return { ...EMPTY_SITEMAP_BAGS, ...overrides };
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

    expect(xml).not.toContain("logbook-1.xml");
    expect(xml).not.toContain("graph-1.xml");
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

  it("collects artists, labels, albums and galaxies into `graph`", () => {
    const xml =
      buildSitemapShardXml(
        "graph",
        1,
        bags({
          albums: [{ slug: "wormhole" }],
          artists: [{ imageLoc: "https://img/dimension.jpg", slug: "dimension" }],
          galaxies: [{ slug: "deep-roller" }],
          labels: [{ slug: "medschool" }],
        }),
      ) ?? "";

    expect(xml).toContain(`<loc>${siteUrl}/artist/dimension</loc>`);
    expect(xml).toContain(`<loc>${siteUrl}/label/medschool</loc>`);
    expect(xml).toContain(`<loc>${siteUrl}/album/wormhole</loc>`);
    expect(xml).toContain(`<loc>${siteUrl}/galaxies/deep-roller</loc>`);
    expect(xml).toContain("<image:loc>https://img/dimension.jpg</image:loc>");
    expect(xml.match(/<loc>/g)).toHaveLength(4);
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

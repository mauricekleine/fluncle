import { describe, expect, it } from "vitest";
import { siteUrl } from "./fluncle-links";
import { buildSitemapXml } from "./sitemap";

describe("buildSitemapXml (sitemap enumeration)", () => {
  // The always-listed hubs: /, /log, /logbook, /mixtapes, /artists, /labels, /albums,
  // /about, /privacy, /galaxy. (/galaxies is gated on the map being named.)
  const STATIC_SURFACES = 10;

  const pages = [
    { lastmod: "2026-06-10T14:57:38.786Z", logId: "011.6.8K" },
    { lastmod: "2026-06-03T10:00:00.000Z", logId: "004.7.2I" },
  ];

  it("enumerates one <loc> per log page plus the static surfaces", () => {
    const xml = buildSitemapXml(pages);

    expect(xml).toContain("<loc>https://www.fluncle.com/</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/log</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/logbook</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/mixtapes</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/artists</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/about</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/privacy</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/galaxy</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/log/011.6.8K</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/log/004.7.2I</loc>");
    expect(xml.match(/<loc>/g)).toHaveLength(STATIC_SURFACES + pages.length);
  });

  it("always includes the /galaxy surface", () => {
    expect(buildSitemapXml(pages)).toContain(`<loc>${siteUrl}/galaxy</loc>`);
    expect(buildSitemapXml([])).toContain(`<loc>${siteUrl}/galaxy</loc>`);
  });

  it("uses the per-finding lastmod, never a build stamp", () => {
    const xml = buildSitemapXml(pages);
    const entry = xml.slice(xml.indexOf("004.7.2I"));

    expect(entry).toContain("<lastmod>2026-06-03T10:00:00.000Z</lastmod>");
  });

  it("gives the home and index the newest finding's lastmod", () => {
    const xml = buildSitemapXml(pages);
    const home = xml.slice(0, xml.indexOf("/log<"));

    expect(home).toContain("<lastmod>2026-06-10T14:57:38.786Z</lastmod>");
  });

  it("omits lastmod entirely when there is nothing honest to say", () => {
    const xml = buildSitemapXml([]);

    expect(xml).not.toContain("<lastmod>");
    expect(xml.match(/<loc>/g)).toHaveLength(STATIC_SURFACES);
  });

  it("appends a <loc> per artist page (thin-gated upstream) with its cover + lastmod", () => {
    const xml = buildSitemapXml(pages, [
      {
        imageLoc: "https://img/dimension.jpg",
        lastmod: "2026-06-09T00:00:00.000Z",
        slug: "dimension",
      },
      { slug: "sub-focus" },
    ]);

    expect(xml).toContain("<loc>https://www.fluncle.com/artist/dimension</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/artist/sub-focus</loc>");
    expect(xml).toContain("<image:loc>https://img/dimension.jpg</image:loc>");
    // The static surfaces + 2 findings + 2 artists.
    expect(xml.match(/<loc>/g)).toHaveLength(STATIC_SURFACES + pages.length + 2);
  });

  it("appends a <loc> per logbook entry with its generated-at lastmod", () => {
    const xml = buildSitemapXml(
      pages,
      [],
      [{ lastmod: "2026-07-05T00:00:00.000Z", sector: "036" }, { sector: "037" }],
    );

    expect(xml).toContain("<loc>https://www.fluncle.com/logbook/036</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/logbook/037</loc>");
    // The /logbook index takes the freshest entry's lastmod.
    const index = xml.slice(0, xml.indexOf("/logbook/036"));
    expect(index).toContain("<loc>https://www.fluncle.com/logbook</loc>");
    // The static surfaces + 2 findings + 2 logbook entries.
    expect(xml.match(/<loc>/g)).toHaveLength(STATIC_SURFACES + pages.length + 2);
  });

  it("adds the /galaxies index + a <loc> per galaxy only once the map is named (gated upstream)", () => {
    // No galaxy pages (the pre-launch dark state): neither /galaxies nor any galaxy loc.
    const dark = buildSitemapXml(pages, [], [], []);
    expect(dark).not.toContain(`<loc>${siteUrl}/galaxies</loc>`);
    expect(dark).not.toContain(`<loc>${siteUrl}/galaxies/`);

    // Named + thin-gated upstream: the index static entry plus one loc per galaxy.
    const live = buildSitemapXml(
      pages,
      [],
      [],
      [{ slug: "the-liquid-deep" }, { slug: "weightless-rollers" }],
    );
    expect(live).toContain(`<loc>${siteUrl}/galaxies</loc>`);
    expect(live).toContain(`<loc>${siteUrl}/galaxies/the-liquid-deep</loc>`);
    expect(live).toContain(`<loc>${siteUrl}/galaxies/weightless-rollers</loc>`);
    // The static surfaces + the /galaxies index + 2 findings + 2 galaxies.
    expect(live.match(/<loc>/g)).toHaveLength(STATIC_SURFACES + 1 + pages.length + 2);
  });

  it("declares the image + video namespaces on the urlset", () => {
    const xml = buildSitemapXml(pages);

    expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
  });

  it("emits an <image:image> cover per finding that carries one", () => {
    const xml = buildSitemapXml([
      {
        imageLoc: "https://found.fluncle.com/011.6.8K/cover.jpg",
        lastmod: "2026-06-10T14:57:38.786Z",
        logId: "011.6.8K",
      },
    ]);

    expect(xml).toContain(
      "<image:image>\n      <image:loc>https://found.fluncle.com/011.6.8K/cover.jpg</image:loc>\n    </image:image>",
    );
  });

  it("emits a well-formed <video:video> block for a finding with footage", () => {
    const xml = buildSitemapXml([
      {
        imageLoc: "https://found.fluncle.com/011.6.8K/cover.jpg",
        lastmod: "2026-06-10T14:57:38.786Z",
        logId: "011.6.8K",
        video: {
          contentLoc: "https://found.fluncle.com/011.6.8K/footage.mp4",
          description: "A rolling 174 BPM banger.",
          thumbnailLoc: "https://found.fluncle.com/011.6.8K/cover.jpg",
          title: "Artist — Title",
        },
      },
    ]);

    // Google's required field order: thumbnail_loc, title, description, content_loc.
    const block = xml.slice(xml.indexOf("<video:video>"), xml.indexOf("</video:video>"));
    const order = [
      block.indexOf("<video:thumbnail_loc>"),
      block.indexOf("<video:title>"),
      block.indexOf("<video:description>"),
      block.indexOf("<video:content_loc>"),
    ];

    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(xml).toContain(
      "<video:content_loc>https://found.fluncle.com/011.6.8K/footage.mp4</video:content_loc>",
    );
  });

  it("XML-escapes the video title and description (no unescaped & or <)", () => {
    const xml = buildSitemapXml([
      {
        lastmod: "2026-06-10T14:57:38.786Z",
        logId: "011.6.8K",
        video: {
          contentLoc: "https://found.fluncle.com/011.6.8K/footage.mp4",
          description: 'Tom & Jerry <vibes> with a "quote".',
          thumbnailLoc: "https://found.fluncle.com/011.6.8K/cover.jpg",
          title: "A & B — <Title>",
        },
      },
    ]);

    expect(xml).toContain("<video:title>A &amp; B — &lt;Title&gt;</video:title>");
    expect(xml).toContain(
      "<video:description>Tom &amp; Jerry &lt;vibes&gt; with a &quot;quote&quot;.</video:description>",
    );
    // No raw metacharacter survives inside the escaped fields.
    expect(xml).not.toContain("A & B");
    expect(xml).not.toContain("<Title>");
  });

  it("omits image + video for a plain page (a mixtape)", () => {
    const xml = buildSitemapXml([{ lastmod: "2026-06-10T14:57:38.786Z", logId: "006.F.01" }]);

    expect(xml).not.toContain("<image:image>");
    expect(xml).not.toContain("<video:video>");
    expect(xml).toContain("<loc>https://www.fluncle.com/log/006.F.01</loc>");
  });
  it("appends a <loc> per graph page (labels + albums) with its cover, and lists their hubs", () => {
    const xml = buildSitemapXml([], [], [], [], {
      albums: [{ imageLoc: "https://i.scdn.co/image/album", slug: "wormhole" }],
      labels: [
        {
          imageLoc: "https://i.scdn.co/image/cover",
          lastmod: "2026-07-01T00:00:00.000Z",
          slug: "hospital-records",
        },
      ],
    });

    expect(xml).toContain("<loc>https://www.fluncle.com/label/hospital-records</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/album/wormhole</loc>");
    expect(xml).toContain("<image:loc>https://i.scdn.co/image/cover</image:loc>");
  });

  it("keeps the thin DETAIL pages out while still listing their hubs", () => {
    // The gate runs upstream (the route filters), so a run with no admitted entity pages is
    // exactly what a thin archive produces — today every album in the archive is a single,
    // so NO album detail page clears the floor. The hub is still a real page (its content is
    // the whole list), so it is listed unconditionally, like /artists.
    const xml = buildSitemapXml([{ lastmod: "2026-06-10T14:57:38.786Z", logId: "006.F.01" }]);

    expect(xml).toContain("<loc>https://www.fluncle.com/labels</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/albums</loc>");
    expect(xml).not.toContain("/label/");
    expect(xml).not.toContain("/album/");
  });
});

import { describe, expect, it } from "vitest";
import { siteUrl } from "./fluncle-links";
import { buildSitemapXml } from "./sitemap";

describe("buildSitemapXml (sitemap enumeration)", () => {
  const pages = [
    { lastmod: "2026-06-10T14:57:38.786Z", logId: "011.6.8K" },
    { lastmod: "2026-06-03T10:00:00.000Z", logId: "004.7.2I" },
  ];

  it("enumerates one <loc> per log page plus the static surfaces", () => {
    const xml = buildSitemapXml(pages);

    expect(xml).toContain("<loc>https://www.fluncle.com/</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/log</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/mixtapes</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/about</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/galaxy</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/log/011.6.8K</loc>");
    expect(xml).toContain("<loc>https://www.fluncle.com/log/004.7.2I</loc>");
    expect(xml.match(/<loc>/g)).toHaveLength(5 + pages.length);
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
    expect(xml.match(/<loc>/g)).toHaveLength(5);
  });
});

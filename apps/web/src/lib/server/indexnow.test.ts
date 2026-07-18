import { describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/fluncle-links";
import {
  buildFindingIndexNowUrls,
  buildIndexNowPayload,
  INDEXNOW_KEY,
} from "@/lib/server/indexnow";

// The payload shape is the one load-bearing, easy-to-get-wrong bit: the host and
// keyLocation must point at the same canonical host as the submitted URLs, or the
// engine rejects the batch. These pin that against the published key file path.
describe("buildIndexNowPayload", () => {
  it("uses the canonical host, the public key, and the matching key file URL", () => {
    const url = "https://www.fluncle.com/log/004.7.2I";
    const payload = buildIndexNowPayload([url]);

    expect(payload).toStrictEqual({
      host: "www.fluncle.com",
      key: INDEXNOW_KEY,
      keyLocation: `https://www.fluncle.com/${INDEXNOW_KEY}.txt`,
      urlList: [url],
    });
  });

  it("commits a 32-char lowercase-hex ownership key (a public token, not a secret)", () => {
    expect(INDEXNOW_KEY).toMatch(/^[0-9a-f]{32}$/);
  });

  it("passes the URL list through verbatim", () => {
    const urls = ["https://www.fluncle.com/log/a", "https://www.fluncle.com/log/b"];

    expect(buildIndexNowPayload(urls).urlList).toEqual(urls);
  });
});

// A publish stales the finding's whole graph, so IndexNow should ask the engines to recrawl
// exactly that set — the log page, every entity page it joins, and the /fresh lens — not just
// the coordinate page. This pins the batch composition against the purge's own targets.
describe("buildFindingIndexNowUrls", () => {
  it("batches the log page, its graph pages, and the /fresh lens", () => {
    const urls = buildFindingIndexNowUrls("004.7.2I", [
      { kind: "artist", slug: "dimension" },
      { kind: "album", slug: "wormhole" },
      { kind: "label", slug: "medschool" },
    ]);

    expect(urls).toEqual([
      `${siteUrl}/log/004.7.2I`,
      `${siteUrl}/artist/dimension`,
      `${siteUrl}/album/wormhole`,
      `${siteUrl}/label/medschool`,
      `${siteUrl}/fresh`,
    ]);
  });

  it("carries several artist pages when a finding has several artists", () => {
    const urls = buildFindingIndexNowUrls("011.6.8K", [
      { kind: "artist", slug: "culture-shock" },
      { kind: "artist", slug: "sub-focus" },
    ]);

    expect(urls).toContain(`${siteUrl}/artist/culture-shock`);
    expect(urls).toContain(`${siteUrl}/artist/sub-focus`);
  });

  it("falls back to just the log page + /fresh when a finding joins no graph pages", () => {
    // A crawler-born row with no linked slugs yet: the log page and the lens still get pinged.
    expect(buildFindingIndexNowUrls("019.F.1A", [])).toEqual([
      `${siteUrl}/log/019.F.1A`,
      `${siteUrl}/fresh`,
    ]);
  });

  it("dedupes so a repeated target is submitted once", () => {
    const urls = buildFindingIndexNowUrls("004.7.2I", [
      { kind: "artist", slug: "dimension" },
      { kind: "artist", slug: "dimension" },
    ]);

    expect(urls.filter((url) => url === `${siteUrl}/artist/dimension`)).toHaveLength(1);
  });
});

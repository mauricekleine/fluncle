import { describe, expect, it } from "bun:test";

import { buildMixtapeCoverUrl, MIXTAPE_COVER_VERSION } from "./mixtape-cover";

describe("buildMixtapeCoverUrl", () => {
  it("defaults to the square size and stamps the cover version", () => {
    expect(buildMixtapeCoverUrl("https://www.fluncle.com", "007.F.01")).toBe(
      `https://www.fluncle.com/api/mixtape-cover/007.F.01?size=square&v=${MIXTAPE_COVER_VERSION}`,
    );
  });

  it("carries every requested size into the query", () => {
    for (const size of ["card", "og", "square", "thumb", "wide"] as const) {
      const url = new URL(buildMixtapeCoverUrl("https://www.fluncle.com", "007.F.01", size));

      expect(url.searchParams.get("size")).toBe(size);
      expect(url.searchParams.get("v")).toBe(String(MIXTAPE_COVER_VERSION));
    }
  });

  it("encodes the log id as one path segment", () => {
    const url = new URL(buildMixtapeCoverUrl("https://www.fluncle.com", "a/b?c#d"));

    expect(url.pathname).toBe("/api/mixtape-cover/a%2Fb%3Fc%23d");
    expect(url.searchParams.get("size")).toBe("square");
  });
});

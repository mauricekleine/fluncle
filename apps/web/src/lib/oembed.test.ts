import { describe, expect, it } from "vitest";
import {
  buildLinkResponse,
  buildRichEmbed,
  OEMBED_PROVIDER_NAME,
  OEMBED_PROVIDER_URL,
  parseOembedTarget,
} from "./oembed";

describe("parseOembedTarget", () => {
  it("maps a finding /log/<logId> URL to a log target", () => {
    expect(parseOembedTarget("https://www.fluncle.com/log/004.7.2I")).toEqual({
      kind: "log",
      logId: "004.7.2I",
    });
  });

  it("maps a mixtape /log/<F-logId> URL to a log target (findings + mixtapes share the route)", () => {
    expect(parseOembedTarget("https://www.fluncle.com/log/004.F.1A")).toEqual({
      kind: "log",
      logId: "004.F.1A",
    });
  });

  it("maps an /artist/<slug> URL to an artist target", () => {
    expect(parseOembedTarget("https://www.fluncle.com/artist/dbridge")).toEqual({
      kind: "artist",
      slug: "dbridge",
    });
  });

  it("maps the /mixtapes index to a mixtapes target", () => {
    expect(parseOembedTarget("https://www.fluncle.com/mixtapes")).toEqual({ kind: "mixtapes" });
  });

  it("accepts the apex host and a trailing slash", () => {
    expect(parseOembedTarget("https://fluncle.com/mixtapes/")).toEqual({ kind: "mixtapes" });
    expect(parseOembedTarget("https://fluncle.com/log/004.7.2I")).toEqual({
      kind: "log",
      logId: "004.7.2I",
    });
  });

  it("decodes a percent-encoded path segment", () => {
    expect(parseOembedTarget("https://www.fluncle.com/artist/goldie%20lookin")).toEqual({
      kind: "artist",
      slug: "goldie lookin",
    });
  });

  it("rejects an off-host URL", () => {
    expect(parseOembedTarget("https://evil.example.com/log/004.7.2I")).toBeUndefined();
    expect(parseOembedTarget("https://galaxy.fluncle.com/log/004.7.2I")).toBeUndefined();
  });

  it("rejects a malformed URL", () => {
    expect(parseOembedTarget("not a url")).toBeUndefined();
    expect(parseOembedTarget("")).toBeUndefined();
  });

  it("rejects an unrecognized page shape", () => {
    expect(parseOembedTarget("https://www.fluncle.com/")).toBeUndefined();
    expect(parseOembedTarget("https://www.fluncle.com/about")).toBeUndefined();
    expect(parseOembedTarget("https://www.fluncle.com/log")).toBeUndefined();
    expect(parseOembedTarget("https://www.fluncle.com/log/a/b")).toBeUndefined();
  });
});

describe("buildRichEmbed", () => {
  const base = {
    authorName: "dBridge",
    logId: "004.7.2I",
    thumbnailUrl: "https://www.fluncle.com/api/og/004.7.2I",
    title: "dBridge — Inner Disbelief",
  };

  it("returns a spec-shaped rich envelope with an iframe at /embed/<logId>", () => {
    const payload = buildRichEmbed(base);

    expect(payload.version).toBe("1.0");
    expect(payload.type).toBe("rich");
    expect(payload.provider_name).toBe(OEMBED_PROVIDER_NAME);
    expect(payload.provider_url).toBe(OEMBED_PROVIDER_URL);
    expect(payload.title).toBe(base.title);
    expect(payload.author_name).toBe("dBridge");
    expect(payload.thumbnail_url).toBe(base.thumbnailUrl);
    expect(payload.thumbnail_width).toBe(1200);
    expect(payload.thumbnail_height).toBe(630);
    expect(payload.html).toContain('src="https://www.fluncle.com/embed/004.7.2I"');
    expect(payload.html).toContain(`width="${payload.width}"`);
    expect(payload.html).toContain(`height="${payload.height}"`);
  });

  it("defaults the box and honors maxwidth/maxheight as ceilings", () => {
    expect(buildRichEmbed(base).width).toBe(550);
    expect(buildRichEmbed(base).height).toBe(240);

    const capped = buildRichEmbed({ ...base, maxheight: 200, maxwidth: 400 });
    expect(capped.width).toBe(400);
    expect(capped.height).toBe(200);

    // Never grown past the default, and never shrunk below the floor.
    const oversized = buildRichEmbed({ ...base, maxwidth: 5000 });
    expect(oversized.width).toBe(550);
    const tiny = buildRichEmbed({ ...base, maxwidth: 10 });
    expect(tiny.width).toBe(240);
  });

  it("escapes the title in the iframe attribute (no attribute breakout)", () => {
    const payload = buildRichEmbed({
      ...base,
      title: 'Bad " onload="alert(1)" title="pwn',
    });

    expect(payload.html).not.toContain('onload="alert(1)"');
    expect(payload.html).toContain("&quot;");
  });

  it("omits thumbnail dimensions when there is no thumbnail", () => {
    const payload = buildRichEmbed({ logId: "004.7.2I", title: "t" });
    expect(payload.thumbnail_url).toBeUndefined();
    expect(payload.thumbnail_width).toBeUndefined();
  });
});

describe("buildLinkResponse", () => {
  it("returns a spec-shaped link envelope with no html", () => {
    const payload = buildLinkResponse({
      authorName: "Fluncle",
      thumbnailUrl: "https://www.fluncle.com/fluncle-cover.png",
      title: "Fluncle: mixtapes",
    });

    expect(payload.version).toBe("1.0");
    expect(payload.type).toBe("link");
    expect(payload.provider_name).toBe(OEMBED_PROVIDER_NAME);
    expect(payload.title).toBe("Fluncle: mixtapes");
    expect(payload.author_name).toBe("Fluncle");
    expect(payload.thumbnail_url).toBe("https://www.fluncle.com/fluncle-cover.png");
    expect("html" in payload).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { fluncleMetaDescription, fluncleSiteTitle } from "@/lib/identity";
import { siteUrl } from "@/lib/fluncle-links";

type Meta = { content?: string; name?: string; property?: string; title?: string };

function metaOf(head: unknown): Meta[] {
  return (head as { meta?: Meta[] }).meta ?? [];
}

function twitter(meta: Meta[]): Record<string, string | undefined> {
  return Object.fromEntries(
    ["twitter:title", "twitter:description", "twitter:image"].map((name) => [
      name,
      meta.find((entry) => entry.name === name)?.content,
    ]),
  );
}

function og(meta: Meta[]): Record<string, string | undefined> {
  return {
    "twitter:description": meta.find((entry) => entry.property === "og:description")?.content,
    "twitter:image": meta.find((entry) => entry.property === "og:image")?.content,
    "twitter:title": meta.find((entry) => entry.property === "og:title")?.content,
  };
}

describe("the lore pages carry their own X card", () => {
  it("home names the site title, the trimmed description and the cover", async () => {
    const { Route } = await import("./index");
    const meta = metaOf(Route.options.head?.({ loaderData: undefined } as never));

    expect(fluncleSiteTitle).toBe("Fluncle: drum & bass bangers from another dimension");
    expect(twitter(meta)).toEqual({
      "twitter:description": fluncleMetaDescription,
      "twitter:image": `${siteUrl}/fluncle-cover.png`,
      "twitter:title": fluncleSiteTitle,
    });
  });

  it("/findings mirrors its own og tags", async () => {
    const { Route } = await import("./findings");
    const meta = metaOf(Route.options.head?.({ loaderData: undefined } as never));

    expect(twitter(meta)["twitter:title"]).toContain("finding");
    expect(twitter(meta)).toEqual(og(meta));
  });

  it("/mixtapes mirrors its own og tags", async () => {
    const { Route } = await import("./mixtapes.index");
    const meta = metaOf(Route.options.head?.({ loaderData: [] } as never));

    expect(twitter(meta)["twitter:title"]).toContain("mixtapes");
    expect(twitter(meta)).toEqual(og(meta));
  });
});

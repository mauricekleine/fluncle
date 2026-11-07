import { describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/fluncle-links";

type Head = {
  links?: Array<{ href?: string; rel?: string }>;
  meta?: Array<{ content?: string; name?: string; property?: string; title?: string }>;
};

function shareTags(head: unknown) {
  const { links = [], meta = [] } = head as Head;

  return {
    canonical: links.find((link) => link.rel === "canonical")?.href,
    description: meta.find((entry) => entry.name === "description")?.content,
    ogDescription: meta.find((entry) => entry.property === "og:description")?.content,
    ogTitle: meta.find((entry) => entry.property === "og:title")?.content,
    ogUrl: meta.find((entry) => entry.property === "og:url")?.content,
    title: meta.find((entry) => entry.title !== undefined)?.title,
  };
}

describe("a shared page unfurls as itself, never as the homepage the root head describes", () => {
  it.each([
    ["/docs/api", () => import("./docs.api")],
    ["/pipeline", () => import("./pipeline")],
  ])(
    "%s declares og tags matching its own canonical, title and description",
    async (path, load) => {
      const { Route } = await load();
      const tags = shareTags(Route.options.head?.({ loaderData: undefined } as never));

      expect(tags.canonical).toBe(`${siteUrl}${path}`);
      expect(tags.ogUrl).toBe(tags.canonical);
      expect(tags.title).toBeTruthy();
      expect(tags.ogTitle).toBe(tags.title);
      expect(tags.description).toBeTruthy();
      expect(tags.ogDescription).toBe(tags.description);
    },
  );
});

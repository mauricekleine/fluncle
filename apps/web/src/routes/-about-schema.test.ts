import { describe, expect, it } from "vitest";
import { fluncleDescription } from "@/lib/identity";
import { Route as AboutRoute } from "./about";

// The entity surface: MusicGroup + FAQPage, mirroring the visible prose.

type HeadResult = {
  links?: Array<{ href: string; rel: string }>;
  scripts?: Array<{ children: string; type: string }>;
};

function aboutSchemas(): Array<Record<string, unknown>> {
  const head = AboutRoute.options.head?.({} as never) as HeadResult;

  return (head.scripts ?? [])
    .filter((script) => script.type === "application/ld+json")
    .map((script) => JSON.parse(script.children) as Record<string, unknown>);
}

describe("/about schema", () => {
  it("emits the Fluncle entity as a MusicGroup with the canonical description", () => {
    const entity = aboutSchemas().find((schema) => schema["@type"] === "MusicGroup");

    expect(entity).toBeDefined();
    expect(entity?.name).toBe("Fluncle");
    expect(entity?.description).toBe(fluncleDescription);
    expect(entity?.sameAs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("tiktok.com/@fluncle"),
        expect.stringContaining("instagram.com/fluncle"),
        expect.stringContaining("youtube.com/@fluncle"),
        expect.stringContaining("mixcloud.com/fluncle"),
        expect.stringContaining("soundcloud.com/fluncle"),
        expect.stringContaining("twitch.tv/flunclelive"),
        expect.stringContaining("musicbrainz.org/artist/"),
        expect.stringContaining("wikidata.org/wiki/Q140169844"),
      ]),
    );
  });

  it("emits a FAQPage whose questions mirror the visible crew questions", () => {
    const faq = aboutSchemas().find((schema) => schema["@type"] === "FAQPage") as
      | { mainEntity: Array<{ acceptedAnswer: { text: string }; name: string }> }
      | undefined;

    expect(faq).toBeDefined();
    expect(faq?.mainEntity).toHaveLength(5);
    expect(faq?.mainEntity.map((entry) => entry.name)).toEqual([
      "Who is Fluncle?",
      "What is Fluncle's Galaxy?",
      "What does a Log ID like 004.7.2I mean?",
      "What is fluncle://?",
      "How are tracks chosen?",
    ]);

    for (const entry of faq?.mainEntity ?? []) {
      expect(entry.acceptedAnswer.text.length).toBeGreaterThan(80);
      expect(entry.acceptedAnswer.text).not.toContain("!");
    }
  });

  it("self-canonicalizes", () => {
    const head = AboutRoute.options.head?.({} as never) as HeadResult;

    expect(head.links).toEqual([{ href: "https://www.fluncle.com/about", rel: "canonical" }]);
  });
});

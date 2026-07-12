import { describe, expect, it } from "vitest";
import { fluncleDescription } from "@/lib/identity";
import { faqAnchor, Route as AboutRoute } from "./about";
import { MEASURED_FAQ_ANCHOR } from "./log.$logId";

// The entity surface: MusicGroup + FAQPage, mirroring the visible prose.

type HeadResult = {
  links?: Array<{ href: string; rel: string }>;
  scripts?: Array<{ children: string; type: string }>;
};

// JSON-LD is emitted via `jsonLdScript`, which HTML-escapes the serialized JSON
// (`<`/`>`/`&`/U+2028/U+2029 → `\uXXXX`). Those escapes are still valid JSON, so
// `JSON.parse` reads the original object back — the structured data is unchanged.
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
        expect.stringContaining(".onion"),
        expect.stringContaining("musicbrainz.org/artist/"),
        expect.stringContaining("wikidata.org/wiki/Q140169844"),
        expect.stringContaining("last.fm/user/fluncle"),
        expect.stringContaining("discogs.com/user/fluncle"),
      ]),
    );
  });

  it("emits a FAQPage whose questions mirror the visible crew questions", () => {
    const faq = aboutSchemas().find((schema) => schema["@type"] === "FAQPage") as
      | { mainEntity: Array<{ acceptedAnswer: { text: string }; name: string }> }
      | undefined;

    expect(faq).toBeDefined();
    expect(faq?.mainEntity).toHaveLength(9);
    expect(faq?.mainEntity.map((entry) => entry.name)).toEqual([
      "Who is Fluncle?",
      "What is Fluncle's Galaxy?",
      "What are the stars in the Galaxy game?",
      "Why is a mixtape called dreaming?",
      "What does a Log ID like 004.7.2I mean?",
      "What is fluncle://?",
      "How are tracks chosen?",
      "How does Fluncle find new tracks?",
      "How does Fluncle measure BPM and key?",
    ]);

    for (const entry of faq?.mainEntity ?? []) {
      expect(entry.acceptedAnswer.text.length).toBeGreaterThan(80);
      expect(entry.acceptedAnswer.text).not.toContain("!");
    }
  });

  it("keeps the measurement question's anchor in step with the /log BPM/key link", () => {
    // The cross-file contract: /log's BPM/Key labels link to this anchor on /about.
    // A reword of the question would silently regenerate the id and no-op the link.
    expect(faqAnchor("How does Fluncle measure BPM and key?")).toBe(MEASURED_FAQ_ANCHOR);
  });

  it("self-canonicalizes", () => {
    const head = AboutRoute.options.head?.({} as never) as HeadResult;

    expect(head.links).toEqual([{ href: "https://www.fluncle.com/about", rel: "canonical" }]);
  });
});

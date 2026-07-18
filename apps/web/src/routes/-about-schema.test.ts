import { describe, expect, it } from "vitest";
import { fluncleEntityId, fluncleWebsiteId } from "@/lib/fluncle-links";
import { fluncleDescription } from "@/lib/identity";
import { faqAnchor, Route as AboutRoute } from "./about";
import { Route as HomeRoute } from "./index";
import { MEASURED_FAQ_ANCHOR } from "./log.$logId";
import { Route as ReachRoute } from "./reach";

// The entity surface: the ONE canonical Fluncle Person node (@id) + FAQPage, mirroring the visible
// prose. The person node is declared ONCE here; every other surface references it by `@id`.

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
  it("emits the Fluncle entity as the canonical Person node (@id) with the canonical description", () => {
    // Retyped MusicGroup → Person: Wikidata P31=Q5 + MusicBrainz both say human, and it carries the
    // ONE canonical `@id` every other surface references.
    const entity = aboutSchemas().find((schema) => schema["@type"] === "Person");

    expect(entity).toBeDefined();
    expect(entity?.["@id"]).toBe(fluncleEntityId);
    expect(entity?.name).toBe("Fluncle");
    expect(entity?.description).toBe(fluncleDescription);
    // The full identity graph lives ONCE, here on the canonical node.
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

// The whole point of the slice: ONE entity node, referenced everywhere. Every surface that names
// Fluncle either IS the declared node (/about) or points at its `@id` — never a second, competing
// re-declaration. This pins that resolution across the surfaces that carry a `#fluncle` reference.
describe("the @id entity graph — every #fluncle reference resolves to the one declared node", () => {
  function schemasOf(head: HeadResult): Array<Record<string, unknown>> {
    return (head.scripts ?? [])
      .filter((script) => script.type === "application/ld+json")
      .map((script) => JSON.parse(script.children) as Record<string, unknown>);
  }

  const homeHead = HomeRoute.options.head?.({
    loaderData: { totalCount: 0, tracks: [] },
  } as never) as HeadResult;

  it("the /about Person node IS the declared canonical node", () => {
    const person = aboutSchemas().find((schema) => schema["@type"] === "Person");

    expect(person?.["@id"]).toBe(fluncleEntityId);
  });

  it("the home WebSite carries its own @id and is publisher-ed BY the canonical node", () => {
    const website = schemasOf(homeHead).find((schema) => schema["@type"] === "WebSite");

    expect(website?.["@id"]).toBe(fluncleWebsiteId);
    expect(website?.publisher).toEqual({ "@id": fluncleEntityId });
  });

  it("the home MusicPlaylist is created BY the canonical node, and no longer re-declares sameAs", () => {
    const playlist = schemasOf(homeHead).find((schema) => schema["@type"] === "MusicPlaylist");

    expect(playlist?.creator).toEqual({ "@id": fluncleEntityId });
    // The identity graph lives once (on /about), not duplicated here.
    expect(playlist).not.toHaveProperty("sameAs");
  });

  it("the reach page hangs its interactionStatistic on the canonical node (not a parallel entity)", () => {
    const reachHead = ReachRoute.options.head?.({
      loaderData: { series: [] },
    } as never) as HeadResult;
    const entity = schemasOf(reachHead).find((schema) => schema["@type"] === "Person");

    expect(entity?.["@id"]).toBe(fluncleEntityId);
  });
});

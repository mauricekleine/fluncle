import { describe, expect, it } from "vitest";
import {
  fluncleEntityId,
  fluncleWebsiteId,
  spotifyPlaylistCanonicalUrl,
  spotifyPlaylistUrl,
} from "@/lib/fluncle-links";
import { fluncleDescription, fluncleMetaDescription } from "@/lib/identity";
import { faqAnchor, Route as AboutRoute } from "./about";
import { Route as FindingsRoute } from "./findings";
import { Route as FrontDoorRoute } from "./index";
import { MEASURED_FAQ_ANCHOR } from "./log.$logId";
import { Route as ReachRoute } from "./reach";

type HeadResult = {
  links?: Array<{ href: string; rel: string }>;
  meta?: Array<{ content?: string; name?: string; title?: string }>;
  scripts?: Array<{ children: string; type: string }>;
};

function metaDescriptionOf(head: HeadResult): string | undefined {
  return head.meta?.find((entry) => entry.name === "description")?.content;
}

function aboutSchemas(): Array<Record<string, unknown>> {
  const head = AboutRoute.options.head?.({} as never) as HeadResult;

  return (head.scripts ?? [])
    .filter((script) => script.type === "application/ld+json")
    .map((script) => JSON.parse(script.children) as Record<string, unknown>);
}

describe("/about schema", () => {
  it("emits the Fluncle entity as the canonical Person node (@id) with the canonical description", () => {
    const entity = aboutSchemas().find((schema) => schema["@type"] === "Person");

    expect(entity).toBeDefined();
    expect(entity?.["@id"]).toBe(fluncleEntityId);
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

  it("claims the Spotify playlist by its BARE URI, never the `?si=` share link", () => {
    const entity = aboutSchemas().find((schema) => schema["@type"] === "Person");
    const sameAs = entity?.sameAs as string[] | undefined;
    const playlist = sameAs?.find((url) => url.includes("open.spotify.com/playlist/"));

    expect(playlist).toBe(spotifyPlaylistCanonicalUrl);
    expect(playlist).not.toContain("?si=");

    expect(spotifyPlaylistUrl).toContain("?si=");
    expect(spotifyPlaylistUrl.startsWith(spotifyPlaylistCanonicalUrl)).toBe(true);
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
    expect(faqAnchor("How does Fluncle measure BPM and key?")).toBe(MEASURED_FAQ_ANCHOR);
  });

  it("self-canonicalizes", () => {
    const head = AboutRoute.options.head?.({} as never) as HeadResult;

    expect(head.links).toEqual([{ href: "https://www.fluncle.com/about", rel: "canonical" }]);
  });
});

describe("the @id entity graph — every #fluncle reference resolves to the one declared node", () => {
  function schemasOf(head: HeadResult): Array<Record<string, unknown>> {
    return (head.scripts ?? [])
      .filter((script) => script.type === "application/ld+json")
      .map((script) => JSON.parse(script.children) as Record<string, unknown>);
  }

  const homeHead = FrontDoorRoute.options.head?.({
    loaderData: {
      counts: { albums: 0, artists: 0, labels: 0, tracks: 0 },
      findings: [],
      findingsTotal: 0,
      releaseWindowDays: 30,
      releases: [],
    },
  } as never) as HeadResult;

  const findingsHead = FindingsRoute.options.head?.({
    loaderData: { totalCount: 0, tracks: [] },
  } as never) as HeadResult;

  it("the /about Person node IS the declared canonical node", () => {
    const person = aboutSchemas().find((schema) => schema["@type"] === "Person");

    expect(person?.["@id"]).toBe(fluncleEntityId);
  });

  it("the front door's WebSite carries its own @id and is publisher-ed BY the canonical node", () => {
    const website = schemasOf(homeHead).find((schema) => schema["@type"] === "WebSite");

    expect(website?.["@id"]).toBe(fluncleWebsiteId);
    expect(website?.publisher).toEqual({ "@id": fluncleEntityId });
  });

  it("the archive page's MusicPlaylist is created BY the canonical node and re-declares no sameAs", () => {
    const playlist = schemasOf(findingsHead).find((schema) => schema["@type"] === "MusicPlaylist");

    expect(playlist?.creator).toEqual({ "@id": fluncleEntityId });

    expect(playlist).not.toHaveProperty("sameAs");
  });

  it("carries its OWN meta description, never the front door's entity line", () => {
    const aboutHead = AboutRoute.options.head?.({} as never) as HeadResult;
    const aboutDescription = metaDescriptionOf(aboutHead);

    expect(metaDescriptionOf(homeHead)).toBeUndefined();
    expect(aboutDescription).toBeDefined();
    expect(aboutDescription).not.toBe(fluncleMetaDescription);
    expect((aboutDescription ?? "").length).toBeLessThanOrEqual(155);
  });

  it("the archive page carries its own description, distinct from the front door's inherited one", () => {
    const findingsDescription = metaDescriptionOf(findingsHead);

    expect(findingsDescription).toBeDefined();
    expect(findingsDescription).not.toBe(fluncleMetaDescription);
    expect((findingsDescription ?? "").length).toBeLessThanOrEqual(160);
  });

  it("the front door and the archive page each self-canonicalize to their own URL", () => {
    expect(homeHead.links).toContainEqual({ href: "https://www.fluncle.com/", rel: "canonical" });
    expect(findingsHead.links).toContainEqual({
      href: "https://www.fluncle.com/findings",
      rel: "canonical",
    });
  });

  it("the reach page hangs its interactionStatistic on the canonical node (not a parallel entity)", () => {
    const reachHead = ReachRoute.options.head?.({
      loaderData: { series: [] },
    } as never) as HeadResult;
    const entity = schemasOf(reachHead).find((schema) => schema["@type"] === "Person");

    expect(entity?.["@id"]).toBe(fluncleEntityId);
  });
});

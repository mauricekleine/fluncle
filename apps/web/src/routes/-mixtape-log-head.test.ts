import { describe, expect, it } from "vitest";
import { Route as LogRoute } from "./log.$logId";

type HeadResult = {
  links?: Array<Record<string, unknown>>;
  meta?: Array<Record<string, unknown>>;
};

const longNote =
  "My first mixtape. Seventeen findings I couldn't stop rewinding, so I mixed them live on Twitch in one pass, all liquid. Put it on with the lights off, and I hope it gets an oof out of you too. Enjoy, cosmonauts.";

const legacyTitle = `${"Liquid rollers for the long drive home ".repeat(4).trim()} | 019.F.1A`;

function mixtapeHead(
  note?: string,
  title = "Fluncle Drum & Bass Mixtape #1 | 019.F.1A",
): HeadResult {
  return LogRoute.options.head?.({
    loaderData: {
      mixtape: {
        addedAt: "2026-06-18T21:00:00.000Z",
        artists: ["Fluncle"],
        externalUrls: {},
        logId: "019.F.1A",
        memberCount: 0,
        members: [],
        note,
        status: "published",
        title,
        type: "mixtape",
      },
      status: "found-mixtape",
    },
  } as never) as HeadResult;
}

function metaValue(head: HeadResult, key: string, value: string): unknown {
  return head.meta?.find((entry) => entry[key] === value)?.["content"];
}

describe("/log mixtape head", () => {
  it("names the coordinate once in the title, the oEmbed link, and the share titles", () => {
    const head = mixtapeHead(longNote);
    const title = head.meta?.find((entry) => "title" in entry)?.["title"];

    expect(title).toBe("019.F.1A · Fluncle Drum & Bass Mixtape #1 · Fluncle");
    expect(metaValue(head, "property", "og:title")).toBe(title);
    expect(metaValue(head, "name", "twitter:title")).toBe(title);
    expect(head.links?.find((link) => link["rel"] === "alternate")?.["title"]).toBe(
      "Fluncle Drum & Bass Mixtape #1 · Fluncle",
    );
  });

  it("keeps a long mixtape note inside the search-snippet budget, cut at a sentence", () => {
    const description = metaValue(mixtapeHead(longNote), "name", "description");

    expect(description).toBe(
      "My first mixtape. Seventeen findings I couldn't stop rewinding, so I mixed them live on Twitch in one pass, all liquid.",
    );
    expect(metaValue(mixtapeHead(longNote), "property", "og:description")).toBe(description);
  });

  it("falls back to the plain mixtape line its JSON-LD also carries when the mixtape has no note", () => {
    expect(metaValue(mixtapeHead(), "name", "description")).toBe(
      "Fluncle drum & bass mixtape: Fluncle Drum & Bass Mixtape #1.",
    );
  });

  it("keeps the no-note fallback inside the search-snippet budget for a long legacy title", () => {
    const head = mixtapeHead(undefined, legacyTitle);
    const description = metaValue(head, "name", "description");

    expect(typeof description).toBe("string");
    expect((description as string).length).toBeLessThanOrEqual(160);
    expect(description).toMatch(/^Fluncle drum & bass mixtape: Liquid rollers/);
    expect(metaValue(head, "property", "og:description")).toBe(description);
    expect(metaValue(head, "name", "twitter:description")).toBe(description);
  });
});

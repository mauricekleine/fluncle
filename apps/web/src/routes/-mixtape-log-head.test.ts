import { describe, expect, it } from "vitest";
import { Route as LogRoute } from "./log.$logId";

type HeadResult = {
  links?: Array<Record<string, unknown>>;
  meta?: Array<Record<string, unknown>>;
};

const longNote =
  "My first mixtape. Seventeen findings I couldn't stop rewinding, so I mixed them live on Twitch in one pass, all liquid. Put it on with the lights off, and I hope it gets an oof out of you too. Enjoy, cosmonauts.";

function mixtapeHead(note?: string): HeadResult {
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
        title: "Fluncle Drum & Bass Mixtape #1 | 019.F.1A",
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

  it("falls back to the checkpoint line when the mixtape has no note", () => {
    expect(metaValue(mixtapeHead(), "name", "description")).toBe(
      "A checkpoint in Fluncle's Findings.",
    );
  });
});

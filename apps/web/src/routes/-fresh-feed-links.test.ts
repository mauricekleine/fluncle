import { describe, expect, it, vi } from "vitest";

// The fresh feeds' contract, pinned. Two tiers ride one list: a CERTIFIED finding links to its
// /log home and shows its cover; an UNCERTIFIED catalogue row links OUT to Spotify only, with no
// /log and no cover (DESIGN.md's Unlit Rule); a row with neither points nowhere. And every date
// is a RELEASE date, never a Found date (VOICE.md's Found Rule) — the feed keys on release_date.

// One track set shared by both feeds, in the order the feeds render them (newest release first):
// a certified finding (coordinate + cover), a certified straggler with no coordinate yet, an
// uncertified row with Spotify, and an uncertified row with nowhere to point.
const CERTIFIED = {
  artists: ["Camo & Krooked"],
  certified: true,
  coverImageUrl: "https://i.scdn.co/image/fresh-cover.jpg",
  logId: "012.8.0A",
  releaseDate: "2026-07-10",
  spotifyUrl: "https://open.spotify.com/track/certified",
  title: "Fresh Roller",
};
const CERTIFIED_NO_COORD = {
  artists: ["Some Artist"],
  certified: true,
  releaseDate: "2026-07-09",
  spotifyUrl: "https://open.spotify.com/track/straggler",
  title: "No Coordinate Yet",
};
const UNCERTIFIED_SPOTIFY = {
  artists: ["Unlit Artist"],
  certified: false,
  releaseDate: "2026-07-08",
  spotifyUrl: "https://open.spotify.com/track/unlit",
  title: "Uncertified Drop",
};
const UNCERTIFIED_BARE = {
  artists: ["Ghost Artist"],
  certified: false,
  releaseDate: "2026-07-07",
  title: "Nowhere To Point",
};
const TRACKS = [CERTIFIED, CERTIFIED_NO_COORD, UNCERTIFIED_SPOTIFY, UNCERTIFIED_BARE];

const listFreshTracks = vi.hoisted(() =>
  vi.fn(async () => ({ albums: [], tracks: TRACKS, windowDays: 30 })),
);

vi.mock("../lib/server/fresh", () => ({ listFreshTracks }));

type Handler = () => Promise<Response>;

async function handlerFor(importer: Promise<{ Route: unknown }>): Promise<Handler> {
  const { Route } = await importer;
  const handlers = (Route as { options: { server?: { handlers?: { GET?: Handler } } } }).options
    .server?.handlers;
  if (!handlers?.GET) {
    throw new Error("route has no GET handler");
  }
  return handlers.GET;
}

const CERTIFIED_LOG = "https://www.fluncle.com/log/012.8.0A";

describe("fresh.xml — release-framed, two tiers", () => {
  it("links a certified finding to its /log page, shows its cover, keeps Spotify in the body", async () => {
    const handler = await handlerFor(import("./fresh[.]xml"));
    const xml = await (await handler()).text();

    expect(xml).toContain(`<link>${CERTIFIED_LOG}</link>`);
    expect(xml).toContain(
      '<media:content url="https://i.scdn.co/image/fresh-cover.jpg" medium="image"/>',
    );
    expect(xml).toContain("https://open.spotify.com/track/certified");
    // The feed-level image.
    expect(xml).toContain("https://www.fluncle.com/fluncle-cover.png");
  });

  it("dates items by RELEASE date, not a Found date", async () => {
    const handler = await handlerFor(import("./fresh[.]xml"));
    const xml = await (await handler()).text();

    // 2026-07-10 as a UTC day.
    expect(xml).toContain("<pubDate>Fri, 10 Jul 2026 00:00:00 GMT</pubDate>");
    // The channel is release-framed; it never borrows the found-date feed's nameplate.
    expect(xml).toContain("<title>New drum &amp; bass releases · Fluncle</title>");
    expect(xml).not.toContain("Fluncle's Findings");
    expect(xml).not.toMatch(/found/i);
  });

  it("falls back to Spotify for a certified straggler with no coordinate", async () => {
    const handler = await handlerFor(import("./fresh[.]xml"));
    const xml = await (await handler()).text();

    expect(xml).toContain("<link>https://open.spotify.com/track/straggler</link>");
  });

  it("links an uncertified row OUT to Spotify with no /log and no cover (Unlit Rule)", async () => {
    const handler = await handlerFor(import("./fresh[.]xml"));
    const xml = await (await handler()).text();

    expect(xml).toContain("<link>https://open.spotify.com/track/unlit</link>");
    // The unlit tier never borrows a coordinate: the only item linking to a /log home and the
    // only cover in the whole feed belong to the one certified finding.
    expect((xml.match(/<link>[^<]*\/log\//g) ?? []).length).toBe(1);
    expect((xml.match(/media:content/g) ?? []).length).toBe(1);
  });

  it("renders an uncertified row with no Spotify as a plain titled item (no link, stable guid)", async () => {
    const handler = await handlerFor(import("./fresh[.]xml"));
    const xml = await (await handler()).text();

    expect(xml).toContain("Ghost Artist — Nowhere To Point");
    expect(xml).toContain("urn:fluncle:release:2026-07-07:");
  });
});

describe("fresh.json — release-framed, two tiers", () => {
  it("links a certified finding to its /log page (id === permalink), shows its image", async () => {
    const handler = await handlerFor(import("./fresh[.]json"));
    const feed = (await (await handler()).json()) as {
      description: string;
      icon?: string;
      items: {
        content_text: string;
        date_published?: string;
        id: string;
        image?: string;
        url?: string;
      }[];
      title: string;
    };

    const item = feed.items[0];
    expect(item?.url).toBe(CERTIFIED_LOG);
    expect(item?.id).toBe(CERTIFIED_LOG);
    expect(item?.image).toBe("https://i.scdn.co/image/fresh-cover.jpg");
    expect(item?.content_text).toContain("https://open.spotify.com/track/certified");
    // Release date, not a Found date.
    expect(item?.date_published).toBe("2026-07-10T00:00:00.000Z");
    // Release-framed channel; never the found-date feed's nameplate.
    expect(feed.title).toBe("New drum & bass releases · Fluncle");
    expect(feed.icon).toBe("https://www.fluncle.com/fluncle-cover.png");
  });

  it("links an uncertified row OUT to Spotify with no image (Unlit Rule)", async () => {
    const handler = await handlerFor(import("./fresh[.]json"));
    const feed = (await (await handler()).json()) as {
      items: { id: string; image?: string; url?: string }[];
    };

    const unlit = feed.items.find((item) => item.url === "https://open.spotify.com/track/unlit");
    expect(unlit?.id).toBe("https://open.spotify.com/track/unlit");
    expect(unlit?.image).toBeUndefined();
    // No item anywhere links to a /log page except the certified finding.
    expect(feed.items.filter((item) => item.url?.includes("/log/"))).toHaveLength(1);
  });

  it("gives an uncertified row with no Spotify a stable id and no url", async () => {
    const handler = await handlerFor(import("./fresh[.]json"));
    const feed = (await (await handler()).json()) as {
      items: { id: string; title: string; url?: string }[];
    };

    const bare = feed.items.find((item) => item.title === "Ghost Artist — Nowhere To Point");
    expect(bare?.url).toBeUndefined();
    expect(bare?.id).toContain("urn:fluncle:release:2026-07-07:");
  });
});

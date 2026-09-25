import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  artists: ["Camo & Krooked"],
  certified: true,
  releaseDate: "2026-07-09",
  spotifyUrl: "https://open.spotify.com/track/straggler",
  title: "No Coordinate Yet",
};
const UNCERTIFIED_SPOTIFY = {
  artists: ["Camo & Krooked"],
  certified: false,
  releaseDate: "2026-07-08",
  spotifyUrl: "https://open.spotify.com/track/unlit",
  title: "Uncertified Drop",
};
const UNCERTIFIED_BARE = {
  artists: ["Camo & Krooked"],
  certified: false,
  releaseDate: "2026-07-07",
  title: "Nowhere To Point",
};
const TRACKS = [CERTIFIED, CERTIFIED_NO_COORD, UNCERTIFIED_SPOTIFY, UNCERTIFIED_BARE];

const listArtistFreshTracks = vi.hoisted(() => vi.fn());
const listLabelFreshTracks = vi.hoisted(() => vi.fn());

vi.mock("../lib/server/fresh-entity", () => ({ listArtistFreshTracks, listLabelFreshTracks }));

type Handler = (ctx: { params: { slug: string } }) => Promise<Response>;

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-20T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/artist/$slug/fresh.xml — release-framed, two tiers, one artist", () => {
  it("links a certified finding to its /log page, shows its cover, keeps Spotify in the body", async () => {
    listArtistFreshTracks.mockResolvedValueOnce({ name: "Camo & Krooked", tracks: TRACKS });
    const handler = await handlerFor(import("./artist.$slug.fresh[.]xml"));
    const res = await handler({ params: { slug: "camo-and-krooked" } });
    const xml = await res.text();

    expect(res.status).toBe(200);
    expect(xml).toContain(`<link>${CERTIFIED_LOG}</link>`);
    expect(xml).toContain(
      '<media:content url="https://i.scdn.co/image/fresh-cover.jpg" medium="image"/>',
    );
    expect(xml).toContain("https://open.spotify.com/track/certified");

    expect(xml).toContain("https://www.fluncle.com/fluncle-cover.png");
  });

  it("scopes the channel to the artist and dates items by RELEASE date, not a Found date", async () => {
    listArtistFreshTracks.mockResolvedValueOnce({ name: "Camo & Krooked", tracks: TRACKS });
    const handler = await handlerFor(import("./artist.$slug.fresh[.]xml"));
    const xml = await (await handler({ params: { slug: "camo-and-krooked" } })).text();

    expect(xml).toContain("<pubDate>Fri, 10 Jul 2026 00:00:00 GMT</pubDate>");

    expect(xml).toContain("<title>New Camo &amp; Krooked releases · Fluncle</title>");
    expect(xml).toContain("The freshest from Camo &amp; Krooked, hot off the press.");

    expect(xml).toContain("<link>https://www.fluncle.com/artist/camo-and-krooked</link>");
    expect(xml).not.toMatch(/found/i);
  });

  it("falls back to Spotify for a certified straggler; links an uncertified row OUT to Spotify only (Unlit Rule)", async () => {
    listArtistFreshTracks.mockResolvedValueOnce({ name: "Camo & Krooked", tracks: TRACKS });
    const handler = await handlerFor(import("./artist.$slug.fresh[.]xml"));
    const xml = await (await handler({ params: { slug: "camo-and-krooked" } })).text();

    expect(xml).toContain("<link>https://open.spotify.com/track/straggler</link>");
    expect(xml).toContain("<link>https://open.spotify.com/track/unlit</link>");

    expect((xml.match(/<link>[^<]*\/log\//g) ?? []).length).toBe(1);
    expect((xml.match(/media:content/g) ?? []).length).toBe(1);
  });

  it("renders an uncertified row with no Spotify as a plain titled item (no link, stable guid)", async () => {
    listArtistFreshTracks.mockResolvedValueOnce({ name: "Camo & Krooked", tracks: TRACKS });
    const handler = await handlerFor(import("./artist.$slug.fresh[.]xml"));
    const xml = await (await handler({ params: { slug: "camo-and-krooked" } })).text();

    expect(xml).toContain("Camo &amp; Krooked — Nowhere To Point");
    expect(xml).toContain("urn:fluncle:release:2026-07-07:");
  });

  it("serves the fresh-feed cache headers", async () => {
    listArtistFreshTracks.mockResolvedValueOnce({ name: "Camo & Krooked", tracks: TRACKS });
    const handler = await handlerFor(import("./artist.$slug.fresh[.]xml"));
    const res = await handler({ params: { slug: "camo-and-krooked" } });

    expect(res.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
    );

    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("404s an unknown slug (never a 200 with an empty feed)", async () => {
    listArtistFreshTracks.mockResolvedValueOnce(undefined);
    const handler = await handlerFor(import("./artist.$slug.fresh[.]xml"));
    const res = await handler({ params: { slug: "no-such-artist" } });

    expect(res.status).toBe(404);
  });

  it("serves a valid empty feed for a known artist with nothing in the window", async () => {
    listArtistFreshTracks.mockResolvedValueOnce({ name: "Camo & Krooked", tracks: [] });
    const handler = await handlerFor(import("./artist.$slug.fresh[.]xml"));
    const res = await handler({ params: { slug: "camo-and-krooked" } });
    const xml = await res.text();

    expect(res.status).toBe(200);
    expect(xml).toContain("<title>New Camo &amp; Krooked releases · Fluncle</title>");
    expect(xml).not.toContain("<item>");
  });
});

describe("/label/$slug/fresh.xml — release-framed, two tiers, one label", () => {
  it("links a certified finding to its /log page and scopes the channel to the label", async () => {
    listLabelFreshTracks.mockResolvedValueOnce({ name: "Hospital Records", tracks: TRACKS });
    const handler = await handlerFor(import("./label.$slug.fresh[.]xml"));
    const res = await handler({ params: { slug: "hospital-records" } });
    const xml = await res.text();

    expect(res.status).toBe(200);
    expect(xml).toContain(`<link>${CERTIFIED_LOG}</link>`);

    expect(xml).toContain("<title>New releases on Hospital Records · Fluncle</title>");
    expect(xml).toContain("The freshest on Hospital Records, hot off the press.");
    expect(xml).toContain("<link>https://www.fluncle.com/label/hospital-records</link>");
    expect(xml).not.toMatch(/found/i);
  });

  it("keeps the two-tier link contract: one /log, one cover, the rest out to Spotify", async () => {
    listLabelFreshTracks.mockResolvedValueOnce({ name: "Hospital Records", tracks: TRACKS });
    const handler = await handlerFor(import("./label.$slug.fresh[.]xml"));
    const xml = await (await handler({ params: { slug: "hospital-records" } })).text();

    expect(xml).toContain("<link>https://open.spotify.com/track/unlit</link>");
    expect((xml.match(/<link>[^<]*\/log\//g) ?? []).length).toBe(1);
    expect((xml.match(/media:content/g) ?? []).length).toBe(1);
  });

  it("404s an unknown slug", async () => {
    listLabelFreshTracks.mockResolvedValueOnce(undefined);
    const handler = await handlerFor(import("./label.$slug.fresh[.]xml"));
    const res = await handler({ params: { slug: "no-such-label" } });

    expect(res.status).toBe(404);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// The feeds' top audit bug: a finding item linked to Spotify, not to its own /log
// page — the archive gave away its citation surface. These tests pin the fix: a
// finding item links to its /log home, a coordinate-less finding falls back to
// Spotify, and the Spotify URL stays reachable in the item body. Plus the light
// enrichment (per-item cover, feed-level icon).

// One row set shared by all three feeds: a certified finding (has a coordinate), a
// coordinate-less finding straggler (the fallback case), and a published mixtape.
const FINDING = {
  added_at: "2026-06-15T20:00:00.000Z",
  album_image_url: "https://i.scdn.co/image/cover.jpg",
  artists_json: '["Camo & Krooked"]',
  item_type: "finding" as const,
  log_id: "012.8.0A",
  note: "a roller",
  spotify_url: "https://open.spotify.com/track/abc",
  title: "Test Banger",
  track_id: "abc",
};
const FINDING_NO_COORD = {
  added_at: "2026-06-14T20:00:00.000Z",
  album_image_url: null,
  artists_json: '["Some Artist"]',
  item_type: "finding" as const,
  log_id: null,
  note: null,
  spotify_url: "https://open.spotify.com/track/noco",
  title: "No Coordinate",
  track_id: "noco",
};
const MIXTAPE = {
  added_at: "2026-06-13T20:00:00.000Z",
  album_image_url: null,
  artists_json: '["Fluncle"]',
  item_type: "mixtape" as const,
  log_id: "019.F.1A",
  note: null,
  spotify_url: null,
  title: "Checkpoint",
  track_id: "019.F.1A",
};
const ROWS = [FINDING, FINDING_NO_COORD, MIXTAPE];

const getDb = vi.hoisted(() =>
  vi.fn(async () => ({ execute: vi.fn(async () => ({ rows: ROWS as unknown[] })) })),
);

vi.mock("../lib/server/db", () => ({
  getDb,
  typedRows: (rows: unknown[]) => rows,
}));
vi.mock("../lib/server/artists", () => ({
  parseArtistsJson: (json: string) => JSON.parse(json) as string[],
}));

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

const FINDING_LOG = "https://www.fluncle.com/log/012.8.0A";
const MIXTAPE_LOG = "https://www.fluncle.com/log/019.F.1A";

beforeEach(() => {
  getDb.mockClear();
});

describe("rss.xml — findings link home", () => {
  it("links a finding to its /log page and keeps Spotify in the body", async () => {
    const handler = await handlerFor(import("./rss[.]xml"));
    const xml = await (await handler()).text();

    expect(xml).toContain(`<link>${FINDING_LOG}</link>`);
    // The Spotify URL is preserved in the body, no longer the link.
    expect(xml).toContain("https://open.spotify.com/track/abc");
    // The per-item album cover rides along as media:content.
    expect(xml).toContain(
      '<media:content url="https://i.scdn.co/image/cover.jpg" medium="image"/>',
    );
    // The feed-level image.
    expect(xml).toContain("https://www.fluncle.com/fluncle-cover.png");
  });

  it("falls back to Spotify only when a finding has no coordinate", async () => {
    const handler = await handlerFor(import("./rss[.]xml"));
    const xml = await (await handler()).text();

    expect(xml).toContain("<link>https://open.spotify.com/track/noco</link>");
  });

  it("links a mixtape to its /log page", async () => {
    const handler = await handlerFor(import("./rss[.]xml"));
    const xml = await (await handler()).text();

    expect(xml).toContain(`<link>${MIXTAPE_LOG}</link>`);
  });
});

describe("atom.xml — findings link home", () => {
  it("links a finding to its /log page and keeps Spotify in the content", async () => {
    const handler = await handlerFor(import("./atom[.]xml"));
    const xml = await (await handler()).text();

    expect(xml).toContain(`<link rel="alternate" href="${FINDING_LOG}"/>`);
    expect(xml).toContain("https://open.spotify.com/track/abc");
    // Per-entry content carries the cover image (escaped HTML).
    expect(xml).toContain("&lt;img src=&quot;https://i.scdn.co/image/cover.jpg&quot;");
    // Feed-level logo.
    expect(xml).toContain("<logo>https://www.fluncle.com/fluncle-cover.png</logo>");
  });

  it("falls back to Spotify only when a finding has no coordinate", async () => {
    const handler = await handlerFor(import("./atom[.]xml"));
    const xml = await (await handler()).text();

    expect(xml).toContain('<link rel="alternate" href="https://open.spotify.com/track/noco"/>');
  });

  it("links a mixtape to its /log page", async () => {
    const handler = await handlerFor(import("./atom[.]xml"));
    const xml = await (await handler()).text();

    expect(xml).toContain(`<link rel="alternate" href="${MIXTAPE_LOG}"/>`);
  });
});

describe("feed.json — findings link home", () => {
  it("links a finding to its /log page (id === permalink) and keeps Spotify in the body", async () => {
    const handler = await handlerFor(import("./feed[.]json"));
    const feed = (await (await handler()).json()) as {
      favicon?: string;
      icon?: string;
      items: { content_text: string; id: string; image?: string; url: string }[];
    };

    const item = feed.items[0];
    expect(item?.url).toBe(FINDING_LOG);
    // JSON Feed 1.1: the id is the permalink URL.
    expect(item?.id).toBe(FINDING_LOG);
    // Spotify kept in the body.
    expect(item?.content_text).toContain("https://open.spotify.com/track/abc");
    // Per-item image + feed-level icon/favicon.
    expect(item?.image).toBe("https://i.scdn.co/image/cover.jpg");
    expect(feed.icon).toBe("https://www.fluncle.com/fluncle-cover.png");
    expect(feed.favicon).toBe("https://www.fluncle.com/favicon.png");
  });

  it("falls back to Spotify only when a finding has no coordinate", async () => {
    const handler = await handlerFor(import("./feed[.]json"));
    const feed = (await (await handler()).json()) as {
      items: { id: string; url: string }[];
    };

    const noCoord = feed.items.find((item) => item.url.includes("track/noco"));
    expect(noCoord?.url).toBe("https://open.spotify.com/track/noco");
    expect(noCoord?.id).toBe("https://open.spotify.com/track/noco");
  });

  it("links a mixtape to its /log page", async () => {
    const handler = await handlerFor(import("./feed[.]json"));
    const feed = (await (await handler()).json()) as { items: { url: string }[] };

    const mixtape = feed.items.find((item) => item.url === MIXTAPE_LOG);
    expect(mixtape?.url).toBe(MIXTAPE_LOG);
  });
});

import { describe, expect, it } from "vitest";

import { entityFreshChannel, freshFeedResponse, renderEntityFreshFeed } from "./fresh-feed-rss";
import { type FreshTrack } from "./server/fresh";

const CERTIFIED: FreshTrack = {
  artists: ["Calibre"],
  certified: true,
  coverImageUrl: "https://images.fluncle.com/covers/mystic.jpg",
  logId: "019.4.2C",
  releaseDate: "2026-08-02",
  spotifyUrl: "https://open.spotify.com/track/lit",
  title: "Mystic",
};

// No `logId`, no `coverImageUrl`: the Unlit Rule is structural upstream — `listFreshTracks`
// gives a catalogue row neither field (see the `FreshTrack` note in lib/server/fresh.ts), so
// this is the only shape an uncertified row can arrive in.
const UNCERTIFIED: FreshTrack = {
  artists: ["Unknown Act"],
  certified: false,
  releaseDate: "2026-08-01",
  spotifyUrl: "https://open.spotify.com/track/unlit",
  title: "Untitled",
};

function render(tracks: FreshTrack[]): string {
  return renderEntityFreshFeed({
    description: "d",
    link: "https://www.fluncle.com/artist/calibre",
    title: "t",
    tracks,
  });
}

/** The `<item>` block for one track, so a per-item rule can be checked in isolation. */
function itemFor(xml: string, title: string): string {
  const block = xml.split("<item>").find((part) => part.includes(title));
  expect(block, `no <item> carrying "${title}"`).toBeDefined();
  return block ?? "";
}

describe("entityFreshChannel", () => {
  it("frames an artist feed around the act and a label feed around the roster", () => {
    expect(entityFreshChannel("artist", "Calibre")).toEqual({
      description:
        "The freshest from Calibre, hot off the press. Every release from the last 30 days, tracked as Fluncle spins his way through them.",
      title: "New Calibre releases · Fluncle",
    });
    expect(entityFreshChannel("label", "Signature")).toEqual({
      description:
        "The freshest on Signature, hot off the press. Every release from the last 30 days, tracked as Fluncle spins his way through them.",
      title: "New releases on Signature · Fluncle",
    });
  });

  it("never claims Fluncle FOUND these — only that they landed (the Found Rule)", () => {
    for (const kind of ["artist", "label"] as const) {
      const channel = entityFreshChannel(kind, "Calibre");

      expect(`${channel.title} ${channel.description}`.toLowerCase()).not.toMatch(/\bfound\b/);
    }
  });
});

describe("renderEntityFreshFeed", () => {
  it("lights a certified finding: its /log link and its cover", () => {
    const item = itemFor(render([CERTIFIED]), "Mystic");

    expect(item).toContain("<link>https://www.fluncle.com/log/019.4.2C</link>");
    expect(item).toContain(
      '<media:content url="https://images.fluncle.com/covers/mystic.jpg" medium="image"/>',
    );
  });

  it("keeps an uncertified row unlit: Spotify out-link, no /log, no cover", () => {
    // DESIGN.md's Unlit Rule on the wire. The renderer never re-derives a cover or a coordinate,
    // so an uncertified row can only render out-linked — the tier is decided upstream and the
    // envelope cannot promote it.
    const item = itemFor(render([UNCERTIFIED]), "Untitled");

    expect(item).toContain("<link>https://open.spotify.com/track/unlit</link>");
    expect(item).not.toContain("/log/");
    expect(item).not.toContain("media:content");
  });

  it("refuses a /log link even if an uncertified row somehow arrives carrying a coordinate", () => {
    // The one half of the Unlit Rule the envelope DOES enforce itself (`itemLink` gates on
    // `certified && logId`), so a producer slip cannot mint a Fluncle home for a catalogue row.
    const item = itemFor(render([{ ...UNCERTIFIED, logId: "019.4.2C" }]), "Untitled");

    expect(item).not.toContain("/log/");
    expect(item).toContain("<link>https://open.spotify.com/track/unlit</link>");
  });

  it("keeps the Spotify link reachable in the body of a certified item", () => {
    expect(itemFor(render([CERTIFIED]), "Mystic")).toContain("https://open.spotify.com/track/lit");
  });

  it("omits the link and pubDate elements rather than emitting empty ones", () => {
    const item = itemFor(
      render([{ artists: ["Nobody"], certified: false, releaseDate: "", title: "Nowhere" }]),
      "Nowhere",
    );

    expect(item).not.toContain("<link>");
    expect(item).not.toContain("<pubDate>");
    expect(item).toContain('<guid isPermaLink="false">urn:fluncle:release::');
  });

  it("dates every item by its RELEASE day, and stamps the build date from the newest", () => {
    const xml = render([CERTIFIED, UNCERTIFIED]);

    expect(itemFor(xml, "Mystic")).toContain("<pubDate>Sun, 02 Aug 2026 00:00:00 GMT</pubDate>");
    expect(itemFor(xml, "Untitled")).toContain("<pubDate>Sat, 01 Aug 2026 00:00:00 GMT</pubDate>");
    expect(xml).toContain("<lastBuildDate>Sun, 02 Aug 2026 00:00:00 GMT</lastBuildDate>");
  });

  it("renders a well-formed empty channel when the 30-day window is empty", () => {
    const xml = render([]);

    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain("</channel>");
    expect(xml).not.toContain("<item>");
    expect(xml).not.toContain("<lastBuildDate>");
  });

  it("escapes every value it splices into the document", () => {
    const xml = renderEntityFreshFeed({
      description: 'a & b <c> "d"',
      link: "https://www.fluncle.com/artist/x?a=1&b=2",
      title: "Rock & Roll",
      tracks: [
        {
          artists: ["A&B"],
          certified: false,
          releaseDate: "2026-08-01",
          spotifyUrl: "https://open.spotify.com/track/x?si=1&nd=1",
          title: "<script>",
        },
      ],
    });

    expect(xml).not.toMatch(/<script>/);
    expect(xml).toContain("&lt;script&gt;");
    expect(xml).toContain("<title>Rock &amp; Roll</title>");
    expect(xml).toContain("<link>https://www.fluncle.com/artist/x?a=1&amp;b=2</link>");
    expect(xml).toContain("si=1&amp;nd=1");
  });
});

describe("freshFeedResponse", () => {
  it("serves RSS with the shared cache ladder", () => {
    const response = freshFeedResponse("<rss/>");

    expect(response.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
    );
  });

  it("keeps a feed out of the index — thousands of them are advertised via rel=alternate", () => {
    expect(freshFeedResponse("<rss/>").headers.get("X-Robots-Tag")).toBe("noindex");
  });
});

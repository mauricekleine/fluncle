import { describe, expect, it } from "vitest";

import { itemId, itemLink, itemTitle, releaseInstant } from "./fresh-feed-item";
import { type FreshTrack } from "./server/fresh";

function track(overrides: Partial<FreshTrack> = {}): FreshTrack {
  return {
    artists: ["Calibre"],
    certified: false,
    releaseDate: "2026-08-01",
    title: "Mystic",
    ...overrides,
  };
}

describe("itemTitle", () => {
  it("renders the tracklist line, joining multiple artists", () => {
    expect(itemTitle(track({ artists: ["Calibre", "DRS"] }))).toBe("Calibre, DRS — Mystic");
  });
});

describe("itemLink — the two-tier Unlit Rule", () => {
  it("points a certified finding at its own /log home", () => {
    expect(itemLink(track({ certified: true, logId: "019.4.2C" }))).toBe(
      "https://www.fluncle.com/log/019.4.2C",
    );
  });

  it("percent-encodes a coordinate rather than splicing it raw into the path", () => {
    expect(itemLink(track({ certified: true, logId: "019.4.2C?x=1" }))).toBe(
      "https://www.fluncle.com/log/019.4.2C%3Fx%3D1",
    );
  });

  it("points an uncertified row OUT to Spotify, never at a /log page", () => {
    // An uncertified row has no coordinate to borrow: it must never gain a Fluncle home.
    const link = itemLink(
      track({ logId: "019.4.2C", spotifyUrl: "https://open.spotify.com/track/x" }),
    );

    expect(link).toBe("https://open.spotify.com/track/x");
  });

  it("falls back to Spotify for a certified straggler with no coordinate yet", () => {
    expect(
      itemLink(track({ certified: true, spotifyUrl: "https://open.spotify.com/track/x" })),
    ).toBe("https://open.spotify.com/track/x");
  });

  it("points nowhere when there is nowhere honest to point", () => {
    expect(itemLink(track())).toBeUndefined();
  });
});

describe("itemId", () => {
  it("uses the permalink when the item has one", () => {
    expect(itemId(track(), "https://open.spotify.com/track/x")).toBe(
      "https://open.spotify.com/track/x",
    );
  });

  it("falls back to a deterministic release urn that borrows no coordinate", () => {
    // The Unlit Rule holds in the id too: a linkless row's stable id is built from its release
    // date and title, never from a Log ID it has not earned.
    const id = itemId(track({ logId: "019.4.2C", title: "Mystic & Co" }), undefined);

    expect(id).toBe("urn:fluncle:release:2026-08-01:Calibre%20%E2%80%94%20Mystic%20%26%20Co");
    expect(id).not.toContain("019.4.2C");
    expect(itemId(track({ title: "Mystic & Co" }), undefined)).toBe(id);
  });
});

describe("releaseInstant — the Found Rule on the wire", () => {
  it("reads a YYYY-MM-DD release date as a UTC day, not a local one", () => {
    expect(releaseInstant("2026-08-01")?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("returns undefined for an absent or unparseable date", () => {
    expect(releaseInstant("")).toBeUndefined();
    expect(releaseInstant("last tuesday")).toBeUndefined();
  });
});

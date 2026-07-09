import { describe, expect, it } from "vitest";
import { extractYoutubeChannelId } from "./youtube";

// `extractYoutubeChannelId` is a PURE, network-free lift: it pulls a `UC…` channel id
// straight out of a `…/channel/UC…` URL and returns `null` for every other shape (a
// `/user/<name>` or `/@handle` link needs an API lookup; a `/watch` link or junk carries
// no channel). The capture queue's artist-own-channel trust signal reads it, so an API
// round-trip per finding is off the table.

describe("extractYoutubeChannelId", () => {
  it("extracts the UC… id from a /channel/UC… URL", () => {
    expect(
      extractYoutubeChannelId("https://www.youtube.com/channel/UCq-Fj5jknLsUf-MWSy4_brA"),
    ).toBe("UCq-Fj5jknLsUf-MWSy4_brA");
  });

  it("extracts from a /channel/UC… URL with a trailing path or query", () => {
    expect(
      extractYoutubeChannelId("https://youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw/videos?foo=1"),
    ).toBe("UC_x5XG1OV2P6uZZ5FSM9Ttw");
  });

  it("returns null for a /user/<name> URL (needs an API lookup, out of scope)", () => {
    expect(extractYoutubeChannelId("https://www.youtube.com/user/someartist")).toBeNull();
  });

  it("returns null for a /@handle URL (needs an API lookup, out of scope)", () => {
    expect(extractYoutubeChannelId("https://www.youtube.com/@someartist")).toBeNull();
  });

  it("returns null for a non-channel YouTube URL (a /watch link)", () => {
    expect(extractYoutubeChannelId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("returns null for a channel path that is not a UC… id", () => {
    // Only the canonical `UC…` id form is a usable channel id for yt-dlp matching.
    expect(extractYoutubeChannelId("https://www.youtube.com/channel/HCabcdef")).toBeNull();
  });

  it("returns null for junk / an empty string", () => {
    expect(extractYoutubeChannelId("")).toBeNull();
    expect(extractYoutubeChannelId("not a url at all")).toBeNull();
    expect(extractYoutubeChannelId("https://open.spotify.com/artist/abc")).toBeNull();
  });
});

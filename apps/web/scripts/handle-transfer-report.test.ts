import { describe, expect, it } from "vitest";

import {
  buildCandidates,
  handleFromUrl,
  handleVariants,
  isShortHandle,
  parseTiktokProfile,
} from "./handle-transfer-report";

// PURE coverage for the handle-transfer report. The live TikTok probing is exercised by
// running the script; this pins handle extraction (esp. the youtube channel-vs-@ rule),
// the profile-marker parse, and the candidate builder (skip artists that already have tiktok).

describe("handleFromUrl", () => {
  it("lifts the first path segment for instagram/soundcloud/twitter, dropping a leading @", () => {
    expect(handleFromUrl("instagram", "https://www.instagram.com/circadian_dnb")).toBe(
      "circadian_dnb",
    );
    expect(handleFromUrl("soundcloud", "https://soundcloud.com/circadian/tracks")).toBe(
      "circadian",
    );
    expect(handleFromUrl("twitter", "https://twitter.com/@somednb")).toBe("somednb");
  });
  it("only lifts a youtube handle from the /@ form, never channel/UC… or /user/", () => {
    expect(handleFromUrl("youtube", "https://www.youtube.com/@circadian.dnb")).toBe(
      "circadian.dnb",
    );
    expect(handleFromUrl("youtube", "https://www.youtube.com/channel/UCabc123")).toBeNull();
    expect(handleFromUrl("youtube", "https://www.youtube.com/user/someone")).toBeNull();
  });
  it("returns null for a rootless or malformed url", () => {
    expect(handleFromUrl("instagram", "https://instagram.com/")).toBeNull();
    expect(handleFromUrl("instagram", "not a url")).toBeNull();
  });
});

describe("handleVariants", () => {
  it("includes the base, a punctuation-stripped form, and dnb/music/official suffixes, deduped", () => {
    expect(handleVariants("circadian_dnb")).toEqual([
      "circadian_dnb",
      "circadiandnb",
      "circadian_dnbdnb",
      "circadian_dnbmusic",
      "circadian_dnbofficial",
    ]);
  });
});

describe("isShortHandle — namesake-prone flag", () => {
  it("flags handles of 6 normalized chars or fewer", () => {
    expect(isShortHandle("camo")).toBe(true);
    expect(isShortHandle("a.b.c-d")).toBe(true); // 4 after stripping punctuation
    expect(isShortHandle("circadian")).toBe(false);
  });
});

describe("parseTiktokProfile", () => {
  it("detects existence + follower count from the followerCount marker", () => {
    expect(parseTiktokProfile('...,"followerCount":32600,...', "andromedik")).toEqual({
      exists: true,
      followers: "32600",
    });
  });
  it("detects existence from the uniqueId marker when no follower count is present", () => {
    expect(parseTiktokProfile('..."uniqueId":"mitekiss"...', "mitekiss")).toMatchObject({
      exists: true,
    });
  });
  it("reports not-exists when no marker is present", () => {
    expect(parseTiktokProfile("<html>nope</html>", "ghost")).toEqual({
      exists: false,
      followers: null,
    });
  });
});

describe("buildCandidates", () => {
  const names = new Map([
    ["a1", "Circadian"],
    ["a2", "Already"],
    ["a3", "NoHandle"],
  ]);

  it("proposes a candidate from the best anchor when the artist has no tiktok", () => {
    const anchors = new Map([
      [
        "a1",
        new Map([
          ["instagram", "https://instagram.com/circadian_dnb"],
          ["soundcloud", "https://soundcloud.com/circ"],
        ]),
      ],
    ]);
    const [c] = buildCandidates(anchors, names);
    expect(c).toMatchObject({
      anchor: "instagram",
      artistId: "a1",
      handle: "circadian_dnb",
      short: false,
    });
  });

  it("skips an artist that already has a tiktok link", () => {
    const anchors = new Map([
      [
        "a2",
        new Map([
          ["instagram", "https://instagram.com/x"],
          ["tiktok", "https://tiktok.com/@x"],
        ]),
      ],
    ]);
    expect(buildCandidates(anchors, names)).toHaveLength(0);
  });

  it("skips an artist with no usable handle anchor", () => {
    const anchors = new Map([["a3", new Map([["youtube", "https://youtube.com/channel/UCabc"]])]]);
    expect(buildCandidates(anchors, names)).toHaveLength(0);
  });
});

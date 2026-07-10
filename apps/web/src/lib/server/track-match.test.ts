import { describe, expect, it } from "vitest";
import {
  buildTrackMatchIndex,
  fold,
  matchKey,
  normalizeArtists,
  resolveTrackByText,
  splitTitle,
} from "./track-match";

// The TS port of the rekordbox_sync.py matcher — these cases mirror the Python
// source's documented discipline so the two stay in lockstep.

describe("fold", () => {
  it("lowercases, strips accents, folds & → and, drops punctuation", () => {
    expect(fold("Beyoncé & JAY-Z!")).toBe("beyonce and jay z");
    expect(fold("  Sub   Focus ")).toBe("sub focus");
  });
});

describe("normalizeArtists", () => {
  it("is order- and separator-agnostic across list and string forms", () => {
    const fromList = normalizeArtists(["Charlotte Haining", "BCee"]);
    const fromString = normalizeArtists("BCee & Charlotte Haining");

    expect([...fromList].sort()).toEqual([...fromString].sort());
  });

  it("drops feat. credits so 'A feat. B' matches a stored ['A']", () => {
    expect([...normalizeArtists("Netsky feat. Bev Lee Harling")]).toEqual(["netsky"]);
    expect([...normalizeArtists("Netsky ft. Bev Lee Harling")]).toEqual(["netsky"]);
  });

  it("splits on x / vs / and / with", () => {
    expect([...normalizeArtists("Kanine x Brandon vs Hedex")].sort()).toEqual([
      "brandon",
      "hedex",
      "kanine",
    ]);
  });
});

describe("splitTitle", () => {
  it("keeps a remix descriptor as identity", () => {
    expect(splitTitle("Song (Calibre Remix)")).toEqual({
      base: "song",
      descriptor: "calibre remix",
    });
  });

  it("treats Original Mix as the original (non-distinguishing)", () => {
    expect(splitTitle("Song (Original Mix)")).toEqual({ base: "song", descriptor: "" });
  });

  it("drops a feat. parenthetical from the base without making it a version", () => {
    expect(splitTitle("Let's Leave Tomorrow (feat. Bev Lee Harling)")).toEqual({
      base: "let s leave tomorrow",
      descriptor: "",
    });
  });

  it("recognises a dash-suffixed version", () => {
    expect(splitTitle("Song - Calibre Remix")).toEqual({
      base: "song",
      descriptor: "calibre remix",
    });
  });

  it("drops a non-version subtitle but keeps it non-distinguishing", () => {
    expect(splitTitle("Song (Part Two)")).toEqual({ base: "song", descriptor: "" });
  });
});

describe("matchKey", () => {
  it("a remix never folds onto the original", () => {
    expect(matchKey(["Alix Perez"], "Song")).not.toBe(matchKey(["Alix Perez"], "Song (VIP)"));
  });

  it("matches across separator/case/feat variance", () => {
    expect(matchKey("Netsky feat. Bev Lee Harling", "Let's Leave Tomorrow")).toBe(
      matchKey(["NETSKY"], "Let's Leave Tomorrow (feat. Bev Lee Harling)"),
    );
  });
});

describe("buildTrackMatchIndex / resolveTrackByText", () => {
  const index = buildTrackMatchIndex([
    { artists: ["Netsky", "Bev Lee Harling"], title: "Let's Leave Tomorrow", trackId: "t1" },
    { artists: ["Dawn Wall"], title: "I See You", trackId: "t2" },
    // Two DIFFERENT findings sharing one identity → ambiguous, never guessed.
    { artists: ["Dup"], title: "Same Song", trackId: "t3" },
    { artists: ["Dup"], title: "Same Song", trackId: "t4" },
  ]);

  it("resolves a folded/reordered identity to the finding", () => {
    expect(resolveTrackByText(index, "Bev Lee Harling & Netsky", "let's leave tomorrow")).toBe(
      "t1",
    );
  });

  it("returns null for an unmatched identity (honest silence)", () => {
    expect(resolveTrackByText(index, ["Unknown"], "Dubplate 7")).toBeNull();
  });

  it("returns null for an ambiguous identity (never guessed)", () => {
    expect(resolveTrackByText(index, ["Dup"], "Same Song")).toBeNull();
  });

  it("a remix of an indexed original stays unresolved", () => {
    expect(resolveTrackByText(index, ["Dawn Wall"], "I See You (Calibre Remix)")).toBeNull();
  });
});

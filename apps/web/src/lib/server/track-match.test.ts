import { describe, expect, it } from "vitest";
import {
  buildTrackMatchIndex,
  dedupeByRecordingIdentity,
  fold,
  matchKey,
  normalizeArtists,
  type RecordingIdentity,
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

  it("treats Original Version as the original too, so it folds onto the base title", () => {
    expect(splitTitle("Song (Original Version)")).toEqual({ base: "song", descriptor: "" });
    expect(splitTitle("Song - Original Version")).toEqual({ base: "song", descriptor: "" });
    // The identity is therefore the same as the bare title — a reissue tagged "(Original
    // Version)" is the SAME recording, so it collapses onto it.
    expect(matchKey(["Aphrodite"], "Song (Original Version)")).toBe(
      matchKey(["Aphrodite"], "Song"),
    );
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

describe("dedupeByRecordingIdentity (the render-time twin fold)", () => {
  const identify = (row: RecordingIdentity): RecordingIdentity => row;

  function row(overrides: Partial<RecordingIdentity> & { trackId: string }): RecordingIdentity {
    return {
      artists: ["Serum"],
      isrc: null,
      releaseDate: null,
      spotifyUrl: null,
      title: "20 Man Down",
      ...overrides,
    };
  }

  it("collapses same-identity twins to one and keeps the Spotify-anchored row", () => {
    const kept = dedupeByRecordingIdentity(
      [
        row({ isrc: "AAA", trackId: "t_isrc" }),
        row({ spotifyUrl: "https://open.spotify.com/track/x", trackId: "t_spotify" }),
        row({ trackId: "t_bare" }),
      ],
      identify,
    );

    expect(kept).toHaveLength(1);
    expect(kept[0]?.trackId).toBe("t_spotify");
  });

  it("prefers ISRC, then newest release, then the lowest id — deterministically", () => {
    // No Spotify anywhere: the ISRC row wins over the bare one.
    expect(
      dedupeByRecordingIdentity(
        [row({ trackId: "t_bare" }), row({ isrc: "AAA", trackId: "t_isrc" })],
        identify,
      )[0]?.trackId,
    ).toBe("t_isrc");

    // Neither has Spotify or ISRC: the newer release wins.
    expect(
      dedupeByRecordingIdentity(
        [
          row({ releaseDate: "2015-01-01", trackId: "t_old" }),
          row({ releaseDate: "2022-01-01", trackId: "t_new" }),
        ],
        identify,
      )[0]?.trackId,
    ).toBe("t_new");

    // A dead heat on every signal falls back to the lowest id, regardless of input order.
    const forward = dedupeByRecordingIdentity(
      [row({ trackId: "t_a" }), row({ trackId: "t_b" })],
      identify,
    );
    const reverse = dedupeByRecordingIdentity(
      [row({ trackId: "t_b" }), row({ trackId: "t_a" })],
      identify,
    );

    expect(forward[0]?.trackId).toBe("t_a");
    expect(reverse[0]?.trackId).toBe("t_a");
  });

  it("folds a '(Original Version)' reissue onto its base title (RC3 through the fold)", () => {
    const kept = dedupeByRecordingIdentity(
      [
        row({
          spotifyUrl: "https://open.spotify.com/track/x",
          title: "20 Man Down",
          trackId: "t1",
        }),
        row({ title: "20 Man Down (Original Version)", trackId: "t2" }),
      ],
      identify,
    );

    expect(kept.map((r) => r.trackId)).toEqual(["t1"]);
  });

  it("keeps genuinely distinct versions apart (the Baddadan case)", () => {
    // Distinct descriptors are distinct recordings — a remix never folds onto the original, so
    // both survive even though the base title is identical.
    const kept = dedupeByRecordingIdentity(
      [
        row({ title: "Baddadan", trackId: "t_orig" }),
        row({ title: "Baddadan (Kanine Remix)", trackId: "t_remix" }),
      ],
      identify,
    );

    expect(kept.map((r) => r.trackId).sort()).toEqual(["t_orig", "t_remix"]);
  });
});

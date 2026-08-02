import { describe, expect, it } from "vitest";
import {
  buildTrackMatchIndex,
  canonicalizeSearchTitle,
  dedupeByRecordingIdentity,
  deriveRemixerNames,
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

  it("folds a BARE trailing strong version word into the descriptor (the anchor false-miss)", () => {
    // "Paint It Black VIP" and Spotify's "Paint It Black (Vip)" are the same recording;
    // without this fold it is un-anchorable.
    expect(splitTitle("Paint It Black VIP")).toEqual({ base: "paint it black", descriptor: "vip" });
    expect(splitTitle("Song Remix")).toEqual({ base: "song", descriptor: "remix" });
    expect(matchKey(["Sigma"], "Paint It Black VIP")).toBe(
      matchKey(["Sigma"], "Paint It Black (Vip)"),
    );
  });

  it("keeps the WEAK version words as title words when bare (a '… Dub' is a title, not a version)", () => {
    expect(splitTitle("Champion Dub")).toEqual({ base: "champion dub", descriptor: "" });
    expect(splitTitle("In the Mix")).toEqual({ base: "in the mix", descriptor: "" });
    expect(splitTitle("Final Edit")).toEqual({ base: "final edit", descriptor: "" });
  });

  it("a title that IS a version word stays a title", () => {
    expect(splitTitle("VIP")).toEqual({ base: "vip", descriptor: "" });
    expect(splitTitle("Remix")).toEqual({ base: "remix", descriptor: "" });
  });

  it("folds the `rmx` spelling onto `remix` so the two forms share a key", () => {
    // "Feels Like Before (Air.K & Cephei rmx)" and "(Air.K & Cephei Remix)" identify the
    // same recording, so the descriptor cannot remain opaque.
    expect(splitTitle("Feels Like Before (Air.K & Cephei rmx)")).toEqual({
      base: "feels like before",
      descriptor: "air k and cephei remix",
    });
    expect(matchKey(["Minos"], "Feels Like Before (Air.K & Cephei rmx)")).toBe(
      matchKey(["Minos"], "Feels Like Before (Air.K & Cephei Remix)"),
    );
    // The dash-suffixed spelling folds the same way.
    expect(matchKey(["Minos"], "Feels Like Before - Air.K & Cephei rmx")).toBe(
      matchKey(["Minos"], "Feels Like Before (Air.K & Cephei Remix)"),
    );
  });

  it("drops a redundant trailing `mix` after a version word", () => {
    // "Part of Me (instrumental mix)" and streaming's "(Instrumental)" share a descriptor.
    expect(splitTitle("Part of Me (instrumental mix)")).toEqual({
      base: "part of me",
      descriptor: "instrumental",
    });
    expect(matchKey(["Klute"], "Part of Me (instrumental mix)")).toBe(
      matchKey(["Klute"], "Part of Me (Instrumental)"),
    );
    expect(splitTitle("Song (Dub Mix)")).toEqual({ base: "song", descriptor: "dub" });
  });

  it("leaves a `mix` alone when dropping it would empty the descriptor or a non-version word precedes it", () => {
    // A bare "(Mix)" keeps its one token — an empty descriptor would fold it onto the original.
    expect(splitTitle("Song (Mix)")).toEqual({ base: "song", descriptor: "mix" });
    expect(matchKey(["Klute"], "Song (Mix)")).not.toBe(matchKey(["Klute"], "Song"));
    // "dj" is not a version word, so "dj mix" is left whole (no descriptor-subset matching).
    expect(splitTitle("Song (Nu:Tone DJ Mix)")).toEqual({
      base: "song",
      descriptor: "nu tone dj mix",
    });
  });

  it("canonicalizes AFTER the neutral check, so Original/Extended Mix still fold to the original", () => {
    // "original mix" is neutral BEFORE canonicalization could turn it into a distinguishing
    // "original" — the ordering is the guarantee, so assert the resulting identity too.
    expect(splitTitle("Song (Original Mix)")).toEqual({ base: "song", descriptor: "" });
    expect(matchKey(["Klute"], "Song (Original Mix)")).toBe(matchKey(["Klute"], "Song"));
    expect(splitTitle("Song (Extended Mix)")).toEqual({ base: "song", descriptor: "" });
    expect(matchKey(["Klute"], "Song (Extended Mix)")).toBe(matchKey(["Klute"], "Song"));
    expect(matchKey(["Klute"], "Song - Original Mix")).toBe(matchKey(["Klute"], "Song"));
  });

  it("canonicalizes a BARE trailing `rmx` too", () => {
    expect(splitTitle("Song rmx")).toEqual({ base: "song", descriptor: "remix" });
    expect(matchKey(["Klute"], "Song rmx")).toBe(matchKey(["Klute"], "Song (Remix)"));
  });

  it("a found descriptor wins over a bare trailing word", () => {
    // The paren descriptor is already the identity; the base keeps its remaining words.
    expect(splitTitle("Song VIP (Calibre Remix)")).toEqual({
      base: "song vip",
      descriptor: "calibre remix",
    });
  });
});

describe("canonicalizeSearchTitle (the query spelling)", () => {
  // The retrieval-side twin of the descriptor fold: the SAME two rules on the RAW title the anchor
  // rungs search with. Both cases below are retrievable under the canonical spelling and
  // unreachable under the row's raw spelling.
  it("spells `rmx` the way the platforms index it", () => {
    expect(canonicalizeSearchTitle("Feels Like Before (Air.K & Cephei rmx)")).toBe(
      "Feels Like Before (Air.K & Cephei Remix)",
    );
  });

  it("drops a redundant trailing `mix` after a version word", () => {
    expect(canonicalizeSearchTitle("Part of Me (instrumental mix)")).toBe(
      "Part of Me (instrumental)",
    );
    expect(canonicalizeSearchTitle("Song (Dub Mix)")).toBe("Song (Dub)");
    expect(canonicalizeSearchTitle("Song - Instrumental Mix")).toBe("Song - Instrumental");
  });

  it("keeps the title's own casing, punctuation, and accents — it is not the folded key", () => {
    expect(canonicalizeSearchTitle("Feels Like Before (Air.K & Cephei rmx)")).toContain(
      "Air.K & Cephei",
    );
    // The row's register is preserved: a shouted title keeps shouting, a lowercase descriptor stays
    // lowercase. Only the `rmx`/`mix` token itself is rewritten.
    expect(canonicalizeSearchTitle("FEELS LIKE BEFORE (AIR.K RMX)")).toBe(
      "FEELS LIKE BEFORE (AIR.K REMIX)",
    );
    expect(canonicalizeSearchTitle("Café del Mar (Ratty rmx)")).toBe("Café del Mar (Ratty Remix)");
  });

  it("holds the same guards the identity fold does", () => {
    // Dropping the `mix` would empty the descriptor.
    expect(canonicalizeSearchTitle("Song (Mix)")).toBe("Song (Mix)");
    // A non-version word before it — a DJ mix is not a version of the track.
    expect(canonicalizeSearchTitle("Song (Nu:Tone DJ Mix)")).toBe("Song (Nu:Tone DJ Mix)");
    // A neutral descriptor names the original; `splitTitle` never folds it, so nor does the query.
    expect(canonicalizeSearchTitle("Song (Extended Mix)")).toBe("Song (Extended Mix)");
    expect(canonicalizeSearchTitle("Song (Original Mix)")).toBe("Song (Original Mix)");
  });

  it("passes an ordinary title through byte-identical", () => {
    for (const title of [
      "Weightless",
      "Let's Leave Tomorrow (feat. Bev Lee Harling)",
      "Song (Calibre Remix)",
      "Paint It Black VIP",
      "Mr Right On",
      "",
    ]) {
      expect(canonicalizeSearchTitle(title)).toBe(title);
    }
  });

  it("stays in lockstep with the identity fold — the canonical query still keys the same recording", () => {
    for (const title of [
      "Feels Like Before (Air.K & Cephei rmx)",
      "Part of Me (instrumental mix)",
      "Song - Instrumental Mix",
      "Song (Nu:Tone DJ Mix)",
      "Song (Extended Mix)",
    ]) {
      expect(matchKey(["Klute"], canonicalizeSearchTitle(title))).toBe(matchKey(["Klute"], title));
    }
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

describe("deriveRemixerNames (the remixer credit, RFC label-lineage-remixer U2)", () => {
  it("returns the credited artist a '(X Remix)' title names", () => {
    expect(
      deriveRemixerNames("Nobody Else (Calibre Remix)", ["Marcus Intalex", "Calibre"]),
    ).toEqual(["Calibre"]);
  });

  it("matches a dash-suffixed remix and folds punctuation/accents (S.P.Y ⇄ s p y)", () => {
    expect(deriveRemixerNames("Nobody Else - S.P.Y Remix", ["Axwell", "S.P.Y"])).toEqual(["S.P.Y"]);
  });

  it("strips the VIP version word and matches the remainder", () => {
    expect(
      deriveRemixerNames("Valley of the Shadows (Alix Perez VIP)", [
        "Origin Unknown",
        "Alix Perez",
      ]),
    ).toEqual(["Alix Perez"]);
  });

  it("resolves BOTH names of a co-remix credited individually", () => {
    expect(
      deriveRemixerNames("Tune (Calibre & Fabio Remix)", ["Nu:Tone", "Calibre", "Fabio"]).sort(),
    ).toEqual(["Calibre", "Fabio"]);
  });

  it("returns nothing for a non-remix title", () => {
    expect(deriveRemixerNames("Nobody Else", ["Axwell", "Calibre"])).toEqual([]);
  });

  it("returns nothing for a bare (Remix)/(VIP) with no name", () => {
    expect(deriveRemixerNames("Nobody Else (VIP)", ["Axwell"])).toEqual([]);
    expect(deriveRemixerNames("Nobody Else (Remix)", ["Axwell"])).toEqual([]);
  });

  it("never guesses beyond an exact fold match (an uncredited remixer stays absent)", () => {
    // The title names Calibre, but Calibre is not one of the track's linked artists.
    expect(deriveRemixerNames("Nobody Else (Calibre Remix)", ["Axwell", "Marcus Intalex"])).toEqual(
      [],
    );
  });

  it("does NOT treat the neutral 'Original Mix' as a remixer descriptor", () => {
    expect(deriveRemixerNames("Nobody Else (Original Mix)", ["Axwell"])).toEqual([]);
  });

  it("is unchanged by descriptor canonicalization — the version word is stripped either spelling", () => {
    // `rmx` canonicalizes to `remix`; both are VERSION_WORDS, so the remainder is the same name.
    expect(
      deriveRemixerNames("Feels Like Before (Air.K & Cephei rmx)", [
        "Minos",
        "Air.K",
        "Cephei",
      ]).sort(),
    ).toEqual(["Air.K", "Cephei"]);
    expect(deriveRemixerNames("Nobody Else (Calibre rmx)", ["Axwell", "Calibre"])).toEqual([
      "Calibre",
    ]);
    // A bare "(rmx)" names nobody, exactly as a bare "(Remix)" does.
    expect(deriveRemixerNames("Nobody Else (rmx)", ["Axwell"])).toEqual([]);
    // "instrumental mix" collapses to "instrumental" — still a version word, still no remixer.
    expect(deriveRemixerNames("Part of Me (instrumental mix)", ["Klute"])).toEqual([]);
  });
});

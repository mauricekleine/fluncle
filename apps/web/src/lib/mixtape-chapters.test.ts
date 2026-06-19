import { type MixtapeMember } from "@fluncle/contracts";
import { describe, expect, it } from "vitest";
import {
  formatTimestamp,
  mixtapeChapters,
  mixtapeDescription,
  youtubeDescription,
} from "./mixtape-chapters";

// A MixtapeMember is a full TrackListItem + startMs; fill the required fields with
// dummies and vary only what the helpers read (artists, title, startMs).
function member(
  artists: string[],
  title: string,
  startMs: number | undefined,
  trackId: string,
): MixtapeMember {
  return {
    addedAt: "2026-06-19T00:00:00.000Z",
    addedToSpotify: true,
    artists,
    durationMs: 240_000,
    enrichmentStatus: "done",
    postedToTelegram: true,
    spotifyUrl: "https://open.spotify.com/track/x",
    startMs,
    title,
    trackId,
  };
}

describe("formatTimestamp", () => {
  it("renders m:ss under an hour, h:mm:ss past it", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(5)).toBe("0:05");
    expect(formatTimestamp(65)).toBe("1:05");
    expect(formatTimestamp(600)).toBe("10:00");
    expect(formatTimestamp(3661)).toBe("1:01:01");
  });

  it("floors fractional and clamps negative seconds", () => {
    expect(formatTimestamp(65.9)).toBe("1:05");
    expect(formatTimestamp(-10)).toBe("0:00");
  });
});

describe("mixtapeChapters", () => {
  it("forces the first chapter to 0:00 and emits when ≥3 cued and spaced", () => {
    const members = [
      member(["Alpha"], "First", 5_000, "a"),
      member(["Beta", "Gamma"], "Second", 120_000, "b"),
      member(["Delta"], "Third", 240_000, "c"),
    ];

    const { youtubeChapters, cuedCount, totalCount } = mixtapeChapters(members);

    expect(cuedCount).toBe(3);
    expect(totalCount).toBe(3);
    expect(youtubeChapters).toBe(
      ["0:00 Alpha - First", "2:00 Beta, Gamma - Second", "4:00 Delta - Third"].join("\n"),
    );
  });

  it("returns no YouTube chapters with fewer than 3 cued members", () => {
    const members = [member(["Alpha"], "First", 0, "a"), member(["Beta"], "Second", 120_000, "b")];

    const result = mixtapeChapters(members);

    expect(result.youtubeChapters).toBeNull();
    // Mixcloud still gets both sections — no ≥3 rule there.
    expect(result.mixcloudSections).toHaveLength(2);
  });

  it("drops chapters closer than 10s to the prior, and nulls if that falls below 3", () => {
    const members = [
      member(["Alpha"], "First", 0, "a"),
      member(["Beta"], "Second", 5_000, "b"), // 5s after — dropped
      member(["Gamma"], "Third", 8_000, "c"), // 8s after first kept (0:00) — dropped
    ];

    expect(mixtapeChapters(members).youtubeChapters).toBeNull();
  });

  it("filters un-cued members from both YouTube and Mixcloud", () => {
    const members = [
      member(["Alpha"], "First", 0, "a"),
      member(["Beta"], "Second", undefined, "b"), // no cue
      member(["Gamma"], "Third", 120_000, "c"),
      member(["Delta"], "Fourth", 240_000, "d"),
    ];

    const { mixcloudSections, cuedCount, totalCount, youtubeChapters } = mixtapeChapters(members);

    expect(totalCount).toBe(4);
    expect(cuedCount).toBe(3);
    expect(mixcloudSections.map((s) => s.song)).toEqual(["First", "Third", "Fourth"]);
    expect(youtubeChapters?.split("\n")).toHaveLength(3);
  });

  it("emits Mixcloud sections with integer-second start_time and joined artists", () => {
    const members = [
      member(["Alpha", "Beta"], "First", 90_500, "a"),
      member(["Gamma"], "Second", 181_999, "b"),
    ];

    expect(mixtapeChapters(members).mixcloudSections).toEqual([
      { artist: "Alpha, Beta", song: "First", start_time: 90 },
      { artist: "Gamma", song: "Second", start_time: 181 },
    ]);
  });

  it("sorts by cue offset before building", () => {
    const members = [
      member(["C"], "Third", 240_000, "c"),
      member(["A"], "First", 0, "a"),
      member(["B"], "Second", 120_000, "b"),
    ];

    expect(mixtapeChapters(members).mixcloudSections.map((s) => s.song)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });
});

describe("mixtapeDescription", () => {
  it("appends the fluncle:// breadcrumb after a blank line and trims the note", () => {
    expect(mixtapeDescription("  A late checkpoint.  ", "019.F.1A")).toBe(
      "A late checkpoint.\n\nfluncle://019.F.1A",
    );
  });
});

describe("youtubeDescription", () => {
  it("appends the chapter block after the breadcrumb when ≥3 chapters exist", () => {
    const members = [
      member(["Alpha"], "First", 0, "a"),
      member(["Beta"], "Second", 120_000, "b"),
      member(["Gamma"], "Third", 240_000, "c"),
    ];

    expect(youtubeDescription("Note.", "019.F.1A", members)).toBe(
      [
        "Note.",
        "",
        "fluncle://019.F.1A",
        "",
        "0:00 Alpha - First",
        "2:00 Beta - Second",
        "4:00 Gamma - Third",
      ].join("\n"),
    );
  });

  it("is just note + breadcrumb when there are too few chapters", () => {
    const members = [member(["Alpha"], "First", 0, "a")];

    expect(youtubeDescription("Note.", "019.F.1A", members)).toBe("Note.\n\nfluncle://019.F.1A");
  });
});

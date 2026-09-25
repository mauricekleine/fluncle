import { describe, expect, it } from "vitest";
import { type FreshPage, type FreshView, type FreshWeek } from "@/lib/fresh-releases";
import {
  FRESH_NEW_MARK_LABEL,
  freshEmptyLine,
  freshEmptyViewLine,
  freshEndLine,
  freshIntro,
  freshPlayWeekLabels,
  freshSinceVisitJump,
  freshSinceVisitLine,
  freshStandoutsHeading,
  freshWeekCount,
  freshWeekHeading,
} from "./copy";

const SPAN = "Sep 5 – 11, 2026";

function page(overrides: Partial<FreshPage> = {}): FreshPage {
  return {
    coverage: { kind: "complete" },
    releaseCount: 3,
    standouts: undefined,
    today: "2026-09-25",
    trackCount: 5,
    weeks: [],
    windowDays: 30,
    ...overrides,
  };
}

function week(index: number, trackCounts: number[] = [1]): FreshWeek {
  return {
    from: "2026-09-05",
    index,
    releases: trackCounts.map((count, release) => ({
      artists: ["Artist"],
      key: `release:${release}`,
      lit: false,
      record: count > 1,
      releaseDate: "2026-09-10",
      title: `Release ${release}`,
      tracks: Array.from({ length: count }, (_, track) => ({
        artists: [{ name: "Artist" }],
        lit: false,
        previewable: true,
        title: `Track ${track}`,
        trackId: `t-${release}-${track}`,
      })),
    })),
    span: SPAN,
    to: "2026-09-11",
  };
}

const PARTIAL = page({
  coverage: { kind: "partial", since: "2026-09-02" },
  coverageDate: "Sep 2, 2026",
});

const TRUNCATED = page({
  coverage: { day: "2026-09-25", kind: "truncated" },
  coverageDate: "Sep 25, 2026",
});

describe("freshIntro", () => {
  it("counts releases with the noun that agrees", () => {
    expect(freshIntro(page({ releaseCount: 1 }))).toBe(
      "1 drum & bass release from the last 30 days.",
    );
    expect(freshIntro(page({ releaseCount: 12 }))).toBe(
      "12 drum & bass releases from the last 30 days.",
    );
  });

  it("names the day a partial window reaches back to", () => {
    expect(freshIntro({ ...PARTIAL, releaseCount: 40 })).toBe(
      "40 drum & bass releases since Sep 2, 2026.",
    );
  });

  it("says a day too big for the page is only part-held, never all of it", () => {
    expect(freshIntro({ ...TRUNCATED, releaseCount: 70 })).toBe(
      "70 of the drum & bass releases out on Sep 25, 2026.",
    );
  });
});

describe("the week buckets", () => {
  it("heads this week and last week by name, and an older week by its dates", () => {
    expect(freshWeekHeading(week(0))).toBe("This week");
    expect(freshWeekHeading(week(1))).toBe("Last week");
    expect(freshWeekHeading(week(3))).toBe(SPAN);
  });

  it("counts releases, or tracks in the tracks view", () => {
    const bucket = week(0, [3, 1]);

    expect(freshWeekCount(bucket, "all")).toBe("2 releases");
    expect(freshWeekCount(bucket, "albums")).toBe("2 releases");
    expect(freshWeekCount(bucket, "tracks")).toBe("4 tracks");
    expect(freshWeekCount(week(0, [1]), "all")).toBe("1 release");
    expect(freshWeekCount(week(0, [1]), "tracks")).toBe("1 track");
  });

  it("labels this week and last week's controls plainly, with no separate name", () => {
    expect(freshPlayWeekLabels(week(0))).toEqual({
      pause: "Pause this week",
      play: "Play this week",
    });
    expect(freshPlayWeekLabels(week(1))).toEqual({
      pause: "Pause last week",
      play: "Play last week",
    });
  });

  it("names an older week's control by its dates, starting with the visible label", () => {
    const labels = freshPlayWeekLabels(week(2));

    expect(labels.play).toBe("Play the week");
    expect(labels.pause).toBe("Pause the week");
    expect(labels.name?.play).toBe(`Play the week of ${SPAN}`);
    expect(labels.name?.pause).toBe(`Pause the week of ${SPAN}`);

    expect(labels.name?.play.startsWith(labels.play)).toBe(true);
    expect(labels.name?.pause.startsWith(labels.pause)).toBe(true);
  });
});

describe("the standouts heading", () => {
  it("says where the standouts were drawn from", () => {
    expect(freshStandoutsHeading("this-week")).toBe("This week's standouts");
    expect(freshStandoutsHeading("last-week")).toBe("Last week's standouts");
    expect(freshStandoutsHeading("two-weeks")).toBe("Standouts from the last two weeks");
  });
});

describe("freshEndLine", () => {
  it("closes a whole window as caught up, in the view's own noun", () => {
    expect(freshEndLine(page(), "all")).toEqual({
      lead: "That's every release from the last 30 days.",
      tail: "caught-up",
    });
    expect(freshEndLine(page(), "tracks").lead).toBe("That's every track from the last 30 days.");
    expect(freshEndLine(page(), "albums").lead).toBe(
      "That's every album and EP from the last 30 days.",
    );
  });

  it("closes a partial window on the day it reaches back to, pointing at the older rest", () => {
    expect(freshEndLine(PARTIAL, "all")).toEqual({
      lead: "That's every release since Sep 2, 2026.",
      tail: "older",
    });
    expect(freshEndLine(PARTIAL, "tracks").lead).toBe("That's every track since Sep 2, 2026.");
  });

  it("never closes a part-held day as every release, and points at the rest of it", () => {
    expect(freshEndLine(TRUNCATED, "all")).toEqual({
      lead: "That's part of what came out on Sep 25, 2026.",
      tail: "rest",
    });
  });
});

describe("the empty and since-visit lines", () => {
  it("counts new releases since the last visit, and says plainly when there are none", () => {
    expect(freshSinceVisitLine(0)).toBe("No new releases since your last visit.");
    expect(freshSinceVisitLine(1)).toBe("1 new release since your last visit.");
    expect(freshSinceVisitLine(7)).toBe("7 new releases since your last visit.");
  });

  it("says an empty window and an empty albums view in the window's own days", () => {
    expect(freshEmptyLine(30)).toBe("No new releases in the last 30 days.");
    expect(freshEmptyViewLine(30)).toBe("No albums or EPs out in the last 30 days.");
  });
});

describe("the new mark", () => {
  it("reads as one plain word", () => {
    expect(FRESH_NEW_MARK_LABEL).toBe("New");
  });
});

describe("every string", () => {
  it("carries no em dash", () => {
    const views: FreshView[] = ["all", "albums", "tracks"];
    const strings = [
      freshIntro(page({ releaseCount: 1 })),
      freshIntro(page()),
      freshIntro(PARTIAL),
      freshEmptyLine(30),
      freshEmptyViewLine(30),
      ...[0, 1, 2].map((index) => freshWeekHeading(week(index))),
      ...views.flatMap((view) => [
        freshWeekCount(week(0, [2]), view),
        freshEndLine(page(), view).lead,
        freshEndLine(PARTIAL, view).lead,
      ]),
      ...[0, 1, 2].flatMap((index) => {
        const labels = freshPlayWeekLabels(week(index));

        return [labels.play, labels.pause, labels.name?.play ?? "", labels.name?.pause ?? ""];
      }),
      freshStandoutsHeading("this-week"),
      freshStandoutsHeading("last-week"),
      freshStandoutsHeading("two-weeks"),
      freshSinceVisitLine(0),
      freshSinceVisitLine(1),
      freshSinceVisitLine(3),
      FRESH_NEW_MARK_LABEL,
    ];

    for (const text of strings) {
      expect(text).not.toContain("—");
    }
  });
});

describe("the since-visit line in the Tracks view", () => {
  it("counts tracks there, and names its jump in the same unit", () => {
    expect(freshSinceVisitLine(6, "tracks")).toBe("6 new tracks since your last visit.");
    expect(freshSinceVisitLine(1, "tracks")).toBe("1 new track since your last visit.");
    expect(freshSinceVisitLine(0, "tracks")).toBe("No new tracks since your last visit.");
    expect(freshSinceVisitJump("all")).toBe("Jump to the first new release");
    expect(freshSinceVisitJump("tracks")).toBe("Jump to the first new track");
  });
});

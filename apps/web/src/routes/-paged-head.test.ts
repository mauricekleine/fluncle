import { describe, expect, it } from "vitest";

const { tracksHead } = await import("@/lib/tracks-search");

type TracksHeadResult = {
  links?: Array<{ href: string; rel: string }>;
  meta?: Array<{ content?: string; name?: string; property?: string; title?: string }>;
  scripts?: Array<{ children?: string }>;
};

function tracksRobots(result: TracksHeadResult): string | undefined {
  return result.meta?.find((entry) => entry.name === "robots")?.content;
}

function tracksTitle(result: TracksHeadResult): string | undefined {
  return (result.meta as Array<{ title?: string }>)?.find((entry) => entry.title !== undefined)
    ?.title;
}

function tracksDescription(result: TracksHeadResult): string | undefined {
  return result.meta?.find((entry) => entry.name === "description")?.content;
}

function tracksEntry(releaseDate: string) {
  return {
    artistLinks: [],
    kind: "catalogue" as const,
    releaseDate,
    track: {
      artists: ["Test"],
      previewable: false,
      releaseDate,
      spotifyUrl: "",
      title: "Test",
      trackId: "t1",
    },
  };
}

describe("tracks hub page 1 titles and descriptions remain byte-identical", () => {
  it("returns the canonical page 1 title", () => {
    const result = tracksHead({}, { entries: [], page: 1, total: 0 });

    expect(tracksTitle(result)).toBe("Every drum & bass track, newest first · Fluncle");
  });

  it("returns the canonical page 1 description", () => {
    const result = tracksHead({}, { entries: [], page: 1, total: 0 });

    expect(tracksDescription(result)).toBe(
      "Every drum & bass track Fluncle holds, newest release first. Filter the whole list by release year, key, and label, or jump straight to a year.",
    );
  });
});

describe("tracks hub pagination indexing", () => {
  it.each([
    { expectedRobots: undefined, page: 5 },
    { expectedRobots: "noindex, follow", page: 6 },
  ])(
    "keeps page $page crawlable and self-canonical at the indexing boundary",
    ({ page, expectedRobots }) => {
      const result = tracksHead({}, { entries: [], page, total: 100_000 });

      expect(tracksRobots(result)).toBe(expectedRobots);
      expect(result.links).toEqual([
        { href: `https://www.fluncle.com/tracks?page=${page}`, rel: "canonical" },
      ]);
      expect(result.scripts).toHaveLength(1);
    },
  );
});

describe("tracks hub page>1 content-specific titles", () => {
  it("uses a release span title when entries have release dates", () => {
    const entries = [
      tracksEntry("2019-01-15"),
      tracksEntry("2019-01-10"),
      tracksEntry("2018-12-20"),
    ];
    const result = tracksHead({}, { entries, page: 1692, pageCount: 2000, total: 100_000 });
    expect(tracksTitle(result)).toBe(
      "Drum & bass tracks released December 2018 to January 2019, page 1692 · Fluncle",
    );
    expect(tracksDescription(result)).toBe(
      "Drum & bass tracks released December 2018 to January 2019, page 1692 of 2000.",
    );
    expect(result.meta?.find((entry) => entry.property === "og:title")?.content).toBe(
      tracksTitle(result),
    );
    expect(result.meta?.find((entry) => entry.name === "twitter:title")?.content).toBe(
      tracksTitle(result),
    );
  });

  it("keeps both release endpoints when undated or malformed rows surround dated rows", () => {
    const entries = [
      tracksEntry("0"),
      tracksEntry("2018-12-20"),
      tracksEntry("2019-03-15"),
      tracksEntry("undated-z"),
    ];
    const result = tracksHead({}, { entries, page: 500, pageCount: 2000, total: 100_000 });
    expect(tracksTitle(result)).toBe(
      "Drum & bass tracks released December 2018 to March 2019, page 500 · Fluncle",
    );
  });

  it("ignores entries with empty releaseDate strings", () => {
    const entries = [tracksEntry(""), tracksEntry(""), tracksEntry("")];
    const result = tracksHead({}, { entries, page: 50, total: 100_000 });
    expect(tracksTitle(result)).toBe("Every drum & bass track, page 50 · Fluncle");
  });
});

describe("tracks hub page>1 content-specific descriptions", () => {
  it("falls back to page-only position when pageCount is not provided", () => {
    const entries = [tracksEntry("2018-12-20"), tracksEntry("2019-01-10")];
    const result = tracksHead({}, { entries, page: 1692, total: 100_000 });
    expect(tracksDescription(result)).toBe(
      "Drum & bass tracks released December 2018 to January 2019, page 1692.",
    );
  });
});

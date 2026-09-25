// `/fresh`'s fold, as pure logic: the window's two newest-first halves (lit findings, unlit
// catalogue rows) become RELEASES (one entry per record), and releases become rolling WEEKS back
// from today. No DB and no clock: the rows and `today` are the whole input.

import { describe, expect, it } from "vitest";
import {
  FRESH_STANDOUT_LIMIT,
  type FreshPage,
  type FreshRelease,
  freshDay,
  freshViewWeeks,
  freshWeekIndex,
  groupFreshReleases,
  newestFreshReleases,
  releaseTrack,
  releasesQueue,
} from "./fresh-releases";
import {
  type FreshCatalogueItem,
  type FreshCoverage,
  type FreshFinding,
  type FreshReleases,
} from "./server/fresh";

const TODAY = "2026-09-25";
const WINDOW_DAYS = 30;

/** The locale's range joiner: a thin space, an en dash, a thin space. */
const RANGE = " – ";

type RowOptions = {
  album?: string;
  albumImageUrl?: string;
  albumSlug?: string;
  albumTrackCount?: number;
  artistAvatarUrl?: string;
  artists?: string[];
  isrc?: string;
  releaseDate: string;
  title?: string;
  trackId: string;
};

/** A certified finding row, as `listFreshReleases` hands it over. */
function finding(options: RowOptions): FreshFinding {
  return {
    addedAt: "2026-01-01T00:00:00.000Z",
    addedToSpotify: false,
    album: options.album,
    albumImageUrl: options.albumImageUrl,
    albumSlug: options.albumSlug,
    albumTrackCount: options.albumTrackCount,
    artistAvatarUrl: options.artistAvatarUrl,
    artists: options.artists ?? ["Lit Artist"],
    durationMs: 210_000,
    enrichmentStatus: "complete",
    isrc: options.isrc,
    logId: `100.9.${options.trackId}`,
    postedToTelegram: false,
    releaseDate: options.releaseDate,
    spotifyUrl: `https://open.spotify.com/track/${options.trackId}`,
    title: options.title ?? `Title ${options.trackId}`,
    trackId: options.trackId,
  };
}

/** An uncertified catalogue row, as `listFreshReleases` hands it over. */
function catalogue(options: RowOptions): FreshCatalogueItem {
  return {
    album: options.album,
    albumImageUrl: options.albumImageUrl,
    albumSlug: options.albumSlug,
    albumTrackCount: options.albumTrackCount,
    artistAvatarUrl: options.artistAvatarUrl,
    artists: options.artists ?? ["Quiet Artist"],
    durationMs: 210_000,
    isrc: options.isrc,
    previewable: Boolean(options.isrc),
    releaseDate: options.releaseDate,
    spotifyUrl: `https://open.spotify.com/track/${options.trackId}`,
    title: options.title ?? `Title ${options.trackId}`,
    trackId: options.trackId,
  };
}

function windowOf(
  findings: FreshFinding[],
  rows: FreshCatalogueItem[],
  coverage: FreshCoverage = { kind: "complete" },
): FreshReleases {
  return { catalogue: rows, coverage, findings, windowDays: WINDOW_DAYS };
}

function allReleases(page: FreshPage): FreshRelease[] {
  return page.weeks.flatMap((week) => week.releases);
}

function releaseByKey(page: FreshPage, key: string): FreshRelease | undefined {
  return allReleases(page).find((release) => release.key === key);
}

/** `count` lone catalogue releases on one day, each its own release. */
function loneReleases(prefix: string, releaseDate: string, count: number): FreshCatalogueItem[] {
  return Array.from({ length: count }, (_, index) =>
    catalogue({ releaseDate, trackId: `${prefix}${index + 1}` }),
  );
}

describe("groupFreshReleases — the release fold", () => {
  it("folds every track on one album entity into one release keyed by its slug", () => {
    const page = groupFreshReleases(
      windowOf(
        [
          finding({
            album: "Words Gone Forever",
            albumSlug: "wgf",
            releaseDate: "2026-09-20",
            trackId: "f1",
          }),
        ],
        [
          catalogue({
            album: "Words Gone Forever",
            albumSlug: "wgf",
            releaseDate: "2026-09-20",
            trackId: "c1",
          }),
          catalogue({
            album: "Words Gone Forever",
            albumSlug: "wgf",
            releaseDate: "2026-09-20",
            trackId: "c2",
          }),
        ],
      ),
      TODAY,
    );

    expect(page.releaseCount).toBe(1);
    expect(page.trackCount).toBe(3);
    const release = releaseByKey(page, "album:wgf");
    expect(release).toMatchObject({
      albumSlug: "wgf",
      lit: true,
      releaseDate: "2026-09-20",
      title: "Words Gone Forever",
    });
    expect(release?.tracks).toHaveLength(3);
  });

  it("falls back to the record name and its lead artist, case-folded, when a record has no album entity", () => {
    const page = groupFreshReleases(
      windowOf(
        [],
        [
          catalogue({ album: "Loose Pressing", releaseDate: "2026-09-20", trackId: "c1" }),
          catalogue({ album: "loose pressing", releaseDate: "2026-09-20", trackId: "c2" }),
        ],
      ),
      TODAY,
    );

    expect(page.releaseCount).toBe(1);
    const release = releaseByKey(page, "record:loose pressing|quiet artist");
    expect(release?.tracks.map((track) => track.trackId).sort()).toEqual(["c1", "c2"]);
    expect(release?.albumSlug).toBeUndefined();
    expect(release?.releaseDate).toBe("2026-09-20");
    expect(release?.lit).toBe(false);
  });

  it("keeps two artists' same-named records with no album entity apart, even on the same day", () => {
    const page = groupFreshReleases(
      windowOf(
        [],
        [
          catalogue({
            album: "Remixes",
            artists: ["Ashen Relay"],
            releaseDate: "2026-09-20",
            trackId: "c1",
          }),
          catalogue({
            album: "Remixes",
            artists: ["Cinder Vane"],
            releaseDate: "2026-09-20",
            trackId: "c2",
          }),
        ],
      ),
      TODAY,
    );

    expect(page.releaseCount).toBe(2);
    expect(
      allReleases(page)
        .map((release) => release.key)
        .sort(),
    ).toEqual(["record:remixes|ashen relay", "record:remixes|cinder vane"]);
  });

  it("keeps one record with no album entity as one release when its tracks came out in different weeks", () => {
    const page = groupFreshReleases(
      windowOf(
        [],
        [
          catalogue({ album: "Remixes", releaseDate: "2026-09-20", trackId: "c1" }),
          catalogue({ album: "Remixes", releaseDate: "2026-09-12", trackId: "c2" }),
        ],
      ),
      TODAY,
    );

    // One release, in the two weeks its tracks came out in: the same rule as a linked album.
    expect(page.releaseCount).toBe(1);
    expect(page.weeks.map((week) => week.releases.map((release) => release.key))).toEqual([
      ["record:remixes|quiet artist"],
      ["record:remixes|quiet artist"],
    ]);
  });

  it("keeps a track with no record as a release of one, titled by the track", () => {
    const page = groupFreshReleases(
      windowOf([], [catalogue({ releaseDate: "2026-09-20", title: "Lone Cut", trackId: "c1" })]),
      TODAY,
    );

    expect(allReleases(page).map((release) => release.key)).toEqual(["track:c1"]);
    expect(releaseByKey(page, "track:c1")?.title).toBe("Lone Cut");
  });

  it("titles a release of one track by the track even when it names a record", () => {
    const page = groupFreshReleases(
      windowOf(
        [],
        [
          catalogue({
            album: "The Single",
            releaseDate: "2026-09-20",
            title: "A Side",
            trackId: "c1",
          }),
        ],
      ),
      TODAY,
    );

    expect(releaseByKey(page, "record:the single|quiet artist")?.title).toBe("A Side");
  });

  it("orders a release's tracks by ISRC, the tracks with one first, then the rest by title", () => {
    const page = groupFreshReleases(
      windowOf(
        [finding({ albumSlug: "ep", releaseDate: "2026-09-20", title: "Bravo", trackId: "f1" })],
        [
          catalogue({
            albumSlug: "ep",
            isrc: "GBAAA2600002",
            releaseDate: "2026-09-20",
            title: "Alpha",
            trackId: "c1",
          }),
          catalogue({
            albumSlug: "ep",
            releaseDate: "2026-09-20",
            title: "alpha two",
            trackId: "c2",
          }),
          catalogue({
            albumSlug: "ep",
            isrc: "GBAAA2600001",
            releaseDate: "2026-09-20",
            title: "Delta",
            trackId: "c3",
          }),
        ],
      ),
      TODAY,
    );

    const tracks = releaseByKey(page, "album:ep")?.tracks ?? [];
    // A finding holds no lead inside its release: the record's own order does.
    expect(tracks.map((track) => track.title)).toEqual(["Delta", "Alpha", "alpha two", "Bravo"]);
    expect(tracks.map((track) => track.lit)).toEqual([false, false, false, true]);
  });

  it("lets ISRC order win over title order within a release", () => {
    const page = groupFreshReleases(
      windowOf(
        [],
        [
          catalogue({
            albumSlug: "lp",
            isrc: "GBAAA2600003",
            releaseDate: "2026-09-20",
            title: "Aardvark",
            trackId: "c1",
          }),
          catalogue({
            albumSlug: "lp",
            isrc: "GBAAA2600001",
            releaseDate: "2026-09-20",
            title: "Zebra",
            trackId: "c2",
          }),
          catalogue({
            albumSlug: "lp",
            isrc: "GBAAA2600002",
            releaseDate: "2026-09-20",
            title: "Mongoose",
            trackId: "c3",
          }),
        ],
      ),
      TODAY,
    );

    expect(releaseByKey(page, "album:lp")?.tracks.map((track) => track.title)).toEqual([
      "Zebra",
      "Mongoose",
      "Aardvark",
    ]);
  });

  it("holds a record's cover and portrait once, and releaseTrack puts them back on each row", () => {
    const page = groupFreshReleases(
      windowOf(
        [],
        [
          catalogue({
            albumImageUrl: "https://img/cover-a",
            albumSlug: "ep",
            artistAvatarUrl: "https://img/face-a",
            releaseDate: "2026-09-20",
            title: "Alpha",
            trackId: "c1",
          }),
          catalogue({
            albumImageUrl: "https://img/cover-a",
            albumSlug: "ep",
            artistAvatarUrl: "https://img/face-a",
            releaseDate: "2026-09-20",
            title: "Bravo",
            trackId: "c2",
          }),
          catalogue({
            albumImageUrl: "https://img/cover-b",
            albumSlug: "ep",
            artistAvatarUrl: "https://img/face-b",
            releaseDate: "2026-09-20",
            title: "Charlie",
            trackId: "c3",
          }),
        ],
      ),
      TODAY,
    );
    const release = releaseByKey(page, "album:ep");

    expect(release?.coverUrl).toBe("https://img/cover-a");
    expect(release?.avatarUrl).toBe("https://img/face-a");
    // A cover equal to the release's is dropped from the track; a different one stays.
    expect(release?.tracks.map((track) => track.coverUrl)).toEqual([
      undefined,
      undefined,
      "https://img/cover-b",
    ]);
    expect(release?.tracks.map((track) => track.avatarUrl)).toEqual([
      undefined,
      undefined,
      "https://img/face-b",
    ]);

    if (!release) {
      throw new Error("the release folded away");
    }
    const restored = release.tracks.map((track) => releaseTrack(release, track));
    expect(restored.map((track) => track.coverUrl)).toEqual([
      "https://img/cover-a",
      "https://img/cover-a",
      "https://img/cover-b",
    ]);
    expect(restored.map((track) => track.avatarUrl)).toEqual([
      "https://img/face-a",
      "https://img/face-a",
      "https://img/face-b",
    ]);
    expect(releasesQueue([release])).toEqual(restored);
  });

  it("credits a release past three distinct artists as Various artists", () => {
    const rows = ["A", "B", "C", "D"].map((artist, index) =>
      catalogue({
        albumSlug: "va",
        artists: [artist],
        releaseDate: "2026-09-20",
        trackId: `va${index}`,
      }),
    );
    const three = ["A", "B", "C"].map((artist, index) =>
      catalogue({
        albumSlug: "trio",
        artists: [artist],
        releaseDate: "2026-09-20",
        trackId: `trio${index}`,
      }),
    );
    const page = groupFreshReleases(windowOf([], [...rows, ...three]), TODAY);

    expect(releaseByKey(page, "album:va")?.artists).toEqual(["Various artists"]);
    expect(releaseByKey(page, "album:trio")?.artists).toEqual(["A", "B", "C"]);
  });
});

describe("groupFreshReleases — rolling weeks back from today", () => {
  it("indexes a release by its age in whole weeks, clamping a future day to this week", () => {
    expect(freshWeekIndex("2026-09-25", TODAY, WINDOW_DAYS)).toBe(0);
    expect(freshWeekIndex("2026-09-19", TODAY, WINDOW_DAYS)).toBe(0);
    expect(freshWeekIndex("2026-09-18", TODAY, WINDOW_DAYS)).toBe(1);
    expect(freshWeekIndex("2026-09-12", TODAY, WINDOW_DAYS)).toBe(1);
    expect(freshWeekIndex("2026-09-05", TODAY, WINDOW_DAYS)).toBe(2);
    expect(freshWeekIndex("2026-09-30", TODAY, WINDOW_DAYS)).toBe(0);
  });

  it("folds the window's tail into its last full week, never a stub bucket of a few days", () => {
    // A 30-day window holds four full weeks (0..3); ages 21 through 30 all land in week 3.
    expect(freshWeekIndex("2026-09-04", TODAY, WINDOW_DAYS)).toBe(3);
    expect(freshWeekIndex("2026-08-28", TODAY, WINDOW_DAYS)).toBe(3);
    expect(freshWeekIndex("2026-08-26", TODAY, WINDOW_DAYS)).toBe(3);
    // A window shorter than a week is one bucket.
    expect(freshWeekIndex("2026-09-20", TODAY, 5)).toBe(0);
  });

  it("reads a partial date as the first day its precision stands for", () => {
    expect(freshDay("2026-09-05")).toBe("2026-09-05");
    expect(freshDay("2026-09")).toBe("2026-09-01");
    expect(freshDay("2026")).toBe("2026-01-01");
    expect(freshWeekIndex("2026-09", TODAY, WINDOW_DAYS)).toBe(3);
  });

  it("emits only the weeks that hold a release, newest first, each with its span", () => {
    const page = groupFreshReleases(
      windowOf(
        [],
        [
          catalogue({ releaseDate: "2026-09-24", trackId: "w0" }),
          catalogue({ releaseDate: "2026-09-10", trackId: "w2" }),
        ],
      ),
      TODAY,
    );

    expect(page.today).toBe(TODAY);
    expect(page.windowDays).toBe(WINDOW_DAYS);
    expect(page.weeks.map((week) => week.index)).toEqual([0, 2]);
    expect(page.weeks[0]).toMatchObject({
      from: "2026-09-19",
      span: `Sep 19${RANGE}25, 2026`,
      to: "2026-09-25",
    });
    expect(page.weeks[1]).toMatchObject({
      from: "2026-09-05",
      span: `Sep 5${RANGE}11, 2026`,
      to: "2026-09-11",
    });
  });

  it("names both months in a week that crosses one", () => {
    const page = groupFreshReleases(
      windowOf([], [catalogue({ releaseDate: "2026-08-30", trackId: "cross" })]),
      "2026-09-02",
    );

    expect(page.weeks[0]).toMatchObject({
      from: "2026-08-27",
      index: 0,
      span: `Aug 27${RANGE}Sep 2, 2026`,
      to: "2026-09-02",
    });
  });

  it("starts the oldest week at the window's trailing edge", () => {
    const page = groupFreshReleases(
      windowOf(
        [],
        [
          catalogue({ releaseDate: "2026-09-04", trackId: "age21" }),
          catalogue({ releaseDate: "2026-08-26", trackId: "age30" }),
        ],
      ),
      TODAY,
    );

    expect(page.weeks).toHaveLength(1);
    expect(page.weeks[0]).toMatchObject({
      from: "2026-08-26",
      index: 3,
      span: `Aug 26${RANGE}Sep 4, 2026`,
      to: "2026-09-04",
    });
    expect(page.weeks[0]?.releases.map((release) => release.key)).toEqual([
      "track:age21",
      "track:age30",
    ]);
  });

  it("files a month-precision release in the week holding that month's first day", () => {
    const page = groupFreshReleases(
      windowOf([], [catalogue({ releaseDate: "2026-09", trackId: "month" })]),
      TODAY,
    );

    expect(page.weeks.map((week) => week.index)).toEqual([3]);
    expect(page.weeks[0]?.releases.map((release) => release.key)).toEqual(["track:month"]);
  });

  it("returns no weeks and no standouts for an empty window", () => {
    const page = groupFreshReleases(windowOf([], []), TODAY);

    expect(page.weeks).toEqual([]);
    expect(page.standouts).toBeUndefined();
    expect(page.releaseCount).toBe(0);
    expect(page.trackCount).toBe(0);
  });
});

describe("groupFreshReleases — coverage", () => {
  it("formats a partial read's oldest day and a truncated read's one day, and a whole window neither", () => {
    const rows = [catalogue({ releaseDate: "2026-09-20", trackId: "c1" })];

    expect(groupFreshReleases(windowOf([], rows), TODAY).coverageDate).toBeUndefined();
    expect(
      groupFreshReleases(windowOf([], rows, { kind: "partial", since: "2026-09-02" }), TODAY)
        .coverageDate,
    ).toBe("Sep 2, 2026");
    expect(
      groupFreshReleases(windowOf([], rows, { kind: "partial", since: "2026-09" }), TODAY)
        .coverageDate,
    ).toBe("Sep 1, 2026");
    expect(
      groupFreshReleases(windowOf([], rows, { day: "2026-09-20", kind: "truncated" }), TODAY)
        .coverageDate,
    ).toBe("Sep 20, 2026");
  });
});

describe("groupFreshReleases — the week rule: a track sits in the week it came out", () => {
  // An album whose single came out two weeks before the rest of it.
  const page = groupFreshReleases(
    windowOf(
      [],
      [
        catalogue({ albumSlug: "lp", isrc: "X2", releaseDate: "2026-09-24", trackId: "lp2" }),
        catalogue({ albumSlug: "lp", isrc: "X3", releaseDate: "2026-09-24", trackId: "lp3" }),
        catalogue({ albumSlug: "lp", isrc: "X1", releaseDate: "2026-09-10", trackId: "lp1" }),
      ],
    ),
    TODAY,
  );

  it("files each of an album's tracks under the week of its own release date", () => {
    expect(page.weeks.map((week) => week.index)).toEqual([0, 2]);
    expect(page.weeks[0]?.releases[0]?.tracks.map((track) => track.trackId)).toEqual([
      "lp2",
      "lp3",
    ]);
    expect(page.weeks[1]?.releases[0]?.tracks.map((track) => track.trackId)).toEqual(["lp1"]);
    // Still one release on the page.
    expect(page.releaseCount).toBe(1);
  });

  it("plays exactly the week's own tracks from that week", () => {
    const thisWeek = page.weeks[0];

    expect(releasesQueue(thisWeek?.releases ?? []).map((track) => track.trackId)).toEqual([
      "lp2",
      "lp3",
    ]);
  });

  it("dates and titles each week's share of the record by its own tracks", () => {
    expect(page.weeks[0]?.releases[0]?.releaseDate).toBe("2026-09-24");
    // The single alone in its week reads as the single, not the record.
    expect(page.weeks[1]?.releases[0]?.title).toBe("Title lp1");
  });

  it("gives the front door the whole record, every track in the window", () => {
    const whole = newestFreshReleases(
      windowOf(
        [],
        [
          catalogue({ albumSlug: "lp", isrc: "X2", releaseDate: "2026-09-24", trackId: "lp2" }),
          catalogue({ albumSlug: "lp", isrc: "X1", releaseDate: "2026-09-10", trackId: "lp1" }),
        ],
      ),
      8,
    );

    expect(whole[0]?.tracks.map((track) => track.trackId)).toEqual(["lp1", "lp2"]);
  });

  it("never lets one record stand out twice when it has tracks in this week and last", () => {
    const standouts = groupFreshReleases(
      windowOf(
        [],
        [
          catalogue({ albumSlug: "both", releaseDate: "2026-09-24", trackId: "b1" }),
          catalogue({ albumSlug: "both", releaseDate: "2026-09-24", trackId: "b2" }),
          catalogue({ albumSlug: "both", releaseDate: "2026-09-15", trackId: "b3" }),
          ...loneReleases("prior", "2026-09-15", 5),
        ],
      ),
      TODAY,
    ).standouts;

    expect(standouts?.keys.filter((key) => key === "album:both")).toHaveLength(1);
  });
});

describe("groupFreshReleases — the standouts", () => {
  function standouts(thisWeek: FreshCatalogueItem[], lastWeek: FreshCatalogueItem[] = []) {
    return groupFreshReleases(windowOf([], [...thisWeek, ...lastWeek]), TODAY).standouts;
  }

  it("ranks findings first and holds at most half of this week", () => {
    const page = groupFreshReleases(
      windowOf(
        [finding({ releaseDate: "2026-09-19", trackId: "lit" })],
        loneReleases("c", "2026-09-24", 5),
      ),
      TODAY,
    );

    // Six releases this week: a selection of three.
    expect(page.standouts?.span).toBe("this-week");
    expect(page.standouts?.keys).toHaveLength(3);
    expect(page.standouts?.keys[0]).toBe("track:lit");
  });

  it("never holds more than the limit, however big the week", () => {
    const picked = standouts(loneReleases("c", "2026-09-24", 12));

    expect(picked?.span).toBe("this-week");
    expect(picked?.keys).toHaveLength(FRESH_STANDOUT_LIMIT);
  });

  it("ranks a playable release ahead of a silent one", () => {
    const picked = standouts([
      ...loneReleases("quiet", "2026-09-24", 4),
      catalogue({ isrc: "GBTEST2600001", releaseDate: "2026-09-20", trackId: "plays" }),
    ]);

    expect(picked?.keys).toHaveLength(2);
    expect(picked?.keys[0]).toBe("track:plays");
  });

  it("ranks the bigger record ahead of a single", () => {
    const picked = standouts([
      ...loneReleases("single", "2026-09-24", 3),
      catalogue({ albumSlug: "ep", releaseDate: "2026-09-20", trackId: "ep1" }),
      catalogue({ albumSlug: "ep", releaseDate: "2026-09-20", trackId: "ep2" }),
    ]);

    expect(picked?.keys[0]).toBe("album:ep");
  });

  it("tops a thin week up from last week, up to half of both, and says it spans two weeks", () => {
    // Three this week make room for one; eight across both weeks make room for four.
    const picked = standouts(
      loneReleases("now", "2026-09-24", 3),
      loneReleases("prior", "2026-09-15", 5),
    );

    expect(picked?.span).toBe("two-weeks");
    expect(picked?.keys).toHaveLength(4);
    expect(picked?.keys[0]?.startsWith("track:now")).toBe(true);
    expect(picked?.keys.slice(1).every((key) => key.startsWith("track:prior"))).toBe(true);
  });

  it("draws from last week alone when this week has no room of its own", () => {
    expect(standouts([], loneReleases("prior", "2026-09-15", 5))).toEqual({
      keys: expect.any(Array),
      span: "last-week",
    });
    expect(standouts([], loneReleases("prior", "2026-09-15", 5))?.keys).toHaveLength(2);
  });

  it("leads a thin week's top-up with this week's own release", () => {
    // Half of one is none, but the week's only release still heads the strip.
    const onePlusFour = standouts(
      loneReleases("now", "2026-09-24", 1),
      loneReleases("prior", "2026-09-15", 4),
    );

    expect(onePlusFour?.span).toBe("two-weeks");
    expect(onePlusFour?.keys).toHaveLength(2);
    expect(onePlusFour?.keys[0]?.startsWith("track:now")).toBe(true);
  });

  it("does not top up a week that already makes a selection", () => {
    const picked = standouts(
      loneReleases("now", "2026-09-24", 4),
      loneReleases("prior", "2026-09-15", 6),
    );

    expect(picked?.span).toBe("this-week");
    expect(picked?.keys).toHaveLength(2);
  });

  it("prints no strip when half the pool is fewer than two releases", () => {
    expect(standouts(loneReleases("c", "2026-09-24", 2))).toBeUndefined();
    expect(standouts(loneReleases("c", "2026-09-24", 3))).toBeUndefined();
    expect(
      standouts(loneReleases("now", "2026-09-24", 1), loneReleases("prior", "2026-09-15", 2)),
    ).toBeUndefined();
    expect(standouts(loneReleases("c", "2026-09-24", 1))).toBeUndefined();
    expect(standouts([], loneReleases("prior", "2026-09-15", 1))).toBeUndefined();
  });

  it("never draws from a week older than last week", () => {
    expect(standouts(loneReleases("old", "2026-09-05", 6))).toBeUndefined();
  });
});

describe("freshViewWeeks and newestFreshReleases", () => {
  const rows = [
    catalogue({ albumSlug: "ep", albumTrackCount: 4, releaseDate: "2026-09-24", trackId: "ep1" }),
    catalogue({ albumSlug: "ep", albumTrackCount: 4, releaseDate: "2026-09-24", trackId: "ep2" }),
    catalogue({ releaseDate: "2026-09-23", trackId: "single-now" }),
    catalogue({ releaseDate: "2026-09-15", trackId: "single-prior" }),
  ];
  const page = groupFreshReleases(windowOf([], rows), TODAY);

  it("keeps every week and release for the all and tracks views", () => {
    expect(freshViewWeeks(page, "all")).toBe(page.weeks);
    expect(freshViewWeeks(page, "tracks")).toBe(page.weeks);
  });

  it("keeps only records for the albums view, dropping a week left empty", () => {
    const weeks = freshViewWeeks(page, "albums");

    expect(weeks.map((week) => week.index)).toEqual([0]);
    expect(weeks[0]?.releases.map((release) => release.key)).toEqual(["album:ep"]);
    // The page itself is untouched.
    expect(page.weeks.map((week) => week.index)).toEqual([0, 1]);
  });

  it("decides a record by its stored track count, not by how much of it is in the window", () => {
    const albums = freshViewWeeks(
      groupFreshReleases(
        windowOf(
          [],
          [
            // A ten-track album with one track in the window is still an album.
            catalogue({
              albumSlug: "lp",
              albumTrackCount: 10,
              releaseDate: "2026-09-24",
              trackId: "lp1",
            }),
            // A single the archive holds once is a single, whatever the window holds of it.
            catalogue({
              albumSlug: "single",
              albumTrackCount: 1,
              releaseDate: "2026-09-24",
              trackId: "s1",
            }),
          ],
        ),
        TODAY,
      ),
      "albums",
    );

    expect(albums.flatMap((week) => week.releases.map((release) => release.key))).toEqual([
      "album:lp",
    ]);
  });

  it("takes the newest whole releases in the window", () => {
    const data = windowOf([], rows);

    expect(newestFreshReleases(data, 2).map((release) => release.key)).toEqual([
      "album:ep",
      "track:single-now",
    ]);
    expect(newestFreshReleases(data, 10).map((release) => release.key)).toEqual([
      "album:ep",
      "track:single-now",
      "track:single-prior",
    ]);
  });
});

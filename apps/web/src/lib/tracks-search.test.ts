// The `/tracks` hub's pure, client-safe contract: the URL filter coercion, the active-filter bit,
// and the SEO head (canonical always bare, noindex the moment a filter appears). No router, no DB.

import { describe, expect, it } from "vitest";
import {
  KEY_FILTER_OPTIONS,
  type TracksSearch,
  buildTracksHref,
  parseTracksSearch,
  tracksHead,
  tracksMastheadLine,
  tracksSearchHasFilters,
} from "./tracks-search";

describe("tracksMastheadLine", () => {
  it("carries the held count as ONE composed string when the count is real", () => {
    // One string, one SSR text node — no comment-split fragments a text extractor can truncate.
    expect(tracksMastheadLine(31788)).toBe(
      "Every drum & bass track Fluncle holds, all 31,788 of them.",
    );
    expect(tracksMastheadLine(2)).toBe("Every drum & bass track Fluncle holds, all 2 of them.");
  });

  it("drops the count clause at 0 / 1 (never 'all 0 of them')", () => {
    expect(tracksMastheadLine(0)).toBe("Every drum & bass track Fluncle holds.");
    expect(tracksMastheadLine(1)).toBe("Every drum & bass track Fluncle holds.");
  });
});

describe("parseTracksSearch", () => {
  it("keeps the clean, mirrored filter vocabulary", () => {
    expect(
      parseTracksSearch({
        bpmMax: "180",
        bpmMin: "160",
        galaxy: "green-sector",
        key: "F minor",
        label: "Hospital Records",
        yearMax: "2026",
        yearMin: "2015",
      }),
    ).toEqual({
      bpmMax: 180,
      bpmMin: 160,
      galaxy: "green-sector",
      key: "F minor",
      label: "Hospital Records",
      yearMax: 2026,
      yearMin: 2015,
    });
  });

  it("folds junk numeric params to undefined (clean defaults)", () => {
    expect(
      parseTracksSearch({ bpmMax: "not-a-number", bpmMin: "-4", yearMax: "", yearMin: "0" }),
    ).toEqual({
      bpmMax: undefined,
      bpmMin: undefined,
      galaxy: undefined,
      key: undefined,
      label: undefined,
      yearMax: undefined,
      yearMin: undefined,
    });
  });

  it("trims strings and drops the empties", () => {
    expect(parseTracksSearch({ key: "  A minor  ", label: "   " })).toMatchObject({
      key: "A minor",
      label: undefined,
    });
  });

  it("ignores unknown params entirely", () => {
    expect(parseTracksSearch({ page: "2", q: "netsky" })).toEqual({
      bpmMax: undefined,
      bpmMin: undefined,
      galaxy: undefined,
      key: undefined,
      label: undefined,
      yearMax: undefined,
      yearMin: undefined,
    });
  });
});

describe("tracksSearchHasFilters", () => {
  it("is false for the bare hub", () => {
    expect(tracksSearchHasFilters(parseTracksSearch({}))).toBe(false);
  });

  it("is true the moment any axis is set", () => {
    expect(tracksSearchHasFilters(parseTracksSearch({ bpmMin: "170" }))).toBe(true);
    expect(tracksSearchHasFilters(parseTracksSearch({ label: "Hospital" }))).toBe(true);
  });
});

describe("KEY_FILTER_OPTIONS", () => {
  it("offers the 24 scale spellings (12 sharp pitch classes × major/minor)", () => {
    expect(KEY_FILTER_OPTIONS).toHaveLength(24);
    expect(KEY_FILTER_OPTIONS).toContain("F minor");
    expect(KEY_FILTER_OPTIONS).toContain("C major");
    // Sharp spellings only — the parser folds "Db major" to "C# major", so the control offers "C#".
    expect(KEY_FILTER_OPTIONS).toContain("C# major");
    expect(KEY_FILTER_OPTIONS).not.toContain("Db major");
  });
});

describe("buildTracksHref", () => {
  it("a bare, unfiltered page 1 is the plain /tracks (no query)", () => {
    expect(buildTracksHref({}, 1)).toBe("/tracks");
  });

  it("drops the page param on page 1 but sets it beyond", () => {
    expect(buildTracksHref({}, 1)).toBe("/tracks");
    expect(buildTracksHref({}, 4)).toBe("/tracks?page=4");
  });

  it("serializes EVERY filter axis — bpm included, since it stays in the search vocabulary", () => {
    // The BPM control is gone from the UI, but a `?bpmMin=` filter arriving by URL must survive
    // paging, so the pager href still carries it. Every axis the parser reads, the builder writes.
    const filters: TracksSearch = {
      bpmMax: 180,
      bpmMin: 160,
      galaxy: "green-sector",
      key: "F minor",
      label: "Hospital Records",
      yearMax: 2026,
      yearMin: 2015,
    };
    const href = buildTracksHref(filters, 2);

    expect(href).toContain("yearMin=2015");
    expect(href).toContain("yearMax=2026");
    expect(href).toContain("bpmMin=160");
    expect(href).toContain("bpmMax=180");
    expect(href).toContain("key=F+minor");
    expect(href).toContain("label=Hospital+Records");
    expect(href).toContain("galaxy=green-sector");
    expect(href).toContain("page=2");
  });

  it("round-trips every axis: parse(build(filters)) === filters", () => {
    // The load-bearing invariant — the builder and `parseTracksSearch` stay in lockstep, so a pager
    // link never silently drops a filter. Rebuild the search record from the href and re-parse it.
    const filters: TracksSearch = {
      bpmMax: 180,
      bpmMin: 160,
      galaxy: "green-sector",
      key: "F minor",
      label: "Hospital Records",
      yearMax: 2026,
      yearMin: 2015,
    };
    const query = buildTracksHref(filters, 1).split("?")[1] ?? "";
    const record = Object.fromEntries(new URLSearchParams(query));

    expect(parseTracksSearch(record)).toEqual(filters);
  });

  it("omits the axes that are unset (a single-axis filter carries only itself)", () => {
    expect(buildTracksHref({ label: "Metalheadz" }, 1)).toBe("/tracks?label=Metalheadz");
    expect(buildTracksHref({ yearMin: 1995 }, 1)).toBe("/tracks?yearMin=1995");
  });
});

/** Pull the robots meta content out of a head result, if present. */
function robots(head: ReturnType<typeof tracksHead>): string | undefined {
  return head.meta.find((entry) => "name" in entry && entry.name === "robots")?.content;
}

/** Pull the <title> out of a head result. */
function title(head: ReturnType<typeof tracksHead>): string | undefined {
  return head.meta.find((entry) => "title" in entry)?.title;
}

describe("tracksHead", () => {
  it("page 1 is indexable, self-canonical to the bare hub, and carries the findings ItemList", () => {
    const head = tracksHead(
      {},
      {
        entries: [
          {
            artistLinks: [{ name: "Netsky" }],
            finding: {
              artists: ["Netsky"],
              logId: "241.7.3A",
              title: "Idols",
            } as never,
            kind: "finding",
            releaseDate: "2021-05-01",
          },
          {
            artistLinks: [],
            kind: "catalogue",
            releaseDate: "2020-01-01",
            track: { title: "Unlit" } as never,
          },
        ],
        page: 1,
        total: 4214,
      },
    );

    // Page 1 canonical is the bare hub.
    expect(head.links).toEqual([{ href: "https://www.fluncle.com/tracks", rel: "canonical" }]);
    // No robots meta => indexable.
    expect(robots(head)).toBeUndefined();
    // The ItemList carries the LIT finding (a catalogue row is never given a fluncle URL), and
    // `numberOfItems` is the whole held count, not the page size.
    const ld = (head.scripts[0] as { children: string }).children;
    expect(ld).toContain("https://www.fluncle.com/log/241.7.3A");
    expect(ld).not.toContain("Unlit");
    expect(ld).toContain('"numberOfItems":4214');
  });

  it("a clean ?page=N is its own canonical, with the page number baked into the title", () => {
    const head = tracksHead({}, { entries: [], page: 3, total: 4214 });

    expect(head.links).toEqual([
      { href: "https://www.fluncle.com/tracks?page=3", rel: "canonical" },
    ]);
    expect(robots(head)).toBeUndefined();
    expect(title(head)).toBe("Every drum & bass track, page 3 · Fluncle");
  });

  it("ANY filter flips the page to noindex, keeps the bare canonical, and drops the JSON-LD", () => {
    const head = tracksHead({ bpmMin: 170 }, { entries: [], page: 2, total: 12 });

    expect(robots(head)).toBe("noindex, follow");
    // A filtered view collapses onto the bare hub, even when paged.
    expect(head.links).toEqual([{ href: "https://www.fluncle.com/tracks", rel: "canonical" }]);
    expect(title(head)).toBe("Every drum & bass track, newest first · Fluncle");
    expect(head.scripts).toEqual([]);
  });
});

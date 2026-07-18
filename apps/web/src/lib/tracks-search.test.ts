// The `/tracks` hub's pure, client-safe contract: the URL filter coercion, the active-filter bit,
// and the SEO head (canonical always bare, noindex the moment a filter appears). No router, no DB.

import { describe, expect, it } from "vitest";
import {
  KEY_FILTER_OPTIONS,
  parseTracksSearch,
  tracksHead,
  tracksSearchHasFilters,
} from "./tracks-search";

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

/** Pull the robots meta content out of a head result, if present. */
function robots(head: ReturnType<typeof tracksHead>): string | undefined {
  return head.meta.find((entry) => "name" in entry && entry.name === "robots")?.content;
}

describe("tracksHead", () => {
  it("the bare hub is indexable, self-canonical, and carries the findings ItemList", () => {
    const head = tracksHead(
      {},
      {
        entries: [
          {
            finding: {
              artists: ["Netsky"],
              logId: "241.7.3A",
              title: "Idols",
            } as never,
            kind: "finding",
            releaseDate: "2021-05-01",
          },
          { kind: "catalogue", releaseDate: "2020-01-01", track: { title: "Unlit" } as never },
        ],
      },
    );

    // Canonical is always the bare hub.
    expect(head.links).toEqual([{ href: "https://www.fluncle.com/tracks", rel: "canonical" }]);
    // No robots meta => indexable.
    expect(robots(head)).toBeUndefined();
    // The ItemList carries the LIT finding (a catalogue row is never given a fluncle URL).
    const scriptJson = JSON.stringify(head.scripts);
    expect(scriptJson).toContain("https://www.fluncle.com/log/241.7.3A");
    expect(scriptJson).not.toContain("Unlit");
  });

  it("ANY filter flips the page to noindex, keeps the bare canonical, and drops the JSON-LD", () => {
    const head = tracksHead({ bpmMin: 170 }, { entries: [] });

    expect(robots(head)).toBe("noindex, follow");
    expect(head.links).toEqual([{ href: "https://www.fluncle.com/tracks", rel: "canonical" }]);
    expect(head.scripts).toEqual([]);
  });
});

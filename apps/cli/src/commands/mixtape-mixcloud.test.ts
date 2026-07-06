import { describe, expect, test } from "bun:test";
import { mixcloudEditUrl, mixcloudSectionFields, mixcloudSections } from "@fluncle/contracts/util";
import { mixtapeDescription } from "./mixtape-mixcloud";
import { type MixtapeMemberItem } from "./mixtapes";

const member = (overrides: Partial<MixtapeMemberItem>): MixtapeMemberItem =>
  ({
    addedAt: "2026-06-06T00:00:00.000Z",
    addedToSpotify: true,
    artists: ["Artist"],
    durationMs: 300000,
    enrichmentStatus: "done",
    postedToTelegram: false,
    spotifyUrl: "https://open.spotify.com/track/x",
    title: "Song",
    trackId: "t",
    ...overrides,
  }) as MixtapeMemberItem;

describe("mixtapeDescription", () => {
  test("appends the fluncle:// breadcrumb after a blank line", () => {
    expect(mixtapeDescription("Late-night dream.", "F.3")).toBe(
      "Late-night dream.\n\nfluncle://F.3",
    );
  });

  test("trims a stray-whitespace note", () => {
    expect(mixtapeDescription("  spaced  ", "F.3")).toBe("spaced\n\nfluncle://F.3");
  });

  test("returns just the breadcrumb when there is no note", () => {
    expect(mixtapeDescription(undefined, "F.3")).toBe("fluncle://F.3");
    expect(mixtapeDescription("   ", "F.3")).toBe("fluncle://F.3");
  });

  test("clamps to 1000 chars, trimming the note and never the breadcrumb", () => {
    const note = "x".repeat(2000);
    const result = mixtapeDescription(note, "F.3");

    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result.endsWith("fluncle://F.3")).toBe(true);
  });
});

describe("mixcloudSections", () => {
  test("filters un-cued members, sorts by offset, converts ms→integer seconds", () => {
    const sections = mixcloudSections([
      member({ artists: ["B"], startMs: 90_000, title: "Second" }),
      member({ artists: ["A"], startMs: 1_500, title: "First" }),
      member({ artists: ["C"], title: "No cue" }),
    ]);

    expect(sections).toEqual([
      { artist: "A", song: "First", start_time: 1 },
      { artist: "B", song: "Second", start_time: 90 },
    ]);
  });

  test("joins multiple artists with a comma", () => {
    const sections = mixcloudSections([
      member({ artists: ["A", "B"], startMs: 0, title: "Collab" }),
    ]);

    expect(sections[0]?.artist).toBe("A, B");
  });
});

describe("mixcloudSectionFields", () => {
  test("builds the indexed sections-N-* multipart field pairs", () => {
    const fields = mixcloudSectionFields([
      { artist: "A", song: "First", start_time: 0 },
      { artist: "B, C", song: "Second", start_time: 90 },
    ]);

    expect(fields).toEqual([
      ["sections-0-artist", "A"],
      ["sections-0-song", "First"],
      ["sections-0-start_time", "0"],
      ["sections-1-artist", "B, C"],
      ["sections-1-song", "Second"],
      ["sections-1-start_time", "90"],
    ]);
  });

  test("is empty for no sections (nothing to overwrite)", () => {
    expect(mixcloudSectionFields([])).toEqual([]);
  });
});

describe("mixcloudEditUrl", () => {
  test("splices edit/ after the cloudcast key under /upload", () => {
    expect(mixcloudEditUrl("/fluncle/a-set/")).toBe(
      "https://api.mixcloud.com/upload/fluncle/a-set/edit/",
    );
  });

  test("normalizes a key missing its leading/trailing slash", () => {
    expect(mixcloudEditUrl("fluncle/a-set")).toBe(
      "https://api.mixcloud.com/upload/fluncle/a-set/edit/",
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listFeedEntries } from "./feed";

// The feed carries the three kinds on one chronological list. What these pin is the
// QUIET: a letter is an item among the findings, in date order, tagged as what it is —
// never a section, never the lead by virtue of being a letter, and never able to be
// mistaken for a track by a reader or a crawler.

const execute = vi.hoisted(() => vi.fn());
const listEditions = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  getDb: async () => ({ execute }),
  typedRows: <T extends object>(rows: T[]) => rows,
}));

vi.mock("./editions", () => ({ listEditions }));

const FINDING_ROW = {
  added_at: "2026-06-25T10:00:00.000Z",
  artists_json: '["Netsky"]',
  item_type: "finding" as const,
  note: "Rolled straight through me.",
  spotify_url: "https://open.spotify.com/track/abc",
  title: "Iron Heart",
  track_id: "abc",
};

const OLDER_FINDING_ROW = {
  ...FINDING_ROW,
  added_at: "2026-06-20T10:00:00.000Z",
  title: "Escape",
  track_id: "def",
};

const LETTER = {
  content: { galaxies: [{ findings: [{ logId: "004.7.2I" }], galaxy: "Liftoff" }], intro: "Ahoy." },
  id: "edition-id",
  logId: "027.L.1A",
  number: 1,
  sentAt: "2026-06-26T13:00:00.000Z",
  status: "sent" as const,
  subject: "the week in one breath",
};

beforeEach(() => {
  execute.mockReset().mockResolvedValue({ rows: [FINDING_ROW, OLDER_FINDING_ROW] });
  listEditions.mockReset().mockResolvedValue([LETTER]);
});

describe("listFeedEntries", () => {
  it("merges the letter into the findings in date order, tagged as a letter", async () => {
    const entries = await listFeedEntries(25);

    expect(entries.map((entry) => entry.kind)).toEqual(["edition", "finding", "finding"]);
    expect(entries[0]).toMatchObject({
      guid: "027.L.1A",
      kind: "edition",
      link: "https://www.fluncle.com/log/027.L.1A",
      title: "Letter No. 1: the week in one breath",
    });
    // The letter points at its coordinate page; a finding still points at Spotify.
    expect(entries[1]?.link).toBe("https://open.spotify.com/track/abc");
  });

  it("keeps it quiet: the letter is one row, not a section", async () => {
    const entries = await listFeedEntries(25);

    expect(entries.filter((entry) => entry.kind === "edition")).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === "finding")).toHaveLength(2);
  });

  it("is chronological, so an older letter sits below newer findings", async () => {
    listEditions.mockResolvedValue([{ ...LETTER, sentAt: "2026-06-22T13:00:00.000Z" }]);

    const entries = await listFeedEntries(25);

    expect(entries.map((entry) => entry.kind)).toEqual(["finding", "edition", "finding"]);
  });

  it("leaves out a letter that never went out (a draft has no coordinate)", async () => {
    listEditions.mockResolvedValue([
      { ...LETTER, logId: undefined, number: undefined, sentAt: undefined, status: "draft" },
    ]);

    const entries = await listFeedEntries(25);

    expect(entries.every((entry) => entry.kind === "finding")).toBe(true);
  });

  it("honours the limit across the merged list", async () => {
    const entries = await listFeedEntries(2);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.kind)).toEqual(["edition", "finding"]);
  });
});

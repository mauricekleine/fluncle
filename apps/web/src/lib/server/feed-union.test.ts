import { describe, expect, it } from "vitest";
import { type FeedItem, type MixtapeDTO } from "../mixtapes";
import { type TrackCursor, type TrackListItem, feedFindingsCount, mergeFeedPage } from "./tracks";

let findingSeq = 0;

function makeFinding(addedAt: string, trackId?: string): TrackListItem {
  findingSeq += 1;
  const id = trackId ?? `finding-${findingSeq}`;
  return {
    addedAt,
    addedToSpotify: true,
    artists: ["Test Artist"],
    durationMs: 240_000,
    enrichmentStatus: "done",
    postedToTelegram: true,
    spotifyUrl: `https://open.spotify.com/track/${id}`,
    title: `Finding ${id}`,
    trackId: id,
    type: "finding",
  };
}

function makeMixtape(addedAt: string, logId: string): MixtapeDTO {
  return {
    addedAt,
    artists: ["Fluncle"],
    externalUrls: {},
    logId,
    memberCount: 12,
    members: [],
    status: "published",
    title: `Checkpoint ${logId}`,
    type: "mixtape",
  };
}

function feedItemId(item: FeedItem): string {
  return item.type === "mixtape" ? (item.logId as string) : item.trackId;
}

function pageThrough(
  findings: FeedItem[],
  mixtapes: FeedItem[],
  dir: "asc" | "desc",
  limit: number,
): FeedItem[] {
  const all: FeedItem[] = [];
  let cursor: TrackCursor | undefined;
  for (let i = 0; i < 50; i++) {
    const page = mergeFeedPage(findings, mixtapes, dir, limit, cursor);
    all.push(...page.items);
    if (!page.hasMore || !page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }
  return all;
}

function expectExactOrder(items: FeedItem[], expectedIds: string[]): void {
  expect(items.map(feedItemId)).toEqual(expectedIds);
  expect(new Set(items.map(feedItemId)).size).toBe(expectedIds.length);
}

describe("mergeFeedPage — no skip/dup across mixtape boundaries", () => {
  const f1 = makeFinding("2026-06-07T00:00:00.000Z", "f1");
  const f2 = makeFinding("2026-06-06T00:00:00.000Z", "f2");
  const f3 = makeFinding("2026-06-05T00:00:00.000Z", "f3");
  const m1 = makeMixtape("2026-06-04T12:00:00.000Z", "019.F.1A");
  const f4 = makeFinding("2026-06-04T00:00:00.000Z", "f4");
  const f5 = makeFinding("2026-06-03T00:00:00.000Z", "f5");
  const f6 = makeFinding("2026-06-02T00:00:00.000Z", "f6");
  const f7 = makeFinding("2026-06-01T00:00:00.000Z", "f7");
  const findings = [f1, f2, f3, f4, f5, f6, f7];
  const mixtapes = [m1];
  const expectedDesc = ["f1", "f2", "f3", "019.F.1A", "f4", "f5", "f6", "f7"];

  it("pages through every item exactly once (mixtape at page edge, limit=3)", () => {
    const items = pageThrough(findings, mixtapes, "desc", 3);
    expectExactOrder(items, expectedDesc);
  });

  it("pages through every item exactly once (mixtape mid-page, limit=4)", () => {
    const items = pageThrough(findings, mixtapes, "desc", 4);
    expectExactOrder(items, expectedDesc);
  });

  it("asc direction also pages without skip/dup", () => {
    const expectedAsc = [...expectedDesc].reverse();
    const items = pageThrough(findings, mixtapes, "asc", 3);
    expectExactOrder(items, expectedAsc);
  });
});

describe("mergeFeedPage — limit+1 per-table over-fetch", () => {
  it("findings-only page does not lose items when mixtapes are empty", () => {
    const findings = [
      makeFinding("2026-06-05T00:00:00.000Z", "f1"),
      makeFinding("2026-06-04T00:00:00.000Z", "f2"),
      makeFinding("2026-06-03T00:00:00.000Z", "f3"),
      makeFinding("2026-06-02T00:00:00.000Z", "f4"),
      makeFinding("2026-06-01T00:00:00.000Z", "f5"),
    ];
    const items = pageThrough(findings, [], "desc", 3);
    expectExactOrder(items, ["f1", "f2", "f3", "f4", "f5"]);
  });

  it("mixtapes-only page does not lose items when findings are empty", () => {
    const mixtapes = [
      makeMixtape("2026-06-05T00:00:00.000Z", "019.F.1A"),
      makeMixtape("2026-06-04T00:00:00.000Z", "019.F.1B"),
      makeMixtape("2026-06-03T00:00:00.000Z", "019.F.1C"),
      makeMixtape("2026-06-02T00:00:00.000Z", "019.F.1D"),
      makeMixtape("2026-06-01T00:00:00.000Z", "019.F.1E"),
    ];
    const items = pageThrough([], mixtapes, "desc", 3);
    expectExactOrder(items, ["019.F.1A", "019.F.1B", "019.F.1C", "019.F.1D", "019.F.1E"]);
  });
});

describe("mergeFeedPage — addedAt tie between a finding and a mixtape", () => {
  const f1 = makeFinding("2026-06-05T00:00:00.000Z", "f1");
  const fTie = makeFinding("2026-06-04T00:00:00.000Z", "zzz-finding");
  const mTie = makeMixtape("2026-06-04T00:00:00.000Z", "aaa-mixtape");
  const f2 = makeFinding("2026-06-03T00:00:00.000Z", "f2");

  it("resolves the tie deterministically (binary tiebreak, desc)", () => {
    const page = mergeFeedPage([f1, fTie, f2], [mTie], "desc", 10);
    expectExactOrder(page.items, ["f1", "zzz-finding", "aaa-mixtape", "f2"]);
  });

  it("resolves the tie deterministically (binary tiebreak, asc)", () => {
    const page = mergeFeedPage([f1, fTie, f2], [mTie], "asc", 10);
    expectExactOrder(page.items, ["f2", "aaa-mixtape", "zzz-finding", "f1"]);
  });

  it("survives paging when the tie straddles a page boundary", () => {
    const items = pageThrough([f1, fTie, f2], [mTie], "desc", 2);
    expectExactOrder(items, ["f1", "zzz-finding", "aaa-mixtape", "f2"]);
  });
});

describe("feedFindingsCount — Found · N stays findings-only", () => {
  it("returns the SQL count when available", () => {
    expect(feedFindingsCount(42, 10)).toBe(42);
  });

  it("falls back to the findings row count when SQL count is undefined", () => {
    expect(feedFindingsCount(undefined, 10)).toBe(10);
  });

  it("a zero SQL count is NOT the fallback (0 is a real findings count)", () => {
    expect(feedFindingsCount(0, 10)).toBe(0);
  });

  it("does not include mixtapes: totalCount < total feed items when mixtapes present", () => {
    const findings = [
      makeFinding("2026-06-03T00:00:00.000Z", "f1"),
      makeFinding("2026-06-02T00:00:00.000Z", "f2"),
      makeFinding("2026-06-01T00:00:00.000Z", "f3"),
    ];
    const mixtapes = [makeMixtape("2026-06-02T12:00:00.000Z", "019.F.1A")];
    const page = mergeFeedPage(findings, mixtapes, "desc", 10);
    const totalCount = feedFindingsCount(findings.length, findings.length);

    expect(page.items).toHaveLength(4);

    expect(totalCount).toBe(3);
    expect(totalCount).toBeLessThan(page.items.length);
  });
});

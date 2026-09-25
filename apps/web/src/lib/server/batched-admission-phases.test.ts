import { describe, expect, it, vi } from "vitest";

import {
  CRAWL_COMMIT_BATCH_NODE_MARKER_MINT_BOUND,
  commitCrawlNodes,
  type CrawlCommitBatchItem,
} from "./crawl";
import { CRAWL_CLAIM_REPAIR_DRAIN_BUDGET } from "./crawl-cutover";
import {
  commitCaptureReconciliations,
  prepareCaptureReconciliations,
} from "./track-capture-reconciliation";

function crawlItem(index: number): CrawlCommitBatchItem {
  return {
    commitToken: `token-${index}`,
    operationId: "catalogue.crawl",
    operationKey: `catalogue.crawl:${index}`,
    requestDigest: "0".repeat(64),
  };
}

describe("the batched crawl commit", () => {
  it("answers per item, so a poisoned middle node never costs its neighbours their commit", async () => {
    const items = [crawlItem(0), crawlItem(1), crawlItem(2)];
    const commit = vi.fn(async (item: CrawlCommitBatchItem) => {
      if (item.operationKey === "catalogue.crawl:1") {
        throw new Error("stale crawl claim exploded");
      }
      return {
        outcome: "committed" as const,
        replayed: false,
        result: { expanded: 1 },
        resultIdentity: item.operationKey,
        resultJson: '{"expanded":1}',
        state: "committed" as const,
      };
    });

    const { deferred, receipts } = await commitCrawlNodes(items, { commit });

    expect(deferred).toBe(0);
    expect(receipts.map((receipt) => receipt.outcome)).toEqual([
      "committed",
      "failed",
      "committed",
    ]);

    expect(receipts.map((receipt) => receipt.operationKey)).toEqual([
      "catalogue.crawl:0",
      "catalogue.crawl:1",
      "catalogue.crawl:2",
    ]);
    expect(receipts[1]?.error).toContain("stale crawl claim exploded");
    expect(commit).toHaveBeenCalledTimes(3);
  });

  it("returns the unprocessed tail as safely-retryable instead of running past its wall budget", async () => {
    const items = [crawlItem(0), crawlItem(1), crawlItem(2)];
    let clock = 0;
    const commit = vi.fn(async () => {
      clock += 40_000;
      return {
        outcome: "committed" as const,
        replayed: false,
        result: {},
        resultIdentity: "node",
        resultJson: "{}",
        state: "committed" as const,
      };
    });

    const { deferred, receipts } = await commitCrawlNodes(items, {
      commit,
      now: () => clock,
      wallBudgetMs: 30_000,
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(deferred).toBe(2);
    expect(receipts.map((receipt) => receipt.outcome)).toEqual([
      "committed",
      "safely-retryable",
      "safely-retryable",
    ]);
  });

  it("refuses a batch whose signed envelopes exceed the wire budget rather than sending it", async () => {
    const fat = { ...crawlItem(0), commitToken: "x".repeat(5 * 1024 * 1024) };

    await expect(
      commitCrawlNodes([fat, { ...fat, operationKey: "catalogue.crawl:1" }], {
        commit: async () => {
          throw new Error("must not be reached");
        },
      }),
    ).rejects.toThrow(/at most/);
  });

  it("keeps a batched commit's marker mint under the next claim's node drain capacity", () => {
    const drainCapacity =
      CRAWL_CLAIM_REPAIR_DRAIN_BUDGET.nodeChunks * CRAWL_CLAIM_REPAIR_DRAIN_BUDGET.nodeChunkRows;

    expect(CRAWL_COMMIT_BATCH_NODE_MARKER_MINT_BOUND).toBeLessThan(drainCapacity);

    expect(CRAWL_COMMIT_BATCH_NODE_MARKER_MINT_BOUND * 2).toBeLessThan(drainCapacity);
  });
});

describe("the batched capture commit", () => {
  const item = (trackId: string) => ({
    commitToken: `commit-${trackId}`,
    operationId: "track.capture",
    operationKey: `track.capture:${trackId}`,
    requestDigest: "0".repeat(64),
    trackId,
  });

  it("answers per item, so a poisoned middle row never costs its neighbours their commit", async () => {
    const commit = vi.fn(async (input: { trackId: string }) => {
      if (input.trackId === "track-b") {
        throw new Error("commit token expired");
      }
      return {
        outcome: "committed" as const,
        replayed: false,
        result: { applied: true, kind: "capture", outcome: "done" },
      };
    });

    const { deferred, receipts } = await commitCaptureReconciliations(
      [item("track-a"), item("track-b"), item("track-c")],
      { commit: commit as never },
    );

    expect(deferred).toBe(0);
    expect(receipts.map((receipt) => [receipt.trackId, receipt.outcome])).toEqual([
      ["track-a", "committed"],
      ["track-b", "failed"],
      ["track-c", "committed"],
    ]);
  });

  it("returns the unprocessed tail as safely-retryable instead of running past its wall budget", async () => {
    let clock = 0;
    const commit = vi.fn(async () => {
      clock += 40_000;
      return { outcome: "committed" as const, replayed: false, result: undefined };
    });

    const { deferred, receipts } = await commitCaptureReconciliations(
      [item("track-a"), item("track-b")],
      { commit: commit as never, now: () => clock, wallBudgetMs: 30_000 },
    );

    expect(commit).toHaveBeenCalledTimes(1);
    expect(deferred).toBe(1);
    expect(receipts[1]).toMatchObject({ outcome: "safely-retryable", trackId: "track-b" });
  });
});

describe("the batched capture prepare's budget accounting", () => {
  const catalogueRow = (trackId: string) => ({ kind: "capture" as const, trackId });

  function recordingPrepare(certified: (trackId: string) => boolean) {
    const asked: { open: boolean | undefined; trackId: string }[] = [];
    const prepare = (async (
      trackId: string,
      _kind: unknown,
      _prior: unknown,
      options?: { catalogueCaptureOpen?: boolean },
    ) => {
      asked.push({ open: options?.catalogueCaptureOpen, trackId });

      if (options?.catalogueCaptureOpen === false && !certified(trackId)) {
        return { prepared: false as const, reason: "ineligible" as const };
      }
      return {
        prepared: true as const,
        snapshotToken: `snapshot-${trackId}`,
        track: {
          artists: [],
          certified: certified(trackId),
          title: trackId,
          trackId,
          ...(certified(trackId) ? { logId: `LOG-${trackId}` } : {}),
        },
      };
    }) as never;

    return { asked, prepare };
  }

  it("cannot authorize more uncertified downloads than the rolling count cap has left", async () => {
    const { asked, prepare } = recordingPrepare(() => false);

    const { results } = await prepareCaptureReconciliations(
      ["a", "b", "c", "d", "e", "f"].map(catalogueRow),
      {
        captureState: async () => ({ open: true, remainingTracks: 2 }),
        prepare,
      },
    );

    expect(asked.map((ask) => ask.open)).toEqual([true, true, false, false, false, false]);
    expect(results.filter((row) => row.prepared).length).toBe(2);
    expect(results.slice(2).every((row) => !row.prepared)).toBe(true);
  });

  it("never gates a certified finding, and never lets one consume the catalogue's budget", async () => {
    const certified = new Set(["a", "c"]);
    const { asked, prepare } = recordingPrepare((trackId) => certified.has(trackId));

    const { results } = await prepareCaptureReconciliations(
      ["a", "b", "c", "d"].map(catalogueRow),
      { captureState: async () => ({ open: true, remainingTracks: 1 }), prepare },
    );

    expect(asked.map((ask) => ask.open)).toEqual([true, true, false, false]);
    expect(results.map((row) => row.prepared)).toEqual([true, true, true, false]);
  });

  it("subtracts what the tick already authorized, so a second call cannot re-spend the cap", async () => {
    const { asked, prepare } = recordingPrepare(() => false);

    const first = await prepareCaptureReconciliations(["a", "b"].map(catalogueRow), {
      captureState: async () => ({ open: true, remainingTracks: 3 }),
      prepare,
    });
    expect(first.reserved).toBe(2);

    const second = await prepareCaptureReconciliations(["c", "d", "e"].map(catalogueRow), {
      captureState: async () => ({ open: true, remainingTracks: 3 }),
      prepare,
      reservedThisTick: first.reserved,
    });

    expect(second.reserved).toBe(1);
    expect(asked.map((ask) => ask.open)).toEqual([true, true, true, false, false]);
  });

  it("can only ever shrink the budget, never grow it", async () => {
    const { prepare } = recordingPrepare(() => false);

    const overReported = await prepareCaptureReconciliations(["a", "b"].map(catalogueRow), {
      captureState: async () => ({ open: true, remainingTracks: 2 }),
      prepare,

      reservedThisTick: 99,
    });
    expect(overReported.reserved).toBe(0);

    const negative = await prepareCaptureReconciliations(["a", "b"].map(catalogueRow), {
      captureState: async () => ({ open: true, remainingTracks: 2 }),
      prepare,

      reservedThisTick: -50,
    });
    expect(negative.reserved).toBe(2);
  });

  it("never lets a carried reservation gate a certified finding", async () => {
    const { prepare } = recordingPrepare(() => true);

    const page = await prepareCaptureReconciliations(["a", "b"].map(catalogueRow), {
      captureState: async () => ({ open: true, remainingTracks: 0 }),
      prepare,
      reservedThisTick: 50,
    });

    expect(page.results.map((row) => row.prepared)).toEqual([true, true]);
    expect(page.reserved).toBe(0);
  });

  it("reports each item's own server milliseconds, so the batch width becomes derivable", async () => {
    let clock = 0;
    const prepare = (async (trackId: string) => {
      clock += 7;
      return {
        prepared: true as const,
        snapshotToken: `snapshot-${trackId}`,
        track: { artists: [], certified: false, title: trackId, trackId },
      };
    }) as never;

    const { results } = await prepareCaptureReconciliations(["a", "b"].map(catalogueRow), {
      captureState: async () => ({ open: true, remainingTracks: 10 }),
      now: () => clock,
      prepare,
    });

    expect(results.map((row) => row.elapsedMs)).toEqual([7, 7]);
  });

  it("reads the ledger once for the whole batch, never once per row", async () => {
    const captureState = vi.fn(async () => ({ open: true, remainingTracks: 10 }));
    const { prepare } = recordingPrepare(() => false);

    await prepareCaptureReconciliations(["a", "b", "c"].map(catalogueRow), {
      captureState,
      prepare,
    });

    expect(captureState).toHaveBeenCalledTimes(1);
  });

  it("returns the unprepared tail as `deferred`, which charges nothing and freezes nothing", async () => {
    let clock = 0;
    const prepare = (async (trackId: string) => {
      clock += 40_000;
      return {
        prepared: true as const,
        snapshotToken: `snapshot-${trackId}`,
        track: { artists: [], certified: false, title: trackId, trackId },
      };
    }) as never;

    const { deferred, results } = await prepareCaptureReconciliations(
      ["a", "b", "c"].map(catalogueRow),
      {
        captureState: async () => ({ open: true, remainingTracks: 10 }),
        now: () => clock,
        prepare,
        wallBudgetMs: 30_000,
      },
    );

    expect(deferred).toBe(2);
    expect(results.slice(1)).toEqual([
      { elapsedMs: 0, prepared: false, reason: "deferred", trackId: "b" },
      { elapsedMs: 0, prepared: false, reason: "deferred", trackId: "c" },
    ]);
  });
});

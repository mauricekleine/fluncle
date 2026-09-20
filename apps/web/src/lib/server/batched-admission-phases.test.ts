// THE BATCHED ADMITTED PHASES' CONTRACT — crawl, capture and embed, proved at the table.
//
// Every DB-touching phase a box sweep runs takes a lease on the single `write` lane
// (docs/database-performance.md), so a per-row phase paid that toll once per row. These ops moved
// the batch inside one phase WITHOUT collapsing the rows, and the four properties that makes
// load-bearing are exactly what this file pins:
//
//   1. PER-ITEM RECEIPTS — a poisoned item answers for itself and its neighbours still commit.
//   2. THE WALL BUDGET — a batch stops itself inside the admission watchdog window and hands the
//      unprocessed tail back as a retryable per-item verdict.
//   3. THE CAPTURE BUDGET, CUMULATIVELY — a batched prepare can never authorize more downloads than
//      the rolling count cap has left, which the per-row prepare could.
//   4. THE ADMISSION MARKER INVARIANT — a batched commit still mints fewer repair markers than the
//      next claim can drain, checked at module load where both constants are literal.

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
    // The receipt is keyed by the item's OWN operation key, never a batch-wide one: that identity
    // is what keeps `catalogue.crawl` non-replayable and lets a caller reconcile exactly one node.
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

    // The first item always runs, so the batch overshoots by at most one item and never stalls.
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
    // Invariant (d), restated as a value rather than only as a module-load throw: one admitted
    // phase now mints K nodes' worth of NODE repair markers, and the claim that follows has to be
    // able to clear all of them or the crawl stops claiming rows entirely.
    const drainCapacity =
      CRAWL_CLAIM_REPAIR_DRAIN_BUDGET.nodeChunks * CRAWL_CLAIM_REPAIR_DRAIN_BUDGET.nodeChunkRows;

    expect(CRAWL_COMMIT_BATCH_NODE_MARKER_MINT_BOUND).toBeLessThan(drainCapacity);
    // With margin, not by one: the bound is what a future widening of the claim or the browse page
    // is measured against.
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

  /** A prepare that answers `prepared` exactly when the batch says the budget is open for it. */
  function recordingPrepare(certified: (trackId: string) => boolean) {
    const asked: { open: boolean | undefined; trackId: string }[] = [];
    const prepare = (async (
      trackId: string,
      _kind: unknown,
      _prior: unknown,
      options?: { catalogueCaptureOpen?: boolean },
    ) => {
      asked.push({ open: options?.catalogueCaptureOpen, trackId });
      // The real prepare consults the budget verdict ONLY for an uncertified row: `budgeted` is
      // derived from the snapshot it just read, so a certified finding is never gated whatever the
      // batch hands down. The fake mirrors that, because it is the guarantee under test.
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
    // The per-row prepare asked "is the budget open" once per row and each row saw the same
    // untouched ledger, so a batch of six could be authorized against a budget with two left. The
    // batch consumes the cap in request order instead.
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
    // capture-budget.ts § "the findings are never gated": the archive must not be starved by the
    // speculative half, whatever the catalogue's ledger says.
    const certified = new Set(["a", "c"]);
    const { asked, prepare } = recordingPrepare((trackId) => certified.has(trackId));

    const { results } = await prepareCaptureReconciliations(
      ["a", "b", "c", "d"].map(catalogueRow),
      { captureState: async () => ({ open: true, remainingTracks: 1 }), prepare },
    );

    // Two certified rows prepare, and neither spends the reservation the uncertified rows draw on,
    // so exactly one uncertified row (the first) is authorized while the other is refused.
    expect(asked.map((ask) => ask.open)).toEqual([true, true, false, false]);
    expect(results.map((row) => row.prepared)).toEqual([true, true, true, false]);
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
      { prepared: false, reason: "deferred", trackId: "b" },
      { prepared: false, reason: "deferred", trackId: "c" },
    ]);
  });
});

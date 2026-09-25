import { describe, expect, it } from "bun:test";

import {
  type BatchArgs,
  type BatchDeps,
  type PageAudio,
  type WorkItem,
  affordableTracks,
  EmbedScriptError,
  FIRST_PAGE_TRACK_MS,
  mapWithConcurrency,
  MAX_PAGE,
  parseBatchArgs,
  runBatch,
  sourceAudioExt,
} from "./embed-batch";

type FakeOptions = {
  deadAudio?: Set<string>;

  embedErrors?: Set<string>;

  msPerTrack?: number;

  throwOnPage?: number;

  total: number;
};

function makeFakePod(options: FakeOptions) {
  const { msPerTrack = 10_000, total } = options;
  const vectors = new Map<string, number[]>();
  const clock = { now: 0 };

  const events: string[] = [];
  const downloadedIds: string[] = [];
  const embeddedIds: string[] = [];
  const liveWorkdirs = new Set<string>();

  let workdirs = 0;
  let pages = 0;

  const queue = (): WorkItem[] =>
    Array.from({ length: total }, (_, index) => ({
      certified: index % 10 === 0,
      logId: index % 10 === 0 ? `00${index}.1.1A` : null,
      sourceAudioKey: `key/t${index}.webm`,
      title: `Track ${index}`,
      trackId: `t${index}`,
    })).filter((item) => !vectors.has(item.trackId));

  const deps: BatchDeps = {
    discard: (audio: PageAudio) => {
      liveWorkdirs.delete(audio.workdir);
    },
    download: async (items, workdir) => {
      events.push(`download:${items.length}`);

      await Promise.resolve();

      const entries = items.flatMap((item) => {
        const id = item.trackId ?? "";

        if (options.deadAudio?.has(id)) {
          return [];
        }

        downloadedIds.push(id);

        return [{ id, path: `${workdir}/${id}.webm` }];
      });

      events.push(`downloaded:${entries.length}`);

      return entries;
    },
    embed: async (audio) => {
      pages += 1;
      events.push(`embed:start:${audio.entries.length}`);

      if (options.throwOnPage !== undefined && pages >= options.throwOnPage) {
        throw new EmbedScriptError("CUDA out of memory");
      }

      await Promise.resolve();
      await Promise.resolve();

      clock.now += audio.entries.length * msPerTrack;

      const results = audio.entries
        .filter((entry) => !options.embedErrors?.has(entry.id))
        .map((entry) => ({ embedding: [1, 2, 3], id: entry.id }));
      const errors = audio.entries
        .filter((entry) => options.embedErrors?.has(entry.id))
        .map((entry) => ({ error: "decode failed", id: entry.id }));

      events.push(`embed:end:${audio.entries.length}`);

      return { errors, results };
    },
    fetchQueue: async ({ count, limit }) => {
      const pending = queue();

      return { queued: count ? pending.length : undefined, tracks: pending.slice(0, limit) };
    },
    log: () => undefined,
    mkWorkdir: () => {
      workdirs += 1;
      const dir = `/tmp/fake-${workdirs}`;
      liveWorkdirs.add(dir);

      return dir;
    },
    now: () => clock.now,
    write: async (trackId, embedding) => {
      embeddedIds.push(trackId);
      vectors.set(trackId, embedding);
    },
  };

  return { clock, deps, downloadedIds, embeddedIds, events, liveWorkdirs, vectors };
}

const args = (overrides: Partial<BatchArgs> = {}): BatchArgs => ({
  dryRun: false,
  limit: 10,
  minutes: 55,
  scope: "all",
  ...overrides,
});

describe("parseBatchArgs", () => {
  it("defaults to a 55-minute run — an hour's rental, stopped short on purpose", () => {
    expect(parseBatchArgs([])).toEqual({
      dryRun: false,
      limit: MAX_PAGE,
      minutes: 55,
      scope: "all",
    });
  });

  it("takes --minutes, the number the operator matches to the block he rented", () => {
    expect(parseBatchArgs(["--minutes", "115"]).minutes).toBe(115);
    expect(parseBatchArgs(["--minutes", "0"]).minutes).toBe(55);
    expect(parseBatchArgs(["--minutes", "nonsense"]).minutes).toBe(55);
  });

  it("clamps --limit to the PAGE cap — it is the page size, not the run size", () => {
    expect(parseBatchArgs(["--limit", "100000"]).limit).toBe(MAX_PAGE);
    expect(parseBatchArgs(["--limit", "200"]).limit).toBe(MAX_PAGE);
    expect(parseBatchArgs(["--limit", "40"]).limit).toBe(40);
    expect(parseBatchArgs(["--limit", "0"]).limit).toBe(MAX_PAGE);
  });

  it("takes only the three real scopes, ignoring anything else", () => {
    expect(parseBatchArgs(["--scope", "catalogue"]).scope).toBe("catalogue");
    expect(parseBatchArgs(["--scope", "everything"]).scope).toBe("all");
  });

  it("carries --dry-run, the answer-without-spending flag", () => {
    expect(parseBatchArgs(["--dry-run", "--minutes", "115"])).toEqual({
      dryRun: true,
      limit: MAX_PAGE,
      minutes: 115,
      scope: "all",
    });
  });
});

describe("affordableTracks — the page sizer", () => {
  it("cuts the page to the time that is LEFT, never to a hardcoded batch size", () => {
    expect(affordableTracks({ at: 0, deadline: 600_000, page: 100, perTrackMs: 30_000 })).toBe(20);
  });

  it("never exceeds the page cap even when the clock is wide open", () => {
    expect(affordableTracks({ at: 0, deadline: 9_000_000, page: 100, perTrackMs: 1_000 })).toBe(
      100,
    );
  });

  it("returns 0 when the budget cannot pay for even ONE track — the stop signal", () => {
    expect(affordableTracks({ at: 0, deadline: 20_000, page: 100, perTrackMs: 30_000 })).toBe(0);
    expect(affordableTracks({ at: 100, deadline: 100, page: 100, perTrackMs: 1_000 })).toBe(0);
    expect(affordableTracks({ at: 200, deadline: 100, page: 100, perTrackMs: 1_000 })).toBe(0);
  });
});

describe("sourceAudioExt", () => {
  it("carries the captured container's suffix onto the temp file", () => {
    expect(sourceAudioExt("004.7.2I/abc123.webm")).toBe(".webm");
    expect(sourceAudioExt("004.7.2I/abc123.M4A")).toBe(".m4a");
  });

  it("falls back to .audio when the key carries no usable extension", () => {
    expect(sourceAudioExt("004.7.2I/abc123")).toBe(".audio");
    expect(sourceAudioExt("004.7.2I/abc123.")).toBe(".audio");
    expect(sourceAudioExt("bare-key")).toBe(".audio");
  });
});

describe("mapWithConcurrency", () => {
  it("runs every item and keeps the results positionally aligned", async () => {
    expect(await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10)).toEqual([
      10, 20, 30, 40, 50,
    ]);
  });

  it("never exceeds the requested width", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async (n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;

        return n;
      },
    );

    expect(peak).toBeLessThanOrEqual(4);
  });

  it("yields null for a failed item and finishes the rest — one dead object cannot sink the batch", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 3, async (n) => {
      if (n === 2) {
        throw new Error("R2 GET failed (404)");
      }

      return n * 10;
    });

    expect(results).toEqual([10, null, 30]);
  });

  it("is a no-op on an empty worklist (it never even starts a worker)", async () => {
    let calls = 0;

    const results = await mapWithConcurrency<number, number>([], 8, async (n) => {
      calls += 1;

      return n;
    });

    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("runBatch — the run is bounded by the CLOCK, not by the queue", () => {
  it("drains the whole queue across MANY pages — an hour is not one page", async () => {
    const pod = makeFakePod({ total: 45 });

    const summary = await runBatch(args({ limit: 10 }), pod.deps);

    expect(summary.embedded).toBe(45);
    expect(summary.pages).toBeGreaterThan(1);
    expect(summary.stopReason).toBe("queue_dry");
    expect(summary.remaining).toBe(0);
    expect(summary.abandoned).toBe(0);

    expect(new Set(pod.embeddedIds).size).toBe(45);
  });

  it("stops BEFORE the budget, and never spills past the hour boundary", async () => {
    const pod = makeFakePod({ msPerTrack: 60_000, total: 10_000 });

    const summary = await runBatch(args({ limit: 10, minutes: 55 }), pod.deps);

    expect(summary.stopReason).toBe("budget_spent");

    expect(pod.clock.now).toBeLessThanOrEqual(55 * 60_000);
    expect(summary.minutes).toBeLessThanOrEqual(55);

    expect(summary.embedded).toBeGreaterThanOrEqual(40);
  });

  it("never downloads a page it cannot finish — abandoned audio is money paid for nothing", async () => {
    const pod = makeFakePod({ msPerTrack: 6 * 60_000, total: 100 });

    const summary = await runBatch(args({ limit: 10, minutes: 20 }), pod.deps);

    expect(summary.abandoned).toBe(0);
    expect(pod.downloadedIds.length).toBe(summary.embedded);
    expect(summary.embedded).toBeGreaterThan(0);

    expect(pod.liveWorkdirs.size).toBe(0);

    expect(pod.clock.now).toBeLessThanOrEqual(20 * 60_000 + 6 * 60_000);
  });

  it("probes with ONE track, then opens the page up to the MEASURED rate", async () => {
    const pod = makeFakePod({ msPerTrack: 10_000, total: 60 });

    const summary = await runBatch(args({ limit: 20, minutes: 30 }), pod.deps);

    expect(pod.events[0]).toBe("download:1");

    expect(summary.embedded).toBe(60);
    expect(summary.pages).toBeGreaterThan(1);
    expect(pod.clock.now).toBeLessThanOrEqual(30 * 60_000);

    expect(FIRST_PAGE_TRACK_MS).toBeGreaterThan(0);
  });

  it("pulls the NEXT page's audio WHILE the current page is on the GPU", async () => {
    const pod = makeFakePod({ total: 30 });

    await runBatch(args({ limit: 10 }), pod.deps);

    const firstEmbedEnd = pod.events.indexOf("embed:end:10");
    const secondDownloadStart = pod.events.indexOf(
      "download:10",
      pod.events.indexOf("embed:start:10"),
    );

    expect(firstEmbedEnd).toBeGreaterThan(-1);
    expect(secondDownloadStart).toBeGreaterThan(-1);
    expect(secondDownloadStart).toBeLessThan(firstEmbedEnd);
  });

  it("reports the backlog it did not get to — 'done' is a claim, not a default", async () => {
    const pod = makeFakePod({ msPerTrack: 60_000, total: 500 });

    const summary = await runBatch(args({ limit: 10, minutes: 10 }), pod.deps);

    expect(summary.stopReason).toBe("budget_spent");
    expect(summary.remaining).toBe(500 - summary.embedded);
    expect(summary.remaining).toBeGreaterThan(0);
    expect(summary.tracksPerMinute).toBeGreaterThan(0);
  });
});

describe("runBatch — resumability: a pod that dies costs the page in flight and nothing else", () => {
  it("picks up exactly the unembedded remainder, and redoes NO work", async () => {
    const first = makeFakePod({ msPerTrack: 60_000, total: 40 });

    const runOne = await runBatch(args({ limit: 10, minutes: 12 }), first.deps);

    expect(runOne.stopReason).toBe("budget_spent");
    expect(runOne.embedded).toBeGreaterThan(0);
    expect(runOne.embedded).toBeLessThan(40);
    expect(runOne.remaining).toBe(40 - runOne.embedded);

    const done = new Set(first.embeddedIds);
    const second = makeFakePod({ total: 40 });

    for (const [id, vector] of first.vectors) {
      second.vectors.set(id, vector);
    }

    const runTwo = await runBatch(args({ limit: 10, minutes: 55 }), second.deps);

    expect(runTwo.stopReason).toBe("queue_dry");
    expect(runTwo.remaining).toBe(0);
    expect(runOne.embedded + runTwo.embedded).toBe(40);

    for (const id of second.embeddedIds) {
      expect(done.has(id)).toBe(false);
    }

    for (const id of second.downloadedIds) {
      expect(done.has(id)).toBe(false);
    }
  });

  it("keeps every vector written before the GPU blew up — the write-back is per TRACK", async () => {
    const pod = makeFakePod({ throwOnPage: 3, total: 40 });

    const summary = await runBatch(args({ limit: 10 }), pod.deps);

    expect(summary.stopReason).toBe("embed_failed");
    expect(summary.embedded).toBe(11);
    expect(summary.remaining).toBe(29);

    expect(pod.liveWorkdirs.size).toBe(0);
  });
});

describe("runBatch — the failure modes it must not mistake for an empty queue", () => {
  it("does not hand a dead R2 object back to itself forever", async () => {
    const pod = makeFakePod({ deadAudio: new Set(["t0", "t1"]), total: 12 });

    const summary = await runBatch(args({ limit: 5 }), pod.deps);

    expect(summary.downloadFailed).toBe(2);
    expect(summary.embedded).toBe(10);
    expect(summary.stopReason).toBe("queue_blocked");

    expect(summary.remaining).toBe(2);
  });

  it("counts a track the model could not embed, and leaves it queued", async () => {
    const pod = makeFakePod({ embedErrors: new Set(["t3"]), total: 6 });

    const summary = await runBatch(args({ limit: 6 }), pod.deps);

    expect(summary.failed).toBe(1);
    expect(summary.embedded).toBe(5);
    expect(summary.remaining).toBe(1);
  });

  it("separates the findings from the catalogue in its ledger", async () => {
    const pod = makeFakePod({ total: 20 });

    const summary = await runBatch(args({ limit: 10 }), pod.deps);

    expect(summary.findings).toBe(2);
    expect(summary.catalogue).toBe(18);
  });
});

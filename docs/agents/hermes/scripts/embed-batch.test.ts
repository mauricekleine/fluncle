// Unit tests for the GPU batch — the pure helpers AND the drain loop itself. The orchestrator
// is self-contained (a rented pod cannot import the workspace) and lives outside any package's
// test runner, so this file uses `bun:test` and is run directly:
//
//   bun test docs/agents/hermes/scripts/embed-batch.test.ts
//
// ── WHAT IS ACTUALLY ON TRIAL ─────────────────────────────────────────────────────────────
// The batch has never run on real hardware and MUST NOT, from here: renting a pod is a paid,
// operator-gated act. So the properties that decide whether an hour of GPU is money well spent
// are proven with a FAKE CLOCK and a STUBBED GPU, which is the right place to prove them anyway
// — a real run would tell you what happened once, not what is guaranteed.
//
//   1. THE RUN FILLS THE HOUR. It keeps taking pages until the queue is dry, not until one page
//      is done. (`drains the whole queue…`)
//   2. THE RUN STOPS SHORT OF THE HOUR. It never spills past the budget, because one minute past
//      an hour boundary buys a whole second hour. (`stops before the budget…`)
//   3. IT NEVER STARTS A PAGE IT CANNOT FINISH. A page of audio pulled and then abandoned is
//      money paid for nothing. (`never downloads a page…`)
//   4. THE DOWNLOAD OVERLAPS THE GPU. The next page's R2 pull begins while the current page is
//      still on the (expensive) GPU. (`pulls the NEXT page's audio…`)
//   5. IT IS RESUMABLE. A pod killed mid-run costs the page in flight and nothing else; the next
//      run picks up the remainder and redoes NO work. (`resumability`)
//   6. IT REPORTS HONESTLY. "Done" means the queue is drained; anything else names how much is
//      left, counted server-side. (`reports the backlog it did not get to`)
//
// `main()` is guarded behind `import.meta.main`, so importing this module spawns no python,
// rents no GPU, and touches no R2 — the tests are hermetic.

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

// ---------------------------------------------------------------------------
// The fake pod: a fake clock, a fake queue, a stubbed GPU.
// ---------------------------------------------------------------------------

type FakeOptions = {
  /** Track ids whose R2 object is gone — the download throws for these. */
  deadAudio?: Set<string>;
  /** Track ids the model cannot embed — they come back in `errors` and stay queued. */
  embedErrors?: Set<string>;
  /** How much wall clock ONE track costs on the (stubbed) GPU. */
  msPerTrack?: number;
  /** Blow up the python side after this many pages (a pod OOM, a reclaimed spot instance). */
  throwOnPage?: number;
  /** How many tracks are queued at the start. */
  total: number;
};

/**
 * A fake server + pod. The queue is REAL in the only way that matters: a track leaves it exactly
 * when its vector is written back, which is the property the whole "resumable by construction"
 * claim rests on. The clock only moves when the GPU works — so a test's assertions about the
 * budget are assertions about the thing that actually bills.
 */
function makeFakePod(options: FakeOptions) {
  const { msPerTrack = 10_000, total } = options;
  const vectors = new Map<string, number[]>();
  const clock = { now: 0 };

  // What happened, in order — so a test can prove the next page's download STARTED while the
  // current page was still on the GPU.
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

      // A download is not free wall clock in reality, but it is OVERLAPPED with the GPU, so the
      // fake keeps it off the clock: the budget must be paid for by the GPU, which is what the
      // pod actually bills for. The `await` is what makes the interleaving observable.
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

      // Yield twice, so anything the loop kicked off before awaiting the GPU (the prefetch) gets
      // to run WHILE the GPU is "busy" — that interleaving is the thing under test.
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

// ---------------------------------------------------------------------------
// The pure helpers
// ---------------------------------------------------------------------------

describe("parseBatchArgs", () => {
  it("defaults to a 55-minute run — an hour's rental, stopped short on purpose", () => {
    // 60 would be the naive number and it is the wrong one: spilling ONE minute past the hour
    // boundary buys a whole second hour for a single track.
    expect(parseBatchArgs([])).toEqual({
      dryRun: false,
      limit: MAX_PAGE,
      minutes: 55,
      scope: "all",
    });
  });

  it("takes --minutes, the number the operator matches to the block he rented", () => {
    expect(parseBatchArgs(["--minutes", "115"]).minutes).toBe(115); // a two-hour block
    expect(parseBatchArgs(["--minutes", "0"]).minutes).toBe(55); // non-positive → the default
    expect(parseBatchArgs(["--minutes", "nonsense"]).minutes).toBe(55);
  });

  it("clamps --limit to the PAGE cap — it is the page size, not the run size", () => {
    // The run size is the CLOCK. And the page cannot exceed half the server's 200-row worklist
    // read, or the cross-page prefetch could never see past the page still on the GPU.
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
    // 10 minutes left, 30s a track → 20 tracks fit.
    expect(affordableTracks({ at: 0, deadline: 600_000, page: 100, perTrackMs: 30_000 })).toBe(20);
  });

  it("never exceeds the page cap even when the clock is wide open", () => {
    expect(affordableTracks({ at: 0, deadline: 9_000_000, page: 100, perTrackMs: 1_000 })).toBe(
      100,
    );
  });

  it("returns 0 when the budget cannot pay for even ONE track — the stop signal", () => {
    // This is the "do not start a page you cannot finish" rule, in one line: a page begun here
    // would be audio pulled out of R2 and then thrown away.
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

// ---------------------------------------------------------------------------
// The drain loop — the thing the operator is paying for
// ---------------------------------------------------------------------------

describe("runBatch — the run is bounded by the CLOCK, not by the queue", () => {
  it("drains the whole queue across MANY pages — an hour is not one page", async () => {
    // 45 tracks, a page of 10, and a GPU that does a track in 10s → the whole queue costs 7.5
    // minutes and fits inside the hour many times over. The OLD script embedded one page and
    // exited, leaving the pod idle on 35 tracks the operator had already paid for.
    const pod = makeFakePod({ total: 45 });

    const summary = await runBatch(args({ limit: 10 }), pod.deps);

    expect(summary.embedded).toBe(45);
    expect(summary.pages).toBeGreaterThan(1);
    expect(summary.stopReason).toBe("queue_dry");
    expect(summary.remaining).toBe(0);
    expect(summary.abandoned).toBe(0);
    // No track is embedded twice: the queue is the state, and a written vector leaves it.
    expect(new Set(pod.embeddedIds).size).toBe(45);
  });

  it("stops BEFORE the budget, and never spills past the hour boundary", async () => {
    // A bottomless queue and a 55-minute budget. A GPU minute a track: the run must stop itself.
    const pod = makeFakePod({ msPerTrack: 60_000, total: 10_000 });

    const summary = await runBatch(args({ limit: 10, minutes: 55 }), pod.deps);

    expect(summary.stopReason).toBe("budget_spent");
    // THE HARD ONE: the wall clock consumed is inside the budget. Never 56 minutes.
    expect(pod.clock.now).toBeLessThanOrEqual(55 * 60_000);
    expect(summary.minutes).toBeLessThanOrEqual(55);
    // And it did not just do one page and sulk — it filled the hour it was paid for.
    expect(summary.embedded).toBeGreaterThanOrEqual(40);
  });

  it("never downloads a page it cannot finish — abandoned audio is money paid for nothing", async () => {
    // A SLOW pod: 6 minutes of GPU a track, six times slower than the un-calibrated assumption.
    // This is the case that punishes a guess. The run must discover the real rate on one probe
    // track and then size every page to it — pulling nothing out of R2 it will not embed.
    const pod = makeFakePod({ msPerTrack: 6 * 60_000, total: 100 });

    const summary = await runBatch(args({ limit: 10, minutes: 20 }), pod.deps);

    expect(summary.abandoned).toBe(0);
    expect(pod.downloadedIds.length).toBe(summary.embedded);
    expect(summary.embedded).toBeGreaterThan(0);
    // Nothing was left on the pod's disk: private audio never outlives its page.
    expect(pod.liveWorkdirs.size).toBe(0);
    // THE BOUND. A run cannot stop in the middle of a page, so a pod slower than the assumption
    // can overrun — by AT MOST the one-track calibration probe, which is the tightest bound
    // available. (Had the first page been sized off the 60s/track guess, this pod would have run
    // 10 tracks × 6 min = an HOUR over a 20-minute budget.)
    expect(pod.clock.now).toBeLessThanOrEqual(20 * 60_000 + 6 * 60_000);
  });

  it("probes with ONE track, then opens the page up to the MEASURED rate", async () => {
    // The first page is a calibration probe — a guess is not a measurement. Once the run knows
    // the pod does 10s a track, the pages open all the way up to the cap.
    const pod = makeFakePod({ msPerTrack: 10_000, total: 60 });

    const summary = await runBatch(args({ limit: 20, minutes: 30 }), pod.deps);

    expect(pod.events[0]).toBe("download:1");
    // …and the run then goes far past that one cautious track.
    expect(summary.embedded).toBe(60);
    expect(summary.pages).toBeGreaterThan(1);
    expect(pod.clock.now).toBeLessThanOrEqual(30 * 60_000);
    // The un-calibrated assumption is only ever used to ask "is there time for anything at all".
    expect(FIRST_PAGE_TRACK_MS).toBeGreaterThan(0);
  });

  it("pulls the NEXT page's audio WHILE the current page is on the GPU", async () => {
    // The pod is remote from R2 and the GPU is the expensive thing in the room. This is the
    // across-page overlap, and it is where the throughput is: the second page's download must
    // START before the first page's embed ENDS.
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
    // The lie this exists to prevent: a run that reports ok:true while 8,000 tracks are queued.
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
    // ONE fake archive, TWO runs. The queue is the checkpoint — a written vector leaves it — so
    // there is nothing to remember between them.
    const first = makeFakePod({ msPerTrack: 60_000, total: 40 });

    const runOne = await runBatch(args({ limit: 10, minutes: 12 }), first.deps);

    expect(runOne.stopReason).toBe("budget_spent");
    expect(runOne.embedded).toBeGreaterThan(0);
    expect(runOne.embedded).toBeLessThan(40);
    expect(runOne.remaining).toBe(40 - runOne.embedded);

    // The pod is destroyed. A NEW pod, a NEW run — reading the SAME archive, which now holds the
    // vectors the first run wrote.
    const done = new Set(first.embeddedIds);
    const second = makeFakePod({ total: 40 });

    for (const [id, vector] of first.vectors) {
      second.vectors.set(id, vector);
    }

    const runTwo = await runBatch(args({ limit: 10, minutes: 55 }), second.deps);

    // It finished the job…
    expect(runTwo.stopReason).toBe("queue_dry");
    expect(runTwo.remaining).toBe(0);
    expect(runOne.embedded + runTwo.embedded).toBe(40);

    // …and it did not embed a single track the first run had already done. That is the money:
    // re-embedding 400 tracks on a rented GPU is a rented hour spent on nothing.
    for (const id of second.embeddedIds) {
      expect(done.has(id)).toBe(false);
    }

    // Nor did it even DOWNLOAD one of them.
    for (const id of second.downloadedIds) {
      expect(done.has(id)).toBe(false);
    }
  });

  it("keeps every vector written before the GPU blew up — the write-back is per TRACK", async () => {
    // A pod OOMs (or a spot instance is reclaimed) on its third page. The calibration probe and
    // the full page behind it are already in the archive; nothing is lost but the page in flight.
    const pod = makeFakePod({ throwOnPage: 3, total: 40 });

    const summary = await runBatch(args({ limit: 10 }), pod.deps);

    expect(summary.stopReason).toBe("embed_failed");
    expect(summary.embedded).toBe(11); // the 1-track probe + one full page
    expect(summary.remaining).toBe(29);
    // Even on the failure path the private audio leaves the pod's disk — INCLUDING the page the
    // prefetch had already pulled down.
    expect(pod.liveWorkdirs.size).toBe(0);
  });
});

describe("runBatch — the failure modes it must not mistake for an empty queue", () => {
  it("does not hand a dead R2 object back to itself forever", async () => {
    // The queue is ORDERED, not stateful: a track whose audio 404s stays at the head of it. A
    // loop that re-read the queue naively would pull that same track every page, forever.
    const pod = makeFakePod({ deadAudio: new Set(["t0", "t1"]), total: 12 });

    const summary = await runBatch(args({ limit: 5 }), pod.deps);

    expect(summary.downloadFailed).toBe(2);
    expect(summary.embedded).toBe(10);
    expect(summary.stopReason).toBe("queue_blocked");
    // The two dead ones are still queued — honestly reported, not silently "done".
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

    expect(summary.findings).toBe(2); // every tenth seeded row is certified
    expect(summary.catalogue).toBe(18);
  });
});

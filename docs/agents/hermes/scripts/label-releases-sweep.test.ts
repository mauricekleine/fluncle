// Unit tests for label-releases-sweep.ts — the FRESHNESS TAP cron's orchestrator (D8).
//
// The sweep is a TRIGGER: the Worker does the Spotify search, the gate, the dedupe and the mint, and
// paces ITSELF against the shared call meter. So what is worth pinning here is the sweep's LOOP —
// when it asks again, when it stops, and above all that `budgetPaused` (the tap yielding the Spotify
// window to a user-facing mint) is a WAIT-and-retry rather than either a fault or a burst.
//
// Runs outside any package's test runner (bun:test), like anchor-sweep.test.ts:
//   bun test docs/agents/hermes/scripts/label-releases-sweep.test.ts

import { describe, expect, test } from "bun:test";
import {
  type LabelReleasesDeps,
  type PassResult,
  parseLimitArg,
  runLabelReleasesTick,
} from "./label-releases-sweep";

/** A pass that probed labels and minted a row — the "there was work, ask again" shape. */
const PASS: PassResult = {
  albumsMatched: 1,
  albumsSeen: 2,
  budgetPaused: false,
  configured: true,
  failedLabels: [],
  fetchCeilingHit: false,
  labelsProbed: 5,
  newRows: 1,
  rateLimited: false,
  skippedKnown: 0,
  skippedUndated: 0,
  skippedUngrounded: 1,
};

/** A pass that found nothing due — the tick's natural end. */
const DRAINED: PassResult = {
  ...PASS,
  albumsMatched: 0,
  albumsSeen: 0,
  labelsProbed: 0,
  newRows: 0,
  skippedUngrounded: 0,
};

function deps(overrides: Partial<LabelReleasesDeps> = {}): LabelReleasesDeps {
  return {
    log: () => {},
    runPass: () => Promise.resolve(DRAINED),
    wait: () => Promise.resolve(),
    ...overrides,
  };
}

/** A `runPass` that replays a fixed script of pass results, recording how many times it was asked. */
function scripted(results: PassResult[]): {
  calls: () => number;
  runPass: () => Promise<PassResult>;
} {
  let index = 0;

  return {
    calls: () => index,
    runPass: () => {
      const result = results[Math.min(index, results.length - 1)] ?? DRAINED;
      index += 1;

      return Promise.resolve(result);
    },
  };
}

describe("runLabelReleasesTick", () => {
  test("loops bounded passes until nothing is due, accumulating the tallies", async () => {
    const script = scripted([PASS, PASS, DRAINED]);
    const summary = await runLabelReleasesTick(5, deps({ runPass: script.runPass }));

    expect(summary.ok).toBe(true);
    expect(summary.passes).toBe(3);
    expect(summary.labelsProbed).toBe(10); // two working passes x 5
    expect(summary.newRows).toBe(2);
    expect(summary.skippedUngrounded).toBe(2);
    // It stopped at the drained pass — it did not keep asking.
    expect(script.calls()).toBe(3);
  });

  test("stops immediately when the Spotify grant is gone (configured:false, not a fault)", async () => {
    const script = scripted([{ ...PASS, configured: false, labelsProbed: 0 }]);
    const summary = await runLabelReleasesTick(5, deps({ runPass: script.runPass }));

    expect(summary.configured).toBe(false);
    expect(summary.ok).toBe(true); // a documented no-op, never a crash
    expect(script.calls()).toBe(1);
  });

  test("stops on a Spotify 429 — the next tick resumes", async () => {
    const script = scripted([{ ...PASS, rateLimited: true }, PASS]);
    const summary = await runLabelReleasesTick(5, deps({ runPass: script.runPass }));

    expect(summary.rateLimited).toBe(true);
    expect(script.calls()).toBe(1); // it did NOT push through the throttle
  });

  test("WAITS and retries when the Worker yields the Spotify window to a user path", async () => {
    // The load-bearing behaviour: `budgetPaused` means the tap stepped back so a user's playlist
    // mint has room. The sweep must neither treat it as an error nor immediately hammer again — it
    // stands down for a window, then carries on and finishes the drain.
    const script = scripted([{ ...PASS, budgetPaused: true, labelsProbed: 2 }, PASS, DRAINED]);
    const waits: number[] = [];
    const summary = await runLabelReleasesTick(
      5,
      deps({
        runPass: script.runPass,
        wait: (ms) => {
          waits.push(ms);

          return Promise.resolve();
        },
      }),
    );

    expect(summary.ok).toBe(true);
    expect(summary.budgetPaused).toBe(true);
    // It stood down exactly once, for a whole meter window, then resumed and drained.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(30_000);
    expect(summary.labelsProbed).toBe(7); // the partial pass's 2 + the full pass's 5
    expect(summary.newRows).toBe(2);
  });

  test("gives up after the pause fuse when the app stays busy — never spins", async () => {
    // A permanently-busy Spotify app is a reason to come back next tick, not to loop all night.
    const script = scripted([{ ...PASS, budgetPaused: true }]);
    const waits: number[] = [];
    const summary = await runLabelReleasesTick(
      5,
      deps({
        runPass: script.runPass,
        wait: (ms) => {
          waits.push(ms);

          return Promise.resolve();
        },
      }),
    );

    expect(summary.budgetPaused).toBe(true);
    expect(summary.ok).toBe(true); // yielding is not failing
    // Bounded: a handful of stand-downs, then it leaves the rest for the next tick.
    expect(waits.length).toBeLessThanOrEqual(5);
    expect(script.calls()).toBeLessThanOrEqual(6);
  });

  test("a failed pass reports ok:false, never a throw", async () => {
    const summary = await runLabelReleasesTick(
      5,
      deps({ runPass: () => Promise.reject(new Error("worker 502")) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("worker 502");
    expect(summary.passes).toBe(0);
  });

  test("counts the labels that hit a transient Spotify error on their search", async () => {
    const script = scripted([
      { ...PASS, failedLabels: ["medschool", "hospital-records"] },
      DRAINED,
    ]);
    const summary = await runLabelReleasesTick(5, deps({ runPass: script.runPass }));

    expect(summary.failedLabels).toBe(2);
    expect(summary.ok).toBe(true); // a per-label miss never fails the tick
  });

  test("carries the undated-album drop through to the summary", async () => {
    // The tripwire for the /fresh-invisible row: an undated album must never mint, and the tick
    // reports it if the vendor ever starts returning them.
    const script = scripted([{ ...PASS, skippedUndated: 3 }, DRAINED]);
    const summary = await runLabelReleasesTick(5, deps({ runPass: script.runPass }));

    expect(summary.skippedUndated).toBe(3);
  });
});

describe("parseLimitArg", () => {
  test("reads --limit N, else the fallback", () => {
    expect(parseLimitArg(["--limit", "20"], 5)).toBe(20);
    expect(parseLimitArg([], 5)).toBe(5);
    expect(parseLimitArg(["--limit", "-3"], 5)).toBe(5);
  });
});

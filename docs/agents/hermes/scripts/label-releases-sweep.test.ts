import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anchorReadyForTap,
  type LabelReleasesDeps,
  type PassResult,
  isSpotifyFreeWindow,
  parseLimitArg,
  recordTapDailyState,
  runLabelReleasesTick,
} from "./label-releases-sweep";

const PASS: PassResult = {
  albumsMatched: 1,
  albumsSeen: 2,
  blockedReason: null,
  budgetPaused: false,
  configured: true,
  failedLabels: [],
  fetchCeilingHit: false,
  labelsDue: 100,
  labelsProbed: 5,
  neverChecked: 70,
  newRows: 1,
  quotaExceeded: false,
  rateLimited: false,
  retryAfterMs: 0,
  skippedKnown: 0,
  skippedUndated: 0,
  skippedUngrounded: 1,
  tapDailyBudget: 500,
  tapDailyCallsSpent: 20,
};

const DRAINED: PassResult = {
  ...PASS,
  albumsMatched: 0,
  albumsSeen: 0,
  labelsProbed: 0,
  newRows: 0,
  skippedUngrounded: 0,
};

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function deps(overrides: Partial<LabelReleasesDeps> = {}): LabelReleasesDeps {
  return {
    log: () => {},
    runPass: () => Promise.resolve(DRAINED),
    wait: () => Promise.resolve(),
    ...overrides,
  };
}

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
    expect(summary.labelsProbed).toBe(10);
    expect(summary.newRows).toBe(2);
    expect(summary.checked).toBe(10);
    expect(summary.produced).toBe(10);
    expect(summary.errors).toBe(0);
    expect(summary.skippedUngrounded).toBe(2);

    expect("queueDepth" in summary).toBe(false);
    expect("queue_depth" in summary).toBe(false);
    expect("expectedIntervalMs" in summary).toBe(false);
    expect("expected_interval_ms" in summary).toBe(false);

    expect(script.calls()).toBe(3);
  });

  test("stops immediately when the Spotify grant is gone (configured:false, not a fault)", async () => {
    const script = scripted([{ ...PASS, configured: false, labelsProbed: 0 }]);
    const summary = await runLabelReleasesTick(5, deps({ runPass: script.runPass }));

    expect(summary.configured).toBe(false);
    expect(summary.ok).toBe(true);
    expect(script.calls()).toBe(1);
  });

  test("a first-label transient 429 waits for Retry-After and probes another label in the same tick", async () => {
    const script = scripted([
      {
        ...PASS,
        blockedReason: "spotify_throttle",
        labelsProbed: 0,
        rateLimited: true,
        retryAfterMs: 4000,
      },
      PASS,
      DRAINED,
    ]);
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

    expect(summary.rateLimited).toBe(true);
    expect(summary.labelsProbed).toBe(5);
    expect(summary.checked).toBe(5);
    expect(waits).toEqual([4000]);
    expect(script.calls()).toBe(3);
  });

  test("daily quota stops this firing and exposes its blocker", async () => {
    const script = scripted([
      {
        ...PASS,
        blockedReason: "spotify_quota",
        labelsProbed: 0,
        quotaExceeded: true,
        rateLimited: true,
      },
      PASS,
    ]);
    const summary = await runLabelReleasesTick(5, deps({ runPass: script.runPass }));
    expect(summary.quotaExceeded).toBe(true);
    expect(summary.blockedReason).toBe("spotify_quota");
    expect(summary.checked).toBe(0);
    expect(script.calls()).toBe(1);
  });

  test("a spent daily tap budget ends the firing without a wait", async () => {
    const script = scripted([
      { ...PASS, blockedReason: "spotify_budget_spent", labelsProbed: 0, tapDailyCallsSpent: 500 },
      PASS,
    ]);
    const summary = await runLabelReleasesTick(5, deps({ runPass: script.runPass }));
    expect(summary.blockedReason).toBe("spotify_budget_spent");
    expect(summary.tapDailyBudget).toBe(500);
    expect(summary.tapDailyCallsSpent).toBe(500);
    expect(script.calls()).toBe(1);
  });

  test("an explicit zero daily budget survives the sweep and persisted state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fluncle-tap-budget-zero-"));
    temporaryDirectories.push(dir);
    const script = scripted([
      {
        ...PASS,
        blockedReason: "spotify_budget_spent",
        labelsProbed: 0,
        tapDailyBudget: 0,
        tapDailyCallsSpent: 0,
      },
    ]);
    const summary = await runLabelReleasesTick(5, deps({ runPass: script.runPass }));
    expect(summary.tapDailyBudget).toBe(0);
    expect(summary.blockedReason).toBe("spotify_budget_spent");
    const state = recordTapDailyState(dir, summary, new Date("2026-09-26T04:00:00Z"));
    expect(state.tapDailyBudget).toBe(0);
  });

  test("defers before the Worker call until the anchor has priority", async () => {
    const script = scripted([PASS]);
    const summary = await runLabelReleasesTick(
      5,
      deps({ anchorReady: () => false, runPass: script.runPass }),
    );
    expect(summary.blockedReason).toBe("anchor_priority");
    expect(script.calls()).toBe(0);
  });

  test("rechecks anchor priority before every pass and preserves completed probes", async () => {
    const script = scripted([PASS, PASS]);
    let checks = 0;
    const summary = await runLabelReleasesTick(
      5,
      deps({
        anchorReady: () => {
          checks += 1;
          return checks === 1;
        },
        runPass: script.runPass,
      }),
    );
    expect(summary.blockedReason).toBe("anchor_priority");
    expect(summary.labelsProbed).toBe(5);
    expect(script.calls()).toBe(1);
    expect(checks).toBe(2);
  });

  test("ends a firing before waits can overrun its service timeout", async () => {
    let elapsed = 0;
    const script = scripted([{ ...PASS, budgetPaused: true, labelsProbed: 0 }, PASS]);
    const waits: number[] = [];
    const summary = await runLabelReleasesTick(
      5,
      deps({
        now: () => new Date(Date.parse("2026-09-26T03:00:00Z") + elapsed),
        runPass: () => {
          elapsed += 10 * 60_000;
          return script.runPass();
        },
        wait: (ms) => {
          waits.push(ms);
          elapsed += ms;
          return Promise.resolve();
        },
      }),
    );
    expect(summary.blockedReason).toBe("spotify_budget");
    expect(waits).toEqual([]);
    expect(script.calls()).toBe(1);
  });

  test("WAITS and retries when the Worker yields the Spotify window to a user path", async () => {
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

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(30_000);
    expect(summary.labelsProbed).toBe(7);
    expect(summary.newRows).toBe(2);
  });

  test("gives up after the pause fuse when the app stays busy — never spins", async () => {
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
    expect(summary.ok).toBe(true);

    expect(waits.length).toBeLessThanOrEqual(12);
    expect(script.calls()).toBeLessThanOrEqual(13);
  });

  test("a failed pass reports ok:false, never a throw", async () => {
    const summary = await runLabelReleasesTick(
      5,
      deps({ runPass: () => Promise.reject(new Error("worker 502")) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("worker 502");
    expect(summary.passes).toBe(0);
    expect(summary.checked).toBeNull();
    expect(summary.produced).toBeNull();
    expect(summary.errors).toBe(1);
  });

  test("preserves completed label units when a later pass fails the run", async () => {
    let calls = 0;
    const summary = await runLabelReleasesTick(
      5,
      deps({
        runPass: () => {
          calls += 1;

          return calls === 1 ? Promise.resolve(PASS) : Promise.reject(new Error("worker 502"));
        },
      }),
    );

    expect(summary.checked).toBe(5);
    expect(summary.produced).toBe(5);
    expect(summary.newRows).toBe(1);
    expect(summary.errors).toBe(1);
  });

  test("counts the labels that hit a transient Spotify error on their search", async () => {
    const script = scripted([
      { ...PASS, failedLabels: ["medschool", "hospital-records"] },
      DRAINED,
    ]);
    const summary = await runLabelReleasesTick(5, deps({ runPass: script.runPass }));

    expect(summary.failedLabels).toBe(2);
    expect(summary.failed).toBe(2);
    expect(summary.checked).toBe(7);
    expect(summary.produced).toBe(5);
    expect(summary.errors).toBe(0);
    expect(summary.ok).toBe(true);
  });

  test("carries the undated-album drop through to the summary", async () => {
    const script = scripted([{ ...PASS, skippedUndated: 3 }, DRAINED]);
    const summary = await runLabelReleasesTick(5, deps({ runPass: script.runPass }));

    expect(summary.skippedUndated).toBe(3);
  });
});

test("anchor priority requires the latest current-hour marker to show zero ISRC asks due", () => {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-anchor-priority-"));
  temporaryDirectories.push(dir);
  const now = new Date("2026-09-26T04:10:00Z");
  expect(anchorReadyForTap(dir, now)).toBe(false);
  const path = join(dir, "anchor.md");
  const write = (at: string, body: Record<string, unknown>) => {
    writeFileSync(path, `# Cron Job: fluncle-anchor\n\n${JSON.stringify(body)}\n`);
    utimesSync(path, new Date(at), new Date(at));
  };
  write("2026-09-26T03:55:00Z", { checked: 25, ok: true, queueDepth: 0, spotifyIsrcDue: 0 });
  expect(anchorReadyForTap(dir, now)).toBe(false);
  write("2026-09-26T04:05:00Z", { checked: 25, ok: false, queueDepth: 100, spotifyIsrcDue: 0 });
  expect(anchorReadyForTap(dir, now)).toBe(false);
  write("2026-09-26T04:05:00Z", { checked: 25, ok: true, queueDepth: 100, spotifyIsrcDue: 2 });
  expect(anchorReadyForTap(dir, now)).toBe(false);
  write("2026-09-26T04:05:00Z", { checked: 25, ok: true, queueDepth: 0 });
  expect(anchorReadyForTap(dir, now)).toBe(false);
  write("2026-09-26T04:05:00Z", { checked: 25, ok: true, queueDepth: 100, spotifyIsrcDue: 0 });
  expect(anchorReadyForTap(dir, now)).toBe(true);
  const later = join(dir, "later.md");
  writeFileSync(
    later,
    `# Cron Job: fluncle-anchor\n\n${JSON.stringify({ checked: 25, ok: true, queueDepth: 2, spotifyIsrcDue: 1 })}\n`,
  );
  utimesSync(later, new Date("2026-09-26T04:06:00Z"), new Date("2026-09-26T04:06:00Z"));
  expect(anchorReadyForTap(dir, now)).toBe(false);
});

test("daily tap state accumulates probes independently of pruned cron markers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-tap-state-"));
  temporaryDirectories.push(dir);
  const now = new Date("2026-09-26T04:10:00Z");
  const summary = await runLabelReleasesTick(
    5,
    deps({ runPass: scripted([PASS, DRAINED]).runPass }),
  );
  for (let i = 0; i < 24; i += 1) {
    recordTapDailyState(dir, summary, now);
  }
  const state = JSON.parse(readFileSync(join(dir, "daily", "2026-09-26.json"), "utf8"));
  expect(state.labelsProbed).toBe(120);
  expect(state.observedDemand).toBe(215);
});

test("daily tap state remembers a later unblocked firing after anchor priority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-tap-state-"));
  temporaryDirectories.push(dir);
  const now = new Date("2026-09-26T04:10:00Z");
  const summary = await runLabelReleasesTick(
    5,
    deps({ runPass: scripted([PASS, DRAINED]).runPass }),
  );
  recordTapDailyState(dir, { ...summary, blockedReason: "anchor_priority", labelsProbed: 0 }, now);
  const state = recordTapDailyState(dir, { ...summary, blockedReason: null, labelsProbed: 3 }, now);
  expect(state.blockedReasons).toEqual(["anchor_priority"]);
  expect(state.nonPriorityFirings).toBe(1);
});

describe("parseLimitArg", () => {
  test("reads --limit N, else the fallback", () => {
    expect(parseLimitArg(["--limit", "20"], 5)).toBe(20);
    expect(parseLimitArg([], 5)).toBe(5);
    expect(parseLimitArg(["--limit", "-3"], 5)).toBe(5);
  });
});

test("the tap only asks Spotify inside the UTC free window", async () => {
  expect(isSpotifyFreeWindow(new Date("2026-09-26T02:59:00Z"))).toBe(false);
  expect(isSpotifyFreeWindow(new Date("2026-09-26T03:00:00Z"))).toBe(true);
  expect(isSpotifyFreeWindow(new Date("2026-09-26T08:59:00Z"))).toBe(true);
  expect(isSpotifyFreeWindow(new Date("2026-09-26T09:00:00Z"))).toBe(false);
  const script = scripted([PASS]);
  const summary = await runLabelReleasesTick(
    5,
    deps({ runPass: script.runPass, withinWindow: () => false }),
  );
  expect(summary.blockedReason).toBe("outside_spotify_window");
  expect(script.calls()).toBe(0);
});

import { describe, expect, test } from "bun:test";
import {
  MAX_WINDOWS,
  parseReconcileCursor,
  parseWindowEnvelope,
  type ReconcileCursor,
  type ReconcileHubCountsDeps,
  type ReconcileHubCountsResponse,
  runReconcileHubCountsTick,
  WINDOW_PAGE_LIMIT,
  WINDOW_START_BUDGET_MS,
  windowBody,
} from "./reconcile-hub-counts";

const DRIFTED: ReconcileHubCountsResponse = {
  albums: { corrected: 3 },
  artists: { corrected: 44 },
  labels: { corrected: 1 },
  ok: true,
  tookMs: 1150,
};

const CLEAN: ReconcileHubCountsResponse = {
  albums: { corrected: 0 },
  artists: { corrected: 0 },
  labels: { corrected: 0 },
  ok: true,
  tookMs: 820,
};

function deps(overrides: Partial<ReconcileHubCountsDeps> = {}): ReconcileHubCountsDeps {
  return {
    log: () => {},
    reconcile: () => Promise.resolve(DRIFTED),
    ...overrides,
  };
}

function capturing(response: ReconcileHubCountsResponse): {
  deps: ReconcileHubCountsDeps;
  lines: string[];
} {
  const lines: string[] = [];

  return {
    deps: deps({
      log: (message) => lines.push(message),
      reconcile: () => Promise.resolve(response),
    }),
    lines,
  };
}

describe("runReconcileHubCountsTick", () => {
  test("maps a drifted response to an ok summary with the per-table + total corrected counts", async () => {
    const summary = await runReconcileHubCountsTick(deps());

    expect(summary.ok).toBe(true);
    expect(summary.labels).toBe(1);
    expect(summary.albums).toBe(3);
    expect(summary.artists).toBe(44);
    expect(summary.corrected).toBe(48);
    expect(summary.checked).toBe(3);
    expect(summary.produced).toBe(48);
    expect(summary.errors).toBe(0);
    expect(summary.tookMs).toBe(1150);
    expect(summary.error).toBeNull();

    expect("queue_depth" in summary).toBe(false);
    expect("expected_interval_ms" in summary).toBe(false);
  });

  test("maps the healthy steady state to zeroes, not to nulls", async () => {
    const summary = await runReconcileHubCountsTick(
      deps({ reconcile: () => Promise.resolve(CLEAN) }),
    );

    expect(summary.ok).toBe(true);
    expect(summary.corrected).toBe(0);
    expect(summary.labels).toBe(0);
    expect(summary.albums).toBe(0);
    expect(summary.artists).toBe(0);
    expect(summary.checked).toBe(3);
    expect(summary.produced).toBe(0);
    expect(summary.errors).toBe(0);
  });

  test("logs the AUDIT line with every per-table number — the operator's drift trail", async () => {
    const { deps: capturingDeps, lines } = capturing(DRIFTED);

    await runReconcileHubCountsTick(capturingDeps);

    const audit = lines.find((line) => line.startsWith("AUDIT "));
    expect(audit).toBeDefined();
    expect(audit).toBe("AUDIT corrected=48 labels=1 albums=3 artists=44 tookMs=1150");
  });

  test("reports date-only writes as latest, never as a clean zero-write tick", async () => {
    const run = capturing({
      albums: { corrected: 0, latestCorrected: 5 },
      artists: { corrected: 0, latestCorrected: 7 },
      labels: { corrected: 0, latestCorrected: 2 },
      ok: true,
      tookMs: 300,
    });
    const summary = await runReconcileHubCountsTick(run.deps);

    expect(summary.corrected).toBe(0);
    expect(summary.latestCorrected).toBe(14);
    expect(summary.produced).toBe(14);
    expect(run.lines).toContain(
      "AUDIT corrected=0 labels=0 albums=0 artists=0 tookMs=300 latest=14",
    );
  });

  test("sums date writes across windows", async () => {
    const responses: ReconcileHubCountsResponse[] = [
      {
        labels: { corrected: 1, deferred: 0, latestCorrected: 3 },
        next: { afterId: null, table: "albums" },
        ok: true,
        tookMs: 10,
      },
      {
        albums: { corrected: 0, deferred: 0, latestCorrected: 4 },
        artists: { corrected: 2, deferred: 0, latestCorrected: 1 },
        next: null,
        ok: true,
        tookMs: 20,
      },
    ];
    const summary = await runReconcileHubCountsTick(
      deps({ reconcile: () => Promise.resolve(responses.shift()) }),
    );

    expect(summary.corrected).toBe(3);
    expect(summary.latestCorrected).toBe(8);
    expect(summary.produced).toBe(11);
  });

  test("logs the AUDIT line on a CLEAN tick too — zeroes are the evidence of health", async () => {
    const { deps: capturingDeps, lines } = capturing(CLEAN);

    await runReconcileHubCountsTick(capturingDeps);

    expect(lines).toContain("AUDIT corrected=0 labels=0 albums=0 artists=0 tookMs=820");
  });

  test("reports ok:false (never throws) when the op does not ack", async () => {
    const summary = await runReconcileHubCountsTick(
      deps({ reconcile: () => Promise.resolve({ labels: { corrected: 1 } }) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("did not ack");
    expect(summary.corrected).toBeNull();
    expect(summary).toMatchObject({ checked: 0, errors: 1, produced: null });
  });

  test("reports ok:false with the error message when the reconcile call throws", async () => {
    const summary = await runReconcileHubCountsTick(
      deps({ reconcile: () => Promise.reject(new Error("reconcile 500")) }),
    );

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("reconcile 500");
    expect(summary.labels).toBeNull();
    expect(summary.corrected).toBeNull();
    expect(summary).toMatchObject({ checked: 0, errors: 1, produced: null });
  });

  test("tolerates a table the op omitted — that table is null, the total is null, tick still ok", async () => {
    const summary = await runReconcileHubCountsTick(
      deps({
        reconcile: () =>
          Promise.resolve({ albums: { corrected: 3 }, labels: { corrected: 1 }, ok: true }),
      }),
    );

    expect(summary.ok).toBe(true);
    expect(summary.labels).toBe(1);
    expect(summary.albums).toBe(3);
    expect(summary.artists).toBeNull();

    expect(summary.corrected).toBeNull();
    expect(summary).toMatchObject({ checked: 2, errors: 0, produced: null });
  });

  test("a partial read still logs an AUDIT line, with `?` for what it could not read", async () => {
    const { deps: capturingDeps, lines } = capturing({
      albums: { corrected: 3 },
      labels: { corrected: 1 },
      ok: true,
    });

    await runReconcileHubCountsTick(capturingDeps);

    expect(lines).toContain("AUDIT corrected=? labels=1 albums=3 artists=? tookMs=?");
  });

  test("BLINDNESS: an ack with no table results is checked:0 and a run failure", async () => {
    const summary = await runReconcileHubCountsTick(
      deps({ reconcile: () => Promise.resolve({ ok: true }) }),
    );

    expect(summary).toMatchObject({
      checked: 0,
      corrected: null,
      errors: 1,
      ok: false,
      produced: null,
    });
    expect(summary.error).toContain("inspected no tables");
  });
});

const ZERO = { corrected: 0, deferred: 0 };

function scripted(responses: Array<ReconcileHubCountsResponse | undefined>): {
  cursors: Array<ReconcileCursor | null>;
  lines: string[];
  deps: ReconcileHubCountsDeps;
} {
  const cursors: Array<ReconcileCursor | null> = [];
  const lines: string[] = [];
  let call = 0;

  return {
    cursors,
    deps: {
      log: (message) => lines.push(message),
      reconcile: (cursor) => {
        cursors.push(cursor);
        const response = responses[call];
        call += 1;
        return Promise.resolve(response);
      },
    },
    lines,
  };
}

describe("runReconcileHubCountsTick — windows", () => {
  test("hands each window the previous `next` and accumulates only the tables it reached", async () => {
    const run = scripted([
      {
        albums: ZERO,
        artists: ZERO,
        labels: { corrected: 1, deferred: 0 },
        next: { afterId: "lbl_b", table: "labels" },
        ok: true,
        pages: 8,
        tookMs: 100,
      },
      {
        albums: { corrected: 3, deferred: 1 },
        artists: ZERO,
        labels: { corrected: 2, deferred: 0 },
        next: { afterId: null, table: "artists" },
        ok: true,
        pages: 8,
        tookMs: 50,
      },
      {
        albums: ZERO,
        artists: { corrected: 4, deferred: 0 },
        labels: ZERO,
        next: null,
        ok: true,
        pages: 3,
        tookMs: 25,
      },
    ]);

    const summary = await runReconcileHubCountsTick(run.deps);

    expect(run.cursors).toEqual([
      null,
      { afterId: "lbl_b", table: "labels" },
      { afterId: null, table: "artists" },
    ]);
    expect(summary).toMatchObject({
      albums: 3,
      artists: 4,
      checked: 3,
      corrected: 10,
      deferred: 1,
      errors: 0,
      labels: 3,
      ok: true,
      partial: false,
      produced: 10,
      tookMs: 175,
      windows: 3,
    });
    expect(run.lines).toContain(
      "AUDIT corrected=10 labels=3 albums=3 artists=4 tookMs=175 deferred=1",
    );
  });

  test("a yielded window pauses the run and keeps the corrections that already landed", async () => {
    const run = scripted([
      {
        albums: ZERO,
        artists: ZERO,
        labels: { corrected: 2, deferred: 0 },
        next: { afterId: "lbl_b", table: "labels" },
        ok: true,
        tookMs: 40,
      },
      undefined,
    ]);

    const summary = await runReconcileHubCountsTick(run.deps);

    expect(summary).toMatchObject({
      admissionOutcome: "phase-yielded",
      albums: null,
      artists: null,
      checked: 0,
      corrected: null,
      errors: 0,
      gateState: "paused",
      labels: 2,
      ok: true,
      partial: true,
      produced: 2,
      reason: "database_admission",
      throttled: true,
      windows: 1,
    });
    expect(run.lines).toContain(
      "AUDIT corrected=? labels=2 albums=? artists=? tookMs=40 deferred=0 partial=database_admission",
    );
  });

  test("a first window that yields proves nothing and writes no audit line", async () => {
    const run = scripted([undefined]);

    const summary = await runReconcileHubCountsTick(run.deps);

    expect(summary).toMatchObject({
      checked: 0,
      errors: 0,
      gateState: "paused",
      ok: true,
      partial: true,
      produced: 0,
      windows: 0,
    });
    expect(run.lines.some((line) => line.startsWith("AUDIT "))).toBe(false);
  });

  test("counts a table as checked only once the cursor has moved past it", async () => {
    const run = scripted([
      {
        albums: { corrected: 1, deferred: 0 },
        artists: ZERO,
        labels: { corrected: 1, deferred: 0 },
        next: { afterId: "alb_c", table: "albums" },
        ok: true,
      },
      undefined,
    ]);

    const summary = await runReconcileHubCountsTick(run.deps);

    expect(summary).toMatchObject({ albums: 1, checked: 1, labels: 1, produced: 2 });
  });

  test("fails a cursor that does not advance instead of looping on it", async () => {
    const stuck: ReconcileHubCountsResponse = {
      albums: ZERO,
      artists: ZERO,
      labels: ZERO,
      next: { afterId: "lbl_b", table: "labels" },
      ok: true,
    };
    const run = scripted([stuck, stuck]);

    const summary = await runReconcileHubCountsTick(run.deps);

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("did not advance");
    expect(summary.errors).toBe(1);
  });

  test("fails a window that omits a table its cursor range covers", async () => {
    const run = scripted([{ next: { afterId: "lbl_b", table: "labels" }, ok: true }]);

    const summary = await runReconcileHubCountsTick(run.deps);

    expect(summary.ok).toBe(false);
    expect(summary.error).toContain("omitted labels");
  });

  test("stops starting windows past the wall budget and reports the stop", async () => {
    let clock = 0;
    const run = scripted([
      {
        albums: ZERO,
        artists: ZERO,
        labels: { corrected: 1, deferred: 0 },
        next: { afterId: "lbl_b", table: "labels" },
        ok: true,
      },
    ]);

    const summary = await runReconcileHubCountsTick({
      ...run.deps,
      now: () => clock,
      reconcile: (cursor) => {
        clock += WINDOW_START_BUDGET_MS;
        return run.deps.reconcile(cursor);
      },
    });

    expect(run.cursors).toHaveLength(1);
    expect(summary).toMatchObject({
      corrected: null,
      ok: true,
      partial: true,
      produced: 1,
      reason: "wall_budget",
    });
    expect(run.lines).toContain(
      "AUDIT corrected=? labels=1 albums=? artists=? tookMs=? deferred=0 partial=wall_budget",
    );
  });

  test("never starts more than MAX_WINDOWS windows", async () => {
    let calls = 0;

    const summary = await runReconcileHubCountsTick({
      log: () => {},
      reconcile: () => {
        calls += 1;
        return Promise.resolve({
          albums: ZERO,
          artists: ZERO,
          labels: ZERO,
          next: { afterId: `lbl_${String(calls).padStart(4, "0")}`, table: "labels" },
          ok: true,
        });
      },
    });

    expect(calls).toBe(MAX_WINDOWS);
    expect(summary).toMatchObject({ ok: true, partial: true, reason: "window_budget" });
  });
});

describe("window wire helpers", () => {
  test("the first window sends only the page limit; later windows send the cursor too", () => {
    expect(windowBody(null)).toEqual({ pageLimit: WINDOW_PAGE_LIMIT });
    expect(windowBody({ afterId: "art_9", table: "artists" })).toEqual({
      cursor: { afterId: "art_9", table: "artists" },
      pageLimit: WINDOW_PAGE_LIMIT,
    });
  });

  test("a window stays inside the op's page-limit bound", () => {
    expect(WINDOW_PAGE_LIMIT).toBeGreaterThanOrEqual(1);
    expect(WINDOW_PAGE_LIMIT).toBeLessThanOrEqual(20);
  });

  test("parses a window envelope and surfaces a child's failure message", () => {
    expect(parseWindowEnvelope(`{"kind":"window","response":{"ok":true,"next":null}}\n`)).toEqual({
      next: null,
      ok: true,
    });
    expect(() => parseWindowEnvelope(`{"kind":"failed","error":"reconcile 503"}`)).toThrow(
      "reconcile 503",
    );
    expect(() => parseWindowEnvelope("not json")).toThrow("invalid envelope");
    expect(() => parseWindowEnvelope(`{"kind":"window"}`)).toThrow("invalid envelope");
  });

  test("accepts only cursors on the three tables with a non-empty or null afterId", () => {
    expect(parseReconcileCursor(null)).toBeNull();
    expect(parseReconcileCursor({ afterId: null, table: "albums" })).toEqual({
      afterId: null,
      table: "albums",
    });
    expect(() => parseReconcileCursor({ afterId: "x", table: "tracks" })).toThrow("invalid cursor");
    expect(() => parseReconcileCursor({ afterId: "", table: "labels" })).toThrow("invalid cursor");
    expect(() => parseReconcileCursor("labels")).toThrow("invalid cursor");
  });
});

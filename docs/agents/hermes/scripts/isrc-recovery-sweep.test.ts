import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEEZER_BLIND_MIN_SEARCHED,
  DEEZER_QUOTA_ABORT_STREAK,
  inProcessWindows,
  ISRC_RECOVERY_EXPECTED_INTERVAL_MS,
  ISRC_RECOVERY_PACE_MS,
  ISRC_RECOVERY_WALL_BUDGET_MS,
  type IsrcRecoveryWindows,
  runIsrcRecoveryCli,
  runIsrcRecoverySweep,
  searchDeezerCandidates,
  SETTLE_WINDOW_ROWS,
  type RuntimeEffects,
} from "./isrc-recovery-sweep";

const HIT = {
  artist: { name: "Calibre" },
  duration: 132,
  id: 123,
  isrc: "GBEXH1900314",
  title: "Mr Right On",
};

type FetchCall = { body?: string; method: string; url: string };

function requestBody(init?: RequestInit): string {
  return typeof init?.body === "string" ? init.body : "{}";
}

function recordingWindows(
  base: IsrcRecoveryWindows,
  timeline: string[],
  overrides: Partial<IsrcRecoveryWindows> = {},
): IsrcRecoveryWindows {
  return {
    readQueue: async (limit) => {
      timeline.push("claim:open");
      try {
        return await (overrides.readQueue ?? base.readQueue)(limit);
      } finally {
        timeline.push("claim:close");
      }
    },
    settle: async (items) => {
      timeline.push("settle:open");
      try {
        return await (overrides.settle ?? base.settle)(items);
      } finally {
        timeline.push("settle:close");
      }
    },
  };
}

function effects(
  request: (url: string, init?: RequestInit) => Promise<Response>,
  options: { batch?: string; windows?: Partial<IsrcRecoveryWindows> } = {},
): {
  calls: FetchCall[];
  effects: RuntimeEffects;
  logs: string[];
  output: string[];
  sleeps: number[];
  timeline: string[];
  windows: IsrcRecoveryWindows;
} {
  const calls: FetchCall[] = [];
  const logs: string[] = [];
  const output: string[] = [];
  const sleeps: number[] = [];
  const timeline: string[] = [];

  const runtime: RuntimeEffects = {
    env: {
      FLUNCLE_API_BASE_URL: "https://worker.example",
      FLUNCLE_API_TOKEN: "agent-token",
      ...(options.batch ? { FLUNCLE_ISRC_RECOVERY_BATCH: options.batch } : {}),
    },
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
        method: init?.method ?? "GET",
        url,
      });
      if (url.includes("api.deezer.com")) {
        timeline.push("deezer");
      }
      return request(url, init);
    }) as typeof fetch,
    log: (message) => logs.push(message),
    output: (line) => output.push(line),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };

  const base = inProcessWindows(runtime);

  runtime.windows = recordingWindows(base, timeline, options.windows);

  return { calls, effects: runtime, logs, output, sleeps, timeline, windows: base };
}

function queue(rows: { deezerQuery: string; trackId: string }[], queued = rows.length): Response {
  return Response.json({ queued, tracks: rows });
}

describe("isrc-recovery sweep", () => {
  test("recovers through resolve_anchor with the server query and spotifySearch false", async () => {
    const harness = effects((url, init) => {
      if (url.includes("/tracks/work?")) {
        return Promise.resolve(
          queue(
            [
              { deezerQuery: "Calibre Mr Right On", trackId: "mb_recover" },
              { deezerQuery: "A B", trackId: "mb_empty" },
            ],
            10,
          ),
        );
      }
      if (url.includes("api.deezer.com") && url.includes("Calibre")) {
        return Promise.resolve(Response.json({ data: [HIT] }));
      }
      if (url.includes("api.deezer.com")) {
        return Promise.resolve(Response.json({ data: [] }));
      }
      if (url.endsWith("/api/v1/admin/catalogue/anchor/resolve")) {
        const body = JSON.parse(requestBody(init)) as { deezerCandidates?: unknown[] };
        return Promise.resolve(
          Response.json({ isrcRecoveredByDeezer: (body.deezerCandidates?.length ?? 0) > 0 }),
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const result = await runIsrcRecoveryCli([], harness.effects);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toMatchObject({
      checked: 2,
      deezerEmpty: 1,
      errors: 0,
      produced: 1,
      queueDepth: 8,
      recovered: 1,
    });

    const deezerCall = harness.calls.find((call) => call.url.includes("api.deezer.com"));
    expect(decodeURIComponent(deezerCall?.url ?? "")).toContain("q=Calibre Mr Right On&limit=5");

    const resolveCalls = harness.calls.filter((call) => call.url.endsWith("/anchor/resolve"));
    expect(resolveCalls.length).toBe(2);
    expect(JSON.parse(resolveCalls[0]?.body ?? "{}")).toEqual({
      deezerCandidates: [
        {
          artistName: "Calibre",
          deezerTrackId: "123",
          durationMs: 132_000,
          isrc: "GBEXH1900314",
          title: "Mr Right On",
        },
      ],
      spotifySearch: false,
      trackId: "mb_recover",
    });
    expect(harness.calls.some((call) => call.url.endsWith("/admin/catalogue/anchor"))).toBe(false);
    expect(harness.sleeps).toEqual([ISRC_RECOVERY_PACE_MS]);
    expect(harness.output.length).toBe(1);
    expect(JSON.parse(harness.output[0] ?? "{}")).toEqual(result.summary);
  });

  test("separates gate refusals, genuine empty results, and failed error bodies", async () => {
    const harness = effects((url, init) => {
      if (url.includes("/tracks/work?")) {
        return Promise.resolve(
          queue(
            [
              { deezerQuery: "candidate", trackId: "mb_refused" },
              { deezerQuery: "empty-data", trackId: "mb_empty_data" },
              { deezerQuery: "incomplete", trackId: "mb_incomplete" },
              { deezerQuery: "empty-code", trackId: "mb_empty_code" },
            ],
            7,
          ),
        );
      }
      if (url.includes("api.deezer.com") && url.includes("candidate")) {
        return Promise.resolve(Response.json({ data: [HIT] }));
      }
      if (url.includes("api.deezer.com") && url.includes("empty-code")) {
        return Promise.resolve(Response.json({ error: { code: 800, message: "no data" } }));
      }
      if (url.includes("api.deezer.com") && url.includes("incomplete")) {
        return Promise.resolve(Response.json({ data: [{ ...HIT, isrc: "" }] }));
      }
      if (url.includes("api.deezer.com")) {
        return Promise.resolve(Response.json({ data: [] }));
      }
      if (url.endsWith("/anchor/resolve")) {
        const body = JSON.parse(requestBody(init)) as {
          deezerCandidates?: unknown[];
          trackId?: string;
        };
        expect(Array.isArray(body.deezerCandidates)).toBe(true);
        return Promise.resolve(
          Response.json({
            anchored: body.trackId === "mb_empty_data",
            isrcRecoveredByDeezer: false,
          }),
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const { summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(summary).toMatchObject({
      checked: 4,
      deezerEmpty: 1,
      deezerHitsDroppedIncomplete: 1,
      errors: 0,
      failed: 1,
      gateRefused: 1,
      produced: 0,
      queueDepth: 4,
      recovered: 0,
      transportFailed: 1,
    });
  });

  test("retries explicit quota bodies and aborts the remainder after the quota streak", async () => {
    let deezerCalls = 0;
    const rows = Array.from({ length: 5 }, (_, index) => ({
      deezerQuery: `q-${index}`,
      trackId: `mb_${index}`,
    }));
    const harness = effects((url) => {
      if (url.includes("/tracks/work?")) {
        return Promise.resolve(queue(rows, 20));
      }
      if (url.includes("api.deezer.com")) {
        deezerCalls += 1;
        return Promise.resolve(
          Response.json({ error: { code: 4, message: "Quota limit exceeded" } }),
        );
      }
      return Promise.resolve(new Response("resolve must not run", { status: 500 }));
    });

    const { summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(DEEZER_QUOTA_ABORT_STREAK).toBe(3);
    expect(deezerCalls).toBe(9);
    expect(summary).toMatchObject({
      checked: 3,
      deezerEmpty: 0,
      errors: 0,
      gateRefused: 0,
      produced: 0,
      queueDepth: 20,
      quotaBlocked: 5,
      recovered: 0,
      transportFailed: 0,
    });
    expect(harness.calls.some((call) => call.url.endsWith("/anchor/resolve"))).toBe(false);
    expect(harness.sleeps.filter((ms) => ms === ISRC_RECOVERY_PACE_MS).length).toBe(2);
    expect(harness.sleeps.filter((ms) => ms === 1_200).length).toBe(3);
    expect(harness.sleeps.filter((ms) => ms === 2_500).length).toBe(3);
    expect(harness.logs.some((line) => line.includes("aborting after 3"))).toBe(true);
  });

  test("counts Deezer and resolve transport failures without collapsing them into empty", async () => {
    const harness = effects((url) => {
      if (url.includes("/tracks/work?")) {
        return Promise.resolve(
          queue([
            { deezerQuery: "network", trackId: "mb_network" },
            { deezerQuery: "resolve", trackId: "mb_resolve" },
          ]),
        );
      }
      if (url.includes("api.deezer.com") && url.includes("network")) {
        return Promise.reject(new Error("socket closed"));
      }
      if (url.includes("api.deezer.com")) {
        return Promise.resolve(Response.json({ data: [HIT] }));
      }
      if (url.endsWith("/anchor/resolve")) {
        return Promise.resolve(new Response("worker unavailable", { status: 503 }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const { summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(summary).toMatchObject({
      checked: 2,
      deezerEmpty: 0,
      errors: 0,
      failed: 2,
      gateRefused: 0,
      queueDepth: 2,
      recovered: 0,
      transportFailed: 2,
    });
    const resolveCalls = harness.calls.filter((call) => call.url.endsWith("/anchor/resolve"));
    expect(resolveCalls).toHaveLength(1);
    expect(JSON.parse(resolveCalls[0]?.body ?? "{}").trackId).toBe("mb_resolve");
  });

  test("caps candidates at five before resolve_anchor", async () => {
    const harness = effects((url, init) => {
      if (url.includes("/tracks/work?")) {
        return Promise.resolve(queue([{ deezerQuery: "many", trackId: "mb_many" }]));
      }
      if (url.includes("api.deezer.com")) {
        return Promise.resolve(
          Response.json({
            data: Array.from({ length: 6 }, (_, index) => ({
              ...HIT,
              id: index,
              isrc: `GBEXH190031${index}`,
            })),
          }),
        );
      }
      if (url.endsWith("/anchor/resolve")) {
        const body = JSON.parse(requestBody(init)) as { deezerCandidates?: unknown[] };
        expect(body.deezerCandidates?.length).toBe(5);
        return Promise.resolve(Response.json({ isrcRecoveredByDeezer: false }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const { summary } = await runIsrcRecoveryCli([], harness.effects);
    expect(summary.gateRefused).toBe(1);
  });

  test("emits numeric run-ledger fields and honors the batch env", async () => {
    const harness = effects(
      (url) => {
        if (url.includes("/tracks/work?")) {
          return Promise.resolve(queue([], 12));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      },
      { batch: "77" },
    );

    const { summary } = await runIsrcRecoveryCli([], harness.effects);
    const queueCall = harness.calls.find((call) => call.url.includes("/tracks/work?"));

    expect(queueCall?.url).toContain("kind=isrc-recovery&limit=77&count=true");
    expect(summary.expectedIntervalMs).toBe(ISRC_RECOVERY_EXPECTED_INTERVAL_MS);
    for (const field of ["checked", "errors", "expectedIntervalMs", "produced", "queueDepth"]) {
      expect(typeof summary[field as keyof typeof summary]).toBe("number");
    }
    expect(harness.output.length).toBe(1);
  });
});

describe("isrc-recovery due-work repair pause", () => {
  test("the typed 503 pauses the tick with no search, no resolve, and exit 0", async () => {
    const harness = effects((url) => {
      if (url.includes("/tracks/work?")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: "due_work_maintenance_pending",
              message: "Due-work maintenance is still converging",
              ok: false,
            }),
            { status: 503 },
          ),
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    const { exitCode, summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(exitCode).toBe(0);
    expect(harness.calls).toHaveLength(1);
    expect(summary).toMatchObject({
      checked: 0,
      errors: 0,
      gateState: "paused",
      ok: true,
      partial: false,
      produced: 0,
      reason: "due_work_repair_pending",
      throttled: true,
    });
    expect(JSON.parse(harness.output[0] ?? "{}")).toMatchObject({ gateState: "paused", ok: true });
  });

  const blindHarness = (rows: number, recoveries: number) => {
    const work = Array.from({ length: rows }, (_, index) => ({
      deezerQuery: `artist ${index}`,
      trackId: `mb_${index}`,
    }));
    const recovering = new Set(work.slice(0, recoveries).map((row) => row.trackId));

    return effects((url, init) => {
      if (url.includes("/tracks/work?")) {
        return Promise.resolve(queue(work, rows));
      }
      if (url.includes("api.deezer.com")) {
        const index = Number(decodeURIComponent(url).match(/artist (\d+)/)?.[1] ?? -1);
        return Promise.resolve(Response.json({ data: index < recoveries ? [HIT] : [] }));
      }
      if (url.endsWith("/api/v1/admin/catalogue/anchor/resolve")) {
        const body = JSON.parse(requestBody(init)) as { trackId?: string };
        return Promise.resolve(
          Response.json({ isrcRecoveredByDeezer: recovering.has(body.trackId ?? "") }),
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });
  };

  test("fails the tick when Deezer answers empty for every searched row", async () => {
    const harness = blindHarness(DEEZER_BLIND_MIN_SEARCHED, 0);

    const { exitCode, summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(exitCode).toBe(1);
    expect(summary).toMatchObject({
      checked: DEEZER_BLIND_MIN_SEARCHED,
      deezerEmpty: DEEZER_BLIND_MIN_SEARCHED,
      ok: false,
      reason: "deezer_blind",
      recovered: 0,
    });
  });

  test("stays healthy when real signal reaches the same counters", async () => {
    const harness = blindHarness(DEEZER_BLIND_MIN_SEARCHED, 3);

    const { exitCode, summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(exitCode).toBe(0);
    expect(summary).toMatchObject({ ok: true, reason: null, recovered: 3 });
  });

  test("a tick that settles only part of its batch still reports what it judged", async () => {
    const searched = DEEZER_BLIND_MIN_SEARCHED * 2;
    const harness = blindHarness(searched, 0);
    const inner = harness.windows;
    let windows = 0;

    harness.effects.windows = {
      readQueue: (limit) => inner.readQueue(limit),
      settle: (items) => {
        windows += 1;
        return windows > 3 ? Promise.resolve(undefined) : inner.settle(items);
      },
    };

    const { exitCode, summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(summary).toMatchObject({
      deezerEmpty: SETTLE_WINDOW_ROWS * 3,
      ok: false,
      reason: "deezer_blind",
    });
    expect(exitCode).toBe(1);
  });

  test("a partial tick below the sample floor stays quiet — the floor, not a deflated ratio", async () => {
    const harness = blindHarness(DEEZER_BLIND_MIN_SEARCHED * 2, 0);
    const inner = harness.windows;
    let windows = 0;
    harness.effects.windows = {
      readQueue: (limit) => inner.readQueue(limit),
      settle: (items) => {
        windows += 1;
        return windows > 1 ? Promise.resolve(undefined) : inner.settle(items);
      },
    };

    const { exitCode, summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(summary).toMatchObject({ gateState: "paused", ok: true, reason: "database_admission" });
    expect(exitCode).toBe(0);
  });

  test("does not trip on a short tick — the sample floor is what makes the rate evidence", async () => {
    const harness = blindHarness(DEEZER_BLIND_MIN_SEARCHED - 1, 0);

    const { exitCode, summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(exitCode).toBe(0);
    expect(summary).toMatchObject({ ok: true, reason: null });
  });

  test("a generic Worker 500 on the queue read stays a failed run", async () => {
    const harness = effects(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: "error", message: "Internal error", ok: false }), {
          status: 500,
        }),
      ),
    );

    const { exitCode, summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(exitCode).toBe(1);
    expect(summary).toMatchObject({ errors: 1, ok: false });
    expect(summary.gateState).toBeUndefined();
  });
});

describe("searchDeezerCandidates", () => {
  test("treats non-quota error bodies and malformed result bodies as transport failures", async () => {
    for (const response of [
      Response.json({ error: { code: 123 } }),
      Response.json({ error: { code: 800 } }),
      Response.json({ nope: [] }),
      new Response("bad json"),
      new Response("down", { status: 503 }),
    ]) {
      const result = await searchDeezerCandidates(
        "q",
        {
          fetch: (() => Promise.resolve(response)) as typeof fetch,
          sleep: () => Promise.resolve(),
        },
        [],
      );
      expect(result.outcome).toBe("transport-failed");
    }
  });
});

const workRows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    deezerQuery: `artist ${index}`,
    trackId: `mb_${index}`,
  }));

function phasedHarness(rows: number, options: { windows?: Partial<IsrcRecoveryWindows> } = {}) {
  const work = workRows(rows);

  return effects((url, init) => {
    if (url.includes("/tracks/work?")) {
      return Promise.resolve(queue(work, rows));
    }
    if (url.includes("api.deezer.com")) {
      return Promise.resolve(Response.json({ data: [HIT] }));
    }
    if (url.endsWith("/api/v1/admin/catalogue/anchor/resolve")) {
      const body = JSON.parse(requestBody(init)) as { trackId?: string };
      return Promise.resolve(Response.json({ isrcRecoveredByDeezer: body.trackId === "mb_0" }));
    }
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  }, options);
}

describe("isrc-recovery phase boundaries", () => {
  test("every Deezer search falls between windows, never inside one", async () => {
    const harness = phasedHarness(3);

    const { exitCode } = await runIsrcRecoveryCli([], harness.effects);

    expect(exitCode).toBe(0);

    expect(harness.timeline).toEqual([
      "claim:open",
      "claim:close",
      "deezer",
      "deezer",
      "deezer",
      "settle:open",
      "settle:close",
    ]);

    let open = 0;
    for (const event of harness.timeline) {
      if (event.endsWith(":open")) {
        open += 1;
      } else if (event.endsWith(":close")) {
        open -= 1;
      } else {
        expect(open, "a Deezer search ran while a database lease was held").toBe(0);
      }
    }
  });

  test("the settle runs in bounded windows, each one its own acquisition", async () => {
    const harness = phasedHarness(SETTLE_WINDOW_ROWS * 2 + 1);
    const inner = harness.windows;
    const widths: number[] = [];
    harness.effects.windows = {
      readQueue: (limit) => inner.readQueue(limit),
      settle: (items) => {
        widths.push(items.length);
        return inner.settle(items);
      },
    };

    const { summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(widths).toEqual([SETTLE_WINDOW_ROWS, SETTLE_WINDOW_ROWS, 1]);
    expect(summary).toMatchObject({
      checked: SETTLE_WINDOW_ROWS * 2 + 1,
      recovered: 1,
      unsettled: 0,
    });
  });

  test("a window that defers its tail hands those rows to the NEXT window, not to this lease", async () => {
    const harness = phasedHarness(4);
    const inner = harness.windows;
    let windows = 0;
    harness.effects.windows = {
      readQueue: (limit) => inner.readQueue(limit),
      settle: async (items) => {
        windows += 1;

        const scoped = windows === 1 ? items.slice(0, 1) : items;
        const settled = await inner.settle(scoped);

        if (!settled) {
          return undefined;
        }

        return {
          ...settled,
          deferred: windows === 1 ? items.slice(1).map((item) => item.trackId) : settled.deferred,
        };
      },
    };

    const { exitCode, summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(exitCode).toBe(0);
    expect(windows).toBe(2);
    expect(summary).toMatchObject({ checked: 4, recovered: 1, unsettled: 0 });

    expect(summary.queueDepth).toBe(0);
  });
});

describe("isrc-recovery window yields", () => {
  test("a yielded settle window leaves its rows eligible and reports paused backpressure", async () => {
    const harness = phasedHarness(3, { windows: { settle: () => Promise.resolve(undefined) } });

    const { exitCode, summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(exitCode).toBe(0);
    expect(summary).toMatchObject({
      admissionOutcome: "phase-yielded",
      checked: 3,
      errors: 0,
      gateState: "paused",
      ok: true,
      partial: true,
      produced: 0,
      reason: "database_admission",
      recovered: 0,
      throttled: true,
      unsettled: 3,
    });

    expect(summary.queueDepth).toBe(3);
    expect(harness.calls.some((call) => call.url.endsWith("/anchor/resolve"))).toBe(false);
    expect(JSON.parse(harness.output[0] ?? "{}")).toEqual(summary);
  });

  test("a yielded CLAIM window ends the tick before a single search is spent", async () => {
    const harness = phasedHarness(3, { windows: { readQueue: () => Promise.resolve(undefined) } });

    const { exitCode, summary } = await runIsrcRecoveryCli([], harness.effects);

    expect(exitCode).toBe(0);
    expect(summary).toMatchObject({
      admissionOutcome: "phase-yielded",
      checked: 0,
      gateState: "paused",
      ok: true,
      partial: false,
      queueDepth: null,
      reason: "database_admission",
      throttled: true,
    });
    expect(harness.calls.some((call) => call.url.includes("api.deezer.com"))).toBe(false);
  });

  test("the wall budget stops the settle and leaves the remainder eligible", async () => {
    const harness = phasedHarness(3);
    let clock = 0;

    const summary = await runIsrcRecoverySweep(100, {
      log: () => undefined,

      now: () => {
        clock += ISRC_RECOVERY_WALL_BUDGET_MS;
        return clock;
      },
      searchDeezer: () =>
        Promise.resolve({ candidates: [], droppedIncomplete: 0, outcome: "ok" as const }),
      sleep: () => Promise.resolve(),
      windows: harness.effects.windows ?? harness.windows,
    });

    expect(summary).toMatchObject({
      checked: 3,
      ok: true,
      partial: true,
      queueDepth: 3,
      reason: "wall_budget",
      unsettled: 3,
    });
  });
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function admissionRunner(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "isrc-recovery-phase-"));
  temporaryDirectories.push(directory);
  const runner = join(directory, "runner");

  writeFileSync(runner, `#!/usr/bin/env bash\nset -uo pipefail\n${body}\n`, "utf8");
  chmodSync(runner, 0o755);

  return runner;
}

function stubWorker(options: { paths: string[]; timeline?: string }) {
  return Bun.serve({
    fetch(request) {
      const url = new URL(request.url);
      options.paths.push(url.pathname);

      if (url.pathname === "/search/track") {
        if (options.timeline) {
          appendFileSync(options.timeline, "deezer\n");
        }
        return Response.json({ data: [HIT] });
      }
      if (url.pathname === "/api/v1/admin/tracks/work") {
        return Response.json({ queued: 2, tracks: workRows(2) });
      }
      return Response.json({ isrcRecoveredByDeezer: true });
    },
    port: 0,
  });
}

async function spawnSweep(
  runner: string,
  origin: string,
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "isrc-recovery-sweep.ts")], {
    env: {
      ...process.env,
      DATABASE_ADMISSION_RUNNER: runner,
      FLUNCLE_ADMISSION_RUNNER_PID: "",
      FLUNCLE_API_BASE_URL: origin,
      FLUNCLE_API_TOKEN: "fixture-token",
      FLUNCLE_DEEZER_API_BASE_URL: origin,
      FLUNCLE_ISRC_RECOVERY_BATCH: "2",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;

  return { exitCode, stderr, stdout };
}

describe("isrc-recovery out-of-process admission", () => {
  test("the runner is entered for the claim and the settle, and for nothing in between", async () => {
    const directory = mkdtempSync(join(tmpdir(), "isrc-recovery-timeline-"));
    temporaryDirectories.push(directory);
    const timeline = join(directory, "timeline");
    writeFileSync(timeline, "", "utf8");
    const runner = admissionRunner(`shift 2
if [ "\${1:-}" = "--" ]; then shift; fi
case " $* " in
  *" --admission-phase claim "*) label=claim ;;
  *" --admission-phase settle "*) label=settle ;;
  *) exit 2 ;;
esac
printf 'acquire %s\\n' "$label" >> "${timeline}"
"$@"
status="$?"
printf 'release\\n' >> "${timeline}"
exit "$status"`);
    const paths: string[] = [];
    const server = stubWorker({ paths, timeline });

    try {
      const result = await spawnSweep(runner, server.url.origin);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(readFileSync(timeline, "utf8").trim().split("\n")).toEqual([
        "acquire claim",
        "release",
        "deezer",
        "deezer",
        "acquire settle",
        "release",
      ]);

      expect([...new Set(paths)].sort((left, right) => left.localeCompare(right))).toEqual([
        "/api/v1/admin/catalogue/anchor/resolve",
        "/api/v1/admin/tracks/work",
        "/search/track",
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        checked: 2,
        ok: true,
        recovered: 2,
        unsettled: 0,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("exit 75 on the settle phase pauses the tick and writes no verdict", async () => {
    const runner = admissionRunner(`shift 2
if [ "\${1:-}" = "--" ]; then shift; fi
case " $* " in
  *" --admission-phase settle "*) exit 75 ;;
esac
"$@"`);
    const paths: string[] = [];
    const server = stubWorker({ paths });

    try {
      const result = await spawnSweep(runner, server.url.origin);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(paths.includes("/api/v1/admin/catalogue/anchor/resolve")).toBe(false);
      expect(JSON.parse(result.stdout)).toMatchObject({
        admissionOutcome: "phase-yielded",
        checked: 2,
        gateState: "paused",
        ok: true,
        produced: 0,
        queueDepth: 2,
        reason: "database_admission",
        throttled: true,
        unsettled: 2,
      });
    } finally {
      await server.stop(true);
    }
  });
});

describe("the standing constraint", () => {
  test("this sweep can reach Deezer and Fluncle, and no other host", () => {
    const source = readFileSync(join(import.meta.dir, "isrc-recovery-sweep.ts"), "utf8");
    const hosts = new Set(
      [...source.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1]),
    );

    expect([...hosts].sort((left, right) => String(left).localeCompare(String(right)))).toEqual([
      "api.deezer.com",
      "www.fluncle.com",
    ]);
  });
});

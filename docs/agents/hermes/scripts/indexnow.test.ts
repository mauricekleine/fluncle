import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexNowTick } from "./indexnow";

let fetchGuard: ReturnType<typeof spyOn>;
beforeEach(() => {
  fetchGuard = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
});
const temporaryDirectories: string[] = [];
afterEach(() => {
  fetchGuard.mockRestore();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});
function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fluncle-indexnow-"));
  temporaryDirectories.push(directory);
  return directory;
}
type Deps = Parameters<typeof runIndexNowTick>[0];
type Request = Parameters<Deps["request"]>[0];
const completeWalk = {
  changed: 2,
  checked: 250,
  inserted: 3,
  kind: "log" as const,
  next: null,
  ok: true as const,
  phase: "walk" as const,
  removed: 4,
};
const indexNow = {
  host: "example.com",
  key: "test-key",
  keyLocation: "https://example.com/key.txt",
};
function items(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    changedAt: "2026-10-05T00:00:00.000Z",
    fingerprint: `fingerprint-${index}`,
    kind: "track" as const,
    subjectId: `track-${index}`,
    url: `https://example.com/track/track-${index}`,
  }));
}
function fixture(count = 5, overrides: Partial<Deps> = {}) {
  const phases: Request[] = [];
  const calls: { body: unknown; endpoint: string }[] = [];
  const sleeps: number[] = [];
  const lines: string[] = [];
  let clock = Date.parse("2026-10-05T04:00:00Z");
  let due = count;
  const deps: Deps = {
    fetch: ((endpoint, init) => {
      if (typeof init?.body !== "string") {
        throw new Error("IndexNow request body must be JSON text");
      }
      const url =
        typeof endpoint === "string"
          ? endpoint
          : endpoint instanceof URL
            ? endpoint.href
            : endpoint.url;
      calls.push({ body: JSON.parse(init.body), endpoint: url });
      return Promise.resolve(new Response(null, { status: 202 }));
    }) as typeof fetch,
    log: (line) => lines.push(line),
    now: () => clock,
    request: (body) => {
      phases.push(body);
      if (body.phase === "walk") {
        return Promise.resolve(completeWalk);
      }
      if (body.phase === "claim") {
        return Promise.resolve({
          due,
          indexNow,
          items: items(Math.min(count, body.limit)),
          ok: true,
          phase: "claim",
        });
      }
      due -= body.versions.length;
      return Promise.resolve({ due, ok: true, phase: "ack", stamped: body.versions.length });
    },
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
      return Promise.resolve();
    },
    stateDirectory: stateDirectory(),
    ...overrides,
  };
  return {
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    calls,
    deps,
    lines,
    phases,
    sleeps,
  };
}
function statuses(
  values: (number | { status: number; retryAfter: string } | Error)[],
): typeof fetch {
  return (() => {
    const value = values.shift();
    if (value === undefined) {
      throw new Error("Unexpected vendor request");
    }
    if (value instanceof Error) {
      return Promise.reject(value);
    }
    return Promise.resolve(
      new Response(
        null,
        typeof value === "number"
          ? { status: value }
          : { headers: { "Retry-After": value.retryAfter }, status: value.status },
      ),
    );
  }) as unknown as typeof fetch;
}

describe("the daily IndexNow sweep", () => {
  test("posts paced batches on the box and acknowledges only their exact accepted versions", async () => {
    const f = fixture(2000);
    const summary = await runIndexNowTick(f.deps);
    expect(f.phases.map((body) => body.phase)).toEqual(["walk", "claim", "ack", "ack"]);
    expect(f.phases[1]).toEqual({ limit: 2_000, phase: "claim" });
    expect(f.calls.map((call) => (call.body as { urlList: string[] }).urlList.length)).toEqual([
      1000, 1000,
    ]);
    expect(f.calls[0]?.body).toEqual({ ...indexNow, urlList: items(1000).map((item) => item.url) });
    expect(f.calls.every((call) => call.endpoint === "https://api.indexnow.org/indexnow")).toBe(
      true,
    );
    expect(f.phases[2]).toEqual({
      phase: "ack",
      versions: items(1000).map(({ url: _url, ...version }) => version),
    });
    expect(f.sleeps).toEqual([5000]);
    expect(summary).toMatchObject({
      checked: 250,
      errors: 0,
      produced: 2000,
      queueDepth: 0,
      status: 202,
      submitted: 2000,
      vendorCalls: 2,
    });
    expect(f.lines).toEqual([
      "AUDIT checked=250 inserted=3 changed=2 removed=4 submitted=2000 due=0 status=202 errors=0 batches=2/2 vendorCalls=2",
    ]);
  });

  test("the claim limit bounds a tick to two thousand accepted URLs and a compact ledger summary", async () => {
    const f = fixture(12_000);
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({
      produced: 2_000,
      queueDepth: 10_000,
      submitted: 2_000,
      vendorCalls: 2,
    });
    expect(JSON.stringify(summary).length).toBeLessThan(4000);
  });

  test("a primary rate limit uses the participating fallback and acknowledges its accepted response", async () => {
    const f = fixture(5, { fetch: statuses([429, 202]) });
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({
      errors: 0,
      produced: 5,
      rateLimited: true,
      status: 202,
      submitted: 10,
      vendorCalls: 2,
    });
    expect(summary.batches).toEqual([
      { accepted: false, endpoint: "indexnow", size: 5, status: 429 },
      { accepted: true, endpoint: "yandex", size: 5, status: 202 },
    ]);
    expect(f.phases.at(-1)?.phase).toBe("ack");
  });

  test.each(["30", "Mon, 05 Oct 2026 04:00:30 GMT"])(
    "two rate limits honour primary Retry-After %s once",
    async (retryAfter) => {
      const f = fixture(5, { fetch: statuses([{ retryAfter, status: 429 }, 429, 200]) });
      const summary = await runIndexNowTick(f.deps);
      expect(f.sleeps).toEqual([30_000]);
      expect(summary).toMatchObject({
        errors: 0,
        produced: 5,
        retryAfterSecs: 30,
        status: 200,
        submitted: 15,
        vendorCalls: 3,
      });
      expect(summary.batches.map((batch) => batch.endpoint)).toEqual([
        "indexnow",
        "yandex",
        "indexnow",
      ]);
    },
  );

  test.each([undefined, "121", "invalid"])(
    "an unaccepted batch with Retry-After %s stops without an unbounded wait",
    async (retryAfter) => {
      const first = retryAfter === undefined ? 429 : { retryAfter, status: 429 };
      const f = fixture(2000, { fetch: statuses([first, 429]) });
      const summary = await runIndexNowTick(f.deps);
      expect(f.sleeps).toEqual([]);
      expect(summary).toMatchObject({
        errors: 1,
        ok: false,
        partial: true,
        produced: 0,
        queueDepth: 2000,
        reason: "rate_limited",
        vendorCalls: 2,
      });
      expect(f.phases.map((body) => body.phase)).toEqual(["walk", "claim"]);
    },
  );

  test("an exhausted bounded rate-limit retry stops after one primary retry", async () => {
    const f = fixture(2000, { fetch: statuses([{ retryAfter: "0", status: 429 }, 429, 429]) });
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({
      errors: 1,
      produced: 0,
      reason: "rate_limited",
      vendorCalls: 3,
    });
  });

  test("a rate limit after accepted work is a successful partial run and leaves the rest due", async () => {
    const f = fixture(3000, { fetch: statuses([202, 429, 429]) });
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({
      errors: 0,
      ok: true,
      partial: true,
      produced: 1000,
      queueDepth: 2000,
      reason: "rate_limited",
      submitted: 3000,
      vendorCalls: 3,
    });
    expect(f.phases.filter((body) => body.phase === "ack")).toHaveLength(1);
  });

  test.each([201, 400, 403, 422, 500])(
    "a primary HTTP %s rejection stops without acknowledging",
    async (status) => {
      const f = fixture(2000, { fetch: statuses([status]) });
      const summary = await runIndexNowTick(f.deps);
      expect(summary).toMatchObject({
        errors: 1,
        produced: 0,
        queueDepth: 2000,
        status,
        vendorCalls: 1,
      });
      expect(f.phases.map((body) => body.phase)).toEqual(["walk", "claim"]);
    },
  );

  test("a fallback rejection fails even when an earlier batch was accepted", async () => {
    const f = fixture(3000, { fetch: statuses([200, 429, 403]) });
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({
      errors: 1,
      ok: false,
      produced: 1000,
      queueDepth: 2000,
      status: 403,
    });
  });

  test.each([new Error("network unavailable"), new DOMException("timed out", "TimeoutError")])(
    "a vendor transport failure records an attempted batch without inventing its status",
    async (error) => {
      const f = fixture(5, { fetch: statuses([error]) });
      const summary = await runIndexNowTick(f.deps);
      expect(summary).toMatchObject({
        error: error.message,
        errors: 1,
        produced: 0,
        queueDepth: 5,
        status: null,
        submitted: 5,
        vendorCalls: 1,
      });
      expect(summary.batches).toEqual([
        { accepted: false, endpoint: "indexnow", size: 5, status: null },
      ]);
    },
  );

  test.each(["yield", "throw"])(
    "an accepted batch with an ack %s remains produced and stops further submission",
    async (failure) => {
      const f = fixture(2000);
      const request = f.deps.request;
      f.deps.request = (body) =>
        body.phase === "ack"
          ? failure === "yield"
            ? Promise.resolve(undefined)
            : Promise.reject(new Error("stamp failed"))
          : request(body);
      const summary = await runIndexNowTick(f.deps);
      expect(summary).toMatchObject({
        errors: 1,
        ok: false,
        produced: 1000,
        queueDepth: 2000,
        submitted: 1000,
        vendorCalls: 1,
      });
    },
  );

  test("no due URLs is a clean success without a vendor call", async () => {
    const f = fixture(0);
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({
      errors: 0,
      produced: 0,
      queueDepth: 0,
      submitted: 0,
      vendorCalls: 0,
    });
    expect(f.calls).toEqual([]);
  });

  test("the submit wall budget stops starting new batches after accepted work", async () => {
    const f = fixture(3000);
    const vendorFetch = f.deps.fetch;
    f.deps.fetch = ((endpoint, init) => {
      f.advance(300_000);
      if (vendorFetch === undefined) {
        throw new Error("Missing stub");
      }
      return vendorFetch(endpoint, init);
    }) as typeof fetch;
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({
      errors: 0,
      partial: true,
      produced: 1000,
      queueDepth: 2000,
      reason: "submit_budget",
      vendorCalls: 1,
    });
  });

  test("a completed walk is checkpointed and its recent retry reports claimed work without walking", async () => {
    const f = fixture(5);
    await runIndexNowTick(f.deps);
    expect(JSON.parse(readFileSync(join(f.deps.stateDirectory, "walk.json"), "utf8"))).toEqual({
      completedAt: "2026-10-05T04:00:00.000Z",
    });
    f.phases.length = 0;
    const summary = await runIndexNowTick(f.deps);
    expect(f.phases.map((body) => body.phase)).toEqual(["claim", "ack"]);
    expect(summary).toMatchObject({ checked: 5, errors: 0, walkSkipped: true, windows: 0 });
  });

  test.each(["missing", "corrupt", "invalid", "expired", "future"])(
    "a %s walk checkpoint requires a fresh observation pass",
    async (condition) => {
      const f = fixture(0);
      const values: Record<string, string> = {
        corrupt: "{",
        expired: JSON.stringify({ completedAt: "2026-10-04T16:00:00Z" }),
        future: JSON.stringify({ completedAt: "2026-10-06T04:00:00Z" }),
        invalid: JSON.stringify({ completedAt: "invalid" }),
      };
      const value = values[condition];
      if (value !== undefined) {
        writeFileSync(join(f.deps.stateDirectory, "walk.json"), value);
      }
      const summary = await runIndexNowTick(f.deps);
      expect(summary).toMatchObject({ walkSkipped: false, windows: 1 });
      expect(f.phases[0]?.phase).toBe("walk");
    },
  );

  test("a dry run claims and samples due URLs without sending, stamping, or checkpointing a completed walk", async () => {
    const f = fixture(10, { dryRun: true });
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({
      dryRun: true,
      gateState: "dry-run",
      produced: 0,
      sample: items(5).map((item) => item.url),
      submitted: 0,
      vendorCalls: 0,
      wouldSubmit: 10,
    });
    expect(f.phases.map((body) => body.phase)).toEqual(["walk", "claim"]);
    expect(existsSync(join(f.deps.stateDirectory, "walk.json"))).toBe(false);
    f.deps.dryRun = false;
    f.phases.length = 0;
    await runIndexNowTick(f.deps);
    expect(f.phases[0]?.phase).toBe("walk");
  });

  test("an unfinished walk retains its catalogue cursor and refreshes daily logs before resuming", async () => {
    const f = fixture(0);
    const original = f.deps.request;
    f.deps.request = (body) => {
      if (body.phase !== "walk") {
        return original(body);
      }
      f.advance(600_000);
      return Promise.resolve({
        ...completeWalk,
        kind: "artist",
        next: { after: "artist-b", kind: "artist" },
      });
    };
    const partial = await runIndexNowTick(f.deps);
    expect(partial).toMatchObject({ errors: 0, partial: true, reason: "wall_budget", windows: 1 });
    expect(existsSync(join(f.deps.stateDirectory, "walk.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.deps.stateDirectory, "cursor.json"), "utf8"))).toEqual({
      after: "artist-b",
      kind: "artist",
    });
    const cursors: unknown[] = [];
    f.deps.request = (body) => {
      if (body.phase !== "walk") {
        return original(body);
      }
      cursors.push(body.cursor ?? null);
      return Promise.resolve(
        cursors.length === 1 ? { ...completeWalk, next: { kind: "artist" } } : completeWalk,
      );
    };
    await runIndexNowTick(f.deps);
    expect(cursors).toEqual([null, { after: "artist-b", kind: "artist" }]);
    expect(existsSync(join(f.deps.stateDirectory, "cursor.json"))).toBe(false);
  });

  test("a yielded first walk is a failure while existing due work can still be accepted", async () => {
    const f = fixture(5);
    const request = f.deps.request;
    f.deps.request = (body) => (body.phase === "walk" ? Promise.resolve(undefined) : request(body));
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({
      errors: 1,
      ok: false,
      partial: true,
      produced: 5,
      reason: "database_admission",
      windows: 0,
    });
  });

  test("a claim admission yield fails without posting an invented worklist", async () => {
    const f = fixture(5);
    const request = f.deps.request;
    f.deps.request = (body) =>
      body.phase === "claim" ? Promise.resolve(undefined) : request(body);
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({
      errors: 1,
      produced: 0,
      queueDepth: null,
      reason: "database_admission",
      vendorCalls: 0,
    });
  });

  test("a stalled cursor fails while preserving the last admitted window", async () => {
    const f = fixture(0);
    const request = f.deps.request;
    f.deps.request = (body) =>
      body.phase === "walk"
        ? Promise.resolve({ ...completeWalk, next: { after: "log-b", kind: "log" } })
        : request(body);
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({ errors: 1, reason: "walk_failed", windows: 1 });
    expect(summary.error).toContain("did not advance");
  });

  test("the window cap bounds an unfinished catalogue walk and still claims once", async () => {
    const f = fixture(0);
    const request = f.deps.request;
    let windows = 0;
    f.deps.request = (body) => {
      if (body.phase !== "walk") {
        return request(body);
      }
      windows += 1;
      return Promise.resolve({
        ...completeWalk,
        next: { after: `log-${String(windows).padStart(4, "0")}`, kind: "log" },
      });
    };
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({
      checked: 500_000,
      errors: 0,
      partial: true,
      reason: "window_budget",
      windows: 2000,
    });
    expect(f.phases.map((body) => body.phase)).toEqual(["claim"]);
    expect(existsSync(join(f.deps.stateDirectory, "walk.json"))).toBe(false);
  });

  test("a yield after completed windows retains their counters and still claims", async () => {
    const f = fixture(0);
    const request = f.deps.request;
    let windows = 0;
    f.deps.request = (body) => {
      if (body.phase !== "walk") {
        return request(body);
      }
      windows += 1;
      return Promise.resolve(
        windows === 1 ? { ...completeWalk, next: { after: "log-b", kind: "log" } } : undefined,
      );
    };
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({
      changed: 2,
      checked: 250,
      errors: 0,
      inserted: 3,
      partial: true,
      reason: "database_admission",
      removed: 4,
      windows: 1,
    });
    expect(f.phases.map((body) => body.phase)).toEqual(["claim"]);
    expect(existsSync(join(f.deps.stateDirectory, "walk.json"))).toBe(false);
  });

  test("a log admission yield preserves a pending catalogue checkpoint", async () => {
    const f = fixture(0);
    const cursor = { after: "track-a", kind: "track" };
    writeFileSync(join(f.deps.stateDirectory, "cursor.json"), JSON.stringify(cursor));
    const request = f.deps.request;
    f.deps.request = (body) => (body.phase === "walk" ? Promise.resolve(undefined) : request(body));
    const summary = await runIndexNowTick(f.deps);
    expect(summary).toMatchObject({ errors: 1, reason: "database_admission", windows: 0 });
    expect(JSON.parse(readFileSync(join(f.deps.stateDirectory, "cursor.json"), "utf8"))).toEqual(
      cursor,
    );
    expect(existsSync(join(f.deps.stateDirectory, "walk.json"))).toBe(false);
  });
});

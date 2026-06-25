import { beforeEach, describe, expect, it, vi } from "vitest";

// The Worker-paced backfills' reliability gate: the per-finding cooldown/done state
// that makes the sweeps resumable and keeps them from re-storming a vendor API.
// The vendor clients (discogsResolveRelease / lastfmLove) and the DB are mocked so
// these tests isolate the gate/backoff logic and the per-source state writes.

const listTracks = vi.fn();
const discogsResolveRelease = vi.fn();
const lastfmLove = vi.fn();

// The mocked libSQL client: `execute({ sql, args })`. SELECTs return a reliability
// row from `reliabilityRows` (keyed by trackId); writes are captured in `writes`.
type Reliability = {
  attempted_at: string | null;
  done_at: string | null;
  failures: number | null;
};

const reliabilityRows = new Map<string, Reliability>();
const writes: Array<{ args: unknown[]; sql: string }> = [];

const execute = vi.fn(async ({ args, sql }: { args: unknown[]; sql: string }) => {
  if (sql.trimStart().startsWith("select")) {
    // The last arg is the trackId bound to `where track_id = ?`.
    const trackId = String(args[args.length - 1]);
    const row = reliabilityRows.get(trackId) ?? {
      attempted_at: null,
      done_at: null,
      failures: 0,
    };

    return { rows: [row] };
  }

  writes.push({ args, sql });

  return { rows: [] };
});

vi.mock("./db", () => ({ getDb: async () => ({ execute }) }));
vi.mock("./tracks", async () => {
  const actual = await vi.importActual<typeof import("./tracks")>("./tracks");

  return { ...actual, listTracks: (...a: unknown[]) => listTracks(...a) };
});
vi.mock("./discogs", () => ({
  discogsReleaseUrl: (id: number) => `https://www.discogs.com/release/${id}`,
  discogsResolveRelease: (...a: unknown[]) => discogsResolveRelease(...a),
}));
vi.mock("./lastfm", () => ({ lastfmLove: (...a: unknown[]) => lastfmLove(...a) }));

// A minimal published finding (the only fields the backfill reads).
function finding(trackId: string, over: Record<string, unknown> = {}) {
  return {
    addedAt: `2026-06-${trackId.padStart(2, "0")}T00:00:00.000Z`,
    addedToSpotify: true,
    artists: ["Artist"],
    logId: `LOG-${trackId}`,
    postedToTelegram: true,
    title: "Title",
    trackId,
    type: "finding" as const,
    ...over,
  };
}

// One feed page that drains immediately (nextCursor null).
function singlePage(tracks: unknown[]) {
  listTracks.mockResolvedValueOnce({ nextCursor: null, tracks });
}

beforeEach(() => {
  vi.clearAllMocks();
  reliabilityRows.clear();
  writes.length = 0;
});

describe("backfillDiscogsIds — reliability gate", () => {
  it("skips a finding already marked done (done_at set), no resolve, no write", async () => {
    reliabilityRows.set("1", {
      attempted_at: null,
      done_at: "2026-01-01T00:00:00.000Z",
      failures: 0,
    });
    singlePage([finding("1")]);

    const { backfillDiscogsIds } = await import("./backfill");
    const result = await backfillDiscogsIds(10, false);

    expect(result.skipped).toEqual(["LOG-1"]);
    expect(result.skippedCount).toBe(1);
    expect(result.resolvedCount).toBe(0);
    expect(discogsResolveRelease).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("skips a finding attempted within its cooldown window (recently tried)", async () => {
    // 0 failures → 24h base cooldown; attempted 1h ago is still cooling.
    reliabilityRows.set("1", {
      attempted_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      done_at: null,
      failures: 0,
    });
    singlePage([finding("1")]);

    const { backfillDiscogsIds } = await import("./backfill");
    const result = await backfillDiscogsIds(10, false);

    expect(result.skipped).toEqual(["LOG-1"]);
    expect(discogsResolveRelease).not.toHaveBeenCalled();
  });

  it("resolves an eligible finding and records done (done_at stamped, failures reset)", async () => {
    discogsResolveRelease.mockResolvedValueOnce({ masterId: 9, releaseId: 42 });
    singlePage([finding("1")]);

    const { backfillDiscogsIds } = await import("./backfill");
    const result = await backfillDiscogsIds(10, false);

    expect(result.resolved).toEqual([
      { logId: "LOG-1", masterId: 9, releaseId: 42, source: "discogs" },
    ]);
    // Two writes: set_discogs_ids + record done.
    const recordDone = writes.find((w) => w.sql.includes("backfill_discogs_done_at = ?"));
    expect(recordDone, "a done record should be written").toBeTruthy();
    expect(recordDone?.sql).toContain("backfill_discogs_failures = 0");
  });

  it("a throttled miss trips the circuit breaker — stops the run, no cooldown (next tick retries); a clean miss records TRIED", async () => {
    // Throttled miss: rateLimited true → the breaker trips. The run STOPS before
    // the second finding (no march into the same 429 wall — the storm #119 missed),
    // and the throttled finding is NOT recorded (no cooldown) so the next tick
    // retries it with a fresh rate-limit window.
    discogsResolveRelease.mockResolvedValueOnce({ rateLimited: true });
    singlePage([finding("1"), finding("2")]);
    const { backfillDiscogsIds } = await import("./backfill");
    const throttled = await backfillDiscogsIds(10, false);
    expect(throttled.rateLimited, "the result flags the throttle so the CLI stops looping").toBe(
      true,
    );
    expect(
      throttled.nextCursor,
      "a throttle-stop nulls the cursor so even the deployed CLI (null-only break) stops looping",
    ).toBeNull();
    expect(writes, "no reliability write for a throttled finding").toEqual([]);
    expect(discogsResolveRelease, "the run halted before the second finding").toHaveBeenCalledTimes(
      1,
    );

    writes.length = 0;
    reliabilityRows.clear();
    discogsResolveRelease.mockClear();

    // Clean no-match: {} → failures reset to 0 (a tried, not a failure).
    discogsResolveRelease.mockResolvedValueOnce({});
    singlePage([finding("2")]);
    await backfillDiscogsIds(10, false);
    expect(writes[0]?.sql).toContain("backfill_discogs_failures = 0");
  });

  it("dry-run resolves nothing and writes no reliability state", async () => {
    singlePage([finding("1")]);

    const { backfillDiscogsIds } = await import("./backfill");
    const result = await backfillDiscogsIds(10, true);

    expect(result.dryRun).toBe(true);
    expect(result.unresolved).toEqual(["LOG-1"]);
    expect(discogsResolveRelease).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});

describe("backfillLastfmLoves — reliability gate", () => {
  it("skips an already-loved finding (done_at set), no love, no write", async () => {
    reliabilityRows.set("1", {
      attempted_at: null,
      done_at: "2026-01-01T00:00:00.000Z",
      failures: 0,
    });
    singlePage([finding("1")]);

    const { backfillLastfmLoves } = await import("./backfill");
    const result = await backfillLastfmLoves(10, false);

    expect(result.skipped).toEqual(["LOG-1"]);
    expect(lastfmLove).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("a clean love records done; a plain (non-throttled) error records a failure", async () => {
    lastfmLove.mockResolvedValueOnce({ ok: true });
    singlePage([finding("1")]);
    const { backfillLastfmLoves } = await import("./backfill");
    const ok = await backfillLastfmLoves(10, false);
    expect(ok.loved).toEqual(["LOG-1"]);
    expect(writes[0]?.sql).toContain("backfill_lastfm_done_at = ?");

    writes.length = 0;
    reliabilityRows.clear();

    lastfmLove.mockResolvedValueOnce({ error: "nope", ok: false, rateLimited: false });
    singlePage([finding("2")]);
    const failedRun = await backfillLastfmLoves(10, false);
    expect(failedRun.failed).toEqual([{ error: "nope", logId: "LOG-2" }]);
    expect(failedRun.rateLimited).toBe(false);
    expect(writes[0]?.sql).toContain("backfill_lastfm_failures = backfill_lastfm_failures + 1");
  });

  it("a rate-limited love trips the circuit breaker — stops the run, flags rateLimited, no failure record (next tick retries)", async () => {
    // Symmetric with Discogs: a throttled love is NOT a failure (no cooldown), so the
    // next tick retries it with a fresh window, and the flag tells the CLI to stop
    // looping the cursor instead of grinding into the same wall to the 120s timeout.
    lastfmLove.mockResolvedValueOnce({ error: "rate", ok: false, rateLimited: true });
    singlePage([finding("1"), finding("2")]);
    const { backfillLastfmLoves } = await import("./backfill");
    const limited = await backfillLastfmLoves(10, false);
    expect(limited.rateLimited, "the result flags the throttle so the CLI stops looping").toBe(
      true,
    );
    expect(limited.nextCursor, "a throttle-stop nulls the cursor for the deployed CLI").toBeNull();
    expect(limited.failed, "a throttled love is not recorded as a failure").toEqual([]);
    expect(writes, "no reliability write for a throttled love").toHaveLength(0);
    expect(lastfmLove, "the run halted before the second finding").toHaveBeenCalledTimes(1);
  });
});

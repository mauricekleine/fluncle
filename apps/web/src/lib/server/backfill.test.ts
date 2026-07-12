import { beforeEach, describe, expect, it, vi } from "vitest";

// The Worker-paced backfills' reliability gate: the per-finding cooldown/done state
// that makes the sweeps resumable and keeps them from re-storming a vendor API.
// The vendor clients (discogsResolveRelease / lastfmLove) and the DB are mocked so
// these tests isolate the gate/backoff logic and the per-source state writes.

const listTracks = vi.fn();
const discogsResolveRelease = vi.fn();
const lastfmLove = vi.fn();
const appleMusicLookupByIsrc = vi.fn();
const appleCatalogLookupByIsrc = vi.fn();
const appleCatalogLookupByIsrcs = vi.fn();
// The cross-cutting Apple breaker/meter — vi.fns so a test can flip the breaker/budget shut.
// Default: allowed + budget available + record calls a no-op, so the reliability-gate tests are
// isolated from the breaker (its own behaviour is proven in apple-breaker.test.ts).
const areAppleCallsAllowed = vi.fn(async () => true);
const isAppleCallBudgetAvailable = vi.fn(async () => true);
const recordAppleAuthOutcome = vi.fn(async () => {});
const recordAppleCall = vi.fn(async () => {});

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

vi.mock("./db", () => ({
  // The Discogs resolve writes across the tracks/findings pair (the release ids are the
  // recording's catalogue identity; the lastmod bump is the finding's) as one batch —
  // replayed through the same `execute` spy, one call per statement.
  getDb: async () => ({
    batch: (statements: { args: unknown[]; sql: string }[]) =>
      Promise.all(statements.map((statement) => execute(statement))),
    execute,
  }),
}));
vi.mock("./tracks", async () => {
  const actual = await vi.importActual<typeof import("./tracks")>("./tracks");

  return { ...actual, listTracks: (...a: unknown[]) => listTracks(...a) };
});
vi.mock("./discogs", () => ({
  discogsReleaseUrl: (id: number) => `https://www.discogs.com/release/${id}`,
  discogsResolveRelease: (...a: unknown[]) => discogsResolveRelease(...a),
}));
vi.mock("./lastfm", () => ({ lastfmLove: (...a: unknown[]) => lastfmLove(...a) }));
vi.mock("./apple-music", () => ({
  appleCatalogLookupByIsrc: (...a: unknown[]) => appleCatalogLookupByIsrc(...a),
  appleCatalogLookupByIsrcs: (...a: unknown[]) => appleCatalogLookupByIsrcs(...a),
  appleMusicLookupByIsrc: (...a: unknown[]) => appleMusicLookupByIsrc(...a),
}));
vi.mock("./apple-breaker", () => ({
  areAppleCallsAllowed: (...a: unknown[]) => areAppleCallsAllowed(...a),
  isAppleCallBudgetAvailable: (...a: unknown[]) => isAppleCallBudgetAvailable(...a),
  recordAppleAuthOutcome: (...a: unknown[]) => recordAppleAuthOutcome(...a),
  recordAppleCall: (...a: unknown[]) => recordAppleCall(...a),
}));

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

describe("backfillAppleMusicUrls — reliability gate + exact ISRC resolve (oracle)", () => {
  // A resolved single-ISRC oracle bundle with just the URL (no album facts).
  function urlBundle(url: string) {
    return { bundle: { songId: "s1", songUrl: url }, configured: true, ok: true };
  }

  it("skips a finding that already has an Apple Music URL (idempotent), no lookup", async () => {
    singlePage([
      finding("1", { appleMusicUrl: "https://music.apple.com/us/song/x/1", isrc: "I1" }),
    ]);

    const { backfillAppleMusicUrls } = await import("./backfill");
    const result = await backfillAppleMusicUrls(10, false);

    expect(result.resolvedCount).toBe(0);
    expect(appleCatalogLookupByIsrc).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("skips a finding with no ISRC (nothing to match on), no lookup, not counted", async () => {
    singlePage([finding("1")]);

    const { backfillAppleMusicUrls } = await import("./backfill");
    const result = await backfillAppleMusicUrls(10, false);

    expect(result.resolvedCount).toBe(0);
    expect(result.unresolvedCount).toBe(0);
    expect(appleCatalogLookupByIsrc).not.toHaveBeenCalled();
  });

  it("skips a finding already marked done (done_at set), no lookup, no write", async () => {
    reliabilityRows.set("1", {
      attempted_at: null,
      done_at: "2026-01-01T00:00:00.000Z",
      failures: 0,
    });
    singlePage([finding("1", { isrc: "I1" })]);

    const { backfillAppleMusicUrls } = await import("./backfill");
    const result = await backfillAppleMusicUrls(10, false);

    expect(result.skipped).toEqual(["LOG-1"]);
    expect(appleCatalogLookupByIsrc).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("resolves an eligible finding by ISRC and records done (url written, failures reset)", async () => {
    appleCatalogLookupByIsrc.mockResolvedValueOnce(
      urlBundle("https://music.apple.com/us/album/x/1?i=2"),
    );
    singlePage([finding("1", { isrc: "I1" })]);

    const { backfillAppleMusicUrls } = await import("./backfill");
    const result = await backfillAppleMusicUrls(10, false);

    expect(result.configured).toBe(true);
    expect(result.resolved).toEqual([
      { logId: "LOG-1", url: "https://music.apple.com/us/album/x/1?i=2" },
    ]);
    // A finding bumps its lastmod — setAppleMusicUrl was called with bumpFinding=true, so the
    // batch carries the findings updated_at write alongside the tracks url write.
    const urlWrite = writes.find((w) => w.sql.includes("set apple_music_url = ?"));
    expect(urlWrite?.args).toEqual(["https://music.apple.com/us/album/x/1?i=2", "1"]);
    expect(writes.find((w) => w.sql.includes("update findings set updated_at"))).toBeTruthy();
    const recordDone = writes.find((w) => w.sql.includes("backfill_apple_music_done_at = ?"));
    expect(recordDone, "a done record should be written").toBeTruthy();
    // The Apple reliability write now targets `tracks`, not `findings` (RFC U1 — the move).
    expect(recordDone?.sql).toContain("update tracks");
    expect(recordDone?.sql).toContain("backfill_apple_music_failures = 0");
    // A success feeds the breaker "ok" (resets any auth streak).
    expect(recordAppleAuthOutcome).toHaveBeenCalledWith("ok", expect.any(Number));
  });

  it("a clean no-match (bundle null) records TRIED (base cooldown, streak reset), no url write", async () => {
    appleCatalogLookupByIsrc.mockResolvedValueOnce({ bundle: null, configured: true, ok: true });
    singlePage([finding("1", { isrc: "I1" })]);

    const { backfillAppleMusicUrls } = await import("./backfill");
    const result = await backfillAppleMusicUrls(10, false);

    expect(result.unresolved).toEqual(["LOG-1"]);
    expect(writes.find((w) => w.sql.includes("set apple_music_url = ?"))).toBeUndefined();
    const tried = writes.find((w) => w.sql.includes("backfill_apple_music_attempted_at"));
    expect(tried?.sql).toContain("update tracks");
    expect(tried?.sql).toContain("backfill_apple_music_failures = 0");
  });

  it("a rate-limited lookup stops the run, nulls the cursor, no write, feeds breaker 'other'", async () => {
    appleCatalogLookupByIsrc.mockResolvedValueOnce({
      configured: true,
      error: "429",
      ok: false,
      rateLimited: true,
    });
    singlePage([finding("1", { isrc: "I1" }), finding("2", { isrc: "I2" })]);

    const { backfillAppleMusicUrls } = await import("./backfill");
    const limited = await backfillAppleMusicUrls(10, false);

    expect(limited.rateLimited).toBe(true);
    expect(limited.nextCursor).toBeNull();
    expect(writes).toHaveLength(0);
    expect(
      appleCatalogLookupByIsrc,
      "the run halted before the second finding",
    ).toHaveBeenCalledTimes(1);
    // A 429 is the OTHER regime — it does not advance the auth-failure breaker streak.
    expect(recordAppleAuthOutcome).toHaveBeenCalledWith("other", expect.any(Number));
  });

  it("a 401/403 (authFailed) feeds the breaker an 'auth_failure' and records a finding failure", async () => {
    appleCatalogLookupByIsrc.mockResolvedValueOnce({
      authFailed: true,
      configured: true,
      error: "401",
      ok: false,
      rateLimited: false,
    });
    singlePage([finding("1", { isrc: "I1" })]);

    const { backfillAppleMusicUrls } = await import("./backfill");
    const result = await backfillAppleMusicUrls(10, false);

    expect(result.failed).toEqual([{ error: "401", logId: "LOG-1" }]);
    expect(recordAppleAuthOutcome).toHaveBeenCalledWith("auth_failure", expect.any(Number));
  });

  it("stops the pass when the cross-cutting breaker is tripped — no call, no write", async () => {
    areAppleCallsAllowed.mockResolvedValueOnce(false);
    singlePage([finding("1", { isrc: "I1" })]);

    const { backfillAppleMusicUrls } = await import("./backfill");
    const result = await backfillAppleMusicUrls(10, false);

    expect(result.breakerTripped).toBe(true);
    expect(result.nextCursor, "a breaker trip nulls the cursor").toBeNull();
    expect(appleCatalogLookupByIsrc).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("stops the pass when the shared call budget is spent — no call, no write", async () => {
    isAppleCallBudgetAvailable.mockResolvedValueOnce(false);
    singlePage([finding("1", { isrc: "I1" })]);

    const { backfillAppleMusicUrls } = await import("./backfill");
    const result = await backfillAppleMusicUrls(10, false);

    expect(result.breakerTripped).toBe(true);
    expect(appleCatalogLookupByIsrc).not.toHaveBeenCalled();
  });

  it("an unconfigured leg reports configured:false, stops cheaply, records nothing", async () => {
    appleCatalogLookupByIsrc.mockResolvedValueOnce({ configured: false });
    singlePage([finding("1", { isrc: "I1" }), finding("2", { isrc: "I2" })]);

    const { backfillAppleMusicUrls } = await import("./backfill");
    const result = await backfillAppleMusicUrls(10, false);

    expect(result.configured).toBe(false);
    expect(result.nextCursor, "an unconfigured no-op nulls the cursor").toBeNull();
    expect(result.resolvedCount).toBe(0);
    expect(writes, "nothing recorded — the finding stays eligible for when the key lands").toEqual(
      [],
    );
    expect(
      appleCatalogLookupByIsrc,
      "stopped after the first unconfigured answer",
    ).toHaveBeenCalledTimes(1);
  });

  it("a non-rate error records a failure (backoff) and surfaces it in `failed`", async () => {
    appleCatalogLookupByIsrc.mockResolvedValueOnce({
      configured: true,
      error: "bad token",
      ok: false,
      rateLimited: false,
    });
    singlePage([finding("1", { isrc: "I1" })]);

    const { backfillAppleMusicUrls } = await import("./backfill");
    const result = await backfillAppleMusicUrls(10, false);

    expect(result.failed).toEqual([{ error: "bad token", logId: "LOG-1" }]);
    expect(result.rateLimited).toBe(false);
    const failure = writes.find((w) => w.sql.includes("backfill_apple_music_attempted_at"));
    expect(failure?.sql).toContain("update tracks");
    expect(failure?.sql).toContain(
      "backfill_apple_music_failures = backfill_apple_music_failures + 1",
    );
  });

  it("dry-run previews the eligible set, no lookup, no write", async () => {
    singlePage([finding("1", { isrc: "I1" })]);

    const { backfillAppleMusicUrls } = await import("./backfill");
    const result = await backfillAppleMusicUrls(10, true);

    expect(result.dryRun).toBe(true);
    expect(result.unresolved).toEqual(["LOG-1"]);
    expect(appleCatalogLookupByIsrc).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});

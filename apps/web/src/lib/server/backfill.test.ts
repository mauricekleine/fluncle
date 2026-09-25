import { beforeEach, describe, expect, it, vi } from "vitest";

const listTracks = vi.fn();
const getTracksByIds = vi.fn();
const discogsResolveRelease = vi.fn();
const lastfmLove = vi.fn();
const appleMusicLookupByIsrc = vi.fn();
const appleCatalogLookupByIsrc = vi.fn();
const appleCatalogLookupByIsrcs = vi.fn();

const areAppleCallsAllowed = vi.fn(async (..._a: unknown[]) => true);
const isAppleCallBudgetAvailable = vi.fn(async (..._a: unknown[]) => true);
const recordAppleAuthOutcome = vi.fn(async (..._a: unknown[]) => {});
const recordAppleCall = vi.fn(async (..._a: unknown[]) => {});

type Reliability = {
  attempted_at: string | null;
  done_at: string | null;
  failures: number | null;
};

const reliabilityRows = new Map<string, Reliability>();
const writes: Array<{ args: unknown[]; sql: string }> = [];

const execute = vi.fn(async ({ args, sql }: { args: unknown[]; sql: string }) => {
  if (sql.trimStart().startsWith("select")) {
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
  getDb: async () => ({
    batch: (statements: { args: unknown[]; sql: string }[]) =>
      Promise.all(statements.map((statement) => execute(statement))),
    execute,
  }),
}));
vi.mock("./tracks", async () => {
  const actual = await vi.importActual<typeof import("./tracks")>("./tracks");

  return {
    ...actual,
    getTracksByIds: (...a: unknown[]) => getTracksByIds(...a),
    listTracks: (...a: unknown[]) => listTracks(...a),
  };
});
vi.mock("./discogs", async () => {
  const actual = await vi.importActual<typeof import("./discogs")>("./discogs");

  return { ...actual, discogsResolveRelease: (...a: unknown[]) => discogsResolveRelease(...a) };
});
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

function singlePage(tracks: unknown[]) {
  listTracks.mockResolvedValueOnce({ nextCursor: null, tracks });
}

beforeEach(() => {
  vi.clearAllMocks();
  reliabilityRows.clear();
  writes.length = 0;
  getTracksByIds.mockResolvedValue({});
});

describe("backfillDiscogsIds — reliability gate", () => {
  it("scores box-fetched releases in the Worker before writing ids", async () => {
    getTracksByIds.mockResolvedValueOnce({ "1": finding("1") });
    const { backfillDiscogsIds } = await import("./backfill");
    const result = await backfillDiscogsIds(10, false, undefined, {
      boxFetch: true,
      discogsCandidates: [
        {
          releases: [
            {
              artists: [{ name: "Artist" }],
              formats: [{ name: "Vinyl" }],
              id: 42,
              labels: [],
              styles: [],
              title: "Title",
              tracklist: [{ title: "Title" }],
            },
          ],
          trackId: "1",
        },
      ],
    });

    expect(result.resolved).toEqual([{ logId: "LOG-1", releaseId: 42, source: "discogs" }]);
    expect(discogsResolveRelease).not.toHaveBeenCalled();
    expect(writes.some((write) => write.sql.includes("in_release_id = ?"))).toBe(true);
  });

  it("does not turn an omitted box result into a clean miss or reliability write", async () => {
    const { backfillDiscogsIds } = await import("./backfill");
    const result = await backfillDiscogsIds(10, false, undefined, {
      boxFetch: true,
      discogsCandidates: [],
    });

    expect(result.unresolved).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(writes).toEqual([]);
    expect(discogsResolveRelease).not.toHaveBeenCalled();
  });

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

    const recordDone = writes.find((w) => w.sql.includes("backfill_discogs_failures = 0"));
    expect(recordDone, "a done record should be written").toBeTruthy();
    expect(recordDone?.sql).toContain("backfill_discogs_failures = 0");

    const setIds = writes.find((w) => w.sql.includes("in_release_id = ?"));
    expect(setIds?.sql).toContain("backfill_discogs_attempted_at = ?");
    expect(setIds?.sql).toContain("backfill_discogs_done_at = ?");
    expect(setIds?.sql).toContain("backfill_discogs_attempts = backfill_discogs_attempts + 1");
  });

  it("a throttled miss trips the circuit breaker — stops the run, no cooldown (next tick retries); a clean miss records TRIED", async () => {
    discogsResolveRelease.mockResolvedValueOnce({
      rateLimited: true,
      rateLimitedBy: "musicbrainz",
    });
    singlePage([finding("1"), finding("2")]);
    const { backfillDiscogsIds } = await import("./backfill");
    const throttled = await backfillDiscogsIds(10, false);
    expect(throttled.rateLimited, "the result flags the throttle so the CLI stops looping").toBe(
      true,
    );
    expect(throttled.rateLimitedBy).toBe("musicbrainz");
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

    const urlWrite = writes.find((w) => w.sql.includes("set apple_music_url = ?"));
    expect(urlWrite?.args).toEqual(["https://music.apple.com/us/album/x/1?i=2", "1"]);
    expect(writes.find((w) => w.sql.includes("update findings set updated_at"))).toBeTruthy();
    const recordDone = writes.find((w) => w.sql.includes("backfill_apple_music_done_at = ?"));
    expect(recordDone, "a done record should be written").toBeTruthy();

    expect(recordDone?.sql).toContain("update tracks");
    expect(recordDone?.sql).toContain("backfill_apple_music_failures = 0");

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

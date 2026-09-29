import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEvidenceHttp,
  EvidenceFetchError,
  type EvidenceHttp,
  fetchEvidenceText,
  parseRetryAfter,
  type Perform,
  type RawResponse,
  reserveSlot,
  SOURCE_POLICIES,
  type SourcePolicy,
} from "./evidence-http";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fluncle-evidence-http-"));
  dirs.push(dir);

  return dir;
}

function fakeHttp(
  policy: Partial<SourcePolicy> = {},
  overrides: Partial<EvidenceHttp> = {},
): EvidenceHttp & { clock: { now: number }; sleeps: number[] } {
  const clock = { now: 1_000_000 };
  const sleeps: number[] = [];
  const merged = { ...SOURCE_POLICIES.musicbrainz, intervalMs: 0, timeoutMs: 50, ...policy };

  return Object.assign(
    createEvidenceHttp({
      cacheDir: tempDir(),
      now: () => clock.now,
      policies: { ...SOURCE_POLICIES, musicbrainz: merged },
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.now += ms;
      },
      ...overrides,
    }),
    { clock, sleeps },
  );
}

function reply(status: number, text = "", headers: Record<string, string> = {}): RawResponse {
  return {
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    status,
    text,
  };
}

function scripted(responses: Array<(() => Promise<RawResponse>) | RawResponse>): {
  calls: () => number;
  perform: Perform;
} {
  let calls = 0;

  return {
    calls: () => calls,
    perform: async () => {
      const next = responses[Math.min(calls, responses.length - 1)];
      calls += 1;

      return typeof next === "function" ? next() : (next ?? reply(500));
    },
  };
}

const hang: Perform = (signal) =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });

describe("fetchEvidenceText", () => {
  test("gives up with a timeout failure once every attempt hangs past the bound", async () => {
    const http = fakeHttp({ attempts: 2, timeoutMs: 20 });
    let calls = 0;
    const counted: Perform = (signal) => {
      calls += 1;

      return hang(signal);
    };

    const failure = await fetchEvidenceText(http, "musicbrainz", "k", counted).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(EvidenceFetchError);
    expect((failure as EvidenceFetchError).kind).toBe("timeout");
    expect((failure as EvidenceFetchError).attempts).toBe(2);
    expect((failure as Error).message).toContain("gave up after 2 attempts");
    expect(calls).toBe(2);
  });

  test("recovers from a timeout when a later attempt answers", async () => {
    const http = fakeHttp({ attempts: 3, timeoutMs: 20 });
    const { calls, perform } = scripted([
      () => hang(new AbortController().signal),
      reply(200, "ok"),
    ]);

    const result = await fetchEvidenceText(http, "musicbrainz", "k", perform);

    expect(result).toEqual({ cached: false, text: "ok" });
    expect(calls()).toBe(2);
  });

  test("honours Retry-After on a 429 before retrying", async () => {
    const http = fakeHttp({ attempts: 3, intervalMs: 100 });
    const { calls, perform } = scripted([reply(429, "", { "retry-after": "7" }), reply(200, "ok")]);

    const result = await fetchEvidenceText(http, "musicbrainz", "k", perform);

    expect(result.text).toBe("ok");
    expect(calls()).toBe(2);
    expect(http.sleeps).toContain(7_000);
  });

  test("a throttled final attempt still makes every other caller wait out Retry-After", async () => {
    const throttled = fakeHttp({ attempts: 1, intervalMs: 100 });
    const other = fakeHttp({ intervalMs: 100 }, { cacheDir: throttled.cacheDir });
    other.clock.now = throttled.clock.now;

    await fetchEvidenceText(
      throttled,
      "musicbrainz",
      "k",
      scripted([reply(429, "", { "retry-after": "7" })]).perform,
    ).catch(() => undefined);
    await reserveSlot(other, "musicbrainz");

    expect(other.sleeps).toEqual([7_000]);
  });

  test("gives up at once when Retry-After exceeds the backoff cap, and caps the shared wait", async () => {
    const http = fakeHttp({ attempts: 3, intervalMs: 100, maxBackoffMs: 30_000 });
    const other = fakeHttp({ intervalMs: 100 }, { cacheDir: http.cacheDir });
    other.clock.now = http.clock.now;
    const { calls, perform } = scripted([reply(429, "", { "retry-after": "3600" })]);

    const failure = (await fetchEvidenceText(http, "musicbrainz", "k", perform).catch(
      (error: unknown) => error,
    )) as EvidenceFetchError;
    await reserveSlot(other, "musicbrainz");

    expect(failure.kind).toBe("rate_limited");
    expect(failure.message).toContain("asked to wait 3600 s");
    expect(calls()).toBe(1);
    expect(http.sleeps).toEqual([]);
    expect(other.sleeps).toEqual([30_000]);
  });

  test("retries a 2xx body the caller rejects and never caches it", async () => {
    const http = fakeHttp({ attempts: 2 });
    const accept = (text: string) => text.startsWith("{");
    const { calls, perform } = scripted([reply(200, "<html>challenge</html>"), reply(200, "{}")]);

    expect(await fetchEvidenceText(http, "musicbrainz", "k", perform, accept)).toEqual({
      cached: false,
      text: "{}",
    });
    expect(calls()).toBe(2);

    const stuck = fakeHttp({ attempts: 2 });
    const failure = (await fetchEvidenceText(
      stuck,
      "musicbrainz",
      "k",
      scripted([reply(200, "<html>challenge</html>")]).perform,
      accept,
    ).catch((error: unknown) => error)) as EvidenceFetchError;
    expect(failure.kind).toBe("invalid");

    const next = scripted([reply(200, "{}")]);
    expect((await fetchEvidenceText(stuck, "musicbrainz", "k", next.perform, accept)).cached).toBe(
      false,
    );
    expect(next.calls()).toBe(1);
  });

  test("ignores a cached body the caller now rejects", async () => {
    const http = fakeHttp();
    await fetchEvidenceText(http, "musicbrainz", "k", scripted([reply(200, "bad")]).perform);
    const next = scripted([reply(200, "{}")]);

    const result = await fetchEvidenceText(http, "musicbrainz", "k", next.perform, (text) =>
      text.startsWith("{"),
    );

    expect(result).toEqual({ cached: false, text: "{}" });
  });

  test("reports a rate-limited failure when every attempt is throttled", async () => {
    const http = fakeHttp({ attempts: 3 });
    const { calls, perform } = scripted([reply(503)]);

    const failure = (await fetchEvidenceText(http, "musicbrainz", "k", perform).catch(
      (error: unknown) => error,
    )) as EvidenceFetchError;

    expect(failure.kind).toBe("rate_limited");
    expect(failure.status).toBe(503);
    expect(calls()).toBe(3);
  });

  test("backs off exponentially from the source interval, capped", async () => {
    const http = fakeHttp({ attempts: 4, intervalMs: 1_000, maxBackoffMs: 5_000 });
    const { perform } = scripted([reply(500), reply(500), reply(500), reply(200, "ok")]);

    await fetchEvidenceText(http, "musicbrainz", "k", perform);

    expect(http.sleeps.filter((ms) => ms >= 1_000)).toEqual([2_000, 4_000, 5_000]);
  });

  test("never retries a 404", async () => {
    const http = fakeHttp({ attempts: 3 });
    const { calls, perform } = scripted([reply(404)]);

    const failure = (await fetchEvidenceText(http, "musicbrainz", "k", perform).catch(
      (error: unknown) => error,
    )) as EvidenceFetchError;

    expect(failure.kind).toBe("not_found");
    expect(failure.attempts).toBe(1);
    expect(calls()).toBe(1);
  });

  test("retries a network error", async () => {
    const http = fakeHttp({ attempts: 2 });
    const { calls, perform } = scripted([
      () => Promise.reject(new Error("ECONNRESET")),
      reply(200, "ok"),
    ]);

    expect((await fetchEvidenceText(http, "musicbrainz", "k", perform)).text).toBe("ok");
    expect(calls()).toBe(2);
  });

  test("serves a fresh cached answer without a request, and refresh or expiry refetches", async () => {
    const http = fakeHttp();
    const first = scripted([reply(200, "v1")]);
    await fetchEvidenceText(http, "musicbrainz", "k", first.perform);

    const again = scripted([reply(200, "v2")]);
    expect(await fetchEvidenceText(http, "musicbrainz", "k", again.perform)).toEqual({
      cached: true,
      text: "v1",
    });
    expect(again.calls()).toBe(0);
    expect(http.stats).toEqual({ cacheHits: 1, requests: 1 });

    const refreshed = fakeHttp({}, { cacheDir: http.cacheDir, refresh: true });
    expect((await fetchEvidenceText(refreshed, "musicbrainz", "k", again.perform)).text).toBe("v2");

    http.clock.now += http.cacheTtlMs + 1;
    const expired = scripted([reply(200, "v3")]);
    expect((await fetchEvidenceText(http, "musicbrainz", "k", expired.perform)).text).toBe("v3");
  });

  test("never caches a failed answer", async () => {
    const http = fakeHttp({ attempts: 1 });
    await fetchEvidenceText(http, "musicbrainz", "k", scripted([reply(500)]).perform).catch(
      () => undefined,
    );
    const next = scripted([reply(200, "ok")]);

    expect((await fetchEvidenceText(http, "musicbrainz", "k", next.perform)).cached).toBe(false);
    expect(next.calls()).toBe(1);
  });
});

describe("reserveSlot", () => {
  test("spaces requests by the source interval across callers sharing a cache dir", async () => {
    const one = fakeHttp({ intervalMs: 1_100 });
    const two = fakeHttp({ intervalMs: 1_100 }, { cacheDir: one.cacheDir });
    two.clock.now = one.clock.now;

    await reserveSlot(one, "musicbrainz");
    await reserveSlot(two, "musicbrainz");
    await reserveSlot(one, "musicbrainz");

    expect(one.sleeps).toEqual([2_200]);
    expect(two.sleeps).toEqual([1_100]);
  });
});

describe("parseRetryAfter", () => {
  test("reads delta-seconds, an HTTP date, and ignores garbage", () => {
    const now = Date.parse("2026-09-29T10:00:00Z");

    expect(parseRetryAfter("3", now)).toBe(3_000);
    expect(parseRetryAfter("Tue, 29 Sep 2026 10:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

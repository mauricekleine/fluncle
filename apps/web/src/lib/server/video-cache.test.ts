import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as workers from "../../test/cloudflare-workers-stub";
import { purgeClipCache, purgeVideoCache } from "./video-cache";

describe("video cache purge lifecycle", () => {
  beforeEach(() => {
    workers.env.CF_CACHE_PURGE_ZONE_ID = "test-zone";
    workers.env.CF_CACHE_PURGE_TOKEN = "test-token";
  });

  afterEach(async () => {
    await Promise.all(workers.takeWaitUntilPromises());
    delete workers.env.CF_CACHE_PURGE_ZONE_ID;
    delete workers.env.CF_CACHE_PURGE_TOKEN;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("continues later purge batches after a timed-out batch", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        signal = init.signal;
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(purgeVideoCache("004.7.2I", true, 2)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all(workers.takeWaitUntilPromises());

    expect(signal?.aborted).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const batches = fetchMock.mock.calls.map(
      ([_url, init]) => JSON.parse(init.body as string).files as string[],
    );
    expect(batches[0]).toHaveLength(30);
    expect(batches.every((files) => files.length > 0 && files.length <= 30)).toBe(true);
    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { error: "timeout", event: "video-cache.purge-error", label: "004.7.2I" },
    ]);
  });

  it("retains HTTP failure warnings for clip purges", async () => {
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );

    expect(purgeClipCache("clip-1", 3)).toBeUndefined();
    await Promise.all(workers.takeWaitUntilPromises());

    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { event: "video-cache.purge-request-failed", label: "clip-1", status: 403, urlCount: 4 },
    ]);
  });
});

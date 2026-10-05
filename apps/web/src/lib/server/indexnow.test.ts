import { afterEach, describe, expect, it, vi } from "vitest";
import * as workers from "../../test/cloudflare-workers-stub";
import { siteUrl } from "@/lib/fluncle-links";
import {
  buildFindingIndexNowUrls,
  buildIndexNowPayload,
  INDEXNOW_KEY,
  IndexNowFailed,
  submitIndexNowUrls,
  submitFindingToIndexNow,
} from "@/lib/server/indexnow";

describe("buildIndexNowPayload", () => {
  it("uses the canonical host, the public key, and the matching key file URL", () => {
    const url = "https://www.fluncle.com/log/004.7.2I";
    const payload = buildIndexNowPayload([url]);

    expect(payload).toStrictEqual({
      host: "www.fluncle.com",
      key: INDEXNOW_KEY,
      keyLocation: `https://www.fluncle.com/${INDEXNOW_KEY}.txt`,
      urlList: [url],
    });
  });

  it("commits a 32-char lowercase-hex ownership key (a public token, not a secret)", () => {
    expect(INDEXNOW_KEY).toMatch(/^[0-9a-f]{32}$/);
  });

  it("passes the URL list through verbatim", () => {
    const urls = ["https://www.fluncle.com/log/a", "https://www.fluncle.com/log/b"];

    expect(buildIndexNowPayload(urls).urlList).toEqual(urls);
  });
});

describe("buildFindingIndexNowUrls", () => {
  it("batches the log page, its graph pages, and the /fresh lens", () => {
    const urls = buildFindingIndexNowUrls("004.7.2I", [
      { kind: "artist", slug: "dimension" },
      { kind: "album", slug: "wormhole" },
      { kind: "label", slug: "medschool" },
    ]);

    expect(urls).toEqual([
      `${siteUrl}/log/004.7.2I`,
      `${siteUrl}/artist/dimension`,
      `${siteUrl}/album/wormhole`,
      `${siteUrl}/label/medschool`,
      `${siteUrl}/fresh`,
    ]);
  });

  it("carries several artist pages when a finding has several artists", () => {
    const urls = buildFindingIndexNowUrls("011.6.8K", [
      { kind: "artist", slug: "culture-shock" },
      { kind: "artist", slug: "sub-focus" },
    ]);

    expect(urls).toContain(`${siteUrl}/artist/culture-shock`);
    expect(urls).toContain(`${siteUrl}/artist/sub-focus`);
  });

  it("falls back to just the log page + /fresh when a finding joins no graph pages", () => {
    expect(buildFindingIndexNowUrls("019.F.1A", [])).toEqual([
      `${siteUrl}/log/019.F.1A`,
      `${siteUrl}/fresh`,
    ]);
  });

  it("dedupes so a repeated target is submitted once", () => {
    const urls = buildFindingIndexNowUrls("004.7.2I", [
      { kind: "artist", slug: "dimension" },
      { kind: "artist", slug: "dimension" },
    ]);

    expect(urls.filter((url) => url === `${siteUrl}/artist/dimension`)).toHaveLength(1);
  });
});

describe("IndexNow submission lifecycle", () => {
  afterEach(async () => {
    await Promise.all(workers.takeWaitUntilPromises());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([200, 202])("accepts HTTP %i", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status })),
    );
    await expect(submitIndexNowUrls([`${siteUrl}/log/004.7.2I`])).resolves.toBe(status);
  });

  it("acknowledges accepted responses without waiting for body cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              cancel: () => new Promise<void>(() => {}),
            }),
            { status: 202 },
          ),
      ),
    );
    await expect(submitIndexNowUrls([`${siteUrl}/log/004.7.2I`])).resolves.toBe(202);
  });

  it.each([201, 403, 422, 429, 500])(
    "rejects HTTP %i with a bounded body excerpt",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("denied ".repeat(1000), { status })),
      );
      const error = await submitIndexNowUrls([`${siteUrl}/log/004.7.2I`]).catch(
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(IndexNowFailed);
      expect(error).toMatchObject({ excerpt: expect.stringContaining("denied"), status });
      if (error instanceof IndexNowFailed) {
        expect(error.excerpt?.length).toBeLessThanOrEqual(512);
      }
    },
  );

  it("carries the rejected HTTP status in the publish background log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid key", { status: 403 })),
    );
    submitFindingToIndexNow("004.7.2I");
    await vi.waitFor(() => expect(workers.takeWaitUntilPromises()).toHaveLength(1));
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      event: "indexnow.submit-failed",
      excerpt: "invalid key",
      status: 403,
    });
  });

  it("retains a rejection status when its body cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("broken body"));
              },
            }),
            { status: 422 },
          ),
      ),
    );
    await expect(submitIndexNowUrls([`${siteUrl}/log/004.7.2I`])).rejects.toMatchObject({
      excerpt: "response body unavailable",
      status: 422,
    });
  });

  it("bounds reading a rejected body and retains the received status", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream(), { status: 429 })),
    );
    const result = submitIndexNowUrls([`${siteUrl}/log/004.7.2I`]).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toMatchObject({ cause: "timeout", status: 429 });
  });

  it("submits in the background and bounds a hung request", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal;
        return new Promise<Response>(() => {});
      }),
    );

    expect(submitFindingToIndexNow("004.7.2I")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    const tasks = workers.takeWaitUntilPromises();
    expect(tasks).toHaveLength(1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all(tasks);

    expect(signal?.aborted).toBe(true);
    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({
        cause: expect.stringContaining("timeout"),
        event: "indexnow.submit-failed",
      }),
    ]);
  });

  it("logs a rejected submission even when waitUntil is unavailable", async () => {
    vi.useFakeTimers();
    vi.spyOn(workers, "waitUntil").mockImplementation(() => {
      throw new Error("no request context");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    expect(submitFindingToIndexNow("004.7.2I")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);

    expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({
        cause: expect.stringContaining("offline"),
        event: "indexnow.submit-failed",
      }),
    ]);
  });
});

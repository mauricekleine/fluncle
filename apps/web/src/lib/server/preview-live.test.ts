import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  areAppleCallsAllowed,
  isAppleCallBudgetAvailable,
  recordAppleAuthOutcome,
  recordAppleCall,
} from "./apple-breaker";
import { appleCatalogLookupByIsrcs } from "./apple-music";
import { enrichFromDeezer } from "./deezer";
import { fetchLivePreview, resolveAppleExactPreviewUrl } from "./preview-live";

vi.mock("./deezer", () => ({
  enrichFromDeezer: vi.fn(async () => ({ previewUrl: undefined })),
}));

// The U1 cross-cutting breaker + meter, mocked so each test drives the rung's guards.
vi.mock("./apple-breaker", () => ({
  areAppleCallsAllowed: vi.fn(async () => true),
  isAppleCallBudgetAvailable: vi.fn(async () => true),
  recordAppleAuthOutcome: vi.fn(async () => undefined),
  recordAppleCall: vi.fn(async () => undefined),
}));

// The U0 oracle's slim batched path, mocked so a test controls the exact-by-ISRC hit.
vi.mock("./apple-music", () => ({
  appleCatalogLookupByIsrcs: vi.fn(async () => ({
    bundles: new Map(),
    configured: true,
    ok: true,
  })),
}));

const APPLE_PREVIEW_URL = "https://audio-ssl.itunes.apple.com/mzaf_exact.m4a";

/** A configurable global-fetch stub: `route(href, init)` returns the Response, or 500. */
function stubFetch(route: (href: string, init?: RequestInit) => Response | undefined): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof Request ? url.url : url.href;

      return route(href, init) ?? new Response(undefined, { status: 500 });
    }),
  );
}

/** A single-ISRC hit bundle carrying an exact Apple preview URL. */
function hitWith(previewUrl: string) {
  return {
    bundles: new Map([["GBXXX123", { preview: { url: previewUrl }, songId: "1", songUrl: "u" }]]),
    configured: true as const,
    ok: true as const,
  };
}

describe("fetchLivePreview", () => {
  beforeEach(() => {
    vi.mocked(enrichFromDeezer).mockResolvedValue({ previewUrl: undefined });
    vi.mocked(areAppleCallsAllowed).mockResolvedValue(true);
    vi.mocked(isAppleCallBudgetAvailable).mockResolvedValue(true);
    vi.mocked(appleCatalogLookupByIsrcs).mockResolvedValue({
      bundles: new Map(),
      configured: true,
      ok: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("falls through stored Deezer and refreshed Deezer to iTunes without touching R2", async () => {
    vi.mocked(enrichFromDeezer).mockResolvedValue({
      previewUrl: "https://deezer.example/fresh.mp3",
    });
    stubFetch((href, init) => {
      if (href === "https://deezer.example/stored.mp3") {
        expect((init?.headers as Record<string, string> | undefined)?.range).toBe("bytes=0-1023");

        return new Response(undefined, { status: 403 });
      }

      if (href === "https://deezer.example/fresh.mp3") {
        expect((init?.headers as Record<string, string> | undefined)?.range).toBe("bytes=0-1023");

        return new Response(undefined, { status: 404 });
      }

      if (href.startsWith("https://itunes.apple.com/search")) {
        return Response.json({
          results: [
            {
              artistName: "Krakota",
              previewUrl: "https://itunes.example/preview.m4a",
              trackName: "Sea Air",
            },
          ],
        });
      }

      if (href === "https://itunes.example/preview.m4a") {
        expect((init?.headers as Record<string, string> | undefined)?.range).toBe("bytes=0-1023");

        return new Response("itunes", { status: 206 });
      }

      return undefined;
    });

    const response = await fetchLivePreview(
      {
        artists: ["Krakota"],
        isrc: "GBXXX123",
        previewUrl: "https://deezer.example/stored.mp3",
        title: "Sea Air",
      },
      new Request("https://www.fluncle.com/api/preview/011.6.8K", {
        headers: { range: "bytes=0-1023" },
      }),
    );

    expect(response?.status).toBe(206);
    expect(await response?.text()).toBe("itunes");
    // Rung 3 (exact Apple) was consulted but returned no hit (default empty bundles), so
    // the chain correctly degraded to the fuzzy iTunes rung (rung 4).
    expect(appleCatalogLookupByIsrcs).toHaveBeenCalledWith(["GBXXX123"], expect.any(AbortSignal));
  });

  it("rung 3: an exact Apple-by-ISRC hit serves before the fuzzy iTunes rung", async () => {
    vi.mocked(appleCatalogLookupByIsrcs).mockResolvedValue(hitWith(APPLE_PREVIEW_URL));
    stubFetch((href) => {
      if (href === APPLE_PREVIEW_URL) {
        return new Response("apple", { status: 206 });
      }

      return undefined;
    });

    const response = await fetchLivePreview(
      { artists: ["Krakota"], isrc: "GBXXX123", title: "Sea Air" },
      new Request("https://www.fluncle.com/api/preview/011.6.8K", {
        headers: { range: "bytes=0-1023" },
      }),
    );

    expect(response?.status).toBe(206);
    expect(await response?.text()).toBe("apple");
    // The exact rung served, so the fuzzy iTunes rung was never reached.
    const fetchMock = vi.mocked(fetch);
    expect(
      fetchMock.mock.calls.some(
        ([u]) => typeof u === "string" && u.includes("itunes.apple.com/search"),
      ),
    ).toBe(false);
    expect(recordAppleCall).toHaveBeenCalledOnce();
    expect(recordAppleAuthOutcome).toHaveBeenCalledWith("ok", expect.any(Number));
  });

  it("rung 3: a tripped breaker short-circuits the rung — no Apple call, falls to iTunes", async () => {
    vi.mocked(areAppleCallsAllowed).mockResolvedValue(false);
    stubFetch((href) => {
      if (href.startsWith("https://itunes.apple.com/search")) {
        return Response.json({
          results: [
            {
              artistName: "Krakota",
              previewUrl: "https://itunes.example/p.m4a",
              trackName: "Sea Air",
            },
          ],
        });
      }

      if (href === "https://itunes.example/p.m4a") {
        return new Response("itunes", { status: 206 });
      }

      return undefined;
    });

    const response = await fetchLivePreview(
      { artists: ["Krakota"], isrc: "GBXXX123", title: "Sea Air" },
      new Request("https://www.fluncle.com/api/preview/011.6.8K"),
    );

    expect(await response?.text()).toBe("itunes");
    // The breaker verdict came first: no Apple call at all, nothing recorded.
    expect(appleCatalogLookupByIsrcs).not.toHaveBeenCalled();
    expect(recordAppleCall).not.toHaveBeenCalled();
  });

  it("rung 3: a spent call-meter window short-circuits the rung", async () => {
    vi.mocked(isAppleCallBudgetAvailable).mockResolvedValue(false);
    stubFetch((href) => {
      if (href.startsWith("https://itunes.apple.com/search")) {
        return Response.json({ results: [] });
      }

      return undefined;
    });

    await fetchLivePreview(
      { artists: ["Krakota"], isrc: "GBXXX123", title: "Sea Air" },
      new Request("https://www.fluncle.com/api/preview/011.6.8K"),
    );

    expect(appleCatalogLookupByIsrcs).not.toHaveBeenCalled();
  });

  it("rung 3: a track with no ISRC skips the exact rung entirely (guards untouched)", async () => {
    stubFetch((href) => {
      if (href.startsWith("https://itunes.apple.com/search")) {
        return Response.json({ results: [] });
      }

      return undefined;
    });

    await fetchLivePreview(
      { artists: ["Krakota"], title: "Sea Air" },
      new Request("https://www.fluncle.com/api/preview/011.6.8K"),
    );

    // No ISRC ⇒ the rung returns before consulting the breaker or the oracle.
    expect(areAppleCallsAllowed).not.toHaveBeenCalled();
    expect(appleCatalogLookupByIsrcs).not.toHaveBeenCalled();
  });
});

describe("resolveAppleExactPreviewUrl", () => {
  beforeEach(() => {
    vi.mocked(areAppleCallsAllowed).mockResolvedValue(true);
    vi.mocked(isAppleCallBudgetAvailable).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the exact preview URL on a hit and records the call as ok", async () => {
    vi.mocked(appleCatalogLookupByIsrcs).mockResolvedValue(hitWith(APPLE_PREVIEW_URL));

    const url = await resolveAppleExactPreviewUrl({
      artists: ["Krakota"],
      isrc: "GBXXX123",
      title: "Sea Air",
    });

    expect(url).toBe(APPLE_PREVIEW_URL);
    expect(recordAppleCall).toHaveBeenCalledOnce();
    expect(recordAppleAuthOutcome).toHaveBeenCalledWith("ok", expect.any(Number));
  });

  it("returns undefined without any call when the row has no ISRC", async () => {
    const url = await resolveAppleExactPreviewUrl({ artists: ["Krakota"], title: "Sea Air" });

    expect(url).toBeUndefined();
    expect(areAppleCallsAllowed).not.toHaveBeenCalled();
    expect(appleCatalogLookupByIsrcs).not.toHaveBeenCalled();
  });

  it("records nothing when MusicKit is unprovisioned (the rung is dark)", async () => {
    vi.mocked(appleCatalogLookupByIsrcs).mockResolvedValue({ configured: false });

    const url = await resolveAppleExactPreviewUrl({
      artists: ["Krakota"],
      isrc: "GBXXX123",
      title: "Sea Air",
    });

    expect(url).toBeUndefined();
    // No real HTTP happened, so the shared budget is not charged.
    expect(recordAppleCall).not.toHaveBeenCalled();
    expect(recordAppleAuthOutcome).not.toHaveBeenCalled();
  });

  it("aborts on the per-request timeout and falls through (records the OTHER regime)", async () => {
    // The oracle honours the AbortSignal exactly as a real fetch would: it hangs until
    // the rung's timeout aborts the controller, then surfaces a plain non-ok outcome.
    vi.mocked(appleCatalogLookupByIsrcs).mockImplementation(
      (_isrcs: string[], signal?: AbortSignal) =>
        new Promise((resolve) => {
          const settle = () =>
            resolve({ configured: true, error: "aborted", ok: false, rateLimited: false });

          if (signal?.aborted) {
            settle();
          } else {
            signal?.addEventListener("abort", settle);
          }
        }),
    );

    const url = await resolveAppleExactPreviewUrl(
      { artists: ["Krakota"], isrc: "GBXXX123", title: "Sea Air" },
      10,
    );

    expect(url).toBeUndefined();
    // A timeout-abort is the OTHER regime — it must NOT advance the breaker's auth streak.
    expect(recordAppleAuthOutcome).toHaveBeenCalledWith("other", expect.any(Number));
  });

  it("records an auth failure so a live-rung suspension trips the shared breaker", async () => {
    vi.mocked(appleCatalogLookupByIsrcs).mockResolvedValue({
      authFailed: true,
      configured: true,
      error: "403 Forbidden",
      ok: false,
      rateLimited: false,
    });

    const url = await resolveAppleExactPreviewUrl({
      artists: ["Krakota"],
      isrc: "GBXXX123",
      title: "Sea Air",
    });

    expect(url).toBeUndefined();
    expect(recordAppleAuthOutcome).toHaveBeenCalledWith("auth_failure", expect.any(Number));
  });
});

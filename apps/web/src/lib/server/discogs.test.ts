import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discogsReleaseUrl, discogsResolveRelease } from "@/lib/server/discogs";

describe("discogsReleaseUrl", () => {
  it("builds the public release URL the per-track sameAs points at", () => {
    expect(discogsReleaseUrl(12345)).toBe("https://www.discogs.com/release/12345");
  });
});

describe("discogsResolveRelease (read-only, best-effort)", () => {
  const ORIGINAL_TOKEN = process.env.DISCOGS_USER_TOKEN;

  beforeEach(() => {
    process.env.DISCOGS_USER_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.DISCOGS_USER_TOKEN;
    } else {
      process.env.DISCOGS_USER_TOKEN = ORIGINAL_TOKEN;
    }
  });

  it("returns the top release hit's release + master ids", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        Response.json({ results: [{ id: 555, master_id: 42 }, { id: 999 }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await discogsResolveRelease("Teddy Killerz", "Gate");

    expect(result).toEqual({ masterId: 42, releaseId: 555 });

    // Authenticated search, by artist + track, with the identifiable User-Agent.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/database/search");
    expect(url).toContain("type=release");
    expect(init?.headers).toMatchObject({
      Authorization: "Discogs token=test-token",
    });
  });

  it("normalizes a 0 master_id (no master) to undefined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ results: [{ id: 7, master_id: 0 }] })),
    );

    expect(await discogsResolveRelease("Artist", "Title")).toEqual({ releaseId: 7 });
  });

  it("no-ops without a token (the column stays inert until provisioned)", async () => {
    delete process.env.DISCOGS_USER_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await discogsResolveRelease("Artist", "Title")).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves to {} on a miss (no results), a non-2xx, or a thrown fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ results: [] })),
    );
    expect(await discogsResolveRelease("Artist", "Title")).toEqual({});

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );
    expect(await discogsResolveRelease("Artist", "Title")).toEqual({});

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await discogsResolveRelease("Artist", "Title")).toEqual({});
  });

  it("skips blank artist/title without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await discogsResolveRelease("  ", "Title")).toEqual({});
    expect(await discogsResolveRelease("Artist", "  ")).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLivePreview } from "./preview-live";

vi.mock("./deezer", () => ({
  enrichFromDeezer: vi.fn(async () => ({ previewUrl: "https://deezer.example/fresh.mp3" })),
}));

describe("fetchLivePreview", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("falls through stored Deezer and refreshed Deezer to iTunes without touching R2", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof Request ? url.url : url.href;

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

      return new Response(undefined, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

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
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("itunes.apple.com/search"),
      expect.any(Object),
    );
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beatportSearchUrl } from "../beatport";
import {
  parseSearchTracks,
  parseTrackLinks,
  pickBeatportUrl,
  resolveBeatportUrl,
} from "./beatport-resolve";

vi.mock("./env", () => ({ readOptionalEnv: vi.fn(async () => "test-key") }));

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "__fixtures__", "beatport", name), "utf8");
}

const PLUTO = fixture("search-pluto.html");
const VENUS_FLY = fixture("search-venus-fly.html");

describe("beatportSearchUrl", () => {
  it("builds the same query the buy-then-mix link already uses", () => {
    expect(beatportSearchUrl(["Rizzle"], "Pluto")).toBe(
      "https://www.beatport.com/search?q=Rizzle%20Pluto",
    );
    expect(beatportSearchUrl(["Alpha Rhythm", "Ritual", "Seba"], "Venus Fly - Seba Remix")).toBe(
      "https://www.beatport.com/search?q=Alpha%20Rhythm%20Ritual%20Seba%20Venus%20Fly%20-%20Seba%20Remix",
    );
  });
});

describe("parseSearchTracks", () => {
  it("reads Beatport's own result objects out of the page data", () => {
    const tracks = parseSearchTracks(PLUTO);

    expect(tracks).not.toBeNull();
    expect(tracks?.length).toBeGreaterThan(0);
    expect(tracks?.[0]?.isrc).toBe("CA5KR2489434");
  });

  it("returns null — never an empty list — when the data island is missing or broken", () => {
    expect(parseSearchTracks("<html><body>no island here</body></html>")).toBeNull();
    expect(
      parseSearchTracks('<script id="__NEXT_DATA__" type="application/json">{oops</script>'),
    ).toBeNull();
    expect(
      parseSearchTracks('<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>'),
    ).toBeNull();
  });
});

describe("parseTrackLinks", () => {
  it("maps each result id to the link Beatport itself rendered", () => {
    const links = parseTrackLinks(PLUTO);

    expect(links.get("19385810")).toBe("https://www.beatport.com/track/pluto/19385810");
  });

  it("keeps the first link for an id that appears more than once", () => {
    const html =
      '<a href="https://www.beatport.com/track/pluto/19385810"></a>' +
      '<a href="https://www.beatport.com/track/pluto-again/19385810"></a>';

    expect(parseTrackLinks(html).get("19385810")).toBe(
      "https://www.beatport.com/track/pluto/19385810",
    );
  });
});

describe("pickBeatportUrl", () => {
  it("returns the URL of the result whose ISRC matches exactly", () => {
    expect(pickBeatportUrl(PLUTO, "CA5KR2489434")).toEqual({
      ok: true,
      url: "https://www.beatport.com/track/pluto/19385810",
    });
  });

  it("matches a remix on its own ISRC, not on its title", () => {
    expect(pickBeatportUrl(VENUS_FLY, "NLCK42416396")).toEqual({
      ok: true,
      url: "https://www.beatport.com/track/venus-fly/19501138",
    });
  });

  it("normalises case and surrounding whitespace before comparing", () => {
    expect(pickBeatportUrl(PLUTO, "  ca5kr2489434  ")).toEqual({
      ok: true,
      url: "https://www.beatport.com/track/pluto/19385810",
    });
  });

  it("misses cleanly when no result carries the ISRC", () => {
    expect(pickBeatportUrl(PLUTO, "GBAAA0000001")).toEqual({ ok: true, url: null });
  });

  it("never returns a URL belonging to a different recording on the same page", () => {
    const picked = pickBeatportUrl(PLUTO, "CA5KR2489434");
    const others = (parseSearchTracks(PLUTO) ?? [])
      .filter((track) => track.isrc !== "CA5KR2489434")
      .map((track) => parseTrackLinks(PLUTO).get(String(track.track_id)));

    expect(picked).toHaveProperty("url", "https://www.beatport.com/track/pluto/19385810");
    expect(others).not.toContain("https://www.beatport.com/track/pluto/19385810");
  });

  it("misses cleanly when the ISRC matches a result Beatport rendered no link for", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({
        props: {
          pageProps: {
            dehydratedState: {
              queries: [
                {
                  state: { data: { tracks: { data: [{ isrc: "CA5KR2489434", track_id: 999 }] } } },
                },
              ],
            },
          },
        },
      }) +
      "</script>";

    expect(pickBeatportUrl(html, "CA5KR2489434")).toEqual({ ok: true, url: null });
  });

  it("reports a shape failure rather than a miss when the page cannot be read", () => {
    expect(pickBeatportUrl("<html><body>403</body></html>", "CA5KR2489434")).toEqual({ ok: false });
  });

  it("treats a genuinely empty result list as a clean miss", () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({
        props: {
          pageProps: {
            dehydratedState: { queries: [{ state: { data: { tracks: { data: [] } } } }] },
          },
        },
      }) +
      "</script>";

    expect(pickBeatportUrl(html, "CA5KR2489434")).toEqual({ ok: true, url: null });
  });
});

describe("resolveBeatportUrl request failures", () => {
  const input = { artists: ["Rizzle"], isrc: "CA5KR2489434", title: "Pluto" };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("resolves a scraped result at the Promise boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { rawHtml: PLUTO } })),
    );

    await expect(resolveBeatportUrl(input)).resolves.toEqual({
      configured: true,
      ok: true,
      url: "https://www.beatport.com/track/pluto/19385810",
    });
  });

  it.each([
    {
      event: "beatport.scrape-failed",
      failure: "BeatportHttpError",
      response: new Response(null, { status: 503 }),
    },
    {
      event: "beatport.scrape-error",
      failure: "BeatportParseError",
      response: new Response("invalid JSON"),
    },
    {
      event: "beatport.scrape-error",
      failure: "BeatportParseError",
      response: Response.json({ data: {} }),
    },
    {
      event: "beatport.scrape-error",
      failure: "BeatportNetworkError",
      response: new TypeError("network down"),
    },
  ])("keeps the scrape failure and diagnoses $failure", async ({ event, failure, response }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (response instanceof Error) {
          throw response;
        }

        return response;
      }),
    );

    await expect(resolveBeatportUrl(input)).resolves.toEqual({
      configured: true,
      error: "beatport search scrape failed",
      ok: false,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`"event":"${event}"`));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`"failure":"${failure}"`));
  });

  it("keeps the page-shape failure distinct from a clean miss", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { rawHtml: "<html></html>" } })),
    );

    await expect(resolveBeatportUrl(input)).resolves.toEqual({
      configured: true,
      error: "beatport search page shape not recognised",
      ok: false,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"failure":"BeatportParseError"'));
  });

  it.each(["request", "body"])(
    "aborts a stalled %s within the complete deadline",
    async (phase) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let signal: AbortSignal | null | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: RequestInfo | URL, init: RequestInit) => {
          signal = init.signal;

          if (phase === "request") {
            return new Promise<Response>(() => {});
          }

          await new Promise((resolve) => setTimeout(resolve, 10_000));

          return {
            json: () => new Promise(() => {}),
            ok: true,
          } as unknown as Response;
        }),
      );
      const pending = resolveBeatportUrl(input);

      await vi.advanceTimersByTimeAsync(45_000);

      await expect(pending).resolves.toEqual({
        configured: true,
        error: "beatport search scrape failed",
        ok: false,
      });
      expect(signal?.aborted).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"failure":"BeatportTimeout"'));
    },
  );
});

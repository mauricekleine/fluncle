import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setRateLimitForTests,
  discogsReleaseUrl,
  discogsResolveRelease,
} from "@/lib/server/discogs";

describe("discogsReleaseUrl", () => {
  it("builds the public release URL the per-track sameAs points at", () => {
    expect(discogsReleaseUrl(12345)).toBe("https://www.discogs.com/release/12345");
  });
});

// A tiny URL-routing fetch mock: map a substring of the request URL to a JSON
// body (or a Response). Anything unmatched 404s, which the resolver treats as a
// miss. Keeps each test declarative about exactly which endpoints it stubs.
function mockFetch(routes: Array<{ match: string; body?: unknown; response?: Response }>) {
  const calls: string[] = [];

  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    calls.push(url);

    const route = routes.find((candidate) => url.includes(candidate.match));

    if (!route) {
      return new Response("not found", { status: 404 });
    }

    if (route.response) {
      return route.response;
    }

    return Response.json(route.body);
  });

  vi.stubGlobal("fetch", fetchMock);

  return { calls, fetchMock };
}

const DISCOGS_SEARCH = "/database/search";
const DISCOGS_RELEASE = "/releases/";
const MB_ISRC = "musicbrainz.org/ws/2/isrc/";

describe("discogsResolveRelease (scored cascade + tracklist gate)", () => {
  const ORIGINAL_TOKEN = process.env.DISCOGS_USER_TOKEN;

  beforeEach(() => {
    process.env.DISCOGS_USER_TOKEN = "test-token";
    // Run the rate limiter + retry backoff with zero real waits.
    __setRateLimitForTests(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __setRateLimitForTests(1100);

    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.DISCOGS_USER_TOKEN;
    } else {
      process.env.DISCOGS_USER_TOKEN = ORIGINAL_TOKEN;
    }
  });

  // ─────────────── MusicBrainz bridge (primary) ───────────────

  it("bridges via a human-verified MusicBrainz Discogs relation when the title matches", async () => {
    mockFetch([
      {
        body: {
          recordings: [
            {
              id: "rec-1",
              relations: [
                { type: "discogs", url: { resource: "https://www.discogs.com/release/16449783" } },
              ],
              title: "Do U?",
            },
          ],
        },
        match: MB_ISRC,
      },
    ]);

    const result = await discogsResolveRelease({
      artists: ["Ownglow"],
      isrc: "GB000ABC0001",
      title: "Do U?",
    });

    // Accepted directly from MB — no Discogs search needed.
    expect(result).toEqual({ releaseId: 16449783 });
  });

  it("follows the relation on a release, then its release-group, sending an identifiable UA", async () => {
    const { calls } = mockFetch([
      {
        body: {
          recordings: [{ id: "rec-1", releases: [{ id: "rel-1" }], title: "Take Me There" }],
        },
        match: MB_ISRC,
      },
      {
        // Release detail carries no Discogs relation but points at a release-group.
        body: { id: "rel-1", relations: [], "release-group": { id: "rg-1" } },
        match: "/ws/2/release/rel-1",
      },
      {
        // The release-group holds the curated Discogs master link.
        body: {
          id: "rg-1",
          relations: [
            { type: "discogs", url: { resource: "https://www.discogs.com/master/99887" } },
          ],
        },
        match: "/ws/2/release-group/rg-1",
      },
    ]);

    const result = await discogsResolveRelease({
      artists: ["Krakota"],
      isrc: "GB000ABC0002",
      title: "Take Me There",
    });

    expect(result).toEqual({ masterId: 99887 });
    // MusicBrainz requires an identifiable User-Agent.
    expect(calls.some((url) => url.includes("musicbrainz.org"))).toBe(true);
  });

  it("never bridges a mismatched recording title (bad/shared ISRC)", async () => {
    // MB returns a recording for the ISRC, but its title is a different track —
    // the bridge must refuse and fall through to the Discogs search (which here
    // finds nothing), so the finding stays unresolved.
    mockFetch([
      {
        body: {
          recordings: [
            {
              id: "rec-x",
              relations: [
                { type: "discogs", url: { resource: "https://www.discogs.com/release/111" } },
              ],
              title: "A Completely Different Song",
            },
          ],
        },
        match: MB_ISRC,
      },
      { body: { results: [] }, match: DISCOGS_SEARCH },
    ]);

    expect(
      await discogsResolveRelease({
        artists: ["Archangel"],
        isrc: "GB000BAD0001",
        title: "Run To You",
      }),
    ).toEqual({});
  });

  // ─────────────── Discogs search fallback + tracklist gate ───────────────

  it("stores the release on a confident, tracklist-confirmed Discogs match", async () => {
    mockFetch([
      { body: { recordings: [] }, match: MB_ISRC }, // MB has nothing → fall through
      { body: { results: [{ id: 555, master_id: 42 }] }, match: DISCOGS_SEARCH },
      {
        body: {
          artists: [{ name: "Ownglow" }],
          formats: [{ name: "Single" }],
          id: 555,
          master_id: 42,
          styles: ["Drum n Bass"],
          title: "Do U?",
          tracklist: [{ title: "Do U?" }, { title: "Do U? (VIP)" }],
          year: 2021,
        },
        match: `${DISCOGS_RELEASE}555`,
      },
    ]);

    const result = await discogsResolveRelease({
      artists: ["Ownglow"],
      isrc: "GB000ABC0001",
      releaseDate: "2021-05-01",
      title: "Do U?",
    });

    expect(result).toEqual({ masterId: 42, releaseId: 555 });
  });

  it("THE GATE: rejects a top hit whose tracklist does not contain the title (VA-comp false match)", async () => {
    mockFetch([
      { body: { recordings: [] }, match: MB_ISRC },
      // Discogs' top hit is a wrong release — a compilation/edit that does NOT
      // contain the actual track. Old code stored this blindly; the gate kills it.
      { body: { results: [{ id: 777, master_id: 0 }] }, match: DISCOGS_SEARCH },
      {
        body: {
          artists: [{ name: "Hypnoman" }],
          id: 777,
          title: "Hypnoman's Dimension - Jungle Revolution",
          tracklist: [{ title: "Some Other Tune" }, { title: "Jungle Revolution" }],
          year: 1994,
        },
        match: `${DISCOGS_RELEASE}777`,
      },
    ]);

    // Wrong artist + the title "Revolution" is not a tracklist entry → unresolved,
    // NOT the wrong release.
    expect(
      await discogsResolveRelease({
        artists: ["Dimension"],
        isrc: "GB000ABC0003",
        title: "Revolution",
      }),
    ).toEqual({});
  });

  it("stays unresolved when the tracklist confirms but the artist is wrong (below threshold)", async () => {
    mockFetch([
      { body: { recordings: [] }, match: MB_ISRC },
      { body: { results: [{ id: 888, master_id: 0 }] }, match: DISCOGS_SEARCH },
      {
        body: {
          // Title token matches a track, but a different artist and no other
          // corroboration keeps the score under CONFIDENCE_THRESHOLD.
          artists: [{ name: "Someone Else Entirely" }],
          id: 888,
          title: "Various",
          tracklist: [{ title: "Revolution" }],
        },
        match: `${DISCOGS_RELEASE}888`,
      },
    ]);

    expect(
      await discogsResolveRelease({
        artists: ["Dimension"],
        isrc: "GB000ABC0003",
        title: "Revolution",
      }),
    ).toEqual({});
  });

  it("normalizes a 0 master_id (no master) to undefined", async () => {
    mockFetch([
      { body: { recordings: [] }, match: MB_ISRC },
      { body: { results: [{ id: 7, master_id: 0 }] }, match: DISCOGS_SEARCH },
      {
        body: {
          artists: [{ name: "Artist" }],
          formats: [{ name: "Single" }],
          id: 7,
          master_id: 0,
          styles: ["Drum n Bass"],
          title: "Title",
          tracklist: [{ title: "Title" }],
          year: 2020,
        },
        match: `${DISCOGS_RELEASE}7`,
      },
    ]);

    expect(
      await discogsResolveRelease({
        artists: ["Artist"],
        releaseDate: "2020",
        title: "Title",
      }),
    ).toEqual({ releaseId: 7 });
  });

  // ─────────────── degradation / safety ───────────────

  it("no-ops without a token once MB has nothing (the column stays inert)", async () => {
    delete process.env.DISCOGS_USER_TOKEN;
    const { fetchMock } = mockFetch([{ body: { recordings: [] }, match: MB_ISRC }]);

    expect(
      await discogsResolveRelease({ artists: ["Artist"], isrc: "GB000ABC0001", title: "Title" }),
    ).toEqual({});
    // It may probe MB (no token needed) but must not hit the token-gated Discogs API.
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("api.discogs.com"))).toBe(
      true,
    );
  });

  it("resolves to {} on a clean miss or a thrown fetch", async () => {
    mockFetch([
      { body: { recordings: [] }, match: MB_ISRC },
      { body: { results: [] }, match: DISCOGS_SEARCH },
    ]);
    expect(await discogsResolveRelease({ artists: ["Artist"], title: "Title" })).toEqual({});

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await discogsResolveRelease({ artists: ["Artist"], title: "Title" })).toEqual({});
  });

  it("flags `rateLimited` when the vendor exhausts the 429 retries (backoff signal)", async () => {
    // Every call 429s past its in-slot retries → the resolution is unresolved
    // BECAUSE we were throttled, not because there's no match. The backfill reads
    // this to back the finding off hard instead of re-storming it next tick.
    mockFetch([
      { match: MB_ISRC, response: new Response("rate limited", { status: 429 }) },
      { match: DISCOGS_SEARCH, response: new Response("rate limited", { status: 429 }) },
    ]);
    expect(await discogsResolveRelease({ artists: ["Artist"], title: "Title" })).toEqual({
      rateLimited: true,
    });
  });

  it("skips blank artist/title without calling any API", async () => {
    const { fetchMock } = mockFetch([]);

    expect(await discogsResolveRelease({ artists: ["  "], title: "Title" })).toEqual({});
    expect(await discogsResolveRelease({ artists: ["Artist"], title: "  " })).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the legacy (artist, title) positional form", async () => {
    mockFetch([
      { body: { results: [{ id: 7, master_id: 0 }] }, match: DISCOGS_SEARCH },
      {
        body: {
          artists: [{ name: "Teddy Killerz" }],
          formats: [{ name: "Single" }],
          id: 7,
          styles: ["Drum n Bass"],
          title: "Gate",
          tracklist: [{ title: "Gate" }],
        },
        match: `${DISCOGS_RELEASE}7`,
      },
    ]);

    // No ISRC in the legacy form → MB bridge is skipped, straight to the search.
    expect(await discogsResolveRelease("Teddy Killerz", "Gate")).toEqual({ releaseId: 7 });
  });

  it("trips the rate-limit signal proactively when X-Discogs-Ratelimit-Remaining is spent", async () => {
    const { calls } = mockFetch([
      {
        match: DISCOGS_SEARCH,
        response: Response.json(
          { results: [] },
          { headers: { "X-Discogs-Ratelimit-Remaining": "0" } },
        ),
      },
    ]);

    // Budget spent → reported throttled (not a clean miss), so the backfill's
    // circuit breaker stops the run instead of storming; the search is not re-fired
    // across the other query variants.
    expect(await discogsResolveRelease("IYRE", "Glowing Embers")).toEqual({ rateLimited: true });
    expect(calls.filter((url) => url.includes(DISCOGS_SEARCH))).toHaveLength(1);
  });
});

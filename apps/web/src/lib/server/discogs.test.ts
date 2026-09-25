import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setRateLimitForTests,
  verifyDiscogsLabelEvidence,
  discogsReleaseUrl,
  discogsResolveRelease,
  fetchDiscogsLabelImage,
  fetchDiscogsReleaseFacts,
  parseDiscogsLabelUrl,
  scoreDiscogsReleaseCandidates,
} from "@/lib/server/discogs";

describe("discogsReleaseUrl", () => {
  it("builds the public release URL the per-track sameAs points at", () => {
    expect(discogsReleaseUrl(12345)).toBe("https://www.discogs.com/release/12345");
  });
});

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

describe("box-fetched Discogs evidence", () => {
  it("runs release evidence through the existing score and tracklist gate", () => {
    const result = scoreDiscogsReleaseCandidates(
      {
        album: "Shelf Life 7",
        artists: ["Calibre"],
        label: "Hospital Records",
        releaseDate: "2026-01-01",
        title: "Funny Games",
      },
      [
        {
          artists: [{ name: "Someone Else" }],
          formats: [{ name: "Vinyl" }],
          id: 1,
          labels: [{ name: "Other" }],
          styles: ["Drum n Bass"],
          title: "Wrong",
          tracklist: [{ title: "Wrong Track" }],
          year: 2026,
        },
        {
          artists: [{ name: "Calibre" }],
          formats: [{ name: "Vinyl" }],
          id: 2,
          labels: [{ catno: "NHS001", name: "Hospital Records" }],
          searchMasterId: 9,
          styles: ["Drum n Bass"],
          title: "Shelf Life 7",
          tracklist: [{ title: "Funny Games" }],
          year: 2026,
        },
      ],
    );

    expect(result).toEqual({
      catno: "NHS001",
      masterId: 9,
      releaseId: 2,
      styles: ["Drum n Bass"],
    });
    expect(
      scoreDiscogsReleaseCandidates({ artists: ["Calibre"], title: "Funny Games" }, [
        {
          artists: [{ name: "Someone Else" }],
          formats: [],
          id: 3,
          labels: [],
          styles: [],
          title: "Unrelated",
          tracklist: [{ title: "Another Tune" }],
        },
      ]),
    ).toEqual({});
  });

  it("repeats the primary-image decision and rejects cross-wired box bytes", () => {
    const candidate = {
      detail: {
        id: 11,
        images: [
          { type: "secondary" as const, uri: "https://i.discogs.com/secondary.jpg" },
          { type: "primary" as const, uri: "https://i.discogs.com/primary.jpg" },
        ],
      },
      discogsLabelId: 11,
      image: {
        bytesBase64: "/9j/4AAQ",
        mime: "image/jpeg",
        uri: "https://i.discogs.com/primary.jpg",
      },
      slug: "hospital",
    };

    const accepted = verifyDiscogsLabelEvidence(candidate);
    expect(accepted.kind).toBe("image");
    if (accepted.kind !== "image") {
      throw new Error("expected a verified label image");
    }
    expect(accepted.image.mime).toBe("image/jpeg");
    expect(accepted.image.bytes.byteLength).toBe(6);
    expect(
      verifyDiscogsLabelEvidence({
        ...candidate,
        image: { ...candidate.image, uri: "https://i.discogs.com/secondary.jpg" },
      }),
    ).toEqual({ kind: "invalid" });
    expect(
      verifyDiscogsLabelEvidence({
        ...candidate,
        detail: { ...candidate.detail, id: 12 },
      }),
    ).toEqual({ kind: "invalid" });
    expect(
      verifyDiscogsLabelEvidence({
        ...candidate,
        detail: {
          ...candidate.detail,
          images: [{ type: "primary", uri: "https://attacker.example/logo.jpg" }],
        },
        image: { ...candidate.image, uri: "https://attacker.example/logo.jpg" },
      }),
    ).toEqual({ kind: "invalid" });
  });

  it("stores the type the bytes ARE, never the type the box claims", () => {
    const candidate = {
      detail: {
        id: 11,
        images: [{ type: "primary" as const, uri: "https://i.discogs.com/l.jpg" }],
      },
      discogsLabelId: 11,
      image: { bytesBase64: "/9j/4AAQ", mime: "image/jpeg", uri: "https://i.discogs.com/l.jpg" },
      slug: "hospital",
    };

    const withBytes = (bytesBase64: string, mime = "image/jpeg") =>
      verifyDiscogsLabelEvidence({
        ...candidate,
        image: { ...candidate.image, bytesBase64, mime },
      });

    expect(
      withBytes(
        "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=",
        "image/svg+xml",
      ),
    ).toEqual({ kind: "invalid" });

    expect(
      withBytes(
        "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=",
      ),
    ).toEqual({ kind: "invalid" });

    expect(withBytes("AQID")).toEqual({ kind: "invalid" });
    expect(withBytes("")).toEqual({ kind: "invalid" });

    expect(withBytes("UklGRiQAAABXQVZF", "image/webp")).toEqual({ kind: "invalid" });
    expect(withBytes("UklGRiQAAABXRUJQ", "image/webp")).toMatchObject({
      image: { mime: "image/webp" },
      kind: "image",
    });

    expect(withBytes("iVBORw0KGgoAAA==", "image/png")).toMatchObject({
      image: { mime: "image/png" },
      kind: "image",
    });
    expect(withBytes("R0lGODlh", "image/gif")).toMatchObject({
      image: { mime: "image/gif" },
      kind: "image",
    });

    expect(withBytes("iVBORw0KGgoAAA==", "image/jpg")).toMatchObject({
      image: { mime: "image/png" },
      kind: "image",
    });
  });
});

describe("discogsResolveRelease (scored cascade + tracklist gate)", () => {
  const ORIGINAL_TOKEN = process.env.DISCOGS_USER_TOKEN;

  beforeEach(() => {
    process.env.DISCOGS_USER_TOKEN = "test-token";

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
        body: { id: "rel-1", relations: [], "release-group": { id: "rg-1" } },
        match: "/ws/2/release/rel-1",
      },
      {
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

    expect(calls.some((url) => url.includes("musicbrainz.org"))).toBe(true);
  });

  it("never bridges a mismatched recording title (bad/shared ISRC)", async () => {
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

  it("stores the release on a confident, tracklist-confirmed Discogs match", async () => {
    mockFetch([
      { body: { recordings: [] }, match: MB_ISRC },
      { body: { results: [{ id: 555, master_id: 42 }] }, match: DISCOGS_SEARCH },
      {
        body: {
          artists: [{ name: "Ownglow" }],
          formats: [{ name: "Single" }],
          id: 555,
          labels: [{ catno: "VPR079", name: "Viper Recordings" }],
          master_id: 42,
          styles: ["Drum n Bass", "Jungle"],
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

    expect(result).toEqual({
      catno: "VPR079",
      masterId: 42,
      releaseId: 555,
      styles: ["Drum n Bass", "Jungle"],
    });
  });

  it("THE GATE: rejects a top hit whose tracklist does not contain the title (VA-comp false match)", async () => {
    mockFetch([
      { body: { recordings: [] }, match: MB_ISRC },

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
    ).toEqual({ releaseId: 7, styles: ["Drum n Bass"] });
  });

  it("no-ops without a token once MB has nothing (the column stays inert)", async () => {
    delete process.env.DISCOGS_USER_TOKEN;
    const { fetchMock } = mockFetch([{ body: { recordings: [] }, match: MB_ISRC }]);

    expect(
      await discogsResolveRelease({ artists: ["Artist"], isrc: "GB000ABC0001", title: "Title" }),
    ).toEqual({});

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
    mockFetch([
      { match: MB_ISRC, response: new Response("rate limited", { status: 429 }) },
      { match: DISCOGS_SEARCH, response: new Response("rate limited", { status: 429 }) },
    ]);
    expect(await discogsResolveRelease({ artists: ["Artist"], title: "Title" })).toEqual({
      rateLimited: true,
      rateLimitedBy: "discogs",
    });
  });

  it("names MusicBrainz when its brake stops the Discogs resolver", async () => {
    mockFetch([
      {
        match: MB_ISRC,
        response: new Response("service unavailable", { status: 503 }),
      },
    ]);

    expect(
      await discogsResolveRelease({
        artists: ["Artist"],
        isrc: "GB000ABC0001",
        title: "Title",
      }),
    ).toEqual({
      rateLimited: true,
      rateLimitedBy: "musicbrainz",
    });
  });

  it("skips blank artist/title without calling any API", async () => {
    const { fetchMock } = mockFetch([]);

    expect(await discogsResolveRelease({ artists: ["  "], title: "Title" })).toEqual({});
    expect(await discogsResolveRelease({ artists: ["Artist"], title: "  " })).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("searches Discogs directly when the input has no ISRC", async () => {
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

    expect(await discogsResolveRelease({ artists: ["Teddy Killerz"], title: "Gate" })).toEqual({
      releaseId: 7,
      styles: ["Drum n Bass"],
    });
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

    expect(await discogsResolveRelease({ artists: ["IYRE"], title: "Glowing Embers" })).toEqual({
      rateLimited: true,
      rateLimitedBy: "discogs",
    });
    expect(calls.filter((url) => url.includes(DISCOGS_SEARCH))).toHaveLength(1);
  });
});

describe("fetchDiscogsReleaseFacts", () => {
  const ORIGINAL_TOKEN = process.env.DISCOGS_USER_TOKEN;

  beforeEach(() => {
    process.env.DISCOGS_USER_TOKEN = "test-token";
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

  it("reads the catalogue number + styles off a resolved release", async () => {
    mockFetch([
      {
        body: {
          id: 6414598,
          labels: [{ catno: "RAMM123", name: "RAM Records" }],
          styles: ["Drum n Bass", "Neurofunk"],
          title: "Gate",
        },
        match: `${DISCOGS_RELEASE}6414598`,
      },
    ]);

    expect(await fetchDiscogsReleaseFacts(6414598, "test-token")).toEqual({
      facts: { catno: "RAMM123", styles: ["Drum n Bass", "Neurofunk"] },
      found: true,
      rateLimited: false,
    });
  });

  it("DROPS Discogs' literal 'none' rather than storing it as a number", async () => {
    mockFetch([
      {
        body: { id: 42, labels: [{ catno: "none", name: "Not On Label" }], styles: ["Jungle"] },
        match: `${DISCOGS_RELEASE}42`,
      },
    ]);

    const outcome = await fetchDiscogsReleaseFacts(42, "test-token");

    expect(outcome.found).toBe(true);
    expect(outcome.facts).toEqual({ styles: ["Jungle"] });
  });

  it("takes the first label that carries a real number on a co-release", async () => {
    mockFetch([
      {
        body: {
          id: 43,
          labels: [
            { catno: "  ", name: "Blank" },
            { catno: "HOSPCD01", name: "Hospital Records" },
            { catno: "SECOND02", name: "Licensee" },
          ],
        },
        match: `${DISCOGS_RELEASE}43`,
      },
    ]);

    expect((await fetchDiscogsReleaseFacts(43, "test-token")).facts).toEqual({
      catno: "HOSPCD01",
    });
  });

  it("reports a release it could not read as NOT FOUND, distinctly from a throttle", async () => {
    mockFetch([{ match: `${DISCOGS_RELEASE}44`, response: new Response("gone", { status: 404 }) }]);

    expect(await fetchDiscogsReleaseFacts(44, "test-token")).toEqual({
      found: false,
      rateLimited: false,
    });
  });

  it("reports a 429 as THROTTLED so the pass stops instead of stamping the album", async () => {
    mockFetch([
      { match: `${DISCOGS_RELEASE}45`, response: new Response("slow down", { status: 429 }) },
    ]);

    expect(await fetchDiscogsReleaseFacts(45, "test-token")).toEqual({
      found: false,
      rateLimited: true,
    });
  });
});

describe("parseDiscogsLabelUrl", () => {
  it("parses a Discogs label id from a label URL (with or without the slug tail)", () => {
    expect(parseDiscogsLabelUrl("https://www.discogs.com/label/1111-Hospital-Records")).toBe(1111);
    expect(parseDiscogsLabelUrl("https://www.discogs.com/label/2222")).toBe(2222);
  });

  it("returns undefined for a release/master URL or an unrelated string", () => {
    expect(parseDiscogsLabelUrl("https://www.discogs.com/release/12345")).toBeUndefined();
    expect(parseDiscogsLabelUrl("https://www.discogs.com/master/999")).toBeUndefined();
    expect(parseDiscogsLabelUrl("https://example.com/label/1")).toBeUndefined();
  });
});

describe("fetchDiscogsLabelImage (the label logo download)", () => {
  beforeEach(() => {
    __setRateLimitForTests(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __setRateLimitForTests(1100);
  });

  it("fetches the label's primary image and downloads its bytes (authed, never hotlinked)", async () => {
    const { calls } = mockFetch([
      {
        body: {
          id: 1111,
          images: [
            { type: "secondary", uri: "https://i.discogs.com/secondary.jpg" },
            { type: "primary", uri: "https://i.discogs.com/primary.jpg" },
          ],
        },
        match: "api.discogs.com/labels/1111",
      },
      {
        match: "i.discogs.com/primary.jpg",
        response: new Response(new ArrayBuffer(64), {
          headers: { "content-type": "image/jpeg" },
          status: 200,
        }),
      },
    ]);

    const result = await fetchDiscogsLabelImage(1111, "test-token");

    expect(result.rateLimited).toBe(false);
    expect(result.image?.mime).toBe("image/jpeg");
    expect(result.image?.bytes.byteLength).toBe(64);

    expect(calls.some((url) => url.includes("i.discogs.com/primary.jpg"))).toBe(true);
  });

  it("returns no image when the label carries none", async () => {
    mockFetch([{ body: { id: 1111, images: [] }, match: "api.discogs.com/labels/1111" }]);

    const result = await fetchDiscogsLabelImage(1111, "test-token");

    expect(result.image).toBeUndefined();
    expect(result.rateLimited).toBe(false);
  });

  it("reports rateLimited when the image download 429s", async () => {
    mockFetch([
      {
        body: { id: 1111, images: [{ type: "primary", uri: "https://i.discogs.com/primary.jpg" }] },
        match: "api.discogs.com/labels/1111",
      },
      {
        match: "i.discogs.com/primary.jpg",
        response: new Response("rate limited", { status: 429 }),
      },
    ]);

    const result = await fetchDiscogsLabelImage(1111, "test-token");

    expect(result.image).toBeUndefined();
    expect(result.rateLimited).toBe(true);
  });
});

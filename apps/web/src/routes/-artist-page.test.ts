import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FindingsGrid } from "@/components/graph-sections";

const getPublicArtistBySlug = vi.hoisted(() => vi.fn());
const getPublicArtistSocials = vi.hoisted(() => vi.fn());
const getPublicArtistAliasNames = vi.hoisted(() => vi.fn());
const countArtistFindings = vi.hoisted(() => vi.fn());
const getFindingsByArtist = vi.hoisted(() => vi.fn());
const getArtistNeighbours = vi.hoisted(() => vi.fn());
const listArtistCatalogue = vi.hoisted(() => vi.fn());
const listArtistUpcoming = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/artists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/artists")>()),
  countArtistFindings,
  getPublicArtistAliasNames,
  getPublicArtistBySlug,
  getPublicArtistSocials,
}));

vi.mock("@/lib/server/tracks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/tracks")>()),
  getFindingsByArtist,
}));

vi.mock("@/lib/server/catalogue-groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/catalogue-groups")>()),
  listArtistCatalogue,
  listArtistUpcoming,
}));

const NO_CATALOGUE = { groups: [], page: 1, pageCount: 1, totalGroups: 0, totalTracks: 0 };
const THIN_CATALOGUE = {
  ...NO_CATALOGUE,
  groups: [{ name: "A record", tracks: [{ artists: ["Drift"], title: "One", trackId: "one" }] }],
  totalGroups: 1,
  totalTracks: 1,
};

vi.mock("@/lib/server/artist-dossier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/artist-dossier")>()),
  getArtistNeighbours,
}));

const { ARTIST_CATALOGUE_SORT_DEFAULT, Route } = await import("./artist.$slug");

const { resolveArtistPageData } = await import("./-artist-page-data");

const ARTIST = {
  discogsUrl: undefined,
  id: "artist-drift",
  lastfmUrl: undefined,
  mbid: undefined,
  name: "Drift",
  renderableTrackCount: 1,
  slug: "drift",
  spotifyUrl: undefined,
  wikidataQid: undefined,
};

function finding(logId: string, extra: { addedAt?: string; bpm?: number; key?: string } = {}) {
  return { artists: ["Drift"], logId, title: "Untitled", trackId: `t-${logId}`, ...extra };
}

function headMeta(data: unknown): Array<{ content?: string; name?: string; property?: string }> {
  const head = Route.options.head?.({ loaderData: data } as never) as
    | { meta?: Array<{ content?: string; name?: string; property?: string }> }
    | undefined;

  return head?.meta ?? [];
}

function robotsMeta(data: unknown): string | undefined {
  return headMeta(data).find((entry) => entry.name === "robots")?.content;
}

function metaDescription(data: unknown): string | undefined {
  return headMeta(data).find((entry) => entry.name === "description")?.content;
}

function headTitle(data: unknown): string | undefined {
  return (headMeta(data) as Array<{ title?: string }>).find((entry) => entry.title !== undefined)
    ?.title;
}

function musicGroupFromHead(data: unknown): Record<string, unknown> {
  const head = Route.options.head?.({ loaderData: data } as never) as
    | { scripts?: Array<{ children?: string }> }
    | undefined;
  const payload = head?.scripts?.[0]?.children;

  return payload ? (JSON.parse(payload) as Record<string, unknown>) : {};
}

function resolvedSort(search: { page?: number; sort?: "name" | "recent" }): string {
  const deps = Route.options.loaderDeps?.({ search } as never) as { sort: string } | undefined;

  return deps?.sort ?? "";
}

describe("the artist page catalogue default (latest release first)", () => {
  it("defaults to the 'recent' (Latest release) key — the dropdown's own sort key", () => {
    expect(ARTIST_CATALOGUE_SORT_DEFAULT).toBe("recent");
  });

  it("resolves to latest-release with NO sort param, so a bare /artist/<slug> opens on it", () => {
    expect(resolvedSort({})).toBe("recent");
  });

  it("still round-trips an explicitly chosen sort through the URL", () => {
    expect(resolvedSort({ sort: "name" })).toBe("name");
    expect(resolvedSort({ sort: "recent" })).toBe("recent");
  });
});

describe("resolveArtistPageData (the artist page indexability gate)", () => {
  beforeEach(() => {
    getPublicArtistBySlug.mockReset();
    getPublicArtistSocials.mockReset();
    getPublicArtistAliasNames.mockReset();
    countArtistFindings.mockReset();
    getFindingsByArtist.mockReset();
    getArtistNeighbours.mockReset();
    listArtistCatalogue.mockReset();
    listArtistUpcoming.mockReset();
    getPublicArtistSocials.mockResolvedValue([]);
    getPublicArtistAliasNames.mockResolvedValue([]);
    getArtistNeighbours.mockResolvedValue([]);
    listArtistCatalogue.mockResolvedValue(NO_CATALOGUE);
    listArtistUpcoming.mockResolvedValue({
      findings: [],
      page: 1,
      pageCount: 1,
      total: 0,
      tracks: [],
    });
    getPublicArtistBySlug.mockResolvedValue(ARTIST);
  });

  it("passes upcoming rows into their own page block", async () => {
    getFindingsByArtist.mockResolvedValue([]);
    countArtistFindings.mockResolvedValue(0);
    listArtistUpcoming.mockResolvedValue({
      findings: [],
      page: 1,
      pageCount: 1,
      total: 1,
      tracks: [{ artists: ["Drift"], title: "Next", trackId: "future" }],
    });

    const data = await resolveArtistPageData("drift", "name", 1);
    expect(
      data.status === "found" ? data.upcoming.tracks.map((track) => track.trackId) : [],
    ).toEqual(["future"]);
  });

  it("hides a findings-free artist with no visible tracks", async () => {
    getPublicArtistBySlug.mockResolvedValue({ ...ARTIST, renderableTrackCount: 0 });
    getFindingsByArtist.mockResolvedValue([]);
    countArtistFindings.mockResolvedValue(0);

    const data = await resolveArtistPageData("drift", "name", 1);

    expect(data).toEqual({ status: "missing" });
  });

  it("indexes a findings-free artist once its CATALOGUE clears the floor", async () => {
    getPublicArtistBySlug.mockResolvedValue({ ...ARTIST, renderableTrackCount: 5 });
    getFindingsByArtist.mockResolvedValue([]);
    countArtistFindings.mockResolvedValue(0);
    listArtistCatalogue.mockResolvedValue({ ...NO_CATALOGUE, totalTracks: 5 });

    const data = await resolveArtistPageData("drift", "name", 1);

    expect(data).toMatchObject({ indexable: true, status: "found" });
    expect(robotsMeta(data)).toBeUndefined();
  });

  it("keeps the gate off the artists_json fallback — grid covers alone do not index a page", async () => {
    getPublicArtistBySlug.mockResolvedValue({ ...ARTIST, renderableTrackCount: 0 });
    getFindingsByArtist.mockResolvedValue([
      finding("001.1.1A"),
      finding("002.1.1A"),
      finding("003.1.1A"),
    ]);
    countArtistFindings.mockResolvedValue(0);

    const data = await resolveArtistPageData("drift", "name", 1);

    expect(data).toMatchObject({ indexable: false, status: "found" });
    expect(robotsMeta(data)).toBe("noindex, follow");
  });

  it("renders (noindex) an artist with one or two certified findings, below the index threshold", async () => {
    getFindingsByArtist.mockResolvedValue([finding("001.1.1A"), finding("002.1.1A")]);

    countArtistFindings.mockResolvedValue(2);

    const data = await resolveArtistPageData("drift", "name", 1);

    expect(data.status).toBe("found");
    if (data.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(data.findings).toHaveLength(2);
    expect(data.indexable).toBe(false);
    expect(robotsMeta(data)).toBe("noindex, follow");
  });

  it("indexes a page once the stored counter clears the threshold", async () => {
    getPublicArtistBySlug.mockResolvedValue({ ...ARTIST, renderableTrackCount: 3 });
    getFindingsByArtist.mockResolvedValue([
      finding("001.1.1A"),
      finding("002.1.1A"),
      finding("003.1.1A"),
    ]);
    countArtistFindings.mockResolvedValue(3);

    const data = await resolveArtistPageData("drift", "name", 1);

    if (data.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(data.indexable).toBe(true);

    expect(robotsMeta(data)).toBeUndefined();
  });

  it("carries the Discogs + Last.fm anchors from the record into the MusicGroup's sameAs", async () => {
    getPublicArtistBySlug.mockResolvedValue({
      ...ARTIST,
      discogsUrl: "https://www.discogs.com/artist/4321-Drift",
      lastfmUrl: "https://www.last.fm/music/Drift",
      mbid: "mb-drift",
    });
    getFindingsByArtist.mockResolvedValue([finding("001.1.1A")]);
    countArtistFindings.mockResolvedValue(1);

    const data = await resolveArtistPageData("drift", "name", 1);

    expect(data).toMatchObject({
      discogsUrl: "https://www.discogs.com/artist/4321-Drift",
      lastfmUrl: "https://www.last.fm/music/Drift",
    });
    expect(musicGroupFromHead(data).sameAs).toEqual([
      "https://musicbrainz.org/artist/mb-drift",
      "https://www.discogs.com/artist/4321-Drift",
      "https://www.last.fm/music/Drift",
    ]);
  });

  it("emits no anchor for an artist that carries none — sameAs simply omits them", async () => {
    getFindingsByArtist.mockResolvedValue([finding("001.1.1A")]);
    countArtistFindings.mockResolvedValue(1);

    const data = await resolveArtistPageData("drift", "name", 1);

    expect(data).toMatchObject({ discogsUrl: undefined, lastfmUrl: undefined });
    expect(musicGroupFromHead(data)).not.toHaveProperty("sameAs");
  });

  it("reports a missing artist without touching the finding counts", async () => {
    getPublicArtistBySlug.mockResolvedValue(undefined);

    const data = await resolveArtistPageData("nobody", "name", 1);

    expect(data).toEqual({ status: "missing" });
    expect(getFindingsByArtist).not.toHaveBeenCalled();
    expect(countArtistFindings).not.toHaveBeenCalled();
    expect(getArtistNeighbours).not.toHaveBeenCalled();
  });

  it("assembles the dossier (signature + neighbours) from the findings", async () => {
    getFindingsByArtist.mockResolvedValue([
      finding("003.1.1A", { addedAt: "2026-03-10T00:00:00.000Z" }),
      finding("002.1.1A", { addedAt: "2026-02-01T00:00:00.000Z" }),
      finding("001.1.1A", { addedAt: "2026-01-05T00:00:00.000Z" }),
    ]);
    countArtistFindings.mockResolvedValue(3);
    getArtistNeighbours.mockResolvedValue([
      { imageUrl: "https://i.scdn.co/image/echo", name: "Echo", slug: "echo" },
    ]);

    const data = await resolveArtistPageData("drift", "name", 1);

    if (data.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(data.dossier.findingCount).toBe(3);

    expect(data.dossier.firstFoundAt).toBe("2026-01-05T00:00:00.000Z");

    expect(data.dossier.neighbours).toEqual([
      { imageUrl: "https://i.scdn.co/image/echo", name: "Echo", slug: "echo" },
    ]);
  });

  it("carries the artist's bio into the page data when the record has one, undefined otherwise", async () => {
    getFindingsByArtist.mockResolvedValue([finding("001.1.1A")]);
    countArtistFindings.mockResolvedValue(1);

    getPublicArtistBySlug.mockResolvedValue({
      ...ARTIST,
      bio: "Drift makes rollers for the deep end.",
    });
    const withBio = await resolveArtistPageData("drift", "name", 1);
    if (withBio.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(withBio.bio).toBe("Drift makes rollers for the deep end.");

    getPublicArtistBySlug.mockResolvedValue(ARTIST);
    const withoutBio = await resolveArtistPageData("drift", "name", 1);
    if (withoutBio.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(withoutBio.bio).toBeUndefined();
  });

  it("derives a ≤160-char meta description from the bio, and the template when there is none", async () => {
    getFindingsByArtist.mockResolvedValue([finding("001.1.1A")]);
    countArtistFindings.mockResolvedValue(1);

    const bio =
      "Drift is a British drum and bass producer known for deep, rolling liquid cuts and a run " +
      "of releases across the scene's most respected labels over the past decade of the sound.";
    getPublicArtistBySlug.mockResolvedValue({ ...ARTIST, bio });
    const withBio = await resolveArtistPageData("drift", "name", 1);

    const desc = metaDescription(withBio);
    expect(desc).toBeDefined();
    expect((desc ?? "").length).toBeLessThanOrEqual(160);
    expect(desc).not.toContain("each with a coordinate");
    expect(desc?.startsWith("Drift is a British drum and bass producer")).toBe(true);

    getPublicArtistBySlug.mockResolvedValue(ARTIST);
    const withoutBio = await resolveArtistPageData("drift", "name", 1);
    expect(metaDescription(withoutBio)).toBe(
      "Drum & bass tracks by Drift that Fluncle recommends, 1 so far, with the labels and releases behind them.",
    );
  });

  it("varies BOTH the title and the description by page (the /artists hub rule)", async () => {
    getFindingsByArtist.mockResolvedValue([finding("001.1.1A")]);
    countArtistFindings.mockResolvedValue(1);
    getPublicArtistBySlug.mockResolvedValue({
      ...ARTIST,
      bio: "Drift is a British drum and bass producer known for deep, rolling liquid cuts.",
    });
    listArtistCatalogue.mockResolvedValue({ ...NO_CATALOGUE, page: 2, pageCount: 4 });

    const paged = await resolveArtistPageData("drift", "name", 2);

    expect(headTitle(paged)).toBe("Drift, page 2 · Fluncle");
    expect(metaDescription(paged)).toBe(
      "Page 2 of the drum & bass records by Drift that Fluncle holds.",
    );

    listArtistCatalogue.mockResolvedValue(NO_CATALOGUE);
    const first = await resolveArtistPageData("drift", "name", 1);

    expect(headTitle(first)).toBe("Drift · Fluncle");
    expect(metaDescription(first)?.startsWith("Drift is a British")).toBe(true);
  });
});

describe("FindingsGrid render contract (the band the artist page delegates to)", () => {
  async function renderFindingsGrid(findings: unknown[]): Promise<string> {
    const rootRoute = createRootRoute({
      component: () => createElement(FindingsGrid, { findings } as never),
    });

    const logRoute = createRoute({ getParentRoute: () => rootRoute, path: "/log/$logId" });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute.addChildren([logRoute]),
    });
    await router.load();

    return renderToString(createElement(RouterProvider, { router } as never));
  }

  it("renders NOTHING for a findings-free entity — no grid, no heading, no 'Quiet sector.'", async () => {
    const html = await renderFindingsGrid([]);

    expect(html).not.toContain("Quiet sector");
    expect(html).not.toContain('class="artist-grid"');
  });

  it("still renders the cover grid, each cover a /log link, under a visible curator heading, when findings exist", async () => {
    const html = await renderFindingsGrid([
      {
        albumImageUrl: "https://i.scdn.co/image/cover",
        artists: ["Drift"],
        logId: "001.1.1A",
        title: "Untitled",
        trackId: "t-1",
      },
    ]);

    expect(html).toContain('class="artist-grid"');
    expect(html).toContain("/log/001.1.1A");

    expect(html).toContain("Recommended by Fluncle");
    expect(html).toMatch(/<h2[^>]*id="findings-grid-heading"/);
    expect(html).toContain('aria-labelledby="findings-grid-heading"');
  });

  it("fetches the FIRST cover eagerly at high priority and leaves the rest lazy", async () => {
    const html = await renderFindingsGrid([
      {
        albumImageUrl: "https://i.scdn.co/image/ab67616d00001e02aaaa",
        artists: ["Drift"],
        logId: "001.1.1A",
        title: "First",
        trackId: "t-1",
      },
      {
        albumImageUrl: "https://i.scdn.co/image/ab67616d00001e02bbbb",
        artists: ["Drift"],
        logId: "001.1.2A",
        title: "Second",
        trackId: "t-2",
      },
    ]);

    const covers = html.match(/<img[^>]*class="track-artwork artist-grid-cover"[^>]*>/g) ?? [];
    expect(covers).toHaveLength(2);

    const [lead = "", follower = ""] = covers;
    expect(lead).toContain('loading="eager"');
    expect(lead.toLowerCase()).toContain('fetchpriority="high"');
    expect(follower).toContain('loading="lazy"');
    expect(follower.toLowerCase()).not.toContain("fetchpriority");
  });
});

it("renders a findings-free artist masthead without a findings band or apology", async () => {
  getPublicArtistBySlug.mockResolvedValue(ARTIST);
  getPublicArtistSocials.mockResolvedValue([]);
  getPublicArtistAliasNames.mockResolvedValue([]);
  getArtistNeighbours.mockResolvedValue([]);
  getFindingsByArtist.mockResolvedValue([]);
  countArtistFindings.mockResolvedValue(0);
  listArtistCatalogue.mockResolvedValue(THIN_CATALOGUE);
  const data = await resolveArtistPageData("drift", "recent", 1);
  const rootRoute = createRootRoute();
  const artistRoute = createRoute({
    component: Route.options.component,
    getParentRoute: () => rootRoute,
    loader: () => data,
    path: "/artist/$slug",
  });
  const artistsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/artists" });
  const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/artist/drift"] }),
    routeTree: rootRoute.addChildren([artistRoute, artistsRoute, homeRoute]),
  });
  await router.load();

  const html = renderToString(createElement(RouterProvider, { router } as never));
  expect(html).toContain('class="log-masthead"');
  expect(html).toContain('class="log-coordinate log-index-title artist-name">Drift</h1>');
  expect(html).not.toContain("Recommended by Fluncle");
  expect(html).not.toContain('class="artist-grid"');
  expect(html).not.toContain("Quiet sector");
});

describe("the artist page spends high fetch priority on one image", () => {
  async function renderArtistPage(findings: unknown[]): Promise<{ head: string; html: string }> {
    getPublicArtistBySlug.mockResolvedValue({
      ...ARTIST,
      imageUrl: "https://found.fluncle.com/artists/drift.jpg",
    });
    getPublicArtistSocials.mockResolvedValue([]);
    getPublicArtistAliasNames.mockResolvedValue([]);
    getArtistNeighbours.mockResolvedValue([]);
    getFindingsByArtist.mockResolvedValue(findings);
    countArtistFindings.mockResolvedValue(findings.length);
    listArtistCatalogue.mockResolvedValue(findings.length === 0 ? THIN_CATALOGUE : NO_CATALOGUE);

    const data = await resolveArtistPageData("drift", "recent", 1);
    const rootRoute = createRootRoute();
    const artistRoute = createRoute({
      component: Route.options.component,
      getParentRoute: () => rootRoute,
      loader: () => data,
      path: "/artist/$slug",
    });
    const artistsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/artists" });
    const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const logRoute = createRoute({ getParentRoute: () => rootRoute, path: "/log/$logId" });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/artist/drift"] }),
      routeTree: rootRoute.addChildren([artistRoute, artistsRoute, homeRoute, logRoute]),
    });
    await router.load();

    const head = JSON.stringify(
      Route.options.head?.({ loaderData: data, params: { slug: "drift" } } as never),
    );

    return { head, html: renderToString(createElement(RouterProvider, { router } as never)) };
  }

  function highPriorityImages(html: string): string[] {
    return (html.match(/<img[^>]*>/g) ?? []).filter((img) =>
      img.toLowerCase().includes('fetchpriority="high"'),
    );
  }

  it("gives it to the findings band's first cover, never also to the portrait", async () => {
    const { head, html } = await renderArtistPage([
      {
        albumImageUrl: "https://found.fluncle.com/albums/first.jpg",
        artists: ["Drift"],
        logId: "001.1.1A",
        title: "First",
        trackId: "t-1",
      },
    ]);
    const high = highPriorityImages(html);

    expect(high).toHaveLength(1);
    expect(high[0]).toContain("artist-grid-cover");
    expect(head).toContain("albums/first.jpg");
    expect(html).toMatch(/<img[^>]*artist-masthead-avatar[^>]*loading="eager"/);
  });

  it("gives it to the portrait when there is no findings band", async () => {
    const { head, html } = await renderArtistPage([]);
    const high = highPriorityImages(html);

    expect(high).toHaveLength(1);
    expect(high[0]).toContain("artist-masthead-avatar");
    expect(head).toContain("artists/drift.jpg");
  });
});

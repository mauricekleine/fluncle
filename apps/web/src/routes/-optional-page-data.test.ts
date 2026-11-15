import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  album: vi.fn(),
  albumArtists: vi.fn(),
  albumCover: vi.fn(),
  albumLabel: vi.fn(),
  artist: vi.fn(),
  artistAliases: vi.fn(),
  artistCatalogue: vi.fn(),
  artistNeighbours: vi.fn(),
  artistSocials: vi.fn(),
  artistUpcoming: vi.fn(),
  catalogue: vi.fn(),
  findings: vi.fn(),
  label: vi.fn(),
  labelAliases: vi.fn(),
  labelArtists: vi.fn(),
  labelCatalogue: vi.fn(),
  labelUpcoming: vi.fn(),
  log: vi.fn(),
  logArtists: vi.fn(),
  logGalaxy: vi.fn(),
  logNeighbours: vi.fn(),
  logSimilar: vi.fn(),
  neighbours: vi.fn(),
  related: vi.fn(),
  siblings: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/server/albums", async (original) => ({
  ...(await original<typeof import("@/lib/server/albums")>()),
  albumCoverUrl: reads.albumCover,
  getAlbumBySlug: reads.album,
}));
vi.mock("@/lib/server/artists", async (original) => ({
  ...(await original<typeof import("@/lib/server/artists")>()),
  getArtistSlugMap: reads.logArtists,
  getPublicArtistAliasNames: reads.artistAliases,
  getPublicArtistBySlug: reads.artist,
  getPublicArtistSocials: reads.artistSocials,
  listArtistsByAlbum: reads.albumArtists,
  listArtistsByLabel: reads.labelArtists,
}));
vi.mock("@/lib/server/labels", async (original) => ({
  ...(await original<typeof import("@/lib/server/labels")>()),
  getConfirmedAliasNames: reads.labelAliases,
  getLabelBySlug: reads.label,
  getLabelForAlbum: reads.albumLabel,
}));
vi.mock("@/lib/server/catalogue-groups", async (original) => ({
  ...(await original<typeof import("@/lib/server/catalogue-groups")>()),
  listArtistCatalogue: reads.artistCatalogue,
  listArtistUpcoming: reads.artistUpcoming,
  listLabelCatalogue: reads.labelCatalogue,
  listLabelUpcoming: reads.labelUpcoming,
}));
vi.mock("@/lib/server/artist-dossier", async (original) => ({
  ...(await original<typeof import("@/lib/server/artist-dossier")>()),
  getArtistNeighbours: reads.artistNeighbours,
}));
vi.mock("@/lib/server/tracks", async (original) => ({
  ...(await original<typeof import("@/lib/server/tracks")>()),
  getFindingsByAlbum: reads.findings,
  getFindingsByArtist: reads.findings,
  getFindingsByLabel: reads.findings,
  getSimilarFindings: reads.logSimilar,
  getTrackNeighbors: reads.logNeighbours,
  listCatalogueTracksByAlbum: reads.catalogue,
  listCatalogueTracksByArtist: reads.siblings,
  listRelatedFindings: reads.related,
}));
vi.mock("@/lib/server/track-page", async (original) => ({
  ...(await original<typeof import("@/lib/server/track-page")>()),
  listSonicNeighbours: reads.neighbours,
  readTrackDestination: reads.track,
}));

vi.mock("@/lib/server/log-resolver", () => ({ resolveLogPageTarget: reads.log }));
vi.mock("@/lib/server/galaxies-map", () => ({ isGalaxyMapFullyNamed: reads.logGalaxy }));

const { resolveLogPageData } = await import("./-log-page-data");
const { resolveAlbumPageData } = await import("./-album-page-data");
const { resolveArtistPageData } = await import("./-artist-page-data");
const { resolveLabelPageData } = await import("./-label-page-data");
const { resolveTrackPageData } = await import("./-track-page-data");
const { Route: albumRoute } = await import("./album.$slug");
const { Route: artistRoute } = await import("./artist.$slug");
const { Route: labelRoute } = await import("./label.$slug");
const { Route: trackRoute } = await import("./track.$trackId");

const coreTrack = { artists: ["Drift"], title: "Core recording", trackId: "core-track" };
const groups = { groups: [], page: 1, pageCount: 1, totalGroups: 0, totalTracks: 0 };
const upcoming = { findingTotal: 0, findings: [], page: 1, pageCount: 1, total: 0, tracks: [] };
const stalled = () => new Promise<never>(() => undefined);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  for (const read of Object.values(reads)) {
    read.mockReset();
  }
  reads.album.mockResolvedValue({
    id: "album",
    name: "Core album",
    renderableTrackCount: 1,
    slug: "core-album",
  });
  reads.artist.mockResolvedValue({
    id: "artist",
    name: "Core artist",
    renderableTrackCount: 1,
    slug: "core-artist",
  });
  reads.label.mockResolvedValue({
    id: "label",
    name: "Core label",
    renderableTrackCount: 1,
    slug: "core-label",
  });
  reads.track.mockResolvedValue({
    graph: { albumId: "album", primaryArtist: { id: "artist", name: "Drift" } },
    kind: "found",
    track: {
      ...coreTrack,
      album: { name: "Core album", slug: "core-album" },
      artists: [{ name: "Drift" }],
      indexable: false,
      listen: [],
      previewable: false,
    },
  });
  reads.catalogue.mockResolvedValue({ total: 1, tracks: [coreTrack] });
  reads.artistCatalogue.mockResolvedValue(groups);
  reads.labelCatalogue.mockResolvedValue(groups);
  reads.artistUpcoming.mockResolvedValue(upcoming);
  reads.labelUpcoming.mockResolvedValue(upcoming);
  reads.findings.mockResolvedValue([]);
  reads.albumLabel.mockResolvedValue(undefined);
  reads.albumCover.mockResolvedValue(undefined);
  for (const read of [
    reads.albumArtists,
    reads.labelArtists,
    reads.artistAliases,
    reads.artistSocials,
    reads.artistNeighbours,
    reads.labelAliases,
    reads.related,
    reads.neighbours,
    reads.siblings,
  ]) {
    read.mockResolvedValue([]);
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  {
    component: trackRoute.options.component,
    load: () => resolveTrackPageData("core-track"),
    name: "track",
    optional: [reads.neighbours, reads.related, reads.catalogue, reads.siblings],
    path: "/track/$trackId",
    title: "Core recording",
    url: "/track/core-track",
  },
  {
    component: albumRoute.options.component,
    load: () => resolveAlbumPageData("core-album"),
    name: "album",
    optional: [reads.albumArtists, reads.related, reads.albumCover, reads.albumLabel],
    path: "/album/$slug",
    title: "Core album",
    url: "/album/core-album",
  },
  {
    component: artistRoute.options.component,
    load: () => resolveArtistPageData("core-artist", "recent", 1),
    name: "artist",
    optional: [reads.artistAliases, reads.artistSocials, reads.artistNeighbours, reads.related],
    path: "/artist/$slug",
    title: "Core artist",
    url: "/artist/core-artist",
  },
  {
    component: labelRoute.options.component,
    load: () => resolveLabelPageData("core-label", "recent", 1),
    name: "label",
    optional: [reads.labelAliases, reads.labelArtists, reads.related],
    path: "/label/$slug",
    title: "Core label",
    url: "/label/core-label",
  },
])(
  "renders $name core content within a short budget while optional reads stay pending",
  async ({ path, url, component, load, title, optional }) => {
    for (const read of optional) {
      read.mockImplementation(stalled);
    }
    const pending = load();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toBe(true);
    const data = await pending;
    expect(data.status).toBe("found");
    const root = createRootRoute();
    const page = createRoute({ component, getParentRoute: () => root, loader: () => data, path });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: [url] }),
      routeTree: root.addChildren([page]),
    });
    await router.load();
    const html = renderToString(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(RouterProvider, { router } as never),
      ),
    );
    expect(html).toContain(title);
    expect(html).not.toContain("Recommended by Fluncle");
    expect(html).not.toContain("Close in sound");
    expect(html).not.toContain("artist-chip");
    expect(html).not.toContain("Quiet sector");
  },
);

it("returns the finding identity when log-page decoration stays pending", async () => {
  reads.log.mockResolvedValue({ kind: "track", track: { ...coreTrack, logId: "020.F.1A" } });
  for (const read of [reads.logArtists, reads.logGalaxy, reads.logNeighbours, reads.logSimilar]) {
    read.mockImplementation(stalled);
  }
  const pending = resolveLogPageData("020.F.1A");
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(settled).toBe(true);
  expect(await pending).toMatchObject({
    artistSlugs: {},
    galaxyReady: false,
    similar: [],
    status: "found",
    track: { title: coreTrack.title },
  });
});

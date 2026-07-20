import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FindingsGrid } from "@/components/graph-sections";

// The artist page earns its page on CONTENT, exactly as a label/album does: a `getArtistBySlug` row
// renders, and the thin-content gate (NOT a certified-finding gate) decides whether it indexes.
//
//   · REACHABILITY: any artist ROW renders 200 (a crawl-minted, findings-free artist has a public
//     catalogue page); only a slug with no row 404s.
//   · INDEXABILITY: the page is `noindex` (and out of the sitemap) below ARTIST_INDEX_MIN_FINDINGS
//     RENDERABLE tracks — the certified findings (`countArtistFindings`, the canonical
//     `track_artists` join) PLUS the quieter catalogue rows (the catalogue's SQL-counted
//     `totalTracks`). Both read through the canonical join, the same source the sitemap keys off, so
//     an indexable page is never an orphan. The `artists_json` completeness fallback in the grid is
//     deliberately NOT part of the gate.
//
// These tests pin that contract.

const getArtistBySlug = vi.hoisted(() => vi.fn());
const getPublicArtistSocials = vi.hoisted(() => vi.fn());
const getPublicArtistAliasNames = vi.hoisted(() => vi.fn());
const countArtistFindings = vi.hoisted(() => vi.fn());
const getFindingsByArtist = vi.hoisted(() => vi.fn());
const getArtistNeighbours = vi.hoisted(() => vi.fn());
const listArtistCatalogue = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/artists", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/artists")>()),
  countArtistFindings,
  getArtistBySlug,
  getPublicArtistAliasNames,
  getPublicArtistSocials,
}));

vi.mock("@/lib/server/tracks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/tracks")>()),
  getFindingsByArtist,
}));

// The grouped catalogue read is DB-backed; stub it so the resolver stays a pure unit (its
// grouping + bounds are covered by catalogue-groups.test.ts and the scale integration test).
vi.mock("@/lib/server/catalogue-groups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/catalogue-groups")>()),
  listArtistCatalogue,
}));

/** The empty grouped catalogue — an artist the crawler has not touched. */
const NO_CATALOGUE = { groups: [], page: 1, pageCount: 1, totalGroups: 0, totalTracks: 0 };

// The dossier's neighbours are DB-backed; stub them so the resolver stays a pure
// unit (the ranking itself is covered by artist-dossier.test.ts).
vi.mock("@/lib/server/artist-dossier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/artist-dossier")>()),
  getArtistNeighbours,
}));

const { ARTIST_CATALOGUE_SORT_DEFAULT, Route, resolveArtistPageData } =
  await import("./artist.$slug");

const ARTIST = {
  id: "artist-drift",
  mbid: undefined,
  name: "Drift",
  slug: "drift",
  spotifyUrl: undefined,
  wikidataQid: undefined,
};

// A minimal grid finding — only the fields the resolver passes through matter.
// `addedAt`/`bpm`/`key` feed the dossier signature; a bare finding leaves them
// undefined, which the signature degrades cleanly on.
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

/** The `<meta name="description">` — the same string og:/twitter: description carry. */
function metaDescription(data: unknown): string | undefined {
  return headMeta(data).find((entry) => entry.name === "description")?.content;
}

/** The route's resolved catalogue sort for a given (validated) search — where the default lands. */
function resolvedSort(search: { page?: number; sort?: "name" | "recent" }): string {
  const deps = Route.options.loaderDeps?.({ search } as never) as { sort: string } | undefined;

  return deps?.sort ?? "";
}

describe("the artist page catalogue default (latest release first)", () => {
  it("defaults to the 'recent' (Latest release) key — the dropdown's own sort key", () => {
    // Reused verbatim, never a fresh ordering: the constant IS the value the dropdown's "Latest
    // release" option carries, so the control reflects the default on the first (param-free) load.
    expect(ARTIST_CATALOGUE_SORT_DEFAULT).toBe("recent");
  });

  it("resolves to latest-release with NO sort param, so a bare /artist/<slug> opens on it", () => {
    // No `?sort` in the URL → `validateSearch` narrows `sort` to undefined → the loader falls to
    // the artist default. This is the "both must agree" pin: the URL default and the sort handed
    // to the server read are the SAME latest-release key.
    expect(resolvedSort({})).toBe("recent");
  });

  it("still round-trips an explicitly chosen sort through the URL", () => {
    // A reader who picks A–Z (or re-picks Latest release) keeps exactly that — the default only
    // fills an ABSENT param, it never overrides a present one.
    expect(resolvedSort({ sort: "name" })).toBe("name");
    expect(resolvedSort({ sort: "recent" })).toBe("recent");
  });
});

describe("resolveArtistPageData (the artist page indexability gate)", () => {
  beforeEach(() => {
    getArtistBySlug.mockReset();
    getPublicArtistSocials.mockReset();
    getPublicArtistAliasNames.mockReset();
    countArtistFindings.mockReset();
    getFindingsByArtist.mockReset();
    getArtistNeighbours.mockReset();
    listArtistCatalogue.mockReset();
    getPublicArtistSocials.mockResolvedValue([]);
    getPublicArtistAliasNames.mockResolvedValue([]);
    getArtistNeighbours.mockResolvedValue([]);
    listArtistCatalogue.mockResolvedValue(NO_CATALOGUE);
    getArtistBySlug.mockResolvedValue(ARTIST);
  });

  it("renders (noindex) a findings-free artist with no catalogue — a thin crawl-minted page", async () => {
    // The artist ROW exists (the crawler minted it off a crawled track's Spotify anchor) and has no
    // certified finding and no catalogue tracks yet. It renders 200 — a public page, like a label —
    // but below the renderable-track floor, so it is noindex + out of the sitemap.
    getArtistBySlug.mockResolvedValue(ARTIST);
    getFindingsByArtist.mockResolvedValue([]);
    countArtistFindings.mockResolvedValue(0);

    const data = await resolveArtistPageData("drift", "name", 1);

    expect(data).toMatchObject({ indexable: false, status: "found" });
    expect(robotsMeta(data)).toBe("noindex, follow");
  });

  it("indexes a findings-free artist once its CATALOGUE clears the floor", async () => {
    // No certified finding, but the crawl has filled enough of its catalogue: canonical count 0 +
    // catalogue totalTracks 5 = 5 >= ARTIST_INDEX_MIN_FINDINGS. It is a real page and indexes,
    // exactly as a findings-free label/album with enough tracks does.
    getFindingsByArtist.mockResolvedValue([]);
    countArtistFindings.mockResolvedValue(0);
    listArtistCatalogue.mockResolvedValue({ ...NO_CATALOGUE, totalTracks: 5 });

    const data = await resolveArtistPageData("drift", "name", 1);

    expect(data).toMatchObject({ indexable: true, status: "found" });
    expect(robotsMeta(data)).toBeUndefined();
  });

  it("keeps the gate off the artists_json fallback — grid covers alone do not index a page", async () => {
    // The completeness fallback (`getFindingsByArtist` reads `artists_json`) could show covers, but
    // the `indexable` gate keys off the canonical count + catalogue total alone — both zero here.
    // So a page with three fallback covers still renders noindex (never an orphaned indexable page).
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
    // Two certified findings: past the EXISTENCE gate (row is public), below the INDEX threshold.
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

  it("indexes a page once the canonical join count clears the threshold", async () => {
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
    // Past the gate: no robots override, so the page is indexable.
    expect(robotsMeta(data)).toBeUndefined();
  });

  it("reports a missing artist without touching the finding counts", async () => {
    getArtistBySlug.mockResolvedValue(undefined);

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
    // The earliest finding is when the artist first crossed his path.
    expect(data.dossier.firstFoundAt).toBe("2026-01-05T00:00:00.000Z");
    // The similar-artists row carries each neighbour's identity + avatar.
    expect(data.dossier.neighbours).toEqual([
      { imageUrl: "https://i.scdn.co/image/echo", name: "Echo", slug: "echo" },
    ]);
  });

  it("carries the artist's bio into the page data when the record has one, undefined otherwise", async () => {
    getFindingsByArtist.mockResolvedValue([finding("001.1.1A")]);
    countArtistFindings.mockResolvedValue(1);

    getArtistBySlug.mockResolvedValue({ ...ARTIST, bio: "Drift makes rollers for the deep end." });
    const withBio = await resolveArtistPageData("drift", "name", 1);
    if (withBio.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(withBio.bio).toBe("Drift makes rollers for the deep end.");

    getArtistBySlug.mockResolvedValue(ARTIST);
    const withoutBio = await resolveArtistPageData("drift", "name", 1);
    if (withoutBio.status !== "found") {
      throw new Error("expected the artist to be found");
    }
    expect(withoutBio.bio).toBeUndefined();
  });

  it("derives a ≤160-char meta description from the bio, and the template when there is none", async () => {
    getFindingsByArtist.mockResolvedValue([finding("001.1.1A")]);
    countArtistFindings.mockResolvedValue(1);

    // A bio over the meta cap: the description is bio-derived, trimmed to ≤160, and drops the
    // catalogue-count template entirely (the whole point — a unique description per entity).
    const bio =
      "Drift is a British drum and bass producer known for deep, rolling liquid cuts and a run " +
      "of releases across the scene's most respected labels over the past decade of the sound.";
    getArtistBySlug.mockResolvedValue({ ...ARTIST, bio });
    const withBio = await resolveArtistPageData("drift", "name", 1);

    const desc = metaDescription(withBio);
    expect(desc).toBeDefined();
    expect((desc ?? "").length).toBeLessThanOrEqual(160);
    expect(desc).not.toContain("each with a coordinate");
    expect(desc?.startsWith("Drift is a British drum and bass producer")).toBe(true);

    // No bio ⇒ the original template is preserved verbatim (no regression).
    getArtistBySlug.mockResolvedValue(ARTIST);
    const withoutBio = await resolveArtistPageData("drift", "name", 1);
    expect(metaDescription(withoutBio)).toBe(
      "Drum & bass tracks by Drift that Fluncle recommends, 1 so far, with the labels and releases behind them.",
    );
  });
});

// Fix 2 — the artist page must stop printing "Quiet sector.". Two layers of proof:
//
//  (1) STRUCTURAL: the artist route SOURCE no longer carries the apology, and its findings band is
//      the shared FindingsGrid (the same component the label/album graph pages use) — so it inherits
//      their "a band with nothing in it renders NOTHING" contract by construction, not by copy.
//  (2) BEHAVIOURAL: FindingsGrid itself, SSR'd through a router, renders NOTHING for a findings-free
//      entity (no grid, no heading, no "Quiet sector.") and a real cover-grid when findings exist.
//
// Together they pin: a findings-free artist page shows no apology — its masthead (name + signature)
// and catalogue tracklist carry it, exactly as a crawler-discovered label's page does.

describe("Fix 2: the artist route dropped the 'Quiet sector.' empty state", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./artist.$slug.tsx", import.meta.url)),
    "utf8",
  );

  it("no longer references the 'Quiet sector.' apology or its scanline empty state", () => {
    expect(source).not.toContain("Quiet sector");
    expect(source).not.toContain("empty-scanlines");
    expect(source).not.toContain("log-index-empty");
  });

  it("renders its findings band through the shared FindingsGrid component", () => {
    expect(source).toContain('import { FindingsGrid } from "@/components/graph-sections"');
    expect(source).toContain("<FindingsGrid");
  });
});

describe("FindingsGrid render contract (the band the artist page now delegates to)", () => {
  /** SSR FindingsGrid through a router (its <Link> needs one), returning the static HTML. */
  async function renderFindingsGrid(findings: unknown[]): Promise<string> {
    const rootRoute = createRootRoute({
      component: () => createElement(FindingsGrid, { findings } as never),
    });
    // The band's covers link to /log/$logId — the router needs the route so Link builds the href.
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
    // The findings block is titled (DESIGN.md mixed-list carve-out): a VISIBLE curator heading,
    // a real H2 (page outline), wired as the grid's accessible name via aria-labelledby. The
    // string is folded into the component (no `label` prop), so it can't drift per call site.
    expect(html).toContain("Recommended by Fluncle");
    expect(html).toMatch(/<h2[^>]*id="findings-grid-heading"/);
    expect(html).toContain('aria-labelledby="findings-grid-heading"');
  });
});

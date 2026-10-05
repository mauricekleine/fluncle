import { describe, expect, it } from "vitest";
import { type CatalogueArtistGroup, type CatalogueRecord } from "@/lib/catalogue";
import { type HubOrder } from "@/lib/hub-order";
import { type AlbumHubEntry } from "@/lib/server/albums";
import { type ArtistHubEntry } from "@/lib/server/artists";
import { type LabelHubEntry } from "@/lib/server/labels";
import { type ArtistPageData } from "./-artist-page-data";
import { type LabelPageData } from "./-label-page-data";

const { Route: ArtistsRoute } = await import("./artists.index");
const { Route: LabelsRoute } = await import("./labels.index");
const { Route: AlbumsRoute } = await import("./albums.index");
const { Route: ArtistRoute } = await import("./artist.$slug");
const { Route: LabelRoute } = await import("./label.$slug");

type Head = {
  links?: Array<{ href: string; rel: string }>;
  meta?: Array<{ content?: string; name?: string; property?: string; title?: string }>;
  scripts?: Array<{ children: string; type: string }>;
};

type ArtistsData = Extract<
  Parameters<NonNullable<typeof ArtistsRoute.options.head>>[0]["loaderData"],
  { status: "found" }
>;
type LabelsData = Extract<
  Parameters<NonNullable<typeof LabelsRoute.options.head>>[0]["loaderData"],
  { status: "found" }
>;
type AlbumsData = Extract<
  Parameters<NonNullable<typeof AlbumsRoute.options.head>>[0]["loaderData"],
  { status: "found" }
>;
type ArtistData = Extract<ArtistPageData, { status: "found" }>;
type LabelData = Extract<LabelPageData, { status: "found" }>;

function readHead(result: unknown): Head {
  return (result ?? {}) as Head;
}

function title(head: Head): string | undefined {
  return head.meta?.find((entry) => entry.title !== undefined)?.title;
}

function description(head: Head): string | undefined {
  return head.meta?.find((entry) => entry.name === "description")?.content;
}

function robots(head: Head): string | undefined {
  return head.meta?.find((entry) => entry.name === "robots")?.content;
}

function canonical(head: Head): string | undefined {
  return head.links?.find((entry) => entry.rel === "canonical")?.href;
}

function expectTitles(head: Head, expected: string): void {
  expect(title(head)).toBe(expected);
  expect(head.meta?.find((entry) => entry.property === "og:title")?.content).toBe(expected);
  expect(head.meta?.find((entry) => entry.name === "twitter:title")?.content).toBe(expected);
}

function hubData<T>(items: T[], options: HubOptions = {}) {
  const page = options.page ?? 1;

  return {
    hub: { items, page, pageCount: 8, total: 384 },
    order: options.order ?? "most",
    page,
    q: options.q,
    recentReady: true,
    requestedOrder: options.requestedOrder ?? options.order ?? "most",
    status: "found" as const,
    thisMonth: [],
  };
}

function artistHubEntry(name: string): ArtistHubEntry {
  return {
    certified: true,
    imageUrl: undefined,
    name,
    playable: true,
    slug: name.toLowerCase(),
    trackCount: 5,
  };
}

function labelHubEntry(name: string): LabelHubEntry {
  return {
    certified: true,
    coverImageUrl: undefined,
    logoImageUrl: undefined,
    name,
    playable: true,
    slug: name.toLowerCase(),
    trackCount: 5,
  };
}

function albumHubEntry(name: string): AlbumHubEntry {
  return {
    artists: ["Drift"],
    certified: true,
    coverImageUrl: undefined,
    name,
    playable: true,
    slug: name.toLowerCase(),
    trackCount: 5,
  };
}

type HubOptions = {
  names?: string[];
  order?: HubOrder;
  page?: number;
  q?: string;
  requestedOrder?: HubOrder;
};

const hubs = [
  {
    description:
      "Every drum & bass artist Fluncle holds, with the labels that pressed their records.",
    emptyDescription: "Page 2 of every drum & bass artist Fluncle holds.",
    head: (options: HubOptions = {}) => {
      const loaderData: ArtistsData = hubData(
        (options.names ?? ["Drift", "Echo", "Flux"]).map(artistHubEntry),
        options,
      );

      return readHead(ArtistsRoute.options.head?.({ loaderData } as never));
    },
    name: "artists",
    pagedDescription: "Drum & bass artists Fluncle holds",
    title: "Every drum & bass artist · Fluncle",
  },
  {
    description:
      "Every drum & bass record label Fluncle holds, with the founding facts and lineage that link them.",
    emptyDescription: "Page 2 of every drum & bass record label Fluncle holds.",
    head: (options: HubOptions = {}) => {
      const loaderData: LabelsData = hubData(
        (options.names ?? ["Drift", "Echo", "Flux"]).map(labelHubEntry),
        options,
      );

      return readHead(LabelsRoute.options.head?.({ loaderData } as never));
    },
    name: "labels",
    pagedDescription: "Drum & bass record labels Fluncle holds",
    title: "Every drum & bass record label · Fluncle",
  },
  {
    description:
      "Every drum & bass album, EP and single Fluncle holds, with the artists and labels behind them.",
    emptyDescription:
      "Page 2 of every drum & bass album, EP and single Fluncle holds, with the artists and labels behind them.",
    head: (options: HubOptions = {}) => {
      const loaderData: AlbumsData = hubData(
        (options.names ?? ["Drift", "Echo", "Flux"]).map(albumHubEntry),
        options,
      );

      return readHead(AlbumsRoute.options.head?.({ loaderData } as never));
    },
    name: "albums",
    pagedDescription: "Drum & bass albums, EPs and singles Fluncle holds",
    title: "Every drum & bass album · Fluncle",
  },
];

const upcoming = { findings: [], page: 1, pageCount: 3, total: 0, tracks: [] };

function record(name: string | undefined): CatalogueRecord {
  return { name, releaseDate: undefined, slug: name?.toLowerCase(), tracks: [] };
}

function artistGroup(name: string): CatalogueArtistGroup {
  return {
    name,
    recordCount: 2,
    records: [record("First record"), record("Second record")],
    slug: name.toLowerCase(),
    truncated: false,
  };
}

function artistData(options: Partial<ArtistData> = {}): ArtistData {
  return {
    alternateNames: [],
    bio: undefined,
    catalogue: { groups: [], page: 1, pageCount: 8, totalGroups: 96, totalTracks: 192 },
    discogsUrl: undefined,
    dossier: { findingCount: 0, firstFoundAt: undefined, neighbours: [] },
    findings: [],
    id: "artist-drift",
    imageUrl: undefined,
    indexable: true,
    lastfmUrl: undefined,
    mbid: undefined,
    name: "Drift",
    related: [],
    slug: "drift",
    socials: [],
    sort: "recent",
    spotifyUrl: undefined,
    status: "found",
    upcoming,
    wikidataQid: undefined,
    ...options,
  };
}

function labelData(options: Partial<LabelData> = {}): LabelData {
  return {
    alternateNames: [],
    artists: [],
    bio: undefined,
    catalogue: { groups: [], page: 1, pageCount: 8, totalGroups: 96, totalTracks: 192 },
    discogsLabelId: undefined,
    findings: [],
    foundedLocation: undefined,
    foundingDate: undefined,
    id: "label-depth",
    indexable: true,
    logoImageUrl: undefined,
    mbLabelId: undefined,
    name: "Depth",
    parentLabel: undefined,
    related: [],
    slug: "depth",
    sort: "name",
    status: "found",
    subLabels: [],
    upcoming,
    ...options,
  };
}

function artistHead(data: ArtistData): Head {
  return readHead(ArtistRoute.options.head?.({ loaderData: data } as never));
}

function labelHead(data: LabelData): Head {
  return readHead(LabelRoute.options.head?.({ loaderData: data } as never));
}

type EntityOptions = {
  indexable?: boolean;
  nonDefaultSort?: boolean;
  page?: number;
  upcomingPage?: number;
};

const entities = [
  {
    canonical: "https://www.fluncle.com/artist/drift",
    description: "Drum & bass by Drift: 192 tracks, with the releases and labels behind them.",
    head: (options: EntityOptions = {}) => {
      const data = artistData({
        indexable: options.indexable ?? true,
        sort: options.nonDefaultSort ? "name" : "recent",
        upcoming: { ...upcoming, page: options.upcomingPage ?? 1 },
      });

      return artistHead({ ...data, catalogue: { ...data.catalogue, page: options.page ?? 1 } });
    },
    name: "artist",
    title: "Drift: drum & bass tracks and releases · Fluncle",
  },
  {
    canonical: "https://www.fluncle.com/label/depth",
    description: "Drum & bass released on Depth: 192 tracks.",
    head: (options: EntityOptions = {}) => {
      const data = labelData({
        indexable: options.indexable ?? true,
        sort: options.nonDefaultSort ? "recent" : "name",
        upcoming: { ...upcoming, page: options.upcomingPage ?? 1 },
      });

      return labelHead({ ...data, catalogue: { ...data.catalogue, page: options.page ?? 1 } });
    },
    name: "label",
    title: "Depth: drum & bass releases and artists · Fluncle",
  },
];

describe.each(hubs)("$name hub head", (hub) => {
  it("keeps the page-one title and description", () => {
    const head = hub.head();

    expectTitles(head, hub.title);
    expect(description(head)).toBe(hub.description);
    expect(robots(head)).toBeUndefined();
    expect(canonical(head)).toBe(`https://www.fluncle.com/${hub.name}`);
  });

  it("names the first two entries in the served most-tracks order and describes the page position", () => {
    const head = hub.head({ names: ["Zebra", "Anchor", "Middle", "Wave"], page: 2 });

    expectTitles(
      head,
      hub.title.replace(" · Fluncle", ", page 2: Zebra, Anchor and more · Fluncle"),
    );
    expect(description(head)).toBe(
      `${hub.pagedDescription}, page 2 of 8: Zebra, Anchor, Middle and 1 more.`,
    );
  });

  it("uses the first-to-last range when the default request is served alphabetically", () => {
    const head = hub.head({
      names: ["Anchor", "Middle", "Zebra"],
      order: "az",
      page: 2,
      requestedOrder: "most",
    });

    expectTitles(head, hub.title.replace(" · Fluncle", ", page 2: Anchor to Zebra · Fluncle"));
  });

  it.each([
    { expectedRobots: undefined, page: 5 },
    { expectedRobots: "noindex, follow", page: 6 },
  ])(
    "keeps page $page self-canonical with the required robots output and collection data",
    ({ page, expectedRobots }) => {
      const head = hub.head({ page });

      expect(robots(head)).toBe(expectedRobots);
      expect(canonical(head)).toBe(`https://www.fluncle.com/${hub.name}?page=${page}`);
      const script = head.scripts?.find((entry) => entry.type === "application/ld+json");
      expect(script).toBeDefined();
      const collection = JSON.parse(script?.children ?? "null");
      expect(collection).toMatchObject({
        "@type": "CollectionPage",
        mainEntity: {
          itemListElement: [{ name: "Drift" }, { name: "Echo" }, { name: "Flux" }],
          numberOfItems: 384,
        },
      });
    },
  );

  it.each([{ order: "az" as const }, { order: "recent" as const }, { q: "Drift" }])(
    "keeps filtered and nondefault orders noindexed with the base canonical: %j",
    (options) => {
      const head = hub.head({ ...options, page: 2 });

      expect(robots(head)).toBe("noindex, follow");
      expect(canonical(head)).toBe(`https://www.fluncle.com/${hub.name}`);
      expect(head.scripts).toBeUndefined();
      expectTitles(head, hub.title);
      expect(description(head)).toBe(hub.description);
    },
  );
});

describe.each(entities)("$name entity head", (entity) => {
  it("keeps the page-one title and description", () => {
    const head = entity.head();

    expectTitles(head, entity.title);
    expect(description(head)).toBe(entity.description);
    expect(canonical(head)).toBe(entity.canonical);
    expect(robots(head)).toBeUndefined();
  });

  it.each([
    { expectedRobots: undefined, page: 5 },
    { expectedRobots: "noindex, follow", page: 6 },
    { expectedRobots: "noindex, follow", indexable: false, page: 1 },
    { expectedRobots: "noindex, follow", indexable: false, page: 5 },
    { expectedRobots: "noindex, follow", nonDefaultSort: true, page: 1 },
    { expectedRobots: "noindex, follow", nonDefaultSort: true, page: 5 },
    { expectedRobots: "noindex, follow", page: 1, upcomingPage: 2 },
    { expectedRobots: "noindex, follow", nonDefaultSort: true, page: 6, upcomingPage: 2 },
  ])(
    "combines catalogue depth, thin content, sort, and upcoming pagination: %j",
    ({ expectedRobots, ...options }) => {
      const head = entity.head(options);

      expect(robots(head)).toBe(expectedRobots);
      expect(canonical(head)).toBe(
        options.page > 1 ? `${entity.canonical}?page=${options.page}` : entity.canonical,
      );
    },
  );
});

describe("entity head track counts", () => {
  it("counts upcoming releases on a page whose only tracks are still to come", () => {
    const futureOnly = {
      catalogue: { groups: [], page: 1, pageCount: 1, totalGroups: 0, totalTracks: 0 },
      upcoming: { ...upcoming, pageCount: 1, total: 5 },
    };

    expect(description(artistHead(artistData(futureOnly)))).toBe(
      "Drum & bass by Drift: 5 tracks, with the releases and labels behind them.",
    );
    expect(description(labelHead(labelData(futureOnly)))).toBe(
      "Drum & bass released on Depth: 5 tracks.",
    );
  });
});

describe("paged names in head metadata", () => {
  it("skips unnamed artist records and describes up to three named groups with the remaining count", () => {
    const data = artistData();
    const head = artistHead({
      ...data,
      catalogue: {
        ...data.catalogue,
        groups: [undefined, "First", "Middle", "Third", "Last", undefined].map(record),
        page: 2,
      },
    });

    expectTitles(head, "Drift, page 2: First to Last · Fluncle");
    expect(description(head)).toContain("First, Middle, Third and 1 more");
    expect(description(head)).toContain("page 2 of 8");
    expect(description(head)).not.toContain("undefined");
  });

  it.each([
    { names: ["Echo"], range: "Echo", snippet: "Echo" },
    {
      names: ["Drift", "Echo", "Flux", "Wave"],
      range: "Drift to Wave",
      snippet: "Drift, Echo, Flux and 1 more",
    },
  ])(
    "uses label artist groups once per artist rather than their records: $range",
    ({ names, range, snippet }) => {
      const data = labelData();
      const head = labelHead({
        ...data,
        catalogue: { ...data.catalogue, groups: names.map(artistGroup), page: 2 },
      });

      expectTitles(head, `Depth, page 2: ${range} · Fluncle`);
      expect(description(head)).toBe(`Drum & bass on Depth by ${snippet}, page 2 of 8.`);
    },
  );

  it("keeps generic page-number titles when a paged result has no named content", () => {
    for (const hub of hubs) {
      const head = hub.head({ names: [], page: 2 });
      expect(description(head)).toBe(hub.emptyDescription);
      expectTitles(head, hub.title.replace(" · Fluncle", ", page 2 · Fluncle"));
    }
    const artist = artistData();
    const label = labelData();

    expectTitles(
      artistHead({
        ...artist,
        catalogue: { ...artist.catalogue, groups: [record(undefined)], page: 2 },
      }),
      "Drift, page 2 · Fluncle",
    );
    expectTitles(
      labelHead({ ...label, catalogue: { ...label.catalogue, page: 2 } }),
      "Depth, page 2 · Fluncle",
    );
  });
});

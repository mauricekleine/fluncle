import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LabelAdminItem } from "@fluncle/contracts";
import { createEvidenceHttp, type RawResponse, SOURCE_POLICIES } from "../evidence-http";
import {
  beatportLabelUrlFrom,
  crawlRuleCredit,
  type BeatportScraper,
  discogsLabelIdFrom,
  discogsSearchName,
  EVIDENCE_SOURCES,
  gatherLabelEvidence,
  labelEvidenceLines,
  type LabelEvidenceDeps,
  type LabelEvidenceOptions,
  parseBeatportTracksPage,
  parseCensusPages,
  parseEvidenceSources,
} from "./admin-label-evidence";

const LABEL_MBID = "11111111-1111-1111-1111-111111111111";
const DNB_ACT = "22222222-2222-2222-2222-222222222222";
const HOUSE_ACT = "33333333-3333-3333-3333-333333333333";
const VARIOUS = "89ad4ac3-39f7-470e-963a-56509c546377";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

type Route = (url: string) => Promise<Response> | Response;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { headers, status });
}

function credit(mbid: string, name: string) {
  return [{ artist: { id: mbid, name }, name }];
}

function mbLabel(links: Array<{ type: string; url: string }>) {
  return {
    area: { name: "London" },
    disambiguation: "UK drum & bass",
    id: LABEL_MBID,
    "label-code": null,
    "life-span": { begin: "1998", ended: false },
    name: "Test Beats",
    relations: [
      ...links.map((link) => ({
        direction: "forward",
        type: link.type,
        url: { resource: link.url },
      })),
      {
        direction: "forward",
        label: { id: "44444444-4444-4444-4444-444444444444", name: "Test Beats Dubs" },
        type: "label ownership",
      },
    ],
    tags: [],
    type: "Original Production",
  };
}

const LINKED = [
  { type: "discogs", url: "https://www.discogs.com/label/555" },
  { type: "purchase for download", url: "https://www.beatport.com/label/test-beats/777" },
];

const RELEASES = {
  "release-count": 3,
  releases: [
    {
      "artist-credit": credit(DNB_ACT, "Roller"),
      barcode: "0001",
      date: "2020-01-01",
      id: "r1",
      "label-info": [{ "catalog-number": "TB001", label: { id: LABEL_MBID } }],
      media: [{ format: '12" Vinyl' }],
      status: "Official",
      title: "Amen Science",
    },
    {
      "artist-credit": credit(DNB_ACT, "Roller"),
      barcode: "0002",
      date: "2021-01-01",
      id: "r2",
      "label-info": [{ "catalog-number": "TB002", label: { id: LABEL_MBID } }],
      media: [{ format: "Digital Media" }],
      title: "Reese Theory",
    },
    {
      "artist-credit": credit(VARIOUS, "Various Artists"),
      barcode: "",
      date: "2022-01-01",
      id: "r3",
      media: [],
      title: "Test Beats Vol. 1",
    },
  ],
};

function beatportHtml(): string {
  const data = {
    props: {
      pageProps: {
        dehydratedState: {
          queries: [
            { queryKey: ["label-777"], state: { data: { id: 777 } } },
            {
              queryKey: ["tracks", { label_id: "777" }],
              state: {
                data: {
                  count: 100,
                  facets: {
                    fields: {
                      artists: [{ count: 60, id: 1, name: "Roller" }],
                      genre: [
                        { count: 10, id: 5, name: "House" },
                        { count: 90, id: 1, name: "Drum & Bass" },
                      ],
                      sub_genre: [{ count: 12, id: 66, name: "Jungle" }],
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  };

  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
}

function defaultRoutes(): Record<string, Route> {
  return {
    "api.discogs.com/database/search?type=label": () =>
      json({ results: [{ id: 9, title: "Test Beats (2)", uri: "/label/9-Test-Beats-2" }] }),
    "api.discogs.com/database/search?type=release": () =>
      json({
        pagination: { items: 3 },
        results: [
          {
            genre: ["Electronic"],
            id: 101,
            label: ["Test Beats"],
            style: ["Drum n Bass", "Jungle"],
          },
          {
            genre: ["Electronic"],
            id: 102,
            label: ["Test Beats", "Other"],
            style: ["Drum n Bass"],
          },
          { genre: ["Rock"], id: 777, label: ["Test Beats"], style: ["Punk"] },
        ],
      }),
    "api.discogs.com/labels/555": () =>
      json({
        id: 555,
        name: "Test Beats",
        parent_label: { id: 1, name: "Test Beats Ltd" },
        profile: "Drum & bass imprint.",
        sublabels: [{ name: "Test Beats Dubs" }],
        uri: "https://www.discogs.com/label/555-Test-Beats",
      }),
    "api.discogs.com/labels/555/releases": () =>
      json({
        pagination: { items: 42 },
        releases: [
          {
            artist: "Roller",
            catno: "TB001",
            format: '12"',
            id: 101,
            title: "Amen Science",
            type: "release",
            year: 2020,
          },
          {
            artist: "Roller",
            catno: "TB002",
            id: 900,
            main_release: 102,
            title: "Reese Theory",
            type: "master",
            year: 0,
          },
          {
            artist: "Dub Unit",
            catno: "TB003",
            id: 103,
            title: "Halfstep",
            type: "release",
            year: 2023,
          },
        ],
      }),
    "api.discogs.com/releases/103": () => json({ genres: ["Electronic"], styles: ["Halftime"] }),
    "itunes.apple.com/lookup?upc=0001": () =>
      json({
        results: [
          {
            collectionName: "Amen Science",
            primaryGenreName: "Jungle/Drum'n'bass",
            wrapperType: "collection",
          },
        ],
      }),
    "itunes.apple.com/lookup?upc=0002": () => json({ results: [] }),
    [`musicbrainz.org/ws/2/label/${LABEL_MBID}`]: () => json(mbLabel(LINKED)),
    [`musicbrainz.org/ws/2/release?label=${LABEL_MBID}&inc=artist-credits+labels`]: () =>
      json(RELEASES),
  };
}

function router(routes: Record<string, Route>): {
  fetch: (url: string) => Promise<Response>;
  hits: string[];
} {
  const hits: string[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);

  return {
    fetch: async (url: string) => {
      hits.push(url);
      const key = keys.find((candidate) => url.includes(candidate));
      const route = key === undefined ? undefined : routes[key];

      return route ? route(url) : new Response("no route", { status: 404 });
    },
    hits,
  };
}

function setup(
  routes: Record<string, Route> = defaultRoutes(),
  extra: Partial<LabelEvidenceDeps> = {},
): { deps: LabelEvidenceDeps; hits: string[] } {
  const cacheDir = mkdtempSync(join(tmpdir(), "fluncle-label-evidence-"));
  dirs.push(cacheDir);
  const { fetch, hits } = router(routes);
  const fast = Object.fromEntries(
    Object.entries(SOURCE_POLICIES).map(([source, policy]) => [
      source,
      { ...policy, attempts: 2, intervalMs: 0, timeoutMs: 50 },
    ]),
  ) as typeof SOURCE_POLICIES;
  let clock = Date.parse("2026-09-29T10:00:00Z");
  const http = createEvidenceHttp({
    cacheDir,
    fetch,
    now: () => clock,
    policies: fast,
    random: () => 0,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const scraper: BeatportScraper = async (): Promise<RawResponse> => ({
    headers: { get: () => null },
    status: 200,
    text: beatportHtml(),
  });

  return {
    deps: {
      http,
      resolveLabel: async () => {
        throw new Error("resolveLabel should not be called for an MBID");
      },
      scraper,
      ...extra,
    },
    hits,
  };
}

const ALL: LabelEvidenceOptions = { census: false, censusPages: 5, sources: EVIDENCE_SOURCES };

describe("gatherLabelEvidence", () => {
  test("assembles the calibration facts from every source", async () => {
    const { deps } = setup();
    const evidence = await gatherLabelEvidence(LABEL_MBID, ALL, deps);
    const { apple, beatport, discogs, musicbrainz } = evidence.sources;

    expect(evidence.ok).toBe(true);
    expect(evidence.partial).toBe(false);
    expect(evidence.errors).toEqual([]);
    expect(evidence.label).toEqual({
      input: LABEL_MBID,
      mbLabelId: LABEL_MBID,
      name: "Test Beats",
    });

    expect(musicbrainz.status).toBe("ok");
    expect(musicbrainz.data?.label?.labelRelations).toEqual([
      {
        direction: "forward",
        mbid: "44444444-4444-4444-4444-444444444444",
        name: "Test Beats Dubs",
        type: "label ownership",
      },
    ]);
    expect(musicbrainz.data?.releases?.firstCreditArtists).toEqual([
      { mbid: DNB_ACT, name: "Roller", releases: 2 },
    ]);
    expect(musicbrainz.data?.releases?.variousArtistsReleases).toBe(1);
    expect(musicbrainz.data?.releases?.releases.map((release) => release.catno)).toEqual([
      null,
      "TB002",
      "TB001",
    ]);

    expect(discogs.status).toBe("ok");
    expect(discogs.data?.label?.parentLabel).toEqual({ id: 1, name: "Test Beats Ltd" });
    expect(discogs.data?.releases?.releaseCount).toBe(42);
    expect(discogs.data?.styles).toEqual({
      genres: [{ count: 3, name: "Electronic" }],
      labelReleasesListed: 3,
      releasesRead: 3,
      styles: [
        { count: 2, name: "Drum n Bass" },
        { count: 1, name: "Halftime" },
        { count: 1, name: "Jungle" },
      ],
      viaRelease: 1,
      viaSearch: 2,
    });

    expect(beatport.status).toBe("ok");
    expect(beatport.data?.trackCount).toBe(100);
    expect(beatport.data?.genres[0]).toEqual({ count: 90, name: "Drum & Bass", share: 0.9 });

    expect(apple.status).toBe("ok");
    expect(apple.data?.looked).toBe(2);
    expect(apple.data?.found).toBe(1);
    expect(apple.data?.genres).toEqual([{ count: 1, name: "Jungle/Drum'n'bass" }]);
  });

  test("reports a failing source with its error and keeps every other source's facts", async () => {
    const routes = defaultRoutes();
    for (const key of Object.keys(routes).filter((k) => k.includes("discogs"))) {
      routes[key] = () => new Response("boom", { status: 500 });
    }
    const { deps } = setup(routes);

    const evidence = await gatherLabelEvidence(LABEL_MBID, ALL, deps);

    expect(evidence.ok).toBe(true);
    expect(evidence.partial).toBe(true);
    expect(evidence.sources.discogs.status).toBe("error");
    expect(evidence.sources.discogs.errors).toHaveLength(2);
    expect(evidence.sources.discogs.data).toEqual({});
    expect(evidence.sources.musicbrainz.status).toBe("ok");
    expect(evidence.sources.beatport.status).toBe("ok");
    expect(evidence.sources.apple.status).toBe("ok");
    expect(evidence.errors.map((failure) => failure.source)).toEqual(["discogs", "discogs"]);
    expect(evidence.errors[0]).toMatchObject({ attempts: 2, kind: "http", status: 500 });
  });

  test("falls back to per-release reads when the Discogs search is rate-limited out", async () => {
    const routes = defaultRoutes();
    routes["api.discogs.com/database/search?type=release"] = () =>
      new Response("", { headers: { "retry-after": "1" }, status: 429 });
    const { deps } = setup(routes);

    const evidence = await gatherLabelEvidence(LABEL_MBID, ALL, deps);

    expect(evidence.sources.discogs.status).toBe("partial");
    expect(evidence.sources.discogs.data?.label?.name).toBe("Test Beats");
    expect(evidence.sources.discogs.data?.styles).toMatchObject({
      releasesRead: 1,
      styles: [{ count: 1, name: "Halftime" }],
      viaRelease: 1,
      viaSearch: 0,
    });
    expect(evidence.sources.discogs.errors?.[0]).toMatchObject({
      kind: "rate_limited",
      status: 429,
    });
  });

  test("reports a timed-out Beatport scrape without failing the run", async () => {
    const hang: BeatportScraper = (_url, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const { deps } = setup(defaultRoutes(), { scraper: hang });

    const evidence = await gatherLabelEvidence(LABEL_MBID, ALL, deps);

    expect(evidence.ok).toBe(true);
    expect(evidence.sources.beatport.status).toBe("error");
    expect(evidence.sources.beatport.errors?.[0]).toMatchObject({ attempts: 2, kind: "timeout" });
    expect(evidence.sources.discogs.status).toBe("ok");
  });

  test("skips the linked sources when the MusicBrainz label itself is unreachable", async () => {
    const routes = defaultRoutes();
    routes[`musicbrainz.org/ws/2/label/${LABEL_MBID}`] = () => new Response("", { status: 503 });
    const { deps } = setup(routes);

    const evidence = await gatherLabelEvidence(LABEL_MBID, ALL, deps);

    expect(evidence.sources.musicbrainz.status).toBe("partial");
    expect(evidence.sources.discogs.status).toBe("skipped");
    expect(evidence.sources.beatport.status).toBe("skipped");
    expect(evidence.sources.apple.status).toBe("ok");
    expect(evidence.ok).toBe(true);
    expect(evidence.partial).toBe(true);
  });

  test("is not ok when no requested source answered", async () => {
    const { deps } = setup({});

    const evidence = await gatherLabelEvidence(LABEL_MBID, ALL, deps);

    expect(evidence.ok).toBe(false);
    expect(evidence.sources.musicbrainz.status).toBe("error");
    expect(evidence.sources.musicbrainz.errors?.[0]?.kind).toBe("not_found");
  });

  test("names unlinked sources as absent and offers only unverified Discogs candidates", async () => {
    const routes = defaultRoutes();
    routes[`musicbrainz.org/ws/2/label/${LABEL_MBID}`] = () => json(mbLabel([]));
    const { deps, hits } = setup(routes);

    const evidence = await gatherLabelEvidence(LABEL_MBID, ALL, deps);

    expect(evidence.sources.discogs.status).toBe("no_link");
    expect(evidence.sources.discogs.data?.candidates).toEqual([
      { id: 9, title: "Test Beats (2)", url: "https://www.discogs.com/label/9-Test-Beats-2" },
    ]);
    expect(evidence.sources.discogs.data?.styles).toBeUndefined();
    expect(evidence.sources.beatport.status).toBe("no_link");
    expect(hits.some((url) => url.includes("/labels/"))).toBe(false);
  });

  test("says Beatport is not configured when no Firecrawl path exists", async () => {
    const { deps } = setup(defaultRoutes(), { scraper: null });

    const evidence = await gatherLabelEvidence(LABEL_MBID, ALL, deps);

    expect(evidence.sources.beatport.status).toBe("not_configured");
    expect(evidence.partial).toBe(true);
  });

  test("answers a repeat run from the cache without touching the network", async () => {
    const { deps, hits } = setup();
    await gatherLabelEvidence(LABEL_MBID, ALL, deps);
    const firstRun = hits.length;

    const evidence = await gatherLabelEvidence(LABEL_MBID, ALL, deps);

    expect(hits.length).toBe(firstRun);
    expect(evidence.sources.musicbrainz.cached).toBe(true);
    expect(evidence.sources.beatport.cached).toBe(true);
  });

  test("only runs the requested sources", async () => {
    const { deps, hits } = setup();

    const evidence = await gatherLabelEvidence(
      LABEL_MBID,
      { ...ALL, sources: ["musicbrainz"] },
      deps,
    );

    expect(evidence.sources.discogs.status).toBe("skipped");
    expect(evidence.sources.apple.status).toBe("skipped");
    expect(hits.every((url) => url.includes("musicbrainz.org"))).toBe(true);
    expect(evidence.partial).toBe(false);
  });

  test("resolves a slug through the admin label list and refuses a label with no MBID", async () => {
    const row = {
      createdAt: "",
      findingCount: 0,
      id: "lbl_1",
      mbLabelId: LABEL_MBID.toUpperCase(),
      name: "Test Beats",
      ruledAt: null,
      seedState: "undecided",
      slug: "test-beats",
      updatedAt: "",
    } satisfies LabelAdminItem;
    const { deps } = setup(defaultRoutes(), { resolveLabel: async () => row });

    const evidence = await gatherLabelEvidence(
      "test-beats",
      { ...ALL, sources: ["musicbrainz"] },
      deps,
    );
    expect(evidence.label).toMatchObject({
      id: "lbl_1",
      mbLabelId: LABEL_MBID,
      seedState: "undecided",
      slug: "test-beats",
    });

    const orphan = setup(defaultRoutes(), {
      resolveLabel: async () => ({ ...row, mbLabelId: null }),
    });
    const refusal = await gatherLabelEvidence("test-beats", ALL, orphan.deps).catch(
      (error: unknown) => error,
    );
    expect(String(refusal)).toContain("no MusicBrainz identity");
  });
});

describe("the first-credit census", () => {
  function censusPage(offset: number) {
    const firstPage = [
      {
        "artist-credit": credit(HOUSE_ACT, "Housey"),
        recording: { "artist-credit": credit(DNB_ACT, "Roller"), id: "rec1" },
      },
      { recording: { id: "rec2" } },
      {
        recording: {
          "artist-credit": [{ name: "Uncredited MC" }, ...credit(DNB_ACT, "Roller")],
          id: "rec3",
        },
      },
      { recording: { "artist-credit": credit(VARIOUS, "Various Artists"), id: "rec5" } },
    ];
    const secondPage = [
      { recording: { "artist-credit": credit(DNB_ACT, "Roller"), id: "rec1" } },
      { "artist-credit": credit(HOUSE_ACT, "Housey"), recording: { id: "rec4" } },
    ];

    return {
      "release-count": 3,
      releases:
        offset === 0
          ? [
              {
                "artist-credit": credit(HOUSE_ACT, "Housey"),
                id: "a",
                media: [{ tracks: firstPage }],
              },
              { id: "b", media: [] },
            ]
          : [{ id: "c", media: [{ tracks: secondPage }] }],
    };
  }

  function censusRoutes(): Record<string, Route> {
    return {
      ...defaultRoutes(),
      [`release?label=${LABEL_MBID}&inc=artist-credits+recordings`]: (url) =>
        json(censusPage(Number(new URL(url).searchParams.get("offset")))),
    };
  }

  test("attributes each recording once, the way the crawler's artist rules read it", async () => {
    const { deps } = setup(censusRoutes());

    const evidence = await gatherLabelEvidence(
      LABEL_MBID,
      { census: true, censusPages: 5, sources: ["musicbrainz"] },
      deps,
    );

    expect(evidence.sources.musicbrainz.data?.census).toEqual({
      caveat: null,
      firstCredits: [
        { artistMbid: DNB_ACT, artistName: "Roller", recordings: 2 },
        { artistMbid: HOUSE_ACT, artistName: "Housey", recordings: 1 },
      ],
      pagesFetched: 2,
      recordingsCounted: 5,
      releaseCount: 3,
      releasesRead: 3,
      sampled: false,
      uncreditedRecordings: 2,
    });
  });

  test("keeps the pages it read when a later census page fails", async () => {
    const routes = censusRoutes();
    routes[`release?label=${LABEL_MBID}&inc=artist-credits+recordings`] = (url) =>
      new URL(url).searchParams.get("offset") === "0"
        ? json(censusPage(0))
        : new Response("", { status: 500 });
    const { deps } = setup(routes);

    const evidence = await gatherLabelEvidence(
      LABEL_MBID,
      { census: true, censusPages: 5, sources: ["musicbrainz"] },
      deps,
    );

    expect(evidence.sources.musicbrainz.status).toBe("partial");
    expect(evidence.sources.musicbrainz.data?.census).toMatchObject({
      caveat: "sampled: first 2 of 3 releases (a later page failed)",
      pagesFetched: 1,
      recordingsCounted: 4,
      sampled: true,
      uncreditedRecordings: 1,
    });
    expect(evidence.errors[0]).toMatchObject({ kind: "http", source: "musicbrainz", status: 500 });
  });

  test("reports an unusable Beatport page as invalid without caching it", async () => {
    let calls = 0;
    const challenge: BeatportScraper = async () => {
      calls += 1;

      return { headers: { get: () => null }, status: 200, text: "<html>Just a moment</html>" };
    };
    const { deps } = setup(defaultRoutes(), { scraper: challenge });

    const first = await gatherLabelEvidence(LABEL_MBID, ALL, deps);
    await gatherLabelEvidence(LABEL_MBID, ALL, deps);

    expect(first.sources.beatport.status).toBe("error");
    expect(first.sources.beatport.errors?.[0]).toMatchObject({ kind: "invalid" });
    expect(calls).toBe(4);
  });

  test("states the sampling caveat when the page cap stops it early", async () => {
    const { deps } = setup(censusRoutes());

    const evidence = await gatherLabelEvidence(
      LABEL_MBID,
      { census: true, censusPages: 1, sources: ["musicbrainz"] },
      deps,
    );

    expect(evidence.sources.musicbrainz.data?.census).toMatchObject({
      caveat: "sampled: first 2 of 3 releases",
      pagesFetched: 1,
      sampled: true,
    });
  });
});

describe("parsers", () => {
  test("reads link ids from MusicBrainz url-rels", () => {
    expect(discogsLabelIdFrom("https://www.discogs.com/label/1386")).toBe(1386);
    expect(discogsLabelIdFrom("https://www.discogs.com/label/1386-Hospital-Records")).toBe(1386);
    expect(discogsLabelIdFrom("https://www.discogs.com/artist/1")).toBeNull();
    expect(discogsSearchName("Rubi Records (2)")).toBe("Rubi Records");
    expect(discogsSearchName("-30 Recordings")).toBe("30 Recordings");
    expect(beatportLabelUrlFrom("https://www.beatport.com/label/hospital-records/2398")).toBe(
      "https://www.beatport.com/label/hospital-records/2398",
    );
    expect(beatportLabelUrlFrom("https://www.beatport.com/label/x/1/tracks?page=2")).toBe(
      "https://www.beatport.com/label/x/1",
    );
  });

  test("picks the crawler's rule credit: the first MBID-bearing entry that is not Various Artists", () => {
    expect(crawlRuleCredit([{ name: "MC" }, ...credit(DNB_ACT, "Roller")])).toEqual({
      mbid: DNB_ACT,
      name: "Roller",
    });
    expect(crawlRuleCredit(credit(VARIOUS, "Various Artists"))).toBeNull();
    expect(crawlRuleCredit(undefined)).toBeNull();
  });

  test("returns null for a Beatport page without the tracks facet", () => {
    expect(parseBeatportTracksPage("<html>404</html>")).toBeNull();
    expect(parseBeatportTracksPage(beatportHtml())?.subGenres).toEqual([
      { count: 12, name: "Jungle" },
    ]);
  });

  test("validates --sources and --census-pages", () => {
    expect(parseEvidenceSources(undefined)).toEqual([...EVIDENCE_SOURCES]);
    expect(parseEvidenceSources("apple, MusicBrainz")).toEqual(["musicbrainz", "apple"]);
    expect(() => parseEvidenceSources("spotify")).toThrow("Unknown source(s): spotify");
    expect(parseCensusPages("3")).toBe(3);
    expect(() => parseCensusPages("6")).toThrow("--census-pages 1-5");
    expect(() => parseCensusPages("x")).toThrow();
  });

  test("renders a one-line-per-source summary", async () => {
    const { deps } = setup(defaultRoutes(), { scraper: null });
    const lines = labelEvidenceLines(await gatherLabelEvidence(LABEL_MBID, ALL, deps));

    expect(lines[0]).toBe(`Test Beats (${LABEL_MBID})`);
    expect(lines.find((line) => line.startsWith("  beatport:"))).toContain("not_configured");
    expect(lines.find((line) => line.startsWith("  discogs:"))).toContain("Drum n Bass 2");
  });
});

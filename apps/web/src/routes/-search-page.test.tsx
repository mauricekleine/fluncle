import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SearchAnswer } from "./search";
import { type SearchPageData } from "./-search-page-data";
import { SEARCH_EXAMPLES, type SearchHit, type SearchResponse } from "@/lib/search-results";

const ROUTE_PATHS = ["/", "/search", "/tracks", "/findings", "/log/$logId", "/artist/$slug"];

async function renderPage(data: SearchPageData, q?: string, like?: string): Promise<string> {
  const rootRoute = createRootRoute({
    component: () => <SearchAnswer data={data} like={like} q={q} />,
  });
  const children = ROUTE_PATHS.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path }),
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren(children),
  });

  await router.load();

  return renderToString(<RouterProvider router={router} />);
}

function hit(overrides: Partial<SearchHit>): SearchHit {
  return {
    artists: ["Nova Kestrel"],
    certified: false,
    title: "A Tune",
    trackId: "t1",
    ...overrides,
  };
}

function answered(overrides: Partial<SearchResponse> = {}): SearchPageData {
  return {
    response: { degraded: false, entities: [], kind: "token", results: [], ...overrides },
    status: "answered",
  };
}

describe("the answered surface", () => {
  it("server-renders the rows, so a crawler with no JS walks the whole answer", async () => {
    const html = await renderPage(
      answered({
        entities: [{ kind: "artist", name: "Nova Kestrel", slug: "nova-kestrel" }],
        results: [hit({ certified: true, logId: "701.1.0A", title: "Synthetic Aurora" })],
      }),
      "nova",
    );

    expect(html).toContain("Synthetic Aurora");
    expect(html).toContain("701.1.0A");
    expect(html).toContain('href="/log/701.1.0A"');
    expect(html).toContain('href="/artist/nova-kestrel"');

    expect(html).toContain("2 matches");
  });

  it("says one match in the singular", async () => {
    const html = await renderPage(
      answered({ results: [hit({ spotifyUrl: "https://open.spotify.com/track/x" })] }),
      "a tune",
    );

    expect(html).toContain("1 match for");
    expect(html).not.toContain("1 matches");
  });

  it("links an uncertified track to its destination, and never names the tier it belongs to", async () => {
    const html = await renderPage(
      answered({
        results: [hit({ spotifyUrl: "https://open.spotify.com/track/x", title: "Quiet Row" })],
      }),
      "quiet",
    );

    expect(html).toContain('href="/track/t1"');

    expect(html).not.toContain("search-row-coordinate");
    expect(html).not.toContain("https://open.spotify.com/track/x");

    expect(html).toContain('<li class="discovery-row">');

    expect(html).not.toContain("Tracks</h2>");
    for (const forbidden of ["catalogue", "Catalogue", "uncertified", "Uncertified"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("links a row the destination refuses out to its off-site anchor", async () => {
    const html = await renderPage(
      answered({
        results: [hit({ artists: [], spotifyUrl: "https://open.spotify.com/track/x", title: "" })],
      }),
      "quiet",
    );

    expect(html).toContain('href="https://open.spotify.com/track/x"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<li class="discovery-row">');
  });

  it("names the superset only when a named group renders above it", async () => {
    const html = await renderPage(
      answered({
        results: [
          hit({ certified: true, logId: "701.1.0A", title: "Synthetic Aurora", trackId: "a" }),
          hit({ spotifyUrl: "https://open.spotify.com/track/x", title: "Quiet Row", trackId: "b" }),
        ],
      }),
      "aurora",
    );

    expect(html).toContain("Findings</h2>");
    expect(html).not.toContain("Fluncle&#x27;s Findings");
    expect(html).toContain("Tracks</h2>");
  });

  it("admits a degraded answer instead of dressing text hits up as filters", async () => {
    const html = await renderPage(answered({ degraded: true, results: [hit({})] }), "quiet ones");

    expect(html).toContain("Reading by name only right now.");
  });

  it("echoes back what the language tier understood", async () => {
    const html = await renderPage(
      answered({ filters: { artist: "Andromedik", key: "A minor" }, results: [hit({})] }),
      "andromedik in A minor",
    );

    expect(html).toContain("artist: Andromedik");
    expect(html).toContain("key: A minor");
  });

  it("counts a style answer as tracks in its order, one list, with where it continues", async () => {
    const html = await renderPage(
      answered({
        filters: { sound: "liquid", soundsLikeArtists: ["Calibre", "LSB"] },
        kind: "sonic",
        results: [
          hit({ title: "Near One", trackId: "t1" }),
          hit({ certified: true, logId: "701.1.0A", title: "Lit Two", trackId: "t2" }),
          hit({ title: "Far Three", trackId: "t3" }),
        ],
      }),
      "liquid",
    );

    expect(html).toContain("3 tracks closest to Liquid.");
    expect(html).toContain("Going by <strong>Calibre and LSB</strong>.");
    expect(html.indexOf("Near One")).toBeLessThan(html.indexOf("Lit Two"));
    expect(html.indexOf("Lit Two")).toBeLessThan(html.indexOf("Far Three"));
    expect(html).not.toContain(">Findings<");
    expect(html).toContain('href="/tracks?sound=liquid"');
    expect(html).toContain("See all tracks closest to Liquid");
  });

  it("names the seed of the sonic view once, and says when it went by the artist instead", async () => {
    const own = await renderPage(
      answered({
        anchor: hit({ title: "Seed Tune", trackId: "seed" }),
        kind: "sonic",
        results: [hit({ title: "Next Tune", trackId: "t2" })],
      }),
      undefined,
      "seed",
    );

    expect(own).toContain("1 track close to Nova Kestrel — Seed Tune.");
    expect(own).not.toContain("Near ");

    const leaned = await renderPage(
      answered({
        anchor: hit({ title: "Seed Tune", trackId: "seed" }),
        filters: { soundsLikeArtists: ["Nova Kestrel"] },
        kind: "sonic",
        results: [hit({ title: "Next Tune", trackId: "t2" })],
      }),
      undefined,
      "seed",
    );

    expect(leaned).toContain("I haven’t got a read on <strong>Seed Tune</strong> yet");

    const nothing = await renderPage(
      answered({ anchor: hit({ title: "Seed Tune", trackId: "seed" }), kind: "sonic" }),
      undefined,
      "seed",
    );

    expect(nothing).toContain("I haven’t got a read on how Nova Kestrel — Seed Tune sounds yet.");
    expect(await renderPage(answered({ kind: "sonic" }), undefined, "nope")).toContain(
      "No track at that link.",
    );
  });

  it("names the track the sonic tier anchored on — a real row, never an invented vibe", async () => {
    const html = await renderPage(
      answered({
        anchor: hit({ certified: true, logId: "701.1.0A", title: "Synthetic Aurora" }),
        kind: "sonic",
        results: [hit({ title: "Neon Undertow", trackId: "t2" })],
      }),
      "tracks that sound like Synthetic Aurora",
    );

    expect(html).toContain("Near ");
    expect(html).toContain("Nova Kestrel — Synthetic Aurora");
  });
});

describe("the states that are not an answer", () => {
  it("offers the four worked examples as real, followable links when nothing is typed", async () => {
    const html = await renderPage({ status: "blank" });

    expect(html).toContain("Give me a name, a coordinate, or the sound of a track.");
    for (const example of SEARCH_EXAMPLES) {
      expect(html).toContain(`q=${encodeURIComponent(example.query)}`);
    }
    expect(html).toContain('href="/search?q=netsky"');
  });

  it("asks for something to go on when the query is below the resolver's floor", async () => {
    const html = await renderPage({ status: "blank" }, "n");

    expect(html).toContain("characters to go on");
    expect(html).toContain("Try one of these.");
  });

  it("names an empty answer with the query that produced it, and offers a way back", async () => {
    const html = await renderPage(answered({}), "zzzqqx");

    expect(html).toContain("Nothing out here for “zzzqqx”.");
    expect(html).toContain("Try a different name, or ");
    expect(html).toContain("dig through every track I hold");
    expect(html).toContain('href="/tracks"');
    expect(html.match(/Nothing out here for/g)).toHaveLength(1);
    expect(html).toMatch(/<output[^>]*>Nothing out here for “zzzqqx”\.<\/output>/);
    expect(html).toContain('href="/tracks?sound=liquid"');
  });

  it("offers the style a missed query mentioned as its nearest sound", async () => {
    const html = await renderPage(answered({}), "chilled liquid zzqx");

    expect(html).toContain("Closest sound I’ve got:");
    expect(html.match(/href="\/tracks\?sound=/g)).toHaveLength(1);
  });

  it("answers a sentence typed live by its words, and leaves the language tier for Enter", async () => {
    const words: SearchPageData = {
      awaitsEnter: true,
      response: {
        degraded: false,
        entities: [],
        kind: "token",
        results: [hit({ title: "Moonlit Current" })],
      },
      status: "answered",
    };
    const html = await renderPage(words, "moonlit current");

    expect(html).toContain("1 match for “moonlit current”. Press Enter to read it as a sentence.");
    expect(html).toContain("Moonlit Current");

    const none = await renderPage(
      { ...words, response: { ...words.response, results: [] } },
      "zz qq",
    );

    expect(none).toContain("Press Enter to search for “zz qq”.");
    expect(none).not.toContain("Nothing out here");
  });

  it("never passes an empty word match off as nothing out here when the language tier was down", async () => {
    const html = await renderPage(answered({ degraded: true }), "tracks in F minor");

    expect(html).toContain(
      "Reading by name only right now, and nothing came up for “tracks in F minor”.",
    );
    expect(html).not.toContain("Nothing out here");
  });

  it("does not offer a style back as the nearest sound when the style itself came back empty", async () => {
    const html = await renderPage(answered({}), "neurofunk");

    expect(html).not.toContain("Closest sound I’ve got:");
  });

  it("tells a coordinate miss apart from a name miss", async () => {
    const html = await renderPage(answered({ kind: "coordinate" }), "999.9.9Z");

    expect(html).toContain("No finding at that coordinate.");
    expect(html).not.toContain("Nothing out here for");

    expect(html).toContain("Nothing logged there yet.");
    expect(html).not.toContain("Try a different name");
  });

  it("names a fault as a fault, never as an empty result", async () => {
    const html = await renderPage({ status: "failed" }, "netsky");

    expect(html).toContain("Couldn&#x27;t get an answer out of the archive just then.");
    expect(html).toContain("Try that search again");
    expect(html).toContain('href="/tracks"');
    expect(html).not.toContain("Nothing out here");
    expect(html).toContain("Search did not answer.");
  });
});

describe("the field", () => {
  it("is a real GET form to the surface's own URL, seeded from the committed query", async () => {
    const html = await renderPage(answered({ results: [hit({})] }), "netsky");

    expect(html).toContain('action="/search"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="q"');
    expect(html).toContain('value="netsky"');
  });

  it("names the field for assistive technology", async () => {
    const html = await renderPage({ status: "blank" });

    expect(html).toContain('for="search-page-q"');
    expect(html).toContain("Search the archive");
  });
});

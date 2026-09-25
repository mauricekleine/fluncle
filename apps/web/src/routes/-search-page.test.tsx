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

async function renderPage(data: SearchPageData, q?: string): Promise<string> {
  const rootRoute = createRootRoute({ component: () => <SearchAnswer data={data} q={q} /> });
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

    expect(html).toContain("No matches for “zzzqqx”.");
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

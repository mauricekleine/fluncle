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

// `/search`, rendered through a router (TanStack `<Link>` needs one) so every assertion runs over
// the REAL server HTML a crawler and a JS-blind reader receive — which is the whole claim of the
// persistent surface. Four contracts, each the point of the page rather than a detail of it:
//
//   1. THE ANSWER IS IN THE HTML. No client fetch, no hydration gate: the rows, the coordinates,
//      and the links out are all in the server response, so a crawler with no JS walks them.
//   2. THE UNLIT RULE SURVIVES THE MOVE. A finding is lit and links to its coordinate; a track
//      Fluncle never certified links OUT and is never named, badged, or given a noun — no heading
//      over a bare unlit list, ever (DESIGN.md).
//   3. EMPTY AND FAILED ARE DIFFERENT FACTS, SAID DIFFERENTLY. "Nothing out here" is a lie about an
//      archive nobody managed to look inside, so the fault has its own copy, and both carry a way
//      onward rather than a dead end.
//   4. THE ZERO STATE TEACHES. The four worked example queries render as REAL links to the surface
//      they answer on — followable, shareable, crawlable — not as buttons that fill a field.

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
    // The count is announced, and it counts the entity jump alongside the row.
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

  // THE UNLIT RULE. An uncertified row links OUT because there is no `/log` page for somewhere
  // Fluncle has not been, and the tier it belongs to is never given a name anywhere on the page.
  it("links an uncertified track out, and never names the tier it belongs to", async () => {
    const html = await renderPage(
      answered({
        results: [hit({ spotifyUrl: "https://open.spotify.com/track/x", title: "Quiet Row" })],
      }),
      "quiet",
    );

    expect(html).toContain('href="https://open.spotify.com/track/x"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("search-row--unlit");
    // Alone on the page, the unlit rows stand BARE: a heading over the only content would exist
    // purely to name the tier.
    expect(html).not.toContain("Tracks</h2>");
    for (const forbidden of ["catalogue", "Catalogue", "uncertified", "Uncertified"]) {
      expect(html).not.toContain(forbidden);
    }
  });

  // The superset heading earns its place only when something NAMED renders above it.
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

    expect(html).toContain("Fluncle&#x27;s Findings");
    expect(html).toContain("Tracks</h2>");
  });

  // The honesty line: the language tier was wanted and could not run, so these are text hits and
  // the page says so rather than passing one off as the filters that were asked for.
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

    expect(html).toContain("Synthetic Aurora");
    expect(html).toContain("Near ");
  });
});

describe("the states that are not an answer", () => {
  it("offers the four worked examples as real, followable links when nothing is typed", async () => {
    const html = await renderPage({ status: "blank" });

    expect(html).toContain("Nothing typed yet.");
    for (const example of SEARCH_EXAMPLES) {
      // A link, not a button: an example query is the best thing on this page for a crawler to
      // follow and for a reader to open in a new tab.
      expect(html).toContain(`q=${encodeURIComponent(example.query)}`);
    }
    expect(html).toContain('href="/search?q=netsky"');
  });

  it("asks for something to go on when the query is below the resolver's floor", async () => {
    const html = await renderPage({ status: "blank" }, "n");

    expect(html).toContain("characters to go on");
  });

  it("names an empty answer with the query that produced it, and offers a way back", async () => {
    const html = await renderPage(answered({}), "zzzqqx");

    expect(html).toContain("Nothing out here for “zzzqqx”.");
    expect(html).toContain("dig through every track I hold");
    expect(html).toContain('href="/tracks"');
  });

  // A coordinate that names no finding is a different fact from a name the archive does not hold,
  // and collapsing the two would throw away the only useful thing the resolver learned.
  it("tells a coordinate miss apart from a name miss", async () => {
    const html = await renderPage(answered({ kind: "coordinate" }), "999.9.9Z");

    expect(html).toContain("No finding at that coordinate.");
    expect(html).not.toContain("Nothing out here for");
  });

  // THE THIRD STATE. "Nothing out here" would be a lie about an archive nobody managed to look
  // inside, so a fault is named as a fault — with a way to retry and a way onward.
  it("names a fault as a fault, never as an empty result", async () => {
    const html = await renderPage({ status: "failed" }, "netsky");

    expect(html).toContain("I could not get an answer out of the archive just then.");
    expect(html).toContain("Try that search again");
    expect(html).toContain('href="/tracks"');
    expect(html).not.toContain("Nothing out here");
  });
});

describe("the field", () => {
  // The no-JS contract: the browser's own submit builds exactly the URL the route reads, so search
  // works before (and without) hydration.
  it("is a real GET form to the surface's own URL, seeded from the committed query", async () => {
    const html = await renderPage(answered({ results: [hit({})] }), "netsky");

    expect(html).toContain('action="/search"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="q"');
    expect(html).toContain('value="netsky"');
  });

  // The visible label is absent, so the accessible name comes from a real `<label>` rather than an
  // aria-label that could disagree with what a voice-control reader sees.
  it("names the field for assistive technology", async () => {
    const html = await renderPage({ status: "blank" });

    expect(html).toContain('for="search-page-q"');
    expect(html).toContain("Search the archive");
  });
});

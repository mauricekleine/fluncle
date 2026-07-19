import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ChatNeighbour, NeighbourList } from "./neighbour-card";

// The chat "similar artists" rail reaches the WHOLE embedded archive, so a neighbour Fluncle never
// certified must render UNLIT (DESIGN.md's Unlit Rule), mirroring the /artist page rail exactly:
// the chip keys its `--unlit` modifier off `certified === false`. Render it through a router (so the
// TanStack `<Link>` builds its /artist href) and assert the lit vs unlit class split.

async function renderNeighbours(
  neighbours: ChatNeighbour[],
  of?: { name?: string; slug?: string },
): Promise<string> {
  const rootRoute = createRootRoute({
    component: () => <NeighbourList neighbours={neighbours} of={of} />,
  });
  const artistRoute = createRoute({ getParentRoute: () => rootRoute, path: "/artist/$slug" });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([artistRoute]),
  });

  await router.load();

  return renderToString(<RouterProvider router={router} />);
}

describe("NeighbourList — the chat similar-artists rail", () => {
  const NEIGHBOURS: ChatNeighbour[] = [
    {
      certified: true,
      imageUrl: "https://cover.example/camo.jpg",
      name: "Camo & Krooked",
      slug: "camo-krooked",
    },
    { certified: false, name: "Faint Trace", slug: "faint-trace" },
  ];

  it("renders a catalogue neighbour UNLIT and a certified one lit, each a real /artist link", async () => {
    const html = await renderNeighbours(NEIGHBOURS, { name: "Koven", slug: "koven" });

    // The unlit modifiers land ONLY on the uncertified neighbour's chip + avatar.
    expect(html).toContain("artist-similar-link--unlit");
    expect(html).toContain("artist-similar-avatar--unlit");

    // The certified neighbour keeps the bare (lit) classes — the closing quote proves the
    // `--unlit` modifier is absent from that chip + its avatar (ArtistAvatar prepends its own
    // `artist-avatar` base class before the caller's).
    expect(html).toContain('class="artist-similar-link"');
    expect(html).toContain('class="artist-avatar artist-similar-avatar"');

    // Both neighbours are named and link to their /artist page (naming an artist is always allowed).
    expect(html).toContain("Camo &amp; Krooked");
    expect(html).toContain("Faint Trace");
    expect(html).toContain('href="/artist/camo-krooked"');
    expect(html).toContain('href="/artist/faint-trace"');
  });

  it("names the anchor artist in the quiet header", async () => {
    const html = await renderNeighbours(NEIGHBOURS, { name: "Koven", slug: "koven" });

    expect(html).toContain("Artists like Koven");
  });

  it("falls back to a bare label when no anchor name rides the output", async () => {
    const html = await renderNeighbours(NEIGHBOURS);

    expect(html).toContain("Similar artists");
  });

  it("renders nothing when there are no neighbours (no bare header block)", async () => {
    const html = await renderNeighbours([], { name: "Koven", slug: "koven" });

    expect(html).not.toContain("artist-similar-list");
    expect(html).not.toContain("Artists like Koven");
  });
});

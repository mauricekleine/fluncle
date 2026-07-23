import { createRouter } from "@tanstack/react-router";
import { subdomainRewrite } from "./router-rewrite";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    // Prefetch a route on hover/touch intent. Router's own default is `false` — no
    // link is prefetched — so every graph hop (log → artist → label → album) paid a
    // cold loader round-trip only once the user had already clicked. "intent" warms
    // the loader while the pointer is on the link, so the hop feels instant.
    defaultPreload: "intent",
    // How long a PREFETCHED loader result counts as fresh once the nav actually
    // happens. Left at Router's 30s default, stated for clarity.
    defaultPreloadStaleTime: 30_000,
    // Client-nav freshness. Router's own default is `0` — loader data is stale the
    // instant it lands, so every in-session SPA navigation re-fires the loader as a
    // `createServerFn` network round-trip to the Worker+Turso that the edge cache
    // never covers (wrong Accept, wrong path). 60s matches the hubs' own edge-cache
    // fresh window, so a re-visited page within the minute is served from the client
    // cache and client/edge freshness agree. Personalised/volatile routes
    // (account/recommendations/chat) pin their own shorter `staleTime` so a stale or
    // another user's read is never reused; the root pins a LONGER one (its galaxy-map
    // count is effectively static). See each route's `staleTime`.
    defaultStaleTime: 60_000,
    // The subdomain root → route rewrite (galaxy./radio./status.), isomorphic so SSR
    // and client hydration agree. Lives in ./router-rewrite (no route-tree import) so
    // its host-rewrite contract is pure + unit-testable.
    rewrite: subdomainRewrite,
    routeTree,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

// The subdomain host-rewrite contract, kept in its own module (no route-tree imports)
// so it is pure + unit-testable. galaxy.fluncle.com is the game's front door;
// radio.fluncle.com is the cycling observation station; status.fluncle.com is the
// service-health board. Each host's root rewrites to its route; the same map drives the
// reverse (route → root) so the address bar stays <subdomain>.fluncle.com/.

const SUBDOMAIN_ROUTES: ReadonlyArray<{ host: string; route: string }> = [
  { host: "galaxy.", route: "/galaxy" },
  { host: "radio.", route: "/radio" },
  { host: "status.", route: "/status" },
];

// The router rewrite. It runs isomorphically (SSR + client hydration agree), so the
// client never hydrates the archive over the game/station/board: a server-only rewrite
// isn't enough — the client router would hydrate against the address bar's "/".
export const subdomainRewrite = {
  // Forward: a subdomain root ("/") becomes its route on the way in.
  input: ({ url }: { url: URL }): URL => {
    for (const { host, route } of SUBDOMAIN_ROUTES) {
      if (url.hostname.startsWith(host) && url.pathname === "/") {
        url.pathname = route;
      }
    }

    return url;
  },
  // Reverse: the route on a subdomain renders back as that host's root.
  output: ({ url }: { url: URL }): URL => {
    for (const { host, route } of SUBDOMAIN_ROUTES) {
      if (url.hostname.startsWith(host) && url.pathname === route) {
        url.pathname = "/";
      }
    }

    return url;
  },
};

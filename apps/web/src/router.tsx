import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    // galaxy.fluncle.com is the game's front door. The router rewrites the
    // subdomain root to /galaxy on the way in — isomorphically, so SSR and
    // client hydration agree and the address bar stays galaxy.fluncle.com/.
    // (A server-only rewrite isn't enough: the client router would hydrate
    // against the address bar's "/" and render the archive over the game.)
    rewrite: {
      input: ({ url }) => {
        if (url.hostname.startsWith("galaxy.") && url.pathname === "/") {
          url.pathname = "/galaxy";
        }

        return url;
      },
      output: ({ url }) => {
        if (url.hostname.startsWith("galaxy.") && url.pathname === "/galaxy") {
          url.pathname = "/";
        }

        return url;
      },
    },
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

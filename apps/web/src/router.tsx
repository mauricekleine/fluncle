import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    // galaxy.fluncle.com is the game's front door; radio.fluncle.com is the
    // cycling observation station. The router rewrites each subdomain root to its
    // route on the way in — isomorphically, so SSR and client hydration agree and
    // the address bar stays <subdomain>.fluncle.com/. (A server-only rewrite isn't
    // enough: the client router would hydrate against the address bar's "/" and
    // render the archive over the game/station.)
    rewrite: {
      input: ({ url }) => {
        if (url.hostname.startsWith("galaxy.") && url.pathname === "/") {
          url.pathname = "/galaxy";
        }

        if (url.hostname.startsWith("radio.") && url.pathname === "/") {
          url.pathname = "/radio";
        }

        return url;
      },
      output: ({ url }) => {
        if (url.hostname.startsWith("galaxy.") && url.pathname === "/galaxy") {
          url.pathname = "/";
        }

        if (url.hostname.startsWith("radio.") && url.pathname === "/radio") {
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

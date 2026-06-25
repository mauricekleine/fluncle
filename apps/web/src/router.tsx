import { createRouter } from "@tanstack/react-router";
import { subdomainRewrite } from "./router-rewrite";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
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

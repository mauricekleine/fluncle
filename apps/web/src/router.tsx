import { createRouter } from "@tanstack/react-router";
import { subdomainRewrite } from "./router-rewrite";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    defaultPreload: "intent",

    defaultPreloadStaleTime: 30_000,

    defaultStaleTime: 60_000,

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

const SUBDOMAIN_ROUTES: ReadonlyArray<{ host: string; route: string }> = [
  { host: "galaxy.fluncle.com", route: "/galaxy" },
  { host: "radio.fluncle.com", route: "/radio" },
  { host: "status.fluncle.com", route: "/status" },
];

export function subdomainSurfaceRoute(hostname: string): string | undefined {
  return SUBDOMAIN_ROUTES.find(({ host }) => host === hostname)?.route;
}

export const subdomainRewrite = {
  input: ({ url }: { url: URL }): URL => {
    const route = subdomainSurfaceRoute(url.hostname);

    if (route && url.pathname === "/") {
      url.pathname = route;
    }

    return url;
  },

  output: ({ url }: { url: URL }): URL => {
    const route = subdomainSurfaceRoute(url.hostname);

    if (route && url.pathname === route) {
      url.pathname = "/";
    }

    return url;
  },
};

const SUBDOMAIN_ROUTES: ReadonlyArray<{ host: string; route: string }> = [
  { host: "galaxy.", route: "/galaxy" },
  { host: "radio.", route: "/radio" },
  { host: "status.", route: "/status" },
];

export const subdomainRewrite = {
  input: ({ url }: { url: URL }): URL => {
    for (const { host, route } of SUBDOMAIN_ROUTES) {
      if (url.hostname.startsWith(host) && url.pathname === "/") {
        url.pathname = route;
      }
    }

    return url;
  },

  output: ({ url }: { url: URL }): URL => {
    for (const { host, route } of SUBDOMAIN_ROUTES) {
      if (url.hostname.startsWith(host) && url.pathname === route) {
        url.pathname = "/";
      }
    }

    return url;
  },
};

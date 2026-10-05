import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { NavFooter } from "./nav-footer";
import { NavBreadcrumb } from "./nav-breadcrumb";
import { subdomainRewrite } from "@/router-rewrite";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const INTERNAL_PATHS = [
  "/log",
  "/artists",
  "/albums",
  "/labels",
  "/galaxies",
  "/logbook",
  "/mixtapes",
  "/about",
  "/newsletter",
  "/docs",
  "/status",
  "/privacy",
  "/terms",
  "/docs/$",
];

async function renderFooter(origin = "https://www.fluncle.com"): Promise<string> {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <NavFooter galaxiesLive={true} />
        <NavBreadcrumb pathname="/album/example" />
      </QueryClientProvider>
    ),
  });
  const children = INTERNAL_PATHS.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path }),
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    origin,
    rewrite: subdomainRewrite,
    routeTree: rootRoute.addChildren(children),
  });

  await router.load();

  return renderToString(<RouterProvider router={router} />);
}

describe("NavFooter SSR anchors", () => {
  let html = "";

  beforeAll(async () => {
    html = await renderFooter();
  });

  it.each(["status", "radio", "galaxy"])(
    "renders every internal anchor on %s as a canonical absolute URL",
    async (host) => {
      const surfaceHtml = await renderFooter(`https://${host}.fluncle.com`);
      const hrefs = [...surfaceHtml.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
      expect(hrefs.some((href) => href?.startsWith("/"))).toBe(false);
      for (const path of [
        "/",
        "/albums",
        "/privacy",
        "/terms",
        "/docs/cli",
        "/docs/ssh",
        "/status",
      ]) {
        expect(hrefs).toContain(`https://www.fluncle.com${path}`);
      }
      expect(surfaceHtml).toContain('href="https://t.me/fluncle"');
      expect(surfaceHtml).toContain('aria-label="Fluncle home"');
      expect(surfaceHtml).toContain('aria-label="Breadcrumb"');
    },
  );

  it("keeps onion chrome links relative", async () => {
    const onionHtml = await renderFooter("http://status.mirror.onion");
    expect(onionHtml).toContain('href="/"');
    expect(onionHtml).toContain('href="/albums"');
    expect(onionHtml).toContain('href="/docs/cli"');
    expect(onionHtml).toContain('href="/status"');
  });

  it("renders real <a href> anchors for every internal index", () => {
    for (const path of [
      "/log",
      "/logbook",
      "/galaxies",
      "/mixtapes",
      "/artists",
      "/albums",
      "/labels",
      "/about",
    ]) {
      expect(html).toContain(`href="${path}"`);
    }
  });

  it("renders the quiet meta/legal links (privacy + terms)", () => {
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('aria-label="Legal and credits"');
  });

  it("renders the out-of-character maker credit", () => {
    expect(html).toContain('href="https://www.mauricekleine.com/"');
    expect(html).toContain("a side quest by maurice kleine");
  });

  it("renders the developer docs deep-links via the /docs splat", () => {
    expect(html).toContain('href="/docs/cli"');
    expect(html).toContain('href="/docs/ssh"');
  });

  it("renders external follow + listen links as anchors with safe rel", () => {
    expect(html).toContain('href="https://t.me/fluncle"');
    expect(html).toContain('rel="noreferrer"');

    expect(html).toContain("<footer");

    expect(html).toContain('aria-label="Travel along"');
    expect(html).toContain('aria-label="Browse"');
  });
});

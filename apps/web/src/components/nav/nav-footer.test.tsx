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

// The SEO backbone: the shared footer must emit REAL server-rendered `<a href>`
// anchors (TanStack `<Link>` renders anchors) to every index, so a JS-blind crawler
// still walks log ↔ artists ↔ galaxies ↔ logbook ↔ mixtapes ↔ the socials. Render
// it through a router and assert the hrefs land in the static HTML.

// The internal paths the footer links; the router needs them so Link builds hrefs.
const INTERNAL_PATHS = [
  "/log",
  "/artists",
  "/galaxies",
  "/logbook",
  "/mixtapes",
  "/about",
  "/newsletter",
  "/docs",
  "/status",
  "/privacy",
  "/docs/$",
];

async function renderFooter(): Promise<string> {
  const rootRoute = createRootRoute({
    // galaxiesLive: true so the gated Galaxies link renders into the output.
    component: () => <NavFooter galaxiesLive={true} />,
  });
  const children = INTERNAL_PATHS.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path }),
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren(children),
  });
  // Load before rendering so the matched route (and its Links) render to string.
  await router.load();

  return renderToString(<RouterProvider router={router} />);
}

describe("NavFooter SSR anchors", () => {
  let html = "";

  beforeAll(async () => {
    html = await renderFooter();
  });

  it("renders real <a href> anchors for every internal index", () => {
    for (const path of ["/log", "/artists", "/galaxies", "/logbook", "/mixtapes", "/about"]) {
      expect(html).toContain(`href="${path}"`);
    }
  });

  it("renders the developer docs deep-links via the /docs splat", () => {
    expect(html).toContain('href="/docs/cli"');
    expect(html).toContain('href="/docs/ssh"');
  });

  it("renders external follow + listen links as anchors with safe rel", () => {
    expect(html).toContain('href="https://t.me/fluncle"');
    expect(html).toContain('rel="noreferrer"');
    // A real <footer> landmark and labelled navs (crawlable structure).
    expect(html).toContain("<footer");
    expect(html).toContain('aria-label="Explore"');
  });
});

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NavBreadcrumb } from "./nav-breadcrumb";

const PATHS = ["/log", "/log/$logId", "/labels", "/album/$slug", "/docs", "/docs/$", "/artists"];

async function renderAt(pathname: string, tail?: string): Promise<string> {
  const rootRoute = createRootRoute({
    component: () => <NavBreadcrumb pathname={pathname} tail={tail} />,
  });
  const children = PATHS.map((path) => createRoute({ getParentRoute: () => rootRoute, path }));
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren(children),
  });
  await router.load();

  return renderToString(<RouterProvider router={router} />);
}

describe("NavBreadcrumb JSON-LD", () => {
  it("marks up a hub trail — no route emits one, and the label is fixed chrome", async () => {
    const html = await renderAt("/labels");

    expect(html).toContain("application/ld+json");
    expect(html).toContain("BreadcrumbList");
    expect(html).toContain("Labels");
  });

  it("leaves a leaf trail's markup to the route that knows the entity's real name", async () => {
    for (const pathname of ["/album/dub-pack-vol-2", "/log/038.6.1J", "/docs/log-id"]) {
      const html = await renderAt(pathname);

      expect(html).toContain('aria-label="Breadcrumb"');
      expect(html).not.toContain("application/ld+json");
    }
  });

  it("treats an /account tab as a leaf too (it is a trail with a tail, and it is noindex)", async () => {
    const html = await renderAt("/account", "Saves");

    expect(html).toContain("Saves");
    expect(html).not.toContain("application/ld+json");
  });

  it("renders nothing at all on home (a single dead crumb is not a trail)", async () => {
    expect(await renderAt("/")).toBe("");
  });
});

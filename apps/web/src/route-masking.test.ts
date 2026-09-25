import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

function buildRouter() {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    validateSearch: (search: Record<string, unknown>): { story?: string } => ({
      story: typeof search.story === "string" && search.story.length > 0 ? search.story : undefined,
    }),
  });
  const logRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/log/$logId",
  });
  const history = createMemoryHistory({ initialEntries: ["/"] });

  return createRouter({
    history,
    routeTree: rootRoute.addChildren([indexRoute, logRoute]),
  });
}

describe("Stories dialog route masking", () => {
  it("opens masked: the actual location keeps the feed mounted, the URL shows /log/<id>", async () => {
    const router = buildRouter();
    await router.load();

    await router.navigate({
      mask: { params: { logId: "004.7.2I" }, to: "/log/$logId" },
      search: { story: "004.7.2I" },
      to: "/",
    } as never);

    expect(router.state.location.pathname).toBe("/");
    expect((router.state.location.search as { story?: string }).story).toBe("004.7.2I");

    expect(router.state.location.maskedLocation?.pathname).toBe("/log/004.7.2I");
  });

  it("closes via history.back(): the previous feed entry comes back as-is", async () => {
    const router = buildRouter();
    await router.load();

    await router.navigate({
      mask: { params: { logId: "004.7.2I" }, to: "/log/$logId" },
      search: { story: "004.7.2I" },
      to: "/",
    } as never);

    router.history.back();
    await router.load();

    expect(router.state.location.pathname).toBe("/");
    expect((router.state.location.search as { story?: string }).story).toBeUndefined();
    expect(router.state.location.maskedLocation).toBeUndefined();
  });

  it("per-flick replace keeps one dialog entry: back still lands on the feed", async () => {
    const router = buildRouter();
    await router.load();

    await router.navigate({
      mask: { params: { logId: "004.7.2I" }, to: "/log/$logId" },
      search: { story: "004.7.2I" },
      to: "/",
    } as never);

    for (const logId of ["004.0.1C", "004.6.0Q", "005.9.9L"]) {
      await router.navigate({
        mask: { params: { logId }, to: "/log/$logId" },
        replace: true,
        search: { story: logId },
        to: "/",
      } as never);
    }

    expect(router.state.location.maskedLocation?.pathname).toBe("/log/005.9.9L");

    router.history.back();
    await router.load();

    expect(router.state.location.pathname).toBe("/");
    expect((router.state.location.search as { story?: string }).story).toBeUndefined();
  });
});

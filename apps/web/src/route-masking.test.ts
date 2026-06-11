import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

// The Stories dialog contract, headless: opening a story is a masked
// navigation (actual location /?story=<id>, displayed URL /log/<id>), and
// closing goes BACK to the feed's existing history entry — never a fresh
// navigate({ to: "/" }) that would mint a new entry and reset the feed.

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

async function settled(router: ReturnType<typeof buildRouter>) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await router.load();
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
    await settled(router);

    // The ACTUAL route is the home feed with the dialog search param...
    expect(router.state.location.pathname).toBe("/");
    expect((router.state.location.search as { story?: string }).story).toBe("004.7.2I");
    // ...while the persisted/displayed URL is the standalone log page.
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
    await settled(router);

    router.history.back();
    await settled(router);

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
    await settled(router);

    // Three flicks, each a masked REPLACE navigation (the player's URL sync).
    for (const logId of ["004.0.1C", "004.6.0Q", "005.9.9L"]) {
      await router.navigate({
        mask: { params: { logId }, to: "/log/$logId" },
        replace: true,
        search: { story: logId },
        to: "/",
      } as never);
      await settled(router);
    }

    expect(router.state.location.maskedLocation?.pathname).toBe("/log/005.9.9L");

    router.history.back();
    await settled(router);

    // One back() exits the dialog completely — flicks never stacked entries.
    expect(router.state.location.pathname).toBe("/");
    expect((router.state.location.search as { story?: string }).story).toBeUndefined();
  });
});

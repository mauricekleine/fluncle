import { beforeEach, describe, expect, it, vi } from "vitest";

// The production fetch dispatch SPINE (server.ts). server.ts composes the Worker's
// one fetch handler: `handleOrpc` mounted AHEAD of `handleMcp` AHEAD of
// `handleAgentDiscovery` AHEAD of the edge-cache wrapper + the TanStack router, all
// wrapped once by Sentry. No test drove that COMPOSITION before — a mount-order
// regression (oRPC no longer first, MCP shadowed, the router captured an /api path)
// would break the whole surface at once with every unit still green. This asserts
// the dispatch DECISIONS with real Requests.
//
// Seams:
//   - `@tanstack/react-start/server-entry` is stubbed: `createServerEntry` becomes a
//     passthrough that just exposes the composed `fetch`, and the default `handler`
//     (the TanStack ROUTER) is a spy — the fall-through target. Fully rendering an
//     SSR page in node is impractical and not the point; the load-bearing assertion
//     is WHICH handler a request is dispatched to, so the router is a sentinel.
//   - `@sentry/cloudflare`'s `withSentry` is a passthrough, so the module's default
//     export is the bare composed CF handler (`cfHandler`) — importable + callable
//     with just a Request, no Worker env/ctx. Sentry adds observability, not
//     dispatch, so removing it changes no routing behaviour. (This is why NO named
//     export had to be added to server.ts — the default is already drivable.)
//   - `handleMcp` / `handleAgentDiscovery` are spies, so the ORDER among the
//     null-returning stages is provable in isolation. `handleOrpc` is kept REAL, so
//     one test proves the actual contract dispatcher genuinely serves an /api op and
//     the router never sees it. Edge-cache is real too (it no-ops to `render()`
//     outside the Workers runtime — no `caches` global — so a cacheable GET still
//     lands on the router).
//
// NOTE — subdomain rewrites are NOT part of server.ts: the host→route rewrite runs
// isomorphically in the router's rewrite config (`router-rewrite.ts`), covered by
// router-rewrite.test.ts, exactly as server.ts's own comment says. So this suite
// asserts the dispatch stages server.ts actually owns and does not restate that one.

const hoisted = vi.hoisted(() => {
  // A FRESH response per call (a Response body streams once) so tests that read the
  // router body never contend over a shared, already-consumed stream.
  const makeRouterResponse = () =>
    new Response("router-sentinel", { headers: { "content-type": "text/html" }, status: 200 });

  return {
    handleAgentDiscovery: vi.fn(
      async (_request: Request): Promise<Response | undefined> => undefined,
    ),
    handleMcp: vi.fn(async (_request: Request): Promise<Response | undefined> => undefined),
    makeRouterResponse,
    routerFetch: vi.fn(async (_request: Request) => makeRouterResponse()),
  };
});

vi.mock("@sentry/cloudflare", () => ({
  withSentry: (_options: unknown, handler: unknown) => handler,
}));

vi.mock("@tanstack/react-start/server-entry", () => ({
  createServerEntry: (options: { fetch: (request: Request) => Promise<Response> }) => ({
    fetch: (request: Request) => options.fetch(request),
  }),
  default: { fetch: hoisted.routerFetch },
}));

vi.mock("./lib/server/mcp", () => ({
  handleMcp: hoisted.handleMcp,
}));

vi.mock("./lib/server/agent-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/server/agent-discovery")>();

  return {
    ...actual,
    // The header-append helpers stay pure passthroughs so a fall-through response is
    // returned identifiably; only the discovery DISPATCH stage is spied.
    appendAgentLinkHeaders: (response: Response) => response,
    appendOnionLocation: (response: Response) => response,
    handleAgentDiscovery: hoisted.handleAgentDiscovery,
  };
});

// The composed CF handler — server.ts's default export, unwrapped by the Sentry
// passthrough above. Typed as a Worker `ExportedHandler` (fetch is 3-arg + optional);
// cast to the single-arg shape the composed `cfHandler.fetch` actually implements (it
// reads only the Request — env/ctx come from the Cloudflare vite binding, see
// server.ts), so the test drives it with just a Request.
const worker = (await import("./server")).default as unknown as {
  fetch: (request: Request) => Promise<Response>;
};

function dispatch(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request(url, { headers, method: "GET" }));
}

beforeEach(() => {
  hoisted.handleMcp.mockReset();
  hoisted.handleMcp.mockResolvedValue(undefined);
  hoisted.handleAgentDiscovery.mockReset();
  hoisted.handleAgentDiscovery.mockResolvedValue(undefined);
  hoisted.routerFetch.mockReset();
  hoisted.routerFetch.mockImplementation(async () => hoisted.makeRouterResponse());
});

describe("server.ts dispatch spine", () => {
  it("serves an /api contract path from the REAL handleOrpc — the router never sees it", async () => {
    // `/api/v1/search?q=a` faults in the real oRPC validator (too-short query) with no
    // DB touch — proof the contract dispatcher itself handled the request first.
    const response = await dispatch("https://www.fluncle.com/api/v1/search?q=a");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "invalid_query",
      message: "Search query must be at least 2 characters",
      ok: false,
    });
    // oRPC won: none of the later stages were consulted.
    expect(hoisted.handleMcp).not.toHaveBeenCalled();
    expect(hoisted.handleAgentDiscovery).not.toHaveBeenCalled();
    expect(hoisted.routerFetch).not.toHaveBeenCalled();
  });

  it("routes an MCP request to handleMcp (mounted after oRPC, before discovery + router)", async () => {
    const mcpResponse = new Response("mcp", { status: 200 });
    hoisted.handleMcp.mockResolvedValueOnce(mcpResponse);

    const response = await dispatch("https://www.fluncle.com/mcp");

    // handleOrpc (real) returned null for this non-/api path, so handleMcp answered.
    expect(response).toBe(mcpResponse);
    expect(hoisted.handleMcp).toHaveBeenCalledTimes(1);
    expect(hoisted.handleAgentDiscovery).not.toHaveBeenCalled();
    expect(hoisted.routerFetch).not.toHaveBeenCalled();
  });

  it("routes an agent-discovery request to handleAgentDiscovery (after MCP, before the router)", async () => {
    const discoveryResponse = new Response("discovery", { status: 200 });
    hoisted.handleAgentDiscovery.mockResolvedValueOnce(discoveryResponse);

    const response = await dispatch("https://www.fluncle.com/.well-known/some-agent-doc");

    expect(response).toBe(discoveryResponse);
    expect(hoisted.handleMcp).toHaveBeenCalledTimes(1); // consulted, returned undefined
    expect(hoisted.handleAgentDiscovery).toHaveBeenCalledTimes(1);
    expect(hoisted.routerFetch).not.toHaveBeenCalled();
  });

  it("falls a non-contract path through to the TanStack router when every earlier stage passes", async () => {
    const response = await dispatch("https://www.fluncle.com/", { accept: "text/html" });

    // All three seams were consulted and declined, so the router rendered.
    expect(hoisted.handleMcp).toHaveBeenCalledTimes(1);
    expect(hoisted.handleAgentDiscovery).toHaveBeenCalledTimes(1);
    expect(hoisted.routerFetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("router-sentinel");
  });

  it("takes the edge-cache branch for a cacheable /log GET and still lands on the router (no oRPC/MCP capture)", async () => {
    // A public log path with an HTML Accept and no admin cookie is edge-cacheable;
    // outside the Workers runtime the cache no-ops straight to the router `render`,
    // so the request must still reach the router — never oRPC or MCP.
    const response = await dispatch("https://www.fluncle.com/log/abc123", { accept: "text/html" });

    expect(hoisted.routerFetch).toHaveBeenCalledTimes(1);
    expect(hoisted.handleAgentDiscovery).toHaveBeenCalledTimes(1);
    // The router body was served (via withEdgeCache's render), not an oRPC/MCP frame.
    expect(await response.text()).toBe("router-sentinel");
  });
});

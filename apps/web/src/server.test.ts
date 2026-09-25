import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeWaitUntilPromises } from "./test/cloudflare-workers-stub";
import {
  CONTENT_POLICY,
  CONTENT_POLICY_WITH_REPORTING,
  REPORTING_ENDPOINTS_VALUE,
} from "./lib/server/security-headers";

const hoisted = vi.hoisted(() => {
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

  mcpToolNames: [],
}));

vi.mock("./lib/server/agent-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/server/agent-discovery")>();

  return {
    ...actual,

    appendAgentLinkHeaders: (response: Response) => response,
    appendOnionLocation: (response: Response) => response,
    handleAgentDiscovery: hoisted.handleAgentDiscovery,
  };
});

const worker = (await import("./server")).default as unknown as {
  fetch: (request: Request) => Promise<Response>;
};

function dispatch(
  url: string,
  headers: Record<string, string> = {},
  method: "GET" | "HEAD" = "GET",
): Promise<Response> {
  return worker.fetch(new Request(url, { headers, method }));
}

beforeEach(() => {
  void takeWaitUntilPromises();
  hoisted.handleMcp.mockReset();
  hoisted.handleMcp.mockResolvedValue(undefined);
  hoisted.handleAgentDiscovery.mockReset();
  hoisted.handleAgentDiscovery.mockResolvedValue(undefined);
  hoisted.routerFetch.mockReset();
  hoisted.routerFetch.mockImplementation(async () => hoisted.makeRouterResponse());
});

describe("server.ts dispatch spine", () => {
  it("keeps the handler promise alive so disconnects cannot strand database leases", async () => {
    const response = await dispatch("https://www.fluncle.com/api/v1/search?q=a");
    const [handlerTask, ...otherTasks] = takeWaitUntilPromises();

    expect(otherTasks).toHaveLength(0);
    expect(handlerTask).toBeDefined();
    await expect(handlerTask).resolves.toBe(response);
  });

  it("serves an /api contract path from the REAL handleOrpc — the router never sees it", async () => {
    const response = await dispatch("https://www.fluncle.com/api/v1/search?q=a");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "invalid_query",
      message: "Search query must be at least 2 characters",
      ok: false,
    });

    expect(hoisted.handleMcp).not.toHaveBeenCalled();
    expect(hoisted.handleAgentDiscovery).not.toHaveBeenCalled();
    expect(hoisted.routerFetch).not.toHaveBeenCalled();
  });

  it("routes an MCP request to handleMcp (mounted after oRPC, before discovery + router)", async () => {
    const mcpResponse = new Response("mcp", { status: 200 });
    hoisted.handleMcp.mockResolvedValueOnce(mcpResponse);

    const response = await dispatch("https://www.fluncle.com/mcp");

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
    expect(hoisted.handleMcp).toHaveBeenCalledTimes(1);
    expect(hoisted.handleAgentDiscovery).toHaveBeenCalledTimes(1);
    expect(hoisted.routerFetch).not.toHaveBeenCalled();
  });

  it("falls a non-contract path through to the TanStack router when every earlier stage passes", async () => {
    const response = await dispatch("https://www.fluncle.com/", { accept: "text/html" });

    expect(hoisted.handleMcp).toHaveBeenCalledTimes(1);
    expect(hoisted.handleAgentDiscovery).toHaveBeenCalledTimes(1);
    expect(hoisted.routerFetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe("router-sentinel");
  });

  it("answers 406 (not the router's 500) when a public page is asked for in a shape it cannot take", async () => {
    for (const path of ["/log/abc123", "/track/mb_abc", "/artist/netsky", "/tracks", "/"]) {
      const response = await dispatch(`https://www.fluncle.com${path}`, {
        accept: "application/json",
      });

      expect(response.status, path).toBe(406);
      expect(response.headers.get("vary"), path).toBe("Accept");
      expect((await response.json()) as { code: string }, path).toMatchObject({
        code: "not_acceptable",
        ok: false,
      });
    }

    expect(hoisted.routerFetch).not.toHaveBeenCalled();
  });

  it("negotiates every entity detail path, including trailing-slash redirects", async () => {
    const entities = [
      ["artist", "sub-focus"],
      ["album", "all-that-jazz"],
      ["label", "hospital-records"],
      ["track", "mb_2b1c4d5e"],
    ] as const;

    for (const [kind, slug] of entities) {
      for (const method of ["GET", "HEAD"] as const) {
        const trailing = await dispatch(
          `https://www.fluncle.com/${kind}/${slug}/`,
          { accept: "application/json" },
          method,
        );

        expect(trailing.status, `${method} /${kind}/${slug}/`).toBe(406);
        expect(trailing.headers.get("vary"), `${method} /${kind}/${slug}/`).toBe("Accept");

        const canonical = await dispatch(
          `https://www.fluncle.com/${kind}/${slug}`,
          { accept: "application/json" },
          method,
        );

        expect(canonical.status, `${method} /${kind}/${slug}`).toBe(406);
        expect(canonical.headers.get("vary"), `${method} /${kind}/${slug}`).toBe("Accept");
      }
    }

    expect(hoisted.routerFetch).not.toHaveBeenCalled();
  });

  it("still renders a public page for every Accept that admits HTML — including none at all", async () => {
    for (const accept of [
      undefined,
      "*/*",
      "text/*",
      "text/html;q=0.9, application/json",
      "application/json, */*;q=0.1",
    ]) {
      hoisted.routerFetch.mockClear();

      const response = await dispatch(
        "https://www.fluncle.com/log/abc123",
        accept === undefined ? {} : { accept },
      );

      expect(response.status, String(accept)).toBe(200);
      expect(await response.text(), String(accept)).toBe("router-sentinel");
      expect(hoisted.routerFetch, String(accept)).toHaveBeenCalledTimes(1);
    }
  });

  it("never negotiates a non-page path: the API, a feed, and a server function flow on untouched", async () => {
    for (const path of ["/rss.xml", "/_serverFn/abc", "/api/preview/x"]) {
      hoisted.routerFetch.mockClear();

      const response = await dispatch(`https://www.fluncle.com${path}`, {
        accept: "application/json",
      });

      expect(response.status, path).not.toBe(406);
      expect(hoisted.routerFetch, path).toHaveBeenCalledTimes(1);
    }
  });

  it("takes the edge-cache branch for a cacheable /log GET and still lands on the router (no oRPC/MCP capture)", async () => {
    const response = await dispatch("https://www.fluncle.com/log/abc123", { accept: "text/html" });

    expect(hoisted.routerFetch).toHaveBeenCalledTimes(1);
    expect(hoisted.handleAgentDiscovery).toHaveBeenCalledTimes(1);

    expect(await response.text()).toBe("router-sentinel");
  });
});

describe("server.ts shared-cache isolation", () => {
  let entries: Map<string, Response>;
  let previousCaches: unknown;

  beforeEach(() => {
    entries = new Map<string, Response>();
    const globals = globalThis as { caches?: unknown };
    previousCaches = globals.caches;
    globals.caches = {
      default: {
        delete: async (key: Request) => entries.delete(key.url),
        match: async (key: Request) => entries.get(key.url)?.clone(),
        put: async (key: Request, response: Response) => {
          entries.set(key.url, response);
        },
      },
    };
  });

  afterEach(() => {
    (globalThis as { caches?: unknown }).caches = previousCaches;
  });

  async function dispatchAndSettle(
    url: string,
    headers: Record<string, string> = {},
    method: "GET" | "HEAD" = "GET",
  ): Promise<Response> {
    const response = await dispatch(url, headers, method);
    await Promise.resolve();
    await Promise.resolve();

    return response;
  }

  it("shared-caches a public hub GET under its canonical key", async () => {
    await dispatchAndSettle("https://www.fluncle.com/artists", { accept: "text/html" });

    expect([...entries.keys()]).toEqual(["https://www.fluncle.com/artists"]);
  });

  it("redirects trailing-slash entity HTML requests without caching them", async () => {
    const entities = [
      ["artist", "sub-focus"],
      ["album", "all-that-jazz"],
      ["label", "hospital-records"],
      ["track", "mb_2b1c4d5e"],
    ] as const;

    hoisted.routerFetch.mockImplementation(async (request) => {
      const path = new URL(request.url).pathname;

      return new Response(null, {
        headers: { Location: path.slice(0, -1) },
        status: 307,
      });
    });

    for (const [kind, slug] of entities) {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await dispatchAndSettle(
          `https://www.fluncle.com/${kind}/${slug}/`,
          { accept: "text/html" },
          method,
        );

        expect(response.status, `${method} /${kind}/${slug}/`).toBe(307);
        expect(response.headers.get("location"), `${method} /${kind}/${slug}/`).toBe(
          `/${kind}/${slug}`,
        );
      }
    }

    expect(entries.size).toBe(0);
  });

  it("serves and caches slashless entity HTML GETs under canonical keys", async () => {
    const entities = [
      ["artist", "sub-focus"],
      ["album", "all-that-jazz"],
      ["label", "hospital-records"],
      ["track", "mb_2b1c4d5e"],
    ] as const;

    for (const [kind, slug] of entities) {
      const response = await dispatchAndSettle(`https://www.fluncle.com/${kind}/${slug}`, {
        accept: "text/html",
      });

      expect(response.status, `/${kind}/${slug}`).toBe(200);
      expect(response.headers.get("x-edge-cache"), `/${kind}/${slug}`).toBe("miss");
    }

    expect(new Set(entries.keys())).toEqual(
      new Set(entities.map(([kind, slug]) => `https://www.fluncle.com/${kind}/${slug}`)),
    );
  });

  it("answers 406 for JSON-only entity requests without caching either path shape", async () => {
    const entities = [
      ["artist", "sub-focus"],
      ["album", "all-that-jazz"],
      ["label", "hospital-records"],
      ["track", "mb_2b1c4d5e"],
    ] as const;

    for (const [kind, slug] of entities) {
      for (const suffix of ["", "/"]) {
        for (const method of ["GET", "HEAD"] as const) {
          const response = await dispatch(
            `https://www.fluncle.com/${kind}/${slug}${suffix}`,
            { accept: "application/json" },
            method,
          );

          expect(response.status, `${method} /${kind}/${slug}${suffix}`).toBe(406);
          expect(response.headers.get("vary"), `${method} /${kind}/${slug}${suffix}`).toBe(
            "Accept",
          );
        }
      }
    }

    expect(entries.size).toBe(0);
  });

  it("NEVER shared-caches an admin view", async () => {
    await dispatchAndSettle("https://www.fluncle.com/artists", {
      accept: "text/html",
      cookie: "fluncle_admin=some-grant; other=1",
    });
    await dispatchAndSettle("https://www.fluncle.com/log/abc123", {
      accept: "text/html",
      cookie: "fluncle_admin=some-grant",
    });

    expect(entries.size).toBe(0);
  });

  it("NEVER shared-caches a query variant that would collide onto the canonical entry", async () => {
    await dispatchAndSettle("https://www.fluncle.com/tracks?galaxy=drift", {
      accept: "text/html",
    });
    await dispatchAndSettle("https://www.fluncle.com/artist/sub-focus?page=2", {
      accept: "text/html",
    });
    await dispatchAndSettle("https://www.fluncle.com/artists?page=2&q=x", {
      accept: "text/html",
    });
    await dispatchAndSettle("https://www.fluncle.com/artists?page=abc", {
      accept: "text/html",
    });

    expect(entries.size).toBe(0);
  });

  it("shared-caches a paginated hub's ?page=N under its OWN distinct key (never colliding onto page 1)", async () => {
    await dispatchAndSettle("https://www.fluncle.com/artists?page=2", { accept: "text/html" });
    await dispatchAndSettle("https://www.fluncle.com/artists?page=3", { accept: "text/html" });

    expect(new Set(entries.keys())).toEqual(
      new Set(["https://www.fluncle.com/artists?page=2", "https://www.fluncle.com/artists?page=3"]),
    );

    const page2Key = new Request("https://www.fluncle.com/artists?page=2");
    const stored = await entries.get(page2Key.url)?.clone()?.text();
    const refetched = await dispatch("https://www.fluncle.com/artists?page=2", {
      accept: "text/html",
    });

    expect(refetched.headers.get("x-edge-cache")).toBe("fresh");
    expect(await refetched.text()).toBe(stored);
  });

  it("NEVER shared-caches a non-HTML request or a non-GET", async () => {
    await dispatchAndSettle("https://www.fluncle.com/artists", { accept: "application/json" });
    await worker.fetch(
      new Request("https://www.fluncle.com/artists", {
        headers: { accept: "text/html" },
        method: "POST",
      }),
    );
    await Promise.resolve();

    expect(entries.size).toBe(0);
  });

  it("NEVER shared-caches an account or admin surface", async () => {
    for (const path of ["/account", "/admin", "/admin/tracks", "/recommendations", "/chat"]) {
      await dispatchAndSettle(`https://www.fluncle.com${path}`, { accept: "text/html" });
    }

    expect(entries.size).toBe(0);
  });

  it("stamps the security headers on a cache HIT, not just the cold render", async () => {
    const miss = await dispatch("https://www.fluncle.com/artists", { accept: "text/html" });

    expect(miss.headers.get("x-edge-cache")).toBe("miss");
    expect(miss.headers.get("x-content-type-options")).toBe("nosniff");
    await Promise.resolve();
    await Promise.resolve();

    const hit = await dispatch("https://www.fluncle.com/artists", { accept: "text/html" });

    expect(hit.headers.get("x-edge-cache")).toBe("fresh");
    expect(hit.headers.get("x-content-type-options")).toBe("nosniff");
    expect(hit.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(hit.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(hit.headers.get("content-security-policy")).toBe(CONTENT_POLICY_WITH_REPORTING);
    expect(hit.headers.get("content-security-policy-report-only")).toBeNull();
    expect(hit.headers.get("reporting-endpoints")).toBe(REPORTING_ENDPOINTS_VALUE);

    expect(
      entries.get("https://www.fluncle.com/artists")?.headers.get("content-security-policy"),
    ).toBeNull();
  });
});

describe("server.ts security headers", () => {
  it("puts nosniff on the REAL oRPC JSON reply (a contract op never escapes the layer)", async () => {
    const response = await dispatch("https://www.fluncle.com/api/v1/search?q=a");

    expect(response.status).toBe(400);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBeNull();
    expect(response.headers.get("strict-transport-security")).toBeNull();

    expect(await response.json()).toEqual({
      code: "invalid_query",
      message: "Search query must be at least 2 characters",
      ok: false,
    });
  });

  it("gives an SSR HTML document the full document header set", async () => {
    const response = await dispatch("https://www.fluncle.com/about", { accept: "text/html" });

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(response.headers.get("content-security-policy")).toBe(CONTENT_POLICY_WITH_REPORTING);
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();

    expect(response.headers.get("reporting-endpoints")).toBe(REPORTING_ENDPOINTS_VALUE);
    expect(await response.text()).toBe("router-sentinel");
  });

  it("leaves a NON-HTML file-route emitter (a feed) with nosniff only — and intact", async () => {
    hoisted.routerFetch.mockImplementationOnce(
      async () =>
        new Response('<?xml version="1.0"?><rss/>', {
          headers: { "cache-control": "public, max-age=600", "content-type": "application/xml" },
        }),
    );

    const response = await dispatch("https://www.fluncle.com/feed.xml");

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toBe("application/xml");
    expect(response.headers.get("cache-control")).toBe("public, max-age=600");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBeNull();
    expect(await response.text()).toBe('<?xml version="1.0"?><rss/>');
  });

  it("keeps the embed route's permissive frame-ancestors — the exemption survives the spine", async () => {
    hoisted.routerFetch.mockImplementationOnce(
      async () =>
        new Response("<!doctype html><html>card</html>", {
          headers: {
            "content-security-policy": "frame-ancestors *",
            "content-type": "text/html; charset=utf-8",
          },
        }),
    );

    const response = await dispatch("https://www.fluncle.com/embed/001.A.01", {
      accept: "text/html",
    });

    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors *");
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("stamps an MCP frame and a discovery doc too (no stage bypasses the wrap)", async () => {
    hoisted.handleMcp.mockResolvedValueOnce(
      new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    const mcp = await dispatch("https://www.fluncle.com/mcp");

    expect(mcp.headers.get("x-content-type-options")).toBe("nosniff");

    hoisted.handleAgentDiscovery.mockResolvedValueOnce(
      new Response("# skill", { headers: { "content-type": "text/markdown" } }),
    );
    const discovery = await dispatch("https://www.fluncle.com/.well-known/agent");

    expect(discovery.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("does NOT pin HSTS on a plain-http request (local dev, and the Tor mirror)", async () => {
    const response = await dispatch("http://localhost:3000/about", { accept: "text/html" });

    expect(response.headers.get("strict-transport-security")).toBeNull();

    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("content-security-policy-report-only")).toBe(CONTENT_POLICY);
    expect(response.headers.get("reporting-endpoints")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

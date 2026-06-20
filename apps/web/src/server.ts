import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { appendAgentLinkHeaders, handleAgentDiscovery } from "./lib/server/agent-discovery";
import { isCacheableLogPath, withEdgeCache } from "./lib/server/edge-cache";
import { ADMIN_COOKIE_NAME } from "./lib/server/env";
import { handleMcp } from "./lib/server/mcp";

export default createServerEntry({
  async fetch(request) {
    // The MCP endpoint and its server card (the agent tool surface) sit ahead
    // of the router, as do the agent discovery surfaces (well-known endpoints,
    // markdown negotiation); everything else flows through unchanged.
    // (galaxy.fluncle.com routing lives in the router's rewrite config, not
    // here — it must run isomorphically or hydration undoes it.)
    const mcp = await handleMcp(request);

    if (mcp) {
      return mcp;
    }

    const discovery = await handleAgentDiscovery(request);

    if (discovery) {
      return discovery;
    }

    // Edge-cache the public log surfaces (`/log` and `/log/<id>`): the cold path
    // is Worker SSR + a Turso read per render (~896ms TTFB), but a finding is
    // publish-then-immutable, so short-TTL + stale-while-revalidate (edge-cache.ts)
    // makes the hot path a cache hit and the rare edit purges on change. Scoped to
    // a plain GET HTML view that no admin is signed into — an admin must always see
    // live data, and a personalized/non-HTML response must never be shared-cached.
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      isCacheableLogPath(url.pathname) &&
      !hasAdminCookie(request) &&
      (request.headers.get("accept")?.includes("text/html") ?? false)
    ) {
      return withEdgeCache(request, async () => handler.fetch(request));
    }

    const response = await handler.fetch(request);

    // The homepage advertises machine-readable surfaces via RFC 8288 Link
    // headers so agents can discover them without guessing paths.
    return url.pathname === "/" ? appendAgentLinkHeaders(response) : response;
  },
});

// A cheap presence check (not a verify) of the admin grant cookie: enough to keep
// an operator's signed-in view off the shared edge cache, while the route handlers
// still enforce real auth. Public visitors never carry this cookie, so the cache
// stays warm for everyone else.
function hasAdminCookie(request: Request): boolean {
  const cookie = request.headers.get("cookie");

  return cookie?.includes(`${ADMIN_COOKIE_NAME}=`) ?? false;
}

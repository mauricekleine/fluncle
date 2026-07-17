import * as Sentry from "@sentry/cloudflare";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import {
  appendAgentLinkHeaders,
  appendOnionLocation,
  handleAgentDiscovery,
} from "./lib/server/agent-discovery";
import {
  isCacheableEntityRequest,
  isCacheableLogPath,
  withEdgeCache,
} from "./lib/server/edge-cache";
import { ADMIN_COOKIE_NAME } from "./lib/server/env";
import { handleMcp } from "./lib/server/mcp";
import { handleOrpc } from "./lib/server/orpc";
import { SENTRY_RELEASE, WORKER_SENTRY_DSN } from "./lib/sentry-config";

// The whole custom entry, wrapped once by Sentry so any unhandled throw from
// EITHER path — handleOrpc (mounted first) or the TanStack router beneath it —
// is captured with a stack. Errors-only, free-tier posture: no tracing, no PII.
// Gated to production builds: `import.meta.env.PROD` is `false` under vite dev
// (`bun run dev`, the smoke routine) and statically `true` in the deployed
// Worker bundle, so no events leave a dev machine. When the DSN is undefined the
// SDK initializes inert and never sends.
const serverEntry = createServerEntry({
  async fetch(request) {
    // oRPC owns the API operations it has contracts for, dual-mounted under
    // `/api/v1` and `/api`. It returns null when no procedure matched (the
    // `matched: false` fall-through), so every unconverted route — and every
    // non-API request — flows on to the existing handlers unchanged. This is the
    // incremental-migration seam; it sits ahead of
    // the router so a converted route is served by its contract, not the stale
    // TanStack file route, while the rest of the surface is untouched.
    const orpc = await handleOrpc(request);

    if (orpc) {
      return orpc;
    }

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

    // Edge-cache the public log surfaces (`/log` and `/log/<id>`) and the entity detail
    // pages (`/artist|/album|/label/<slug>`): the cold path is Worker SSR + Turso reads per
    // render, but these pages change rarely, so short-TTL + stale-while-revalidate
    // (edge-cache.ts) makes the hot path a cache hit and the write paths purge on change.
    // Scoped to a plain GET HTML view that no admin is signed into — an admin must always see
    // live data, and a personalized/non-HTML response must never be shared-cached. Entity
    // pages cache only their canonical (query-less) URL; a paginated/sorted variant flows
    // through uncached so it can't collide onto page 1 (isCacheableEntityRequest).
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      (isCacheableLogPath(url.pathname) || isCacheableEntityRequest(url.pathname, url.search)) &&
      !hasAdminCookie(request) &&
      (request.headers.get("accept")?.includes("text/html") ?? false)
    ) {
      const cached = await withEdgeCache(request, async () => handler.fetch(request));

      // The per-path .onion pill is most valuable here: a Tor user on /log/<id>
      // should land on that exact finding's onion page. Inert until the onion
      // exists (appendOnionLocation no-ops on an empty hostname).
      return appendOnionLocation(cached, url);
    }

    const response = await handler.fetch(request);

    // The homepage advertises machine-readable surfaces via RFC 8288 Link
    // headers so agents can discover them without guessing paths; every HTML
    // response also advertises its onion twin via Onion-Location (per-path,
    // HTML-only, inert until WEB_ONION_HOSTNAME is set — see agent-discovery.ts).
    const located = appendOnionLocation(response, url);

    return url.pathname === "/" ? appendAgentLinkHeaders(located) : located;
  },
});

// Sentry's `withSentry` wraps a Cloudflare `ExportedHandler`, but TanStack's
// `ServerEntry.fetch(request, opts?)` is not typed as one (its second parameter is
// TanStack's, not the Worker's `env`). Rather than the `@ts-expect-error` Sentry's
// docs reach for, bridge with a real CF handler that delegates the request — the
// entry only ever reads `request` (env/ctx come from the Cloudflare vite binding,
// not the fetch args), so nothing is dropped.
const cfHandler: ExportedHandler<Env> = {
  fetch(request) {
    return serverEntry.fetch(request);
  },
};

export default Sentry.withSentry(
  () => ({
    dsn: import.meta.env.PROD ? WORKER_SENTRY_DSN : undefined,
    release: SENTRY_RELEASE,
    // Errors only, free-tier posture (ratified): no tracing, no profiling, no PII.
    sendDefaultPii: false,
    tracesSampleRate: 0,
  }),
  cfHandler,
);

// A cheap presence check (not a verify) of the admin grant cookie: enough to keep
// an operator's signed-in view off the shared edge cache, while the route handlers
// still enforce real auth. Public visitors never carry this cookie, so the cache
// stays warm for everyone else.
function hasAdminCookie(request: Request): boolean {
  const cookie = request.headers.get("cookie");

  return cookie?.includes(`${ADMIN_COOKIE_NAME}=`) ?? false;
}

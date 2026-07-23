import * as Sentry from "@sentry/cloudflare";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import {
  appendAgentLinkHeaders,
  appendOnionLocation,
  handleAgentDiscovery,
} from "./lib/server/agent-discovery";
import { edgeCachePolicyFor, withEdgeCache } from "./lib/server/edge-cache";
import { ADMIN_COOKIE_NAME } from "./lib/server/env";
import { handleMcp } from "./lib/server/mcp";
import { handleOrpc } from "./lib/server/orpc";
import { SENTRY_RELEASE, WORKER_SENTRY_DSN } from "./lib/sentry-config";

// The whole custom entry, wrapped once by Sentry so any unhandled throw from
// EITHER path — handleOrpc (mounted first) or the TanStack router beneath it —
// is captured with a stack. Performance tracing is ON (sampled — see
// `tracesSampler` below), so the per-query `db.query` spans opened in
// `lib/server/db.ts` land in Sentry's Queries insight + the auto "Slow DB
// Queries" detector. `sendDefaultPii: false` still holds. Gated to production
// builds: `import.meta.env.PROD` is `false` under vite dev (`bun run dev`, the
// smoke routine) and statically `true` in the deployed Worker bundle, so no
// events leave a dev machine. When the DSN is undefined the SDK initializes
// inert and never sends.

// Trace-sampling rates (NAMED so they read at the call site). These are the
// LOW-TRAFFIC starting settings — as request volume grows toward the Team
// plan's 5M-spans/mo budget, lower `TRACE_RATE_BASELINE` first and refine the
// route lists rather than widening them.
const TRACE_RATE_ALWAYS = 1.0; // scaling-risk paths — a slow scan must never be missed
const TRACE_RATE_NONE = 0; // pure noise with no query value
const TRACE_RATE_BASELINE = 0.2; // everything else

// The recs / vector-scan surfaces: these MUST be reliably traced so the
// recommendation scan hitting a multi-second wall as the catalogue grows is
// measured in prod, not guessed. Matched as a substring of the transaction name.
const HIGH_VALUE_TRACE_MATCHERS = ["recommend", "search", "frontier"];

// Pure noise — health/status probes, robots/sitemap/llms.txt/.well-known, and
// the OG + cover image + static-asset routes carry no query worth a span.
const NOISE_TRACE_MATCHERS = [
  "/status",
  "/health",
  "/robots",
  "/sitemap",
  "/llms.txt",
  "/.well-known",
  "/og/",
  "/mixtape-cover",
  "/preview/",
  "/favicon",
  "/assets/",
  "/cdn-cgi",
];
const serverEntry = createServerEntry({
  async fetch(request) {
    // oRPC owns the API operations it has contracts for, mounted at the single
    // canonical `/api/v1` prefix. It returns null when no procedure matched (the
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

    // Edge-cache the public read surfaces: the log + entity detail pages (purge-backed page
    // policy) and the hub/index/static/legal/docs pages (60s hub policy). The cold path is
    // Worker SSR + Turso reads per render — measured at ~1s for `/artists`, ~98% of it server
    // think — so a short TTL plus stale-while-revalidate (edge-cache.ts) turns the hot path into
    // a cache hit. Detail pages get an explicit purge from the write paths; a hub rides a 60s
    // fresh window instead, because it invalidates on any member change (see edge-cache.ts).
    //
    // `edgeCachePolicyFor` is the single decision point for WHICH paths are cacheable and under
    // which TTL (the full cacheable set lives there), including the query-string rule: only a
    // bare canonical URL is cached — plus a lone `?page=<n>` on the paginated catalogue hubs,
    // folded into the cache key so page N never collides onto page 1. Every other variant
    // (`?galaxy=…`, `?story=…`, `?platform=…`, `?page=2&…`) flows through uncached. The guards it
    // cannot see are enforced here: a plain GET, an HTML-accepting client, and no admin cookie —
    // an admin must always see live data, and a personalized/non-HTML response must never be
    // shared-cached.
    const url = new URL(request.url);
    const cachePolicy = edgeCachePolicyFor(url.pathname, url.search);

    if (
      cachePolicy &&
      request.method === "GET" &&
      !hasAdminCookie(request) &&
      (request.headers.get("accept")?.includes("text/html") ?? false)
    ) {
      const cached = await withEdgeCache(request, async () => handler.fetch(request), cachePolicy);

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
    // Tracing on (operator-approved raise from the errors-only posture), still no
    // profiling and no PII. See docs/error-tracking.md.
    sendDefaultPii: false,
    // Route sampling keyed on the transaction name (method + path, e.g.
    // `GET /me/recommendations`). LIMITATION: a substring on the name is
    // deliberately coarse — server-fn endpoints share a generic transaction
    // name, so this can't perfectly route-match those; the substring policy on
    // the risk/noise paths is enough to guarantee the scan surfaces are traced
    // and the pure noise is dropped.
    tracesSampler: (samplingContext) => {
      const name = samplingContext.name;

      if (typeof name !== "string") {
        return TRACE_RATE_BASELINE;
      }

      const lower = name.toLowerCase();

      if (HIGH_VALUE_TRACE_MATCHERS.some((matcher) => lower.includes(matcher))) {
        return TRACE_RATE_ALWAYS;
      }

      if (NOISE_TRACE_MATCHERS.some((matcher) => lower.includes(matcher))) {
        return TRACE_RATE_NONE;
      }

      return TRACE_RATE_BASELINE;
    },
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

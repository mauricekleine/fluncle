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
import { withSecurityHeaders } from "./lib/server/security-headers";
import {
  scrubServerSentryEvent,
  scrubServerSentrySpan,
  scrubServerSentryTransaction,
  serverSentryIntegrations,
} from "./lib/server/sentry-options";
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
  // The security-header layer wraps the WHOLE dispatch, so every response — a contract
  // op, an MCP frame, a discovery doc, a cache hit, a cold SSR render, a feed, a media
  // proxy — leaves through it. It sits OUTSIDE `withEdgeCache` deliberately: a stored
  // document would otherwise freeze whatever policy was current when it was rendered
  // (up to 300s fresh + 3600s stale on a detail page), so the headers are stamped on
  // the way out instead of baked into the cached body. See lib/server/security-headers.ts
  // for what is applied to what, and for the structural embed-route CSP exemption.
  async fetch(request) {
    return withSecurityHeaders(request, await dispatch(request));
  },
});

/**
 * The dispatch spine: oRPC → MCP → agent discovery → the edge-cached/plain TanStack
 * router. Extracted from the entry's `fetch` so the security-header layer has exactly
 * one place to wrap, instead of every `return` inside the chain.
 */
async function dispatch(request: Request): Promise<Response> {
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
  // policy), the hub/index/static/legal/docs pages (60s hub policy), and the sitemap documents
  // (1h sitemap policy). The cold path is Worker SSR + Turso reads per render — measured at ~1s
  // for `/artists`, ~98% of it server think — so a short TTL plus stale-while-revalidate
  // (edge-cache.ts) turns the hot path into a cache hit. Detail pages get an explicit purge from
  // the write paths; a hub rides a 60s fresh window instead, because it invalidates on any member
  // change (see edge-cache.ts).
  //
  // `edgeCachePolicyFor` is the single decision point for WHICH paths are cacheable and under
  // which TTL (the full cacheable set lives there), including the query-string rule: only a
  // bare canonical URL is cached — plus a lone `?page=<n>` on the paginated catalogue hubs,
  // folded into the cache key so page N never collides onto page 1. Every other variant
  // (`?galaxy=…`, `?story=…`, `?platform=…`, `?page=2&…`) flows through uncached. The guards it
  // cannot see are enforced here: a plain GET and no admin cookie — an admin must always see live
  // data, and a personalized response must never be shared-cached.
  //
  // The HTML tiers additionally require an HTML-accepting client, so a server-fn/JSON response
  // off a page path is never stored as the page. The SITEMAP tier deliberately does not: a
  // crawler fetching `/sitemap.xml` sends `Accept: application/xml` or nothing useful at all, and
  // the route answers XML either way — the policy's `contentType` is what enforces the shape
  // instead (edge-cache.ts, `isStorable`).
  const url = new URL(request.url);
  const cachePolicy = edgeCachePolicyFor(url.pathname, url.search);
  const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;

  // Content negotiation on the public PAGE tiers is answered here, not by the router. TanStack's
  // SSR handler refuses a request whose `Accept` admits neither `text/html` nor `*/*` with a
  // 500 — which tells an API client or a crawler that asked a /log, /track, or hub URL for JSON
  // that the archive FAULTED, when nothing did. The honest answer is 406: the page exists, it is
  // served as HTML, and the JSON twin of every fact on it lives under /api/v1. `Vary: Accept`
  // keeps the two answers apart in any cache. Only the HTML cache tiers (the public read
  // surfaces) are negotiated; server functions, assets, feeds, and the API never carry an HTML
  // policy and flow on untouched. `text/markdown` on the homepage was already answered above.
  if (
    cachePolicy?.contentType === "text/html" &&
    (request.method === "GET" || request.method === "HEAD") &&
    !acceptHeaderAdmitsHtml(request.headers.get("accept"))
  ) {
    return Response.json(
      {
        code: "not_acceptable",
        message: "This page is served as HTML. The same archive answers as JSON under /api/v1.",
        ok: false,
      },
      { headers: { Vary: "Accept" }, status: 406 },
    );
  }

  if (
    cachePolicy &&
    request.method === "GET" &&
    !hasAdminCookie(request) &&
    (cachePolicy.contentType !== "text/html" || acceptsHtml)
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
}

/**
 * Whether an `Accept` header admits an HTML document: absent (a bare `curl`, a link fetcher),
 * `text/html`, `text/*`, or the bare wildcard range — the same media ranges TanStack's SSR guard
 * honours, plus `text/*`, which it does not but which plainly admits HTML. Parameters (`;q=`) are ignored: a
 * client that lists HTML at any weight can take it.
 */
export function acceptHeaderAdmitsHtml(accept: string | null): boolean {
  if (accept === null || accept.trim() === "") {
    return true;
  }

  return accept.split(",").some((part) => {
    const range = part.trim().split(";")[0]?.trim() ?? "";

    return range === "*/*" || range === "text/*" || range === "text/html";
  });
}

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
    beforeSend: scrubServerSentryEvent,
    beforeSendSpan: scrubServerSentrySpan,
    beforeSendTransaction: scrubServerSentryTransaction,
    dsn: import.meta.env.PROD ? WORKER_SENTRY_DSN : undefined,
    integrations: serverSentryIntegrations,
    release: SENTRY_RELEASE,
    // Tracing on (operator-approved raise from the errors-only posture), still no
    // profiling, PII, or request bodies. See docs/error-tracking.md.
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

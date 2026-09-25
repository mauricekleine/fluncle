import * as Sentry from "@sentry/cloudflare";
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { waitUntil } from "cloudflare:workers";
import {
  appendAgentLinkHeaders,
  appendOnionLocation,
  handleAgentDiscovery,
} from "./lib/server/agent-discovery";
import { edgeCachePolicyFor, isPublicHtmlPagePath, withEdgeCache } from "./lib/server/edge-cache";
import { ADMIN_COOKIE_NAME } from "./lib/server/env";
import { runWithDatabaseRequestScope } from "./lib/server/database-request-scope";
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

const TRACE_RATE_ALWAYS = 1.0;
const TRACE_RATE_NONE = 0;
const TRACE_RATE_BASELINE = 0.2;

const HIGH_VALUE_TRACE_MATCHERS = ["recommend", "search", "frontier"];

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
  fetch(request) {
    const response = runWithDatabaseRequestScope(async () =>
      withSecurityHeaders(request, await dispatch(request)),
    );

    waitUntil(response.catch(() => undefined));
    return response;
  },
});

async function dispatch(request: Request): Promise<Response> {
  const orpc = await handleOrpc(request);

  if (orpc) {
    return orpc;
  }

  const mcp = await handleMcp(request);

  if (mcp) {
    return mcp;
  }

  const discovery = await handleAgentDiscovery(request);

  if (discovery) {
    return discovery;
  }

  const url = new URL(request.url);
  const cachePolicy = edgeCachePolicyFor(url.pathname, url.search);
  const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;

  if (
    isPublicHtmlPagePath(url.pathname) &&
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

    return appendOnionLocation(cached, url);
  }

  const response = await handler.fetch(request);

  const located = appendOnionLocation(response, url);

  return url.pathname === "/" ? appendAgentLinkHeaders(located) : located;
}

export function acceptHeaderAdmitsHtml(accept: string | null): boolean {
  if (accept === null || accept.trim() === "") {
    return true;
  }

  return accept.split(",").some((part) => {
    const range = part.trim().split(";")[0]?.trim() ?? "";

    return range === "*/*" || range === "text/*" || range === "text/html";
  });
}

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

    sendDefaultPii: false,

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

function hasAdminCookie(request: Request): boolean {
  const cookie = request.headers.get("cookie");

  return cookie?.includes(`${ADMIN_COOKIE_NAME}=`) ?? false;
}

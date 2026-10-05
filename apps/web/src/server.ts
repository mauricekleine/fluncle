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
import { presenceRedirect, withPresenceRobots } from "./lib/server/presence-hosts";
import { subdomainSurfaceRoute } from "./router-rewrite";
import {
  serverSentryIntegrations,
  serverSentryScrubHooks,
  serverTracesSampler,
} from "./lib/server/sentry-options";
import { SENTRY_RELEASE, WORKER_SENTRY_DSN } from "./lib/sentry-config";
import { withTransientDatabaseFailure } from "./lib/server/transient-failure";
import { handleSentryTunnel, isSentryTunnelRequest } from "./lib/server/sentry-tunnel";

const serverEntry = createServerEntry({
  fetch(request) {
    const response = runWithDatabaseRequestScope(async () =>
      withSecurityHeaders(request, withPresenceRobots(request, await dispatch(request))),
    );

    waitUntil(response.catch(() => undefined));
    return response;
  },
});

const NULL_ID_PATH = /^\/(?:track|log)\/null\/?$/;

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

  if (NULL_ID_PATH.test(url.pathname)) {
    return new Response("Gone\n", {
      headers: { "Cache-Control": "public, max-age=86400", "Content-Type": "text/plain" },
      status: 410,
    });
  }

  const redirect = presenceRedirect(request);

  if (redirect) {
    return redirect;
  }

  const cachePolicy = edgeCachePolicyFor(url.pathname, url.search);
  const acceptsHtml = acceptHeaderAdmitsHtml(request.headers.get("accept"));

  if (
    isPublicHtmlPagePath(url.pathname) &&
    (request.method === "GET" || request.method === "HEAD") &&
    !acceptsHtml
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
    !subdomainSurfaceRoute(url.hostname) &&
    request.method === "GET" &&
    !hasAdminCookie(request) &&
    (cachePolicy.contentType !== "text/html" || acceptsHtml)
  ) {
    const cached = await withEdgeCache(
      request,
      async () => withTransientDatabaseFailure(request, await handler.fetch(request)),
      cachePolicy,
    );

    const located = appendOnionLocation(cached, url);

    return url.pathname === "/" ? appendAgentLinkHeaders(located) : located;
  }

  let response = withTransientDatabaseFailure(request, await handler.fetch(request));

  if (
    isPublicHtmlPagePath(url.pathname) &&
    hasAdminCookie(request) &&
    response.headers.get("content-type")?.includes("text/html") &&
    !response.headers.has("cache-control")
  ) {
    response = new Response(response.body, response);
    response.headers.set("Cache-Control", "private, no-store");
  }

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

const sentryHandler = Sentry.withSentry(
  () => ({
    ...serverSentryScrubHooks,
    dsn: import.meta.env.PROD ? WORKER_SENTRY_DSN : undefined,
    integrations: serverSentryIntegrations,
    release: SENTRY_RELEASE,

    sendDefaultPii: false,

    tracesSampler: serverTracesSampler,
  }),
  cfHandler,
);

const workerHandler: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    if (isSentryTunnelRequest(request)) {
      return handleSentryTunnel(request);
    }

    if (!sentryHandler.fetch) {
      throw new Error("Sentry handler has no fetch handler.");
    }

    return sentryHandler.fetch(request, env, ctx);
  },
};

export default workerHandler;

function hasAdminCookie(request: Request): boolean {
  const cookie = request.headers.get("cookie");

  return cookie?.includes(`${ADMIN_COOKIE_NAME}=`) ?? false;
}

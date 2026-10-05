import { siteUrl } from "../fluncle-links";
import { subdomainSurfaceRoute } from "../../router-rewrite";

const RUNTIME_PREFIXES = ["/api/", "/_serverFn/", "/assets/", "/fonts/", "/cdn-cgi/"];
const RUNTIME_FILES = new Set([
  "/favicon.ico",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
  "/fluncle.png",
]);
const GALAXY_FILES = new Set([
  "/galaxy/ship.png",
  "/galaxy/earth.png",
  "/galaxy/roadster.png",
  "/galaxy/ufo.png",
  "/galaxy/asteroid.png",
  "/galaxy/amen.mp3",
  "/galaxy/og.png",
]);

export function presenceRedirect(request: Request): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return undefined;
  }

  const url = new URL(request.url);
  const surface = subdomainSurfaceRoute(url.hostname);
  const runtime =
    url.pathname === "/" ||
    RUNTIME_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)) ||
    RUNTIME_FILES.has(url.pathname) ||
    (surface === "/galaxy" && GALAXY_FILES.has(url.pathname));
  const canonicalHost = (surface === "/radio" || surface === "/galaxy") && !runtime;
  const trimSlash =
    url.pathname.length > 1 &&
    url.pathname.endsWith("/") &&
    !url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/_serverFn/");

  if (!canonicalHost && !trimSlash) {
    return undefined;
  }

  const destination = canonicalHost ? new URL(siteUrl) : new URL(url);
  destination.pathname = trimSlash ? url.pathname.replace(/\/+$/, "") || "/" : url.pathname;
  destination.search = url.search;

  return Response.redirect(destination.href, 308);
}

export function withPresenceRobots(request: Request, response: Response): Response {
  const url = new URL(request.url);

  if (
    !subdomainSurfaceRoute(url.hostname) ||
    url.pathname === "/" ||
    !response.headers.get("content-type")?.includes("text/html")
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex");

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

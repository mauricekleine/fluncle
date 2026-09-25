import { env, waitUntil } from "cloudflare:workers";

function edgeCache(): Cache | undefined {
  const store = (globalThis as { caches?: { default?: Cache } }).caches;

  return store?.default;
}

export type EdgeCachePolicy = {
  readonly cacheControl: string;

  readonly contentType: "application/xml" | "text/html";

  readonly freshSeconds: number;

  readonly storedMaxAge: number;

  readonly swrSeconds: number;
};

function policy(
  freshSeconds: number,
  swrSeconds: number,
  contentType: EdgeCachePolicy["contentType"] = "text/html",
): EdgeCachePolicy {
  return {
    cacheControl: `public, max-age=0, s-maxage=${freshSeconds}, stale-while-revalidate=${swrSeconds}`,
    contentType,
    freshSeconds,
    storedMaxAge: freshSeconds + swrSeconds,
    swrSeconds,
  };
}

export const FRESH_SECONDS = 300;

export const SWR_SECONDS = 3_600;

export const PAGE_CACHE_POLICY = policy(FRESH_SECONDS, SWR_SECONDS);

export const HUB_FRESH_SECONDS = 60;

export const HUB_SWR_SECONDS = 600;

export const HUB_CACHE_POLICY = policy(HUB_FRESH_SECONDS, HUB_SWR_SECONDS);

export const SITEMAP_FRESH_SECONDS = 3_600;

export const SITEMAP_SWR_SECONDS = 86_400;

export const SITEMAP_CACHE_POLICY = policy(
  SITEMAP_FRESH_SECONDS,
  SITEMAP_SWR_SECONDS,
  "application/xml",
);

export const PUBLIC_CACHE_CONTROL = PAGE_CACHE_POLICY.cacheControl;

const STAMP_HEADER = "x-edge-cached-at";
const FRESH_UNTIL_HEADER = "x-edge-fresh-until";
const EXPIRES_AT_HEADER = "x-edge-expires-at";

export function isCacheableLogPath(pathname: string): boolean {
  return pathname === "/log" || pathname === "/log/" || pathname.startsWith("/log/");
}

const ENTITY_DETAIL_PATH = /^\/(?:artist|album|label|track)\/[^/]+$/;
const PUBLIC_ENTITY_DETAIL_PATH = /^\/(?:artist|album|label|track)\/[^/]+\/?$/;

export function isCacheableEntityRequest(pathname: string, search: string): boolean {
  return search === "" && ENTITY_DETAIL_PATH.test(pathname);
}

const HUB_PATHS_BELOW_ROOT = new Set(["/albums", "/artists", "/fresh", "/labels", "/tracks"]);

function isPaginatedHubPath(pathname: string): boolean {
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  return HUB_PATHS_BELOW_ROOT.has(trimmed);
}

const STATIC_HUB_EXACT = new Set([
  "/",
  "/findings",
  "/about",
  "/docs",
  "/galaxies",
  "/logbook",
  "/mixtapes",
  "/newsletter",
  "/privacy",
  "/reach",
  "/terms",
]);

const STATIC_HUB_DETAIL = /^\/(?:galaxies|logbook|newsletter)\/[^/]+$/;

function isStaticHubPath(pathname: string): boolean {
  if (pathname === "/") {
    return STATIC_HUB_EXACT.has("/");
  }

  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  if (trimmed === "" || trimmed === "/") {
    return false;
  }

  if (STATIC_HUB_EXACT.has(trimmed)) {
    return true;
  }

  if (trimmed.startsWith("/docs/")) {
    return true;
  }

  return STATIC_HUB_DETAIL.test(trimmed);
}

function loneNumericPage(search: string): number | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const keys = [...params.keys()];

  if (keys.length !== 1 || keys[0] !== "page") {
    return null;
  }

  const raw = params.get("page");

  if (raw === null || !/^\d+$/.test(raw)) {
    return null;
  }

  const page = Number(raw);

  return page >= 1 ? page : null;
}

export function isCacheableHubRequest(pathname: string, search: string): boolean {
  if (isPaginatedHubPath(pathname)) {
    return search === "" || loneNumericPage(search) !== null;
  }

  if (search !== "") {
    return false;
  }

  return isStaticHubPath(pathname);
}

const SITEMAP_PATH = /^\/sitemap(?:\.xml|\/[A-Za-z0-9._-]+)$/;

function isCacheableSitemapRequest(pathname: string, search: string): boolean {
  return search === "" && SITEMAP_PATH.test(pathname);
}

export function isPublicHtmlPagePath(pathname: string): boolean {
  return (
    isCacheableLogPath(pathname) ||
    PUBLIC_ENTITY_DETAIL_PATH.test(pathname) ||
    isCacheableHubRequest(pathname, "")
  );
}

function releaseSensitivePath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return (
    path === "/" ||
    path === "/tracks" ||
    path === "/fresh" ||
    /^\/(?:artist|label)\/[^/]+$/.test(path)
  );
}

function secondsUntilNextUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(0, Math.floor((next - now.getTime()) / 1000));
}

export function releaseBoundPolicy(base: EdgeCachePolicy, now: Date): EdgeCachePolicy {
  const remaining = secondsUntilNextUtcMidnight(now);
  if (base.storedMaxAge <= remaining) {
    return base;
  }
  const fresh = Math.min(base.freshSeconds, remaining);
  const stale = Math.min(base.swrSeconds, remaining - fresh);
  return policy(fresh, stale, base.contentType);
}

export function releaseBoundFeedCacheControl(now: Date = new Date()): string {
  return releaseBoundPolicy(PAGE_CACHE_POLICY, now).cacheControl;
}

export function edgeCachePolicyFor(
  pathname: string,
  search: string,
  now: Date = new Date(),
): EdgeCachePolicy | undefined {
  if (isCacheableLogPath(pathname) || isCacheableEntityRequest(pathname, search)) {
    return releaseSensitivePath(pathname)
      ? releaseBoundPolicy(PAGE_CACHE_POLICY, now)
      : PAGE_CACHE_POLICY;
  }

  if (isCacheableSitemapRequest(pathname, search)) {
    return SITEMAP_CACHE_POLICY;
  }

  return isCacheableHubRequest(pathname, search)
    ? releaseSensitivePath(pathname)
      ? releaseBoundPolicy(HUB_CACHE_POLICY, now)
      : HUB_CACHE_POLICY
    : undefined;
}

const CANONICAL_ORIGIN = "https://www.fluncle.com";

function cacheKeyForPath(pathname: string): Request {
  return new Request(`${CANONICAL_ORIGIN}${pathname}`, { method: "GET" });
}

function cacheKeyRequest(pathname: string, search: string): Request {
  const page = isPaginatedHubPath(pathname) ? loneNumericPage(search) : null;
  const keyPath = page === null ? pathname : `${pathname}?page=${page}`;

  return new Request(`${CANONICAL_ORIGIN}${keyPath}`, { method: "GET" });
}

export async function withEdgeCache(
  request: Request,
  render: () => Promise<Response>,
  cachePolicy: EdgeCachePolicy = PAGE_CACHE_POLICY,
): Promise<Response> {
  const cache = edgeCache();

  if (!cache) {
    return render();
  }

  const url = new URL(request.url);
  const cacheKey = cacheKeyRequest(url.pathname, url.search);
  const hit = await cache.match(cacheKey);

  const storedAt = Number(hit?.headers.get(STAMP_HEADER));
  const crossesReleaseDay =
    releaseSensitivePath(url.pathname) &&
    Number.isFinite(storedAt) &&
    new Date(storedAt).toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10);
  const expiresAt = Number(hit?.headers.get(EXPIRES_AT_HEADER));
  if (hit && !crossesReleaseDay && Number.isFinite(expiresAt) && Date.now() < expiresAt) {
    const freshUntil = Number(hit.headers.get(FRESH_UNTIL_HEADER));

    if (Number.isFinite(freshUntil) && Date.now() < freshUntil) {
      return tagHit(hit, "fresh", cachePolicy);
    }

    waitUntil(refresh(cache, cacheKey, render, cachePolicy));

    return tagHit(hit, "stale", cachePolicy);
  }

  if (hit) {
    await cache.delete(cacheKey);
  }

  const response = await render();

  if (isStorable(response, cachePolicy)) {
    waitUntil(cache.put(cacheKey, toStoredResponse(response.clone(), cachePolicy)));
  }

  return tagResponse(response, "miss", cachePolicy);
}

async function refresh(
  cache: Cache,
  cacheKey: Request,
  render: () => Promise<Response>,
  cachePolicy: EdgeCachePolicy,
): Promise<void> {
  const response = await render();

  if (isStorable(response, cachePolicy)) {
    await cache.put(cacheKey, toStoredResponse(response, cachePolicy));
  } else {
    await cache.delete(cacheKey);
  }
}

function isStorable(response: Response, cachePolicy: EdgeCachePolicy): boolean {
  return (
    response.status === 200 &&
    (response.headers.get("content-type")?.includes(cachePolicy.contentType) ?? false)
  );
}

function toStoredResponse(response: Response, cachePolicy: EdgeCachePolicy): Response {
  const stored = new Response(response.body, response);
  const storedAt = Date.now();
  stored.headers.set("Cache-Control", `public, s-maxage=${cachePolicy.storedMaxAge}`);
  stored.headers.set(STAMP_HEADER, String(storedAt));
  stored.headers.set(FRESH_UNTIL_HEADER, String(storedAt + cachePolicy.freshSeconds * 1_000));
  stored.headers.set(EXPIRES_AT_HEADER, String(storedAt + cachePolicy.storedMaxAge * 1_000));

  return stored;
}

function tagHit(
  response: Response,
  status: "fresh" | "stale",
  cachePolicy: EdgeCachePolicy,
): Response {
  const out = new Response(response.body, response);
  out.headers.set("Cache-Control", cachePolicy.cacheControl);
  out.headers.delete(STAMP_HEADER);
  out.headers.delete(FRESH_UNTIL_HEADER);
  out.headers.delete(EXPIRES_AT_HEADER);
  out.headers.set("x-edge-cache", status);

  return out;
}

function tagResponse(response: Response, status: string, cachePolicy: EdgeCachePolicy): Response {
  const out = new Response(response.body, response);

  if (isStorable(response, cachePolicy)) {
    out.headers.set("Cache-Control", cachePolicy.cacheControl);
  }

  out.headers.set("x-edge-cache", status);

  return out;
}

function logPathsToPurge(logId: string): string[] {
  return [`/log/${encodeURIComponent(logId)}`, "/log"];
}

export function purgeLogCache(logId: string | null | undefined): void {
  if (!logId?.trim()) {
    return;
  }

  waitUntil(purgeLogCacheNow(logId.trim()));
}

async function purgeLogCacheNow(logId: string): Promise<void> {
  await purgePathsNow(logPathsToPurge(logId));
}

export async function purgePathsNow(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  const cache = edgeCache();

  if (cache) {
    await Promise.all(paths.map((path) => cache.delete(cacheKeyForPath(path)).catch(() => false)));
  }

  const zoneId = readBinding("CF_CACHE_PURGE_ZONE_ID");
  const token = readBinding("CF_CACHE_PURGE_TOKEN");

  if (!zoneId || !token) {
    return;
  }

  const urls = paths.map((path) => `${CANONICAL_ORIGIN}${path}`);

  try {
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      body: JSON.stringify({ files: urls }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  } catch {}
}

export type EntityCacheKind = "artist" | "album" | "label" | "track";

function entityPath(kind: EntityCacheKind, slug: string): string {
  return `/${kind}/${encodeURIComponent(slug)}`;
}

export function entityPurgeUrl(kind: EntityCacheKind, slug: string): string {
  return `${CANONICAL_ORIGIN}${entityPath(kind, slug)}`;
}

export async function purgeEntityCachesNow(
  targets: { kind: EntityCacheKind; slug: string }[],
): Promise<void> {
  const paths = [
    ...new Set(
      targets
        .filter((target) => target.slug.trim())
        .map((target) => entityPath(target.kind, target.slug.trim())),
    ),
  ];

  await purgePathsNow(paths);
}

export function purgeEntityCaches(targets: { kind: EntityCacheKind; slug: string }[]): void {
  waitUntil(purgeEntityCachesNow(targets));
}

export function purgeEntityCache(kind: EntityCacheKind, slug: string | null | undefined): void {
  if (!slug?.trim()) {
    return;
  }

  purgeEntityCaches([{ kind, slug: slug.trim() }]);
}

function readBinding(key: "CF_CACHE_PURGE_ZONE_ID" | "CF_CACHE_PURGE_TOKEN"): string | undefined {
  const value = (env as unknown as Record<string, string | undefined>)[key];

  return value?.trim() ? value : undefined;
}

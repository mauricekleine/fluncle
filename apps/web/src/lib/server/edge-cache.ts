import { env, waitUntil } from "cloudflare:workers";

// `caches.default` is the Workers global cache (worker-configuration.d.ts), but the
// app's tsconfig pulls the DOM lib whose `CacheStorage` has no `.default`. Reach it
// through a narrow typed view rather than widening the whole project's lib set.
// Resolved lazily and defensively: outside the Workers runtime (Node tests, the
// `turso dev` data layer) the `caches` global is absent, so this returns undefined
// and the cache/purge paths no-op instead of throwing.
function edgeCache(): Cache | undefined {
  const store = (globalThis as { caches?: { default?: Cache } }).caches;

  return store?.default;
}

// Edge HTML cache for the public read surfaces: the log pages (`/log`, `/log/<id>`),
// the entity detail pages (`/artist|/album|/label/<slug>`), and the hub/index pages
// (`/`, `/artists`, `/albums`, `/labels`, `/tracks`, `/fresh`).
//
// Why the Cache API, not bare `Cache-Control`: this Worker IS the origin — it
// renders the SSR document itself rather than `fetch()`ing an upstream. Cloudflare
// only auto-caches responses it proxies from an origin; a Worker-generated response
// is never auto-stored from its headers. So we drive `caches.default` explicitly:
// store the rendered document, serve it on the next hit, and revalidate in the
// background. The cold path (Worker SSR + a Turso read per render, ~896ms TTFB)
// then only runs on a true miss or a background refresh, never on the hot path.
//
// A finding is publish-then-immutable in practice (the facts are minted on add; the
// async agent fills bpm/key/video once; an operator may re-tag or fix a note), so a
// short fresh window with a long stale-while-revalidate tail is the right shape:
// almost every hit is a cache hit, the rare edit is reflected within the fresh
// window at worst, and an explicit purge-on-change (purgeLogCache) makes even that
// window correct. The Cache API has no native SWR, so we implement it: the stored
// entry carries a long hard TTL (the full SWR window) plus our own freshness stamp,
// and `withEdgeCache` decides fresh / stale-serve-and-revalidate / miss from it.

/**
 * One cache policy: how long a stored document counts as fresh, how long past that it may
 * still be served while a background render refreshes it, and the browser/CDN-facing
 * directive that states both. Two instances exist (below) — a page policy and a hub policy —
 * because a DETAIL page and an INDEX page go stale for different reasons.
 */
export type EdgeCachePolicy = {
  /** The browser/CDN-facing `Cache-Control` for a response served under this policy. */
  readonly cacheControl: string;
  /** Within this many seconds of being stored, a cached document is served as-is. */
  readonly freshSeconds: number;
  /** What we ask `caches.default` to keep the entry for: the whole fresh+stale window. */
  readonly storedMaxAge: number;
  /** Past the fresh window, how long a stale copy may still be served while it refreshes. */
  readonly swrSeconds: number;
};

// `s-maxage`/`stale-while-revalidate` let any downstream shared cache (and Cloudflare's own,
// where applicable) apply the same policy; `max-age=0` keeps private browser caches honest so
// a viewer always revalidates against the edge rather than pinning a stale page locally.
function policy(freshSeconds: number, swrSeconds: number): EdgeCachePolicy {
  return {
    cacheControl: `public, max-age=0, s-maxage=${freshSeconds}, stale-while-revalidate=${swrSeconds}`,
    freshSeconds,
    storedMaxAge: freshSeconds + swrSeconds,
    swrSeconds,
  };
}

// Fresh window for a DETAIL page (`/log/<id>`, `/artist|/album|/label/<slug>`) and the purged
// `/log` index. Short because a re-enrichment or re-tag should surface quickly even if a purge
// is missed; long enough that bursts of crawler/share traffic collapse onto one render.
export const FRESH_SECONDS = 300;
// Stale-while-revalidate tail for a detail page. Deliberately ~an hour, NOT a day: the SSR
// document references BUILD-SCOPED hashed asset URLs (`/assets/<hash>.js`), so HTML that
// outlives its build hands a client dead chunk URLs and breaks client-side navigation until a
// reload. Deploys land many times a day, so an hour keeps the stale tail inside the deploy
// cadence; the client-side chunk-load recovery in `routes/__root.tsx` is the second half of
// that guarantee. A page hit at least once an hour never pays a cold render anyway (the first
// request past the fresh window serves stale and refreshes behind it).
export const SWR_SECONDS = 3_600;

/** The detail-page / `/log` policy. */
export const PAGE_CACHE_POLICY = policy(FRESH_SECONDS, SWR_SECONDS);

// Fresh window for a HUB/INDEX page (`/`, `/artists`, `/albums`, `/labels`, `/tracks`,
// `/fresh`). A minute, because an index invalidates on ANY member change — a new finding, an
// enrichment, an artist bio, a catalogue row the crawler minted — across four entity kinds and
// several write paths. Wiring an explicit purge into every one of those would be a wide,
// easy-to-miss fan-out, and the crawler alone would purge the hubs continuously, which defeats
// the cache. A 60s ceiling is the better trade: bounded, self-healing, and zero coupling to the
// write paths, while still collapsing effectively all crawler and visitor traffic onto one
// render per minute (the measured cold render for `/artists` is ~1s, ~98% of it server think).
export const HUB_FRESH_SECONDS = 60;
// Short stale tail for the same reason the detail tail is short (build-scoped assets), and
// shorter still because a hub's whole job is to show what just landed.
export const HUB_SWR_SECONDS = 600;

/** The hub/index policy. */
export const HUB_CACHE_POLICY = policy(HUB_FRESH_SECONDS, HUB_SWR_SECONDS);

/** The detail-page directive. Kept as a named export because it is the site's default shape. */
export const PUBLIC_CACHE_CONTROL = PAGE_CACHE_POLICY.cacheControl;

// Our own freshness stamp (epoch ms at store time); read back to compute age.
const STAMP_HEADER = "x-edge-cached-at";

/** True for the public log surfaces we edge-cache: `/log` and `/log/<id>`. */
export function isCacheableLogPath(pathname: string): boolean {
  return pathname === "/log" || pathname === "/log/" || pathname.startsWith("/log/");
}

// The public entity DETAIL pages we edge-cache: `/artist/<slug>`, `/album/<slug>`,
// `/label/<slug>` (singular + a single slug segment). The plural index pages are cached too,
// but under the separate, shorter HUB policy below — they invalidate on any member change, so
// they ride a 60s fresh window instead of an explicit purge, whereas a detail page is purged by
// the write paths. A trailing slash is tolerated; a nested path (`/artist/<slug>/x`) is not a
// detail page.
const ENTITY_DETAIL_PATH = /^\/(?:artist|album|label)\/[^/]+\/?$/;

/**
 * True for a cacheable entity detail page — AND ONLY when it carries no query string. The
 * cache key drops the query (cacheKeyForPath), so a paginated/sorted variant (`?page=2`,
 * `?sort=…`) would collide onto the canonical page-1 entry; caching only the bare canonical
 * URL (what crawlers hit) keeps the SEO win without ever serving page 2's body for page 1.
 */
export function isCacheableEntityRequest(pathname: string, search: string): boolean {
  return search === "" && ENTITY_DETAIL_PATH.test(pathname);
}

// The public HUB/index pages: the archive front door, the four editorial indexes, and the
// fresh-releases board. These are the SLOW pages — each is a multi-row aggregate query, and
// `/artists` measured ~1s of server think — and they are the ones crawlers hammer, so they are
// where an edge hit is worth the most. `/log` is deliberately absent: it is on the page policy
// because the finding write paths already purge it explicitly.
const HUB_PATHS_BELOW_ROOT = new Set(["/albums", "/artists", "/fresh", "/labels", "/tracks"]);

/**
 * True for a cacheable hub/index page — AND ONLY when it carries no query string, for exactly
 * the reason `isCacheableEntityRequest` demands it: the cache key drops the query
 * (cacheKeyForPath), so a paginated/filtered/sorted variant (`?page=2`, `?galaxy=…`,
 * `?view=…`, `?story=…`) would collide onto the canonical page-1 entry. Only the bare
 * canonical URL — what a crawler and a first-time visitor hit — is cached; every variant flows
 * through uncached and correct. A single trailing slash is tolerated (`/artists/`), and note
 * that it keys as its own entry rather than folding onto the unslashed one, so no variant can
 * ever be served for another URL.
 */
export function isCacheableHubRequest(pathname: string, search: string): boolean {
  if (search !== "") {
    return false;
  }

  if (pathname === "/") {
    return true;
  }

  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  return HUB_PATHS_BELOW_ROOT.has(trimmed);
}

/**
 * THE chokepoint: the policy this request should be edge-cached under, or `undefined` when it
 * must not be shared-cached at all. Every caller (server.ts) goes through this one function, so
 * the "which paths are cacheable, and for how long" decision is defined and tested in one place.
 *
 * Callers remain responsible for the request-shape guards this function cannot see: GET only, no
 * admin cookie, and an HTML-accepting client (see server.ts).
 */
export function edgeCachePolicyFor(pathname: string, search: string): EdgeCachePolicy | undefined {
  if (isCacheableLogPath(pathname) || isCacheableEntityRequest(pathname, search)) {
    return PAGE_CACHE_POLICY;
  }

  return isCacheableHubRequest(pathname, search) ? HUB_CACHE_POLICY : undefined;
}

// The canonical origin for cache keys. Storing and purging both key off THIS origin
// (plus the request's path), never the incoming host — so the key a write deletes is
// exactly the key a read stored, regardless of which hostname served the request
// (www, a preview tunnel, localhost). Without this, a purge built from the canonical
// URL would miss an entry stored under a different incoming origin.
const CANONICAL_ORIGIN = "https://www.fluncle.com";

// The stable `caches.default` key for a log path: canonical origin + that path,
// dropping any query string so `?utm=…`/share params can't fragment or poison the
// cache (the log surfaces render purely from the path).
function cacheKeyForPath(pathname: string): Request {
  return new Request(`${CANONICAL_ORIGIN}${pathname}`, { method: "GET" });
}

/**
 * Serve a cacheable document through `caches.default` with manual stale-while-revalidate,
 * under the given policy (from `edgeCachePolicyFor`). `render` produces the fresh response on
 * a miss or a background refresh; it is only invoked when needed.
 */
export async function withEdgeCache(
  request: Request,
  render: () => Promise<Response>,
  cachePolicy: EdgeCachePolicy = PAGE_CACHE_POLICY,
): Promise<Response> {
  const cache = edgeCache();

  // No edge cache available (outside the Workers runtime): render straight through.
  if (!cache) {
    return render();
  }

  const cacheKey = cacheKeyForPath(new URL(request.url).pathname);
  const hit = await cache.match(cacheKey);

  if (hit) {
    const ageSeconds = cacheAgeSeconds(hit);

    if (ageSeconds < cachePolicy.freshSeconds) {
      return tagHit(hit, "fresh", cachePolicy);
    }

    // Stale but within the SWR tail: serve the stale copy now, refresh behind it.
    waitUntil(refresh(cache, cacheKey, render, cachePolicy));

    return tagHit(hit, "stale", cachePolicy);
  }

  // Cold miss: render, store (if cacheable), and serve.
  const response = await render();

  if (isStorable(response)) {
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

  if (isStorable(response)) {
    await cache.put(cacheKey, toStoredResponse(response, cachePolicy));
  } else {
    // The page stopped being cacheable (e.g. it now 404s/redirects): evict so the
    // next request re-renders instead of resurrecting a stale body.
    await cache.delete(cacheKey);
  }
}

// Only cache a plain 200 HTML document. A 301 (trackId → coordinate), a 404
// (missing finding), or anything non-HTML must never be edge-cached as the page.
function isStorable(response: Response): boolean {
  return (
    response.status === 200 &&
    (response.headers.get("content-type")?.includes("text/html") ?? false)
  );
}

// Re-wrap with the public Cache-Control, our freshness stamp, and a stored hard TTL.
function toStoredResponse(response: Response, cachePolicy: EdgeCachePolicy): Response {
  const stored = new Response(response.body, response);
  stored.headers.set("Cache-Control", `public, s-maxage=${cachePolicy.storedMaxAge}`);
  stored.headers.set(STAMP_HEADER, String(Date.now()));

  return stored;
}

function cacheAgeSeconds(response: Response): number {
  const stamp = Number(response.headers.get(STAMP_HEADER));

  if (!Number.isFinite(stamp)) {
    return Number.POSITIVE_INFINITY;
  }

  return (Date.now() - stamp) / 1000;
}

// On the way out to the client, present the real SWR directive (not the long stored
// TTL) and a debug status so a preview can confirm hit/miss without guessing.
function tagHit(
  response: Response,
  status: "fresh" | "stale",
  cachePolicy: EdgeCachePolicy,
): Response {
  const out = new Response(response.body, response);
  out.headers.set("Cache-Control", cachePolicy.cacheControl);
  out.headers.delete(STAMP_HEADER);
  out.headers.set("x-edge-cache", status);

  return out;
}

function tagResponse(response: Response, status: string, cachePolicy: EdgeCachePolicy): Response {
  const out = new Response(response.body, response);

  if (isStorable(response)) {
    out.headers.set("Cache-Control", cachePolicy.cacheControl);
  }

  out.headers.set("x-edge-cache", status);

  return out;
}

// ── Purge on change ──────────────────────────────────────────────────────────
//
// A write to a finding (publish, enrichment, re-tag, video link, note edit) must
// drop that finding's `/log/<id>` page and the `/log` index from cache so the next
// request re-renders. Two layers: a local `cache.delete` (instant, this data center
// only) and a global Cloudflare purge-by-URL (every data center) when the zone token
// is configured. The global purge is best-effort — if the token is absent or the
// call fails, the local delete plus the short fresh window still bound staleness, so
// a write never blocks on it.

/** The log paths a finding's change can stale: its own page and the index. */
function logPathsToPurge(logId: string): string[] {
  return [`/log/${encodeURIComponent(logId)}`, "/log"];
}

/**
 * The full canonical purge URLs for a finding's change — its own `/log/<id>` page
 * and the `/log` index — keyed off the canonical origin the read path stored under.
 * The global zone purge sends exactly these; exported so the URL shape is unit-pinned
 * (a drifted origin or a dropped index would silently leave a stale page served).
 */
export function logPurgeUrls(logId: string): string[] {
  return logPathsToPurge(logId).map((path) => `${CANONICAL_ORIGIN}${path}`);
}

/**
 * Purge a finding's cached log surfaces after a write. Fire-and-extend via
 * `waitUntil` so callers (the write paths) don't await network I/O; safe to call
 * with a missing/blank logId (no-op).
 */
export function purgeLogCache(logId: string | null | undefined): void {
  if (!logId?.trim()) {
    return;
  }

  waitUntil(purgeLogCacheNow(logId.trim()));
}

async function purgeLogCacheNow(logId: string): Promise<void> {
  await purgePathsNow(logPathsToPurge(logId));
}

/**
 * The shared purge core: evict a set of canonical paths from BOTH the local `caches.default`
 * (instant, this data center) and the global Cloudflare cache (every data center, via the
 * zone purge-by-URL REST API). Every purge — log surfaces and entity pages alike — funnels
 * through here so the two-layer behaviour and the canonical-origin keying are defined once.
 */
async function purgePathsNow(paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  const cache = edgeCache();

  // Local eviction: instant, this data center. Always safe, no credentials. Skipped
  // outside the Workers runtime (no `caches` global, e.g. unit tests). Keys off the
  // SAME canonical-origin key the read path stored under (cacheKeyForPath), so the
  // delete always lands on the entry a read created.
  if (cache) {
    await Promise.all(paths.map((path) => cache.delete(cacheKeyForPath(path)).catch(() => false)));
  }

  // Global eviction: every data center, via the zone purge-by-URL REST API. Skipped
  // (not an error) when the operator hasn't wired the token — the local delete + the
  // short fresh window keep staleness bounded.
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
  } catch {
    // Best-effort: the local delete + short fresh window bound staleness regardless.
  }
}

// ── Purge the public entity detail pages ───────────────────────────────────────
//
// The `/artist|/album|/label/<slug>` pages are a JOIN — an entity row plus the findings and
// catalogue rows that point at it — so a write to any of those must drop the affected page(s)
// exactly as a finding write drops `/log/<id>`. Same two layers, same canonical keying.

/** The three cacheable entity detail kinds. */
export type EntityCacheKind = "artist" | "album" | "label";

/** The canonical path for one entity detail page. */
function entityPath(kind: EntityCacheKind, slug: string): string {
  return `/${kind}/${encodeURIComponent(slug)}`;
}

/**
 * The canonical purge URL for an entity detail page — exported so the URL shape is unit-pinned
 * (a drifted origin or path would silently leave a stale page served, exactly as for the log
 * surfaces).
 */
export function entityPurgeUrl(kind: EntityCacheKind, slug: string): string {
  return `${CANONICAL_ORIGIN}${entityPath(kind, slug)}`;
}

/**
 * Purge a set of entity detail pages after a write, awaitably. Blank slugs are dropped and
 * duplicate targets collapse to one path. Callers that ALREADY run inside a `waitUntil`
 * (e.g. after resolving a track's linked slugs) use this; everything else uses the
 * fire-and-forget `purgeEntityCache`/`purgeEntityCaches` below.
 */
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

/**
 * Fire-and-forget purge of several entity detail pages after a write — `waitUntil`-extended
 * so the write path never awaits network I/O. Safe with an empty/blank-only target list.
 */
export function purgeEntityCaches(targets: { kind: EntityCacheKind; slug: string }[]): void {
  waitUntil(purgeEntityCachesNow(targets));
}

/** Fire-and-forget purge of a single entity detail page. No-op on a missing/blank slug. */
export function purgeEntityCache(kind: EntityCacheKind, slug: string | null | undefined): void {
  if (!slug?.trim()) {
    return;
  }

  purgeEntityCaches([{ kind, slug: slug.trim() }]);
}

// The purge credentials live on the Worker env (wrangler vars/secrets), read the
// same way the rest of the server reads bindings. Optional: absent in dev and until
// the operator provisions the token, where the local delete path still runs.
function readBinding(key: "CF_CACHE_PURGE_ZONE_ID" | "CF_CACHE_PURGE_TOKEN"): string | undefined {
  const value = (env as unknown as Record<string, string | undefined>)[key];

  return value?.trim() ? value : undefined;
}

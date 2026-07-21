#!/usr/bin/env bun
/**
 * The post-deploy production probe — the RESOLUTION half of Fluncle's monitoring,
 * fired automatically once a push to `main` has deployed (the
 * `.github/workflows/post-deploy-probe.yml` wait loop calls this after prod's
 * /api/health reports the pushed SHA). It is the automated form of the
 * `fluncle-smoke` skill: sweep every public surface and go red the instant one
 * stops resolving — the class a service-health probe (/status, up/down) sails past,
 * where a moved/deleted route quietly returns 404 while the box still reads "up".
 *
 * ANTI-DRIFT — the target list is DERIVED LIVE every run, never hardcoded:
 *   - Web pages, feeds, discovery docs, and subdomains come from `@fluncle/registry`
 *     (`liveSurfaces()` / `statusProbes()`), the single in-code source of truth for
 *     where Fluncle is reachable.
 *   - The API surface comes from `@fluncle/contracts/orpc` — every oRPC op's
 *     `route.method` + `route.path` (+ its tier, read structurally from the path).
 * So a surface that ships, moves, or is retired is picked up automatically; a stale
 * list can never lie.
 *
 * STRICTLY READ-ONLY. Only GET is ever sent, so the probe is side-effect-free and
 * safe against production. Write ops (POST/PATCH/PUT/DELETE) are catalogued but NOT
 * fired; their auth gates are covered by the CI `orpc-auth*` tests instead.
 *
 * Per-class assertions (see `Expectation`):
 *   - web / subdomain     → 2xx + non-empty HTML.
 *   - feed / discovery    → 2xx + parseable XML / JSON / non-empty text (by format).
 *   - public API (GET)    → 2xx + parseable JSON. A 400 counts as SERVED (the route
 *                           resolved and rejected missing input, e.g. search needs a
 *                           query) — served, never a regression.
 *   - auth-gated API (GET, admin/`/me`) → 401/403. Probed UNAUTHENTICATED on purpose:
 *                           the auth gate is itself under test, so a 2xx here is a
 *                           CRITICAL failure (an endpoint that stopped requiring auth).
 *
 * Usage:
 *   bun run scripts/post-deploy-probe.ts                 # prod (default)
 *   bun run scripts/post-deploy-probe.ts --base-url http://127.0.0.1:3000
 *   bun run scripts/post-deploy-probe.ts --json          # machine-readable results
 *
 * Exit code is non-zero if any surface FAILED (or was CRITICAL); SKIPs never fail
 * the run.
 */
import { contract } from "@fluncle/contracts/orpc";
import { liveSurfaces, statusProbes, type Surface } from "@fluncle/registry";

// The canonical production origin — the ONE piece of topology this probe hardcodes,
// and it is fully public (this repo is open source). `--base-url` retargets it for a
// local/preview run.
const PROD_BASE_URL = "https://www.fluncle.com";

// The versioned API prefix every contract op is mounted under (the bare `/api`
// alias serves the same handlers; we probe the canonical one).
const API_PREFIX = "/api/v1";

// Placeholder substituted for a `{param}` in an AUTH-gated op's path. Admin/`/me`
// auth middleware runs BEFORE path-param resolution, so a gated op answers 401
// regardless of the value — verified against prod (`GET /api/v1/admin/tracks/probe`
// → 401). It never reaches a handler, so it is inert.
const PARAM_PLACEHOLDER = "probe";

// Subdomains that do NOT serve a 200 at their bare root, so a root GET is not a
// resolution probe for them (documented, small, like status.ts's RETIRED_SERVICE_IDS):
//   - subdomain.found — the R2 object store; its root 404s by design (the box probes a
//     real object instead). The `fluncle-smoke` skill notes this exact carve-out.
// `.onion` subdomains are skipped separately (not routable from GitHub Actions).
const NON_ROOT_200_SUBDOMAINS = new Set<string>(["subdomain.found"]);

// Politeness + resilience knobs — gentle on prod.
const CONCURRENCY = 4;
const TIMEOUT_MS = 10_000;
const NETWORK_RETRIES = 1; // one retry, on a thrown/timeout error only (never on an HTTP status).

// ── Types ────────────────────────────────────────────────────────────────────

/** The body shape a served (2xx) response must satisfy for its class. */
type ContentKind = "html" | "json" | "text" | "xml";

/** What a target's response must look like to pass. */
type Expectation =
  | { kind: "served"; content: ContentKind } // 2xx (+content); 400 = served-with-input-required.
  | { kind: "auth-gate" }; // 401/403 unauthenticated; a 2xx here is a CRITICAL leak.

/** Coarse grouping for the report, one row per surface. */
type TargetClass = "api-auth" | "api-public" | "discovery" | "feed" | "subdomain" | "web";

/** One thing to GET, fully resolved to an absolute URL. */
type Target = {
  name: string;
  className: TargetClass;
  url: string;
  expect: Expectation;
  /** True when the URL is on the primary www origin, so `--base-url` can retarget it. */
  rewritable: boolean;
};

/** A GET target we deliberately did NOT fire, with the reason (shown in the report). */
type SkippedTarget = {
  name: string;
  className: TargetClass | "api-write";
  reason: string;
};

type Verdict = "CRIT" | "FAIL" | "PASS" | "SKIP";

type ProbeResult = {
  name: string;
  className: Target["className"] | "api-write";
  url: string;
  verdict: Verdict;
  status: number | null;
  detail: string;
};

// ── Tier / classification (pure) ──────────────────────────────────────────────

/**
 * An oRPC op's auth tier, derived STRUCTURALLY from its path — the same structural
 * truth `orpc.ts` relies on to build the public OpenAPI doc (it filters the admin
 * surface by exactly the `/admin/*` prefix) and that the coverage tests enforce:
 *   - `/admin/*`        → admin-tier (any admin principal; unauthenticated → 401).
 *   - `/me` (exact)     → PUBLIC: `get_current_private_user` returns `user: null`
 *                         when signed out and never 401s (a deliberate carve-out).
 *   - `/me/*`           → private-session tier (unauthenticated → 401).
 *   - everything else   → public.
 * The reference-equal-middleware derivation in `orpc-auth-coverage.test.ts` is the
 * authoritative tier source, but it needs the server router (which pulls
 * `cloudflare:workers`, unavailable to this standalone Bun script). This path rule
 * agrees with it for every current op; if a future op ever broke the structural
 * convention, the auth-coverage test would fail in CI first.
 */
export function tierOfPath(path: string): "admin" | "private" | "public" {
  if (path.startsWith("/admin")) {
    return "admin";
  }

  if (path === "/me") {
    return "public";
  }

  if (path.startsWith("/me/")) {
    return "private";
  }

  return "public";
}

/** Read an oRPC contract op's `{ method, path }` off its `~orpc` route metadata. */
function routeOf(op: unknown): { method: string; path: string } {
  const orpc = (op as Record<string, unknown>)["~orpc"] as Record<string, unknown> | undefined;
  const route = (orpc?.route ?? {}) as { method?: string; path?: string };

  return { method: route.method ?? "GET", path: route.path ?? "" };
}

/** Map a registry surface's `apiFormat` to the body kind we assert on it. */
function contentKindForFormat(apiFormat: string | undefined): ContentKind {
  const format = (apiFormat ?? "").toLowerCase();

  if (format.includes("xml")) {
    return "xml";
  }

  if (format.includes("json")) {
    return "json";
  }

  return "text";
}

/** The absolute URL a registry surface is probed at (its explicit `url`, else the
 * www route, else the subdomain host). */
function surfaceUrl(surface: Surface): string | null {
  if (surface.url) {
    return surface.url;
  }

  if (surface.route) {
    return `${PROD_BASE_URL}${surface.route}`;
  }

  if (surface.subdomain) {
    return `https://${surface.subdomain}`;
  }

  return null;
}

// ── Target derivation (pure) ──────────────────────────────────────────────────

/**
 * Build the full probe target list from the registry + the contract. Pure and
 * deterministic (no I/O), so it is unit-tested directly.
 *
 * Returns both the FIRED targets and the deliberately-SKIPPED GET/write targets, so
 * the report can show exactly what was and was not covered.
 */
export function buildTargets(): { targets: Target[]; skipped: SkippedTarget[] } {
  const targets: Target[] = [];
  const skipped: SkippedTarget[] = [];

  // ── Registry: web pages + subdomains ───────────────────────────────────────
  // Only surfaces the registry marks as http-probeable (its author already vouched
  // they answer 200) — this respects the gate/redirect signals (e.g. /mix has no
  // probeConfig because a closed gate 302s a bare GET).
  for (const surface of statusProbes()) {
    if (surface.probeConfig.kind !== "http") {
      continue;
    }

    if (surface.kind !== "web_route" && surface.kind !== "subdomain") {
      continue; // API/feed/discovery handled from their authoritative sources below.
    }

    const url = surfaceUrl(surface);

    if (!url) {
      continue;
    }

    // Tor onion — not routable from CI; its liveness is covered by the existing
    // watchdog cross-ping, not a www-origin GET.
    if (new URL(url).hostname.endsWith(".onion")) {
      skipped.push({
        className: "subdomain",
        name: surface.name,
        reason: "Tor onion — not routable from CI",
      });

      continue;
    }

    if (NON_ROOT_200_SUBDOMAINS.has(surface.name)) {
      skipped.push({
        className: "subdomain",
        name: surface.name,
        reason: "object-store root 404s by design (probed as a real object elsewhere)",
      });

      continue;
    }

    targets.push({
      className: surface.kind === "subdomain" ? "subdomain" : "web",
      expect: { content: "html", kind: "served" },
      name: surface.name,
      rewritable: url.startsWith(PROD_BASE_URL),
      url,
    });
  }

  // ── Registry: feeds + discovery docs ────────────────────────────────────────
  // Static syndication/discovery documents — always GET-able, no gate — so we sweep
  // ALL concrete (non-parameterised) ones, not just the curated /status subset.
  for (const surface of liveSurfaces()) {
    if (surface.kind !== "feed" && surface.kind !== "discovery") {
      continue;
    }

    const route = surface.route ?? surface.url;

    // Parameterised feeds (e.g. /artist/:slug/fresh.xml) have no fixed address to GET.
    if (!route || route.includes(":")) {
      if (route?.includes(":")) {
        skipped.push({
          className: surface.kind === "feed" ? "feed" : "discovery",
          name: surface.name,
          reason: "parameterised route — no fixed address to probe",
        });
      }

      continue;
    }

    const url = surfaceUrl(surface);

    if (!url) {
      continue;
    }

    targets.push({
      className: surface.kind === "feed" ? "feed" : "discovery",
      expect: { content: contentKindForFormat(surface.apiFormat), kind: "served" },
      name: surface.name,
      rewritable: url.startsWith(PROD_BASE_URL),
      url,
    });
  }

  // ── Contract: the API surface ───────────────────────────────────────────────
  for (const [name, op] of Object.entries(contract as Record<string, unknown>)) {
    const { method, path } = routeOf(op);

    // Read-only rule: never fire a write. Catalogue it as skipped.
    if (method !== "GET") {
      skipped.push({
        className: "api-write",
        name,
        reason: `${method} write op — not fired (read-only probe)`,
      });

      continue;
    }

    const tier = tierOfPath(path);
    const hasParams = path.includes("{");

    if (tier === "admin" || tier === "private") {
      // Auth-gated. Substitute the inert placeholder for any param (auth 401s before
      // the param is read) and assert the gate holds.
      const resolvedPath = path.replaceAll(/\{[^}]+\}/g, PARAM_PLACEHOLDER);

      targets.push({
        className: "api-auth",
        expect: { kind: "auth-gate" },
        name,
        rewritable: true,
        url: `${PROD_BASE_URL}${API_PREFIX}${resolvedPath}`,
      });

      continue;
    }

    // Public GET. A parameterised one needs a real id — a bogus id 404s
    // indistinguishably from a dead route — so skip it rather than raise a false
    // alarm. (The bootstrap step below resolves the common track-id family.)
    if (hasParams) {
      skipped.push({
        className: "api-public",
        name,
        reason: `parameterised public read (${path}) — needs a real id`,
      });

      continue;
    }

    targets.push({
      className: "api-public",
      expect: { content: "json", kind: "served" },
      name,
      rewritable: true,
      url: `${PROD_BASE_URL}${API_PREFIX}${path}`,
    });
  }

  return { skipped, targets };
}

// The param names that identify a finding/mixtape by id or Log ID — the one family
// the bootstrap resolves so the flagship `get_track` read is actually covered.
const TRACK_ID_PARAMS = new Set(["idOrLogId", "logId", "trackId"]);

/**
 * Promote the track-id-family public parameterised GET ops from skipped → fired,
 * substituting a REAL Log ID fetched from the public archive list. Ops whose single
 * param is a track id (`get_track`, `list_similar_tracks`, `list_mixable_tracks`)
 * gain live coverage; every other parameterised public read stays skipped.
 * Best-effort: if no sample id is available, nothing is promoted (the ops remain
 * honestly skipped).
 */
export function promoteTrackParamOps(
  skipped: SkippedTarget[],
  sampleLogId: string | null,
): { promoted: Target[]; remaining: SkippedTarget[] } {
  if (!sampleLogId) {
    return { promoted: [], remaining: skipped };
  }

  const promoted: Target[] = [];
  const remaining: SkippedTarget[] = [];

  for (const skip of skipped) {
    const op = (contract as Record<string, unknown>)[skip.name];
    const isPublicParamRead = op !== undefined && skip.className === "api-public";
    const { path } = isPublicParamRead ? routeOf(op) : { path: "" };
    const params = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const onlyTrackId = params.length > 0 && params.every((param) => TRACK_ID_PARAMS.has(param));

    if (isPublicParamRead && onlyTrackId) {
      const resolvedPath = path.replaceAll(/\{[^}]+\}/g, encodeURIComponent(sampleLogId));

      promoted.push({
        className: "api-public",
        expect: { content: "json", kind: "served" },
        name: skip.name,
        rewritable: true,
        url: `${PROD_BASE_URL}${API_PREFIX}${resolvedPath}`,
      });

      continue;
    }

    remaining.push(skip);
  }

  return { promoted, remaining };
}

/** Rewrite a target's prod-origin URL onto `baseUrl` (leaves cross-origin ones as-is). */
export function retarget(target: Target, baseUrl: string): { url: string; crossOrigin: boolean } {
  if (target.rewritable && baseUrl !== PROD_BASE_URL) {
    return { crossOrigin: false, url: target.url.replace(PROD_BASE_URL, baseUrl) };
  }

  // Not rewritable (a distinct subdomain host) and we are off prod → cannot map it.
  const crossOrigin = !target.rewritable && baseUrl !== PROD_BASE_URL;

  return { crossOrigin, url: target.url };
}

// ── Assertions (pure) ─────────────────────────────────────────────────────────

/** Does a 2xx body satisfy the expected content kind? Returns a failure reason or null. */
export function checkContent(
  content: ContentKind,
  contentType: string,
  body: string,
): string | null {
  const trimmed = body.trim();

  if (trimmed.length === 0) {
    return "empty body";
  }

  switch (content) {
    case "html": {
      const looksHtml = contentType.includes("html") || trimmed.startsWith("<");

      return looksHtml ? null : "not HTML";
    }
    case "json": {
      try {
        JSON.parse(trimmed);

        return null;
      } catch {
        return "unparseable JSON";
      }
    }
    case "xml": {
      // XML/RSS/Atom/sitemap all begin with a `<` (optionally an XML prolog). An
      // error page would be HTML or plain text, which this catches.
      return trimmed.startsWith("<") ? null : "not XML";
    }
    case "text": {
      return null; // non-empty already asserted.
    }
  }
}

/** Turn a response (status + body) into a verdict for a target's expectation. */
export function judge(
  expect: Expectation,
  status: number,
  contentType: string,
  body: string,
): { verdict: Verdict; detail: string } {
  if (expect.kind === "auth-gate") {
    if (status === 401 || status === 403) {
      return { detail: `${status} (auth gate held)`, verdict: "PASS" };
    }

    if (status >= 200 && status < 300) {
      return { detail: `${status} — auth gate OPEN (expected 401/403)`, verdict: "CRIT" };
    }

    // An admin op with REQUIRED query input (e.g. `get_mixable_order` needs `ids`,
    // `list_track_work` needs `scope`, `get_prompt` a known-enum slug) validates
    // that input BEFORE the auth middleware resolves, so an unauthenticated GET with
    // missing/placeholder input answers 400 — the route is SERVED and returned no
    // data (not a 404 dead route, not a 2xx leak). We cannot construct valid input
    // generically to force the 401, so the gate itself is left to the CI `orpc-auth*`
    // tests; here a 400 is a pass (it resolves).
    if (status === 400) {
      return { detail: "400 served (input required — gate not exercised)", verdict: "PASS" };
    }

    return { detail: `${status} (expected 401/403)`, verdict: "FAIL" };
  }

  if (status >= 200 && status < 300) {
    const contentFailure = checkContent(expect.content, contentType, body);

    return contentFailure
      ? { detail: `${status} but ${contentFailure}`, verdict: "FAIL" }
      : { detail: `${status} ok`, verdict: "PASS" };
  }

  // A 400 means the route RESOLVED and rejected missing/invalid input (e.g. search
  // needs a query) — served, not a regression.
  if (status === 400) {
    return { detail: "400 served (input required)", verdict: "PASS" };
  }

  return { detail: `${status} (expected 2xx)`, verdict: "FAIL" };
}

// ── Fetch (I/O) ───────────────────────────────────────────────────────────────

type FetchLike = typeof fetch;

/** GET a URL with a timeout and one retry on a thrown/timeout error (never on a status). */
async function fetchWithRetry(url: string, fetchImpl: FetchLike): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      return await fetchImpl(url, {
        headers: { "user-agent": "fluncle-post-deploy-probe" },
        method: "GET",
        signal: controller.signal,
      });
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

async function probeOne(target: Target, url: string, fetchImpl: FetchLike): Promise<ProbeResult> {
  try {
    const response = await fetchWithRetry(url, fetchImpl);
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const body = await response.text();
    const { verdict, detail } = judge(target.expect, response.status, contentType, body);

    return {
      className: target.className,
      detail,
      name: target.name,
      status: response.status,
      url,
      verdict,
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "network error";

    return {
      className: target.className,
      detail: reason,
      name: target.name,
      status: null,
      url,
      verdict: "FAIL",
    };
  }
}

/** Run `targets` through a fixed-size worker pool (polite concurrency). */
async function runPool(
  targets: { target: Target; url: string }[],
  fetchImpl: FetchLike,
): Promise<ProbeResult[]> {
  // Filled by index so the report keeps the derived target order regardless of which
  // worker finishes first; every index is assigned, so it ends up dense.
  const results: ProbeResult[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const { target, url } = targets[index];
      results[index] = await probeOne(target, url, fetchImpl);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()));

  return results;
}

// ── Bootstrap a real Log ID (I/O) ─────────────────────────────────────────────

/** Fetch one real Log ID from the public archive list, for the track-param ops. Null on any failure. */
async function bootstrapSampleLogId(baseUrl: string, fetchImpl: FetchLike): Promise<string | null> {
  try {
    const response = await fetchWithRetry(`${baseUrl}${API_PREFIX}/findings?limit=1`, fetchImpl);

    if (!response.ok) {
      return null;
    }

    const body = (await response.json()) as { tracks?: Array<{ logId?: unknown }> };
    const logId = body.tracks?.[0]?.logId;

    return typeof logId === "string" && logId.length > 0 ? logId : null;
  } catch {
    return null;
  }
}

// ── Report (pure) ─────────────────────────────────────────────────────────────

const VERDICT_ORDER: Record<Verdict, number> = { CRIT: 0, FAIL: 1, PASS: 2, SKIP: 3 };

export function formatTable(results: ProbeResult[]): string {
  const sorted = [...results].sort(
    (a, b) =>
      VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.className.localeCompare(b.className),
  );
  const lines = sorted.map((result) => {
    const status = result.status === null ? "—" : String(result.status);

    return `  ${result.verdict.padEnd(4)} ${result.className.padEnd(11)} ${status.padEnd(4)} ${result.name.padEnd(30)} ${result.detail}`;
  });

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

type Args = { baseUrl: string; json: boolean };

export function parseArgs(argv: string[]): Args {
  let baseUrl = PROD_BASE_URL;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--base-url") {
      const value = argv[i + 1];

      if (!value) {
        throw new Error("--base-url needs a value");
      }

      baseUrl = value.replace(/\/$/, "");
      i += 1;
    } else if (arg.startsWith("--base-url=")) {
      baseUrl = arg.slice("--base-url=".length).replace(/\/$/, "");
    } else if (arg === "--json") {
      json = true;
    }
  }

  return { baseUrl, json };
}

async function main(): Promise<void> {
  const { baseUrl, json } = parseArgs(process.argv.slice(2));
  const fetchImpl = fetch;

  const built = buildTargets();
  const sampleLogId = await bootstrapSampleLogId(baseUrl, fetchImpl);
  const { promoted, remaining } = promoteTrackParamOps(built.skipped, sampleLogId);
  const allTargets = [...built.targets, ...promoted];

  // Resolve every target onto the requested origin; cross-origin subdomains become SKIPs off prod.
  const toRun: { target: Target; url: string }[] = [];
  const crossOriginSkips: ProbeResult[] = [];

  for (const target of allTargets) {
    const { url, crossOrigin } = retarget(target, baseUrl);

    if (crossOrigin) {
      crossOriginSkips.push({
        className: target.className,
        detail: "cross-origin subdomain — only probed against prod",
        name: target.name,
        status: null,
        url: target.url,
        verdict: "SKIP",
      });

      continue;
    }

    toRun.push({ target, url });
  }

  const probed = await runPool(toRun, fetchImpl);

  const skipResults: ProbeResult[] = remaining.map((skip) => ({
    className: skip.className,
    detail: skip.reason,
    name: skip.name,
    status: null,
    url: "",
    verdict: "SKIP",
  }));

  const results = [...probed, ...crossOriginSkips, ...skipResults];

  const counts = results.reduce<Record<Verdict, number>>(
    (acc, result) => {
      acc[result.verdict] += 1;

      return acc;
    },
    { CRIT: 0, FAIL: 0, PASS: 0, SKIP: 0 },
  );
  const failed = counts.CRIT + counts.FAIL;

  if (json) {
    console.log(JSON.stringify({ baseUrl, counts, results, sampleLogId }, null, 2));
  } else {
    console.log(`\nPost-deploy probe → ${baseUrl}\n`);
    // Suppress the (many, uninteresting) write-op skips from the visible table; they
    // are counted in the summary line. Everything actually probed + notable skips show.
    const visible = results.filter((result) => result.className !== "api-write");
    console.log(formatTable(visible));
    console.log(
      `\n  (+ ${counts.SKIP - visible.filter((r) => r.verdict === "SKIP").length} write ops catalogued, not fired)`,
    );
    console.log(
      `\nSummary: ${counts.PASS} passed · ${counts.FAIL} failed · ${counts.CRIT} critical · ${counts.SKIP} skipped · ${results.length} total`,
    );

    if (failed > 0) {
      console.log("\nFAILURES:");
      for (const result of results.filter((r) => r.verdict === "CRIT" || r.verdict === "FAIL")) {
        console.log(`  ${result.verdict} ${result.name} — ${result.detail}\n    ${result.url}`);
      }
    }
  }

  if (failed > 0) {
    process.exit(1);
  }
}

// Run only when invoked directly (not when imported by the test).
if (import.meta.main) {
  await main();
}

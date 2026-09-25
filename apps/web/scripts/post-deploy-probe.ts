#!/usr/bin/env bun

import { contract } from "@fluncle/contracts/orpc";
import { liveSurfaces, statusProbes, type Surface } from "@fluncle/registry";

import { SEARCH_EXAMPLES } from "../src/lib/search-results";
import { SEARCH_STYLES } from "../src/lib/search-styles";
import { VECTOR_ENDPOINT_PROBE_TIMEOUT_MS } from "../src/lib/vector-budget";

const PROD_BASE_URL = "https://www.fluncle.com";

const API_PREFIX = "/api/v1";

const PARAM_PLACEHOLDER = "probe";

const NON_ROOT_200_SUBDOMAINS = new Set<string>(["subdomain.found"]);

const DARK_CAPABLE_OPERATIONS = new Map<string, { darkStatus: number; darkCode: string }>([
  ["get_replica_token", { darkCode: "replica_unavailable", darkStatus: 503 }],
]);

const CONCURRENCY = 4;
const TIMEOUT_MS = 10_000;
const NETWORK_RETRIES = 1;

const VECTOR_CAPABLE_OPERATIONS = new Set<string>([
  "list_mixable_tracks",
  "list_similar_artists",
  "list_similar_tracks",
  "search_archive",
]);

const SLOW_WARNING_MS = 5_000;

type ContentKind = "html" | "json" | "text" | "xml";

type Expectation =
  | { kind: "served"; content: ContentKind }
  | { kind: "auth-gate" }
  | { kind: "dark-or-served"; content: ContentKind; darkStatus: number; darkCode: string }
  | { kind: "search-example" }
  | { anchors: number; kind: "search-style"; slug: string };

type TargetClass = "api-auth" | "api-public" | "discovery" | "feed" | "subdomain" | "web";

type Target = {
  name: string;
  className: TargetClass;
  url: string;
  expect: Expectation;

  rewritable: boolean;

  vectorCapable?: true;
};

type SkippedTarget = {
  name: string;
  className: TargetClass | "api-write";
  reason: string;
};

type Verdict = "CRIT" | "FAIL" | "PASS" | "SKIP" | "WARN";

type ProbeResult = {
  name: string;
  className: Target["className"] | "api-write";
  url: string;
  verdict: Verdict;
  status: number | null;
  detail: string;

  durationMs: number | null;
};

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

function routeOf(op: unknown): { method: string; path: string } {
  const orpc = (op as Record<string, unknown>)["~orpc"] as Record<string, unknown> | undefined;
  const route = (orpc?.route ?? {}) as { method?: string; path?: string };

  return { method: route.method ?? "GET", path: route.path ?? "" };
}

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

export function buildTargets(): { targets: Target[]; skipped: SkippedTarget[] } {
  const targets: Target[] = [];
  const skipped: SkippedTarget[] = [];

  for (const surface of statusProbes()) {
    if (surface.probeConfig.kind !== "http") {
      continue;
    }

    if (surface.kind !== "web_route" && surface.kind !== "subdomain") {
      continue;
    }

    const url = surfaceUrl(surface);

    if (!url) {
      continue;
    }

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

  for (const surface of liveSurfaces()) {
    if (surface.kind !== "feed" && surface.kind !== "discovery") {
      continue;
    }

    const route = surface.route ?? surface.url;

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

  for (const [name, op] of Object.entries(contract as Record<string, unknown>)) {
    const { method, path } = routeOf(op);

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

    if (hasParams) {
      skipped.push({
        className: "api-public",
        name,
        reason: `parameterised public read (${path}) — needs a real id`,
      });

      continue;
    }

    const dark = DARK_CAPABLE_OPERATIONS.get(name);

    targets.push({
      className: "api-public",
      expect: dark
        ? {
            content: "json",
            darkCode: dark.darkCode,
            darkStatus: dark.darkStatus,
            kind: "dark-or-served",
          }
        : { content: "json", kind: "served" },
      name,
      rewritable: true,
      url: `${PROD_BASE_URL}${API_PREFIX}${path}`,
      ...vectorLane(name),
    });
  }

  for (const example of SEARCH_EXAMPLES) {
    targets.push({
      className: "api-public",
      expect: { kind: "search-example" },
      name: `search example · ${example.query}`,
      rewritable: true,
      url: `${PROD_BASE_URL}${API_PREFIX}/search/archive?q=${encodeURIComponent(example.query)}`,
      ...vectorLane("search_archive"),
    });
  }

  for (const style of SEARCH_STYLES) {
    targets.push({
      className: "api-public",
      expect: { anchors: style.anchors.length, kind: "search-style", slug: style.slug },
      name: `search style · ${style.label}`,
      rewritable: true,
      url: `${PROD_BASE_URL}${API_PREFIX}/search/archive?q=${encodeURIComponent(style.aliases[0] ?? style.slug)}`,
      ...vectorLane("search_archive"),
    });
  }

  return { skipped, targets };
}

export function vectorLane(operation: string): { vectorCapable?: true } {
  return VECTOR_CAPABLE_OPERATIONS.has(operation) ? { vectorCapable: true } : {};
}

const TRACK_ID_PARAMS = new Set(["idOrLogId", "logId", "trackId"]);

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
        ...vectorLane(skip.name),
      });

      continue;
    }

    remaining.push(skip);
  }

  return { promoted, remaining };
}

export function retarget(target: Target, baseUrl: string): { url: string; crossOrigin: boolean } {
  if (target.rewritable && baseUrl !== PROD_BASE_URL) {
    return { crossOrigin: false, url: target.url.replace(PROD_BASE_URL, baseUrl) };
  }

  const crossOrigin = !target.rewritable && baseUrl !== PROD_BASE_URL;

  return { crossOrigin, url: target.url };
}

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
      return trimmed.startsWith("<") ? null : "not XML";
    }
    case "text": {
      return null;
    }
  }
}

export function judgeSearchExample(body: string): { verdict: Verdict; detail: string } {
  let payload: { degraded?: unknown; entities?: unknown; results?: unknown };

  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return { detail: "200 but unparseable JSON", verdict: "FAIL" };
  }

  const results = Array.isArray(payload.results) ? payload.results.length : 0;
  const entities = Array.isArray(payload.entities) ? payload.entities.length : 0;

  if (results + entities === 0) {
    return { detail: "200 but NO results — a worked example must find something", verdict: "FAIL" };
  }

  if (payload.degraded === true) {
    return {
      detail: `200 with ${results + entities} but DEGRADED — it reached the language tier`,
      verdict: "FAIL",
    };
  }

  return { detail: `200 ok (${results + entities})`, verdict: "PASS" };
}

export function judgeSearchStyle(
  body: string,
  expected: { anchors: number; slug: string },
): { verdict: Verdict; detail: string } {
  let payload: {
    degraded?: unknown;
    filters?: { sound?: unknown; soundsLikeArtists?: unknown };
    kind?: unknown;
    results?: unknown;
  };

  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return { detail: "200 but unparseable JSON", verdict: "FAIL" };
  }

  if (payload.degraded === true) {
    return { detail: "200 but DEGRADED — the sound ranking did not run", verdict: "FAIL" };
  }

  if (payload.kind !== "sonic" || payload.filters?.sound !== expected.slug) {
    return {
      detail: `200 but answered as ${String(payload.kind)}, not the ${expected.slug} sound`,
      verdict: "FAIL",
    };
  }

  const anchors = Array.isArray(payload.filters.soundsLikeArtists)
    ? payload.filters.soundsLikeArtists.length
    : 0;

  if (anchors !== expected.anchors) {
    return {
      detail: `200 but only ${anchors}/${expected.anchors} anchors resolved to a centroid`,
      verdict: "FAIL",
    };
  }

  const results = Array.isArray(payload.results) ? payload.results.length : 0;

  return results > 0
    ? { detail: `200 ok (${results}, ${anchors} anchors)`, verdict: "PASS" }
    : { detail: "200 but NO results", verdict: "FAIL" };
}

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

    if (status === 400) {
      return { detail: "400 served (input required — gate not exercised)", verdict: "PASS" };
    }

    return { detail: `${status} (expected 401/403)`, verdict: "FAIL" };
  }

  if (expect.kind === "dark-or-served" && status === expect.darkStatus) {
    return body.includes(expect.darkCode)
      ? { detail: `${status} dark (typed ${expect.darkCode} — env not wired)`, verdict: "PASS" }
      : {
          detail: `${status} without ${expect.darkCode} (expected the typed dark fault)`,
          verdict: "FAIL",
        };
  }

  if (expect.kind === "search-example") {
    if (status < 200 || status >= 300) {
      return { detail: `${status} (expected 2xx)`, verdict: "FAIL" };
    }

    return judgeSearchExample(body);
  }

  if (expect.kind === "search-style") {
    if (status < 200 || status >= 300) {
      return { detail: `${status} (expected 2xx)`, verdict: "FAIL" };
    }

    return judgeSearchStyle(body, expect);
  }

  if (status >= 200 && status < 300) {
    const contentFailure = checkContent(expect.content, contentType, body);

    return contentFailure
      ? { detail: `${status} but ${contentFailure}`, verdict: "FAIL" }
      : { detail: `${status} ok`, verdict: "PASS" };
  }

  if (status === 400) {
    return { detail: "400 served (input required)", verdict: "PASS" };
  }

  return { detail: `${status} (expected 2xx)`, verdict: "FAIL" };
}

type FetchLike = typeof fetch;

export function fetchPolicy(target: Pick<Target, "vectorCapable">): {
  attempts: number;
  timeoutMs: number;
} {
  return target.vectorCapable === true
    ? { attempts: 1, timeoutMs: VECTOR_ENDPOINT_PROBE_TIMEOUT_MS }
    : { attempts: NETWORK_RETRIES + 1, timeoutMs: TIMEOUT_MS };
}

async function fetchWithRetry(
  url: string,
  fetchImpl: FetchLike,
  policy: { attempts: number; timeoutMs: number } = fetchPolicy({}),
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);

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

export function applySlowWarning(
  verdict: Verdict,
  detail: string,
  durationMs: number,
): { detail: string; verdict: Verdict } {
  if (verdict !== "PASS" || durationMs <= SLOW_WARNING_MS) {
    return { detail, verdict };
  }

  return { detail: `${detail} — slow (>${Math.round(SLOW_WARNING_MS / 1000)}s)`, verdict: "WARN" };
}

async function probeOne(target: Target, url: string, fetchImpl: FetchLike): Promise<ProbeResult> {
  const startedAt = Date.now();

  try {
    const response = await fetchWithRetry(url, fetchImpl, fetchPolicy(target));
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const body = await response.text();
    const judged = judge(target.expect, response.status, contentType, body);
    const durationMs = Date.now() - startedAt;
    const { verdict, detail } = applySlowWarning(judged.verdict, judged.detail, durationMs);

    return {
      className: target.className,
      detail: `${detail} · ${formatDuration(durationMs)}`,
      durationMs,
      name: target.name,
      status: response.status,
      url,
      verdict,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const reason =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "network error";

    return {
      className: target.className,
      detail: `${reason} · ${formatDuration(durationMs)}`,
      durationMs,
      name: target.name,
      status: null,
      url,
      verdict: "FAIL",
    };
  }
}

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(2)}s`;
}

async function runProbes(
  targets: { target: Target; url: string }[],
  fetchImpl: FetchLike,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const indexed = targets.map((entry, index) => ({ ...entry, index }));
  const ordinary = indexed.filter((entry) => entry.target.vectorCapable !== true);
  const vectorCapable = indexed.filter((entry) => entry.target.vectorCapable === true);

  await runPool(ordinary, results, fetchImpl, CONCURRENCY);
  await runPool(vectorCapable, results, fetchImpl, 1);

  return results;
}

async function runPool(
  entries: { index: number; target: Target; url: string }[],
  results: ProbeResult[],
  fetchImpl: FetchLike,
  concurrency: number,
): Promise<void> {
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < entries.length) {
      const entry = entries[cursor];
      cursor += 1;
      results[entry.index] = await probeOne(entry.target, entry.url, fetchImpl);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, () => worker()));
}

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

const VERDICT_ORDER: Record<Verdict, number> = { CRIT: 0, FAIL: 1, PASS: 3, SKIP: 4, WARN: 2 };

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

  const toRun: { target: Target; url: string }[] = [];
  const crossOriginSkips: ProbeResult[] = [];

  for (const target of allTargets) {
    const { url, crossOrigin } = retarget(target, baseUrl);

    if (crossOrigin) {
      crossOriginSkips.push({
        className: target.className,
        detail: "cross-origin subdomain — only probed against prod",
        durationMs: null,
        name: target.name,
        status: null,
        url: target.url,
        verdict: "SKIP",
      });

      continue;
    }

    toRun.push({ target, url });
  }

  const probed = await runProbes(toRun, fetchImpl);

  const skipResults: ProbeResult[] = remaining.map((skip) => ({
    className: skip.className,
    detail: skip.reason,
    durationMs: null,
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
    { CRIT: 0, FAIL: 0, PASS: 0, SKIP: 0, WARN: 0 },
  );
  const failed = counts.CRIT + counts.FAIL;

  if (json) {
    console.log(JSON.stringify({ baseUrl, counts, results, sampleLogId }, null, 2));
  } else {
    console.log(`\nPost-deploy probe → ${baseUrl}\n`);

    const visible = results.filter((result) => result.className !== "api-write");
    console.log(formatTable(visible));
    console.log(
      `\n  (+ ${counts.SKIP - visible.filter((r) => r.verdict === "SKIP").length} write ops catalogued, not fired)`,
    );
    console.log(
      `\nSummary: ${counts.PASS} passed · ${counts.WARN} slow · ${counts.FAIL} failed · ${counts.CRIT} critical · ${counts.SKIP} skipped · ${results.length} total`,
    );

    if (counts.WARN > 0) {
      console.log("\nSLOW (passed, but above the soft threshold):");
      for (const result of results.filter((r) => r.verdict === "WARN")) {
        console.log(`  WARN ${result.name} — ${result.detail}\n    ${result.url}`);
      }
    }

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

if (import.meta.main) {
  await main();
}

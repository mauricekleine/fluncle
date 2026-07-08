#!/usr/bin/env bun
// fetch-seo-data.ts — pull the last ~28 days of real search data for the nightly audit's
// Surfaces & SEO/AEO domain, so the auditor prioritizes from numbers instead of guessing.
//
// Two read-only sources, no third-party SDK (keeps this a single self-contained box script):
//   • Google Search Console (Search Analytics) — auth is a service-account RS256 JWT signed
//     with node crypto (no google-auth dependency), exchanged for a bearer token. Property:
//     `sc-domain:fluncle.com` (a Domain property; the SA is granted siteFullUser on it).
//   • Bing Webmaster Tools — a plain keyed GET (query + page stats).
//
// Writes a compact JSON bundle to the path in argv[2] (default `.audit/seo-data.json`) that the
// surfaces-seo prompt reads. DEGRADES GRACEFULLY: any source that fails is recorded as an error
// in the bundle and the rest still writes; the process exits 0 (a missing signal makes the
// auditor fall back to the structural checks — never invent metrics). Secrets come from the
// env the driver sources (GOOGLE_APPLICATION_CREDENTIALS → the 0600 SA-json file, or the raw
// FLUNCLE_GSC_SERVICE_ACCOUNT json; FLUNCLE_BING_WEBMASTER_API_KEY). Diagnostics → stderr.

import { createSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const GSC_SITE = process.env.AUDIT_GSC_SITE ?? "sc-domain:fluncle.com";
const BING_SITE = process.env.AUDIT_BING_SITE ?? "https://fluncle.com/";
const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOP_N = 100;

const log = (m: string) => console.error(`[fetch-seo-data] ${m}`);

// ── pure helpers (unit-tested in fetch-seo-data.test.ts) ────────────────────────────────────

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

/** The 28-day GSC window, ending 3 days back (GSC data lags ~2–3d). Dates are UTC YYYY-MM-DD. */
export function searchWindow(now: Date): { endDate: string; startDate: string } {
  const day = 86_400_000;
  const end = new Date(now.getTime() - 3 * day);
  const start = new Date(end.getTime() - 28 * day);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { endDate: iso(end), startDate: iso(start) };
}

/** base64url without padding (JWT + signature encoding). */
export function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Build a signed RS256 service-account assertion for the OAuth2 JWT-bearer flow. */
export function buildJwt(sa: ServiceAccount, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({ aud: tokenUri, exp: iat + 3600, iat, iss: sa.client_email, scope: GSC_SCOPE }),
  );
  const signingInput = `${header}.${claim}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(sa.private_key);
  return `${signingInput}.${b64url(signature)}`;
}

/** Normalize GSC searchAnalytics rows (dimension = the single grouping key) → compact records. */
export function normalizeGscRows(
  rows: Array<{
    clicks?: number;
    ctr?: number;
    impressions?: number;
    keys?: string[];
    position?: number;
  }>,
  key: string,
): Array<Record<string, number | string>> {
  return (rows ?? []).map((r) => ({
    [key]: r.keys?.[0] ?? "",
    clicks: Math.round(r.clicks ?? 0),
    ctr: Number(((r.ctr ?? 0) * 100).toFixed(2)),
    impressions: Math.round(r.impressions ?? 0),
    position: Number((r.position ?? 0).toFixed(1)),
  }));
}

/** Normalize a Bing stats array (its shape varies by endpoint) → compact {label,impressions,clicks}. */
export function normalizeBing(
  rows: Array<{ Clicks?: number; Impressions?: number; Query?: string }> | undefined,
  labelKey: "Query",
): Array<Record<string, number | string>> {
  return (rows ?? []).map((r) => ({
    clicks: Math.round(r.Clicks ?? 0),
    impressions: Math.round(r.Impressions ?? 0),
    query: r[labelKey] ?? "",
  }));
}

// ── I/O (the main tick) ─────────────────────────────────────────────────────────────────────

function loadServiceAccount(): ServiceAccount | { error: string } {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const raw = path ? safeRead(path) : process.env.FLUNCLE_GSC_SERVICE_ACCOUNT;
  if (!raw) {
    return {
      error:
        "no GSC credentials (GOOGLE_APPLICATION_CREDENTIALS file or FLUNCLE_GSC_SERVICE_ACCOUNT)",
    };
  }
  try {
    const sa = JSON.parse(raw) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) {
      return { error: "GSC json missing client_email/private_key" };
    }
    return sa;
  } catch (e) {
    return { error: `GSC json parse failed: ${(e as Error).message}` };
  }
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 20_000): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function gscToken(sa: ServiceAccount): Promise<string> {
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const assertion = buildJwt(sa, new Date());
  const body = new URLSearchParams({
    assertion,
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
  });
  const json = (await fetchJson(tokenUri, {
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  })) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("token endpoint returned no access_token");
  }
  return json.access_token;
}

async function gscQuery(
  token: string,
  window: { endDate: string; startDate: string },
  dimension: "page" | "query",
): Promise<Array<Record<string, number | string>>> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`;
  const json = (await fetchJson(url, {
    body: JSON.stringify({ ...window, dimensions: [dimension], rowLimit: TOP_N }),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    method: "POST",
  })) as {
    rows?: Array<{
      clicks?: number;
      ctr?: number;
      impressions?: number;
      keys?: string[];
      position?: number;
    }>;
  };
  return normalizeGscRows(json.rows ?? [], dimension);
}

async function bingQueryStats(apikey: string): Promise<Array<Record<string, number | string>>> {
  const url = `https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?apikey=${apikey}&siteUrl=${encodeURIComponent(BING_SITE)}`;
  const json = (await fetchJson(url, { method: "GET" })) as {
    d?: Array<{ Clicks?: number; Impressions?: number; Query?: string }>;
  };
  return normalizeBing(json.d, "Query").slice(0, TOP_N);
}

async function main() {
  const outPath = process.argv[2] ?? ".audit/seo-data.json";
  const window = searchWindow(new Date());
  const bundle: Record<string, unknown> = { fetchedAt: new Date().toISOString(), window };

  // GSC — queries + pages.
  const sa = loadServiceAccount();
  if ("error" in sa) {
    bundle.gsc = { error: sa.error };
    log(`GSC skipped: ${sa.error}`);
  } else {
    try {
      const token = await gscToken(sa);
      const [queries, pages] = await Promise.all([
        gscQuery(token, window, "query"),
        gscQuery(token, window, "page"),
      ]);
      bundle.gsc = { pages, property: GSC_SITE, queries };
      log(`GSC ok: ${queries.length} queries, ${pages.length} pages`);
    } catch (e) {
      bundle.gsc = { error: (e as Error).message };
      log(`GSC failed: ${(e as Error).message}`);
    }
  }

  // Bing — query stats.
  const bingKey = process.env.FLUNCLE_BING_WEBMASTER_API_KEY;
  if (!bingKey) {
    bundle.bing = { error: "no FLUNCLE_BING_WEBMASTER_API_KEY" };
    log("Bing skipped: no key");
  } else {
    try {
      const queries = await bingQueryStats(bingKey);
      bundle.bing = { queries, site: BING_SITE };
      log(`Bing ok: ${queries.length} query rows`);
    } catch (e) {
      bundle.bing = { error: (e as Error).message };
      log(`Bing failed: ${(e as Error).message}`);
    }
  }

  writeFileSync(outPath, JSON.stringify(bundle, null, 2));
  log(`wrote ${outPath}`);
}

if (import.meta.main) {
  main().catch((e) => {
    // A total failure still exits 0 with an error bundle — the auditor degrades to structural checks.
    log(`fatal (writing error bundle): ${(e as Error).message}`);
    try {
      writeFileSync(
        process.argv[2] ?? ".audit/seo-data.json",
        JSON.stringify({ error: (e as Error).message }),
      );
    } catch {
      /* best-effort */
    }
    process.exit(0);
  });
}

import { BROWSER_SENTRY_DSN, SENTRY_RELEASE } from "../sentry-config";

const NOSNIFF_HEADER = "X-Content-Type-Options";
const NOSNIFF_VALUE = "nosniff";

const REFERRER_POLICY_VALUE = "strict-origin-when-cross-origin";

const HSTS_VALUE = "max-age=31536000";

const FRAME_ANCESTORS = "frame-ancestors 'self'";

export const CONTENT_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-src 'none'",
  FRAME_ANCESTORS,
  "script-src 'self' 'unsafe-inline' https://scripts.simpleanalyticscdn.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https://found.fluncle.com https://radio.fluncle.com https://i.scdn.co https://coverartarchive.org https://archive.org https://*.archive.org https://lh3.googleusercontent.com https://queue.simpleanalyticscdn.com",
  "media-src 'self' https://found.fluncle.com",
  [
    "connect-src 'self'",
    "https://found.fluncle.com",
    "https://scripts.simpleanalyticscdn.com",
    "https://queue.simpleanalyticscdn.com",
    "https://cloudflareinsights.com",
    "https://*.ingest.de.sentry.io",
  ].join(" "),
].join("; ");

const CSP_REPORT_GROUP = "csp-endpoint";

export function sentryCspReportEndpoint(dsn: string, release?: string): string | undefined {
  let parsed: URL;

  try {
    parsed = new URL(dsn);
  } catch {
    return undefined;
  }

  const publicKey = parsed.username;
  const projectId = parsed.pathname.replace(/^\/+/, "");

  if (publicKey.length === 0 || projectId.length === 0) {
    return undefined;
  }

  const query = new URLSearchParams({ sentry_key: publicKey });

  if (typeof release === "string" && release.length > 0) {
    query.set("sentry_release", release);
  }

  return `${parsed.protocol}//${parsed.host}/api/${projectId}/security/?${query.toString()}`;
}

export const SENTRY_CSP_REPORT_ENDPOINT = sentryCspReportEndpoint(
  BROWSER_SENTRY_DSN,
  SENTRY_RELEASE,
);

export const CONTENT_POLICY_WITH_REPORTING = SENTRY_CSP_REPORT_ENDPOINT
  ? `${CONTENT_POLICY}; report-uri ${SENTRY_CSP_REPORT_ENDPOINT}; report-to ${CSP_REPORT_GROUP}`
  : CONTENT_POLICY;

export const REPORTING_ENDPOINTS_VALUE = SENTRY_CSP_REPORT_ENDPOINT
  ? `${CSP_REPORT_GROUP}="${SENTRY_CSP_REPORT_ENDPOINT}"`
  : undefined;

function isHtmlResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/html") ?? false;
}

function isPublicHttpsOrigin(url: URL): boolean {
  return url.protocol === "https:" && !url.hostname.endsWith(".onion");
}

function isLocalDevOrigin(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1"
  );
}

export function securityHeadersFor(request: Request, response: Response): [string, string][] {
  const headers: [string, string][] = [[NOSNIFF_HEADER, NOSNIFF_VALUE]];

  if (!isHtmlResponse(response)) {
    return headers;
  }

  headers.push(["Referrer-Policy", REFERRER_POLICY_VALUE]);

  const url = new URL(request.url);
  const isPublic = isPublicHttpsOrigin(url);

  if (isPublic) {
    headers.push(["Strict-Transport-Security", HSTS_VALUE]);
  }

  if (!response.headers.has("content-security-policy")) {
    const policyHeader = isLocalDevOrigin(url)
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy";

    if (isPublic && REPORTING_ENDPOINTS_VALUE) {
      headers.push([policyHeader, CONTENT_POLICY_WITH_REPORTING]);
      headers.push(["Reporting-Endpoints", REPORTING_ENDPOINTS_VALUE]);
    } else {
      headers.push([policyHeader, CONTENT_POLICY]);
    }
  }

  return headers;
}

export function withSecurityHeaders(request: Request, response: Response): Response {
  if (response.status === 101) {
    return response;
  }

  const headers = securityHeadersFor(request, response);

  try {
    for (const [name, value] of headers) {
      response.headers.set(name, value);
    }

    return response;
  } catch {
    const out = new Response(response.body, response);

    for (const [name, value] of headers) {
      out.headers.set(name, value);
    }

    return out;
  }
}

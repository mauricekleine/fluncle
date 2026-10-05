export const TRACE_RATE_NONE = 0;
export const TRACE_RATE_ALWAYS = 1;
export const TRACE_RATE_BASELINE = 0.2;
export const ADMIN_TRACE_RATE = 0.01;
export const BROWSER_TRACE_RATE = 0.5;

export function sentryEnvironmentForHost(hostname: string): "production" | "local" | "preview" {
  let host = hostname.trim().toLowerCase();

  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "preview";
    }
  }

  if (host === "fluncle.com" || host.endsWith(".fluncle.com") || host.endsWith(".onion")) {
    return "production";
  }

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("127.") ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0"
  ) {
    return "local";
  }

  return "preview";
}

const AUTOMATED_USER_AGENT =
  /bot|spider|crawl|slurp|externalhit|externalagent|facebookcatalog|headlesschrome|lighthouse|curl\/|wget|python-requests|python-urllib|httpx|aiohttp|go-http-client|okhttp|axios|node-fetch|undici|scrapy|ia_archiver/i;

export function isAutomatedUserAgent(userAgent: string | null | undefined): boolean {
  return !userAgent?.trim() || AUTOMATED_USER_AGENT.test(userAgent);
}

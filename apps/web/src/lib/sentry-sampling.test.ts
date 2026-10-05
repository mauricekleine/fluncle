import { describe, expect, it } from "vitest";
import { isAutomatedUserAgent, sentryEnvironmentForHost } from "./sentry-sampling";

describe("Sentry serving environments", () => {
  it.each([
    ["fluncle.com", "production"],
    ["www.fluncle.com", "production"],
    ["sub.www.fluncle.com", "production"],
    ["FLUNCLE.COM", "production"],
    ["mirror.onion", "production"],
    ["localhost", "local"],
    ["app.localhost", "local"],
    ["127.0.0.1", "local"],
    ["127.1.2.3", "local"],
    ["::1", "local"],
    ["[::1]", "local"],
    ["0.0.0.0", "local"],
    ["app.workers.dev", "preview"],
    ["fluncle.com.example.org", "preview"],
    ["notfluncle.com", "preview"],
    ["https://www.fluncle.com/track/x", "production"],
    ["http://127.0.0.1:8788/", "local"],
    ["http://[::1]:4312/", "local"],
    ["https://[malformed", "preview"],
  ])("maps %s to %s", (host, expected) => {
    expect(sentryEnvironmentForHost(host)).toBe(expected);
  });
});

describe("automated traffic", () => {
  it.each([
    undefined,
    null,
    "",
    " ",
    "spider",
    "CRAWL",
    "Slurp",
    "facebookcatalog",
    "HeadlessChrome/130",
    "Lighthouse",
    "curl/8.0",
    "Wget/1.0",
    "python-requests/2.0",
    "Python-urllib/3.0",
    "httpx/0.28",
    "aiohttp/3.0",
    "Go-http-client/1.1",
    "okhttp/4.0",
    "axios/1.0",
    "node-fetch",
    "undici",
    "Scrapy/2.0",
    "ia_archiver",
    "SentryUptimeBot",
    "Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)",
    "Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)",
    "Mozilla/5.0 (compatible; SemrushBot/7~bl; +https://www.semrush.com/bot.html)",
    "Reflectionbot",
    "PerplexityBot/1.0",
    "Applebot/0.1",
    "GPTBot/1.0",
    "SERankingBacklinksBot",
    "MJ12bot/v1.4.8",
    "KeenableBot",
    "meta-externalagent/1.1",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Baiduspider",
    "Googlebot/2.1",
    "ClaudeBot/1.0",
    "facebookexternalhit/1.1",
  ])("recognizes %s as automated", (userAgent) => {
    expect(isAutomatedUserAgent(userAgent)).toBe(true);
  });

  it.each([
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  ])("keeps ordinary browser traffic: %s", (userAgent) => {
    expect(isAutomatedUserAgent(userAgent)).toBe(false);
  });
});

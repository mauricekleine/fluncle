import * as Sentry from "@sentry/cloudflare";
import { type SamplingContext } from "@sentry/core";
import { describe, expect, it } from "vitest";
import {
  scrubLegacyReceiptCoordinate,
  scrubServerSentryEvent,
  scrubServerSentrySpan,
  scrubServerSentryTransaction,
  serverSentryIntegrations,
  serverSentryScrubHooks,
  serverTracesSampler,
  shouldCreateSpanForRequest,
} from "./sentry-options";

const HUMAN_UA = "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36";

describe("Worker trace sampling priority", () => {
  const human = { "server.address": "www.fluncle.com", "user_agent.original": HUMAN_UA };
  it.each<[string, SamplingContext, number]>([
    [
      "noise beats search and sampled parents",
      { attributes: human, name: "GET /health/search", parentSampled: true },
      0,
    ],
    [
      "local search is excluded",
      {
        attributes: { ...human, "server.address": "127.0.0.1" },
        name: "GET /search",
        parentSampled: true,
      },
      0,
    ],
    [
      "preview admin is excluded",
      {
        attributes: { ...human, "server.address": "app.workers.dev" },
        name: "GET /api/v1/admin/search",
      },
      0,
    ],
    [
      "admission has no diagnostic sample",
      { attributes: human, name: "POST /api/v1/admin/database-admission", parentSampled: true },
      0,
    ],
    [
      "admin search is a trickle",
      { attributes: human, name: "GET /api/v1/admin/search", parentSampled: true },
      0.01,
    ],
    [
      "automated admin keeps the trickle",
      {
        attributes: { ...human, "user_agent.original": "curl/8" },
        name: "GET /api/v1/admin/tracks",
        parentSampled: false,
      },
      0.01,
    ],
    [
      "bots cannot force search tracing",
      {
        attributes: { ...human, "user_agent.original": "Googlebot" },
        name: "GET /search",
        parentSampled: true,
      },
      0,
    ],
    [
      "missing UA is automated",
      { attributes: { "server.address": "fluncle.com" }, name: "GET /search" },
      0,
    ],
    [
      "sampled human parents stay connected",
      { attributes: human, name: "POST /_serverFn/x", parentSampled: true },
      1,
    ],
    [
      "unsampled human search parents stay unsampled",
      { attributes: human, name: "GET /search", parentSampled: false },
      0,
    ],
    ["recommendations have full sampling", { attributes: human, name: "GET /recommendations" }, 1],
    ["search has full sampling", { attributes: human, name: "GET /search" }, 1],
    ["frontier has full sampling", { attributes: human, name: "GET /frontier" }, 1],
    ["human public pages have baseline sampling", { attributes: human, name: "GET /track/x" }, 0.2],
    ["operator HTML has baseline sampling", { attributes: human, name: "GET /admin" }, 0.2],
    ["unknown hosts are excluded", { name: "GET /track/x" }, 0],
    [
      "full URL can supply the host",
      {
        attributes: { "url.full": "https://fluncle.com/track/x", "user_agent.original": HUMAN_UA },
        name: "GET /track/x",
      },
      0.2,
    ],
    [
      "normalized request can supply the host",
      {
        attributes: { "user_agent.original": HUMAN_UA },
        name: "GET /track/x",
        normalizedRequest: { url: "https://mirror.onion/track/x" },
      },
      0.2,
    ],
    [
      "normalized local requests are excluded",
      {
        attributes: { "user_agent.original": HUMAN_UA },
        name: "GET /search",
        normalizedRequest: { url: "http://127.0.0.1:8788/search" },
      },
      0,
    ],
  ])("%s", (_description, context, expected) => {
    expect(serverTracesSampler(context)).toBe(expected);
  });
});

describe("Worker event environments follow the request host", () => {
  it.each([
    ["http://127.0.0.1:8788/track/x", "local"],
    ["https://www.fluncle.com/track/x", "production"],
    ["https://app.workers.dev/track/x", "preview"],
  ])("labels errors and transactions from %s as %s", (url, environment) => {
    expect(
      serverSentryScrubHooks.beforeSend({
        environment: "production",
        request: { url },
        type: undefined,
      }).environment,
    ).toBe(environment);
    expect(
      serverSentryScrubHooks.beforeSendTransaction({
        environment: "production",
        request: { url },
        type: "transaction",
      }).environment,
    ).toBe(environment);
  });

  it("preserves the environment when there is no request URL", () => {
    expect(
      serverSentryScrubHooks.beforeSend({ environment: "custom", type: undefined }).environment,
    ).toBe("custom");
    expect(
      serverSentryScrubHooks.beforeSendTransaction({ environment: "custom", type: "transaction" })
        .environment,
    ).toBe("custom");
  });
});

describe("serverSentryIntegrations", () => {
  it("installs exactly one Fetch integration with the Turso exclusion", () => {
    expect(
      serverSentryIntegrations([Sentry.fetchIntegration(), Sentry.fetchIntegration()]).filter(
        (integration) => integration.name === "Fetch",
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["https://x-y.aws-eu-west-1.turso.io/v2/pipeline", false],
    ["https://api.spotify.com/v1/tracks", true],
    ["https://turso.io.example.org/v2/pipeline", true],
    ["not a URL", true],
  ])("traces %s: %s", (url, expected) => {
    expect(shouldCreateSpanForRequest(url)).toBe(expected);
  });
  it("replaces the default HTTP integration with request-body capture disabled", () => {
    const integrations = serverSentryIntegrations([
      Sentry.httpServerIntegration(),
      { name: "sentinel", setupOnce() {} },
    ]);
    const httpIntegrations = integrations.filter(
      (integration) => integration.name === "HttpServer",
    );

    expect(httpIntegrations).toHaveLength(1);
    expect(httpIntegrations[0]).toMatchObject({ maxRequestBodySize: "none" });
    expect(integrations.some((integration) => integration.name === "sentinel")).toBe(true);
  });

  it("redacts stale keyed receipt coordinates from errors and spans", () => {
    const keyedUrl =
      "https://www.fluncle.com/api/v1/admin/operation-receipts/health.snapshot%3Aprivate-key";
    const redactedPath = "/api/v1/admin/operation-receipts/{operationKey}";
    const event = scrubServerSentryEvent({
      request: { url: keyedUrl },
      transaction: `GET ${keyedUrl}`,
      type: undefined,
    });
    const span = scrubServerSentrySpan({
      data: { "url.full": keyedUrl, "url.path": new URL(keyedUrl).pathname },
      description: `GET ${keyedUrl}`,
      span_id: "1",
      start_timestamp: 1,
      trace_id: "1",
    });

    expect(event.request?.url?.endsWith(redactedPath)).toBe(true);
    expect(event.transaction?.endsWith(redactedPath)).toBe(true);
    expect(span.data["url.full"]).toBe(`https://www.fluncle.com${redactedPath}`);
    expect(span.data["url.path"]).toBe(redactedPath);
    expect(span.description).not.toContain("private-key");
  });

  it("redacts every accepted stale key and bundled transaction span", () => {
    const legacy =
      "https://www.fluncle.com/api/v1/admin/operation-receipts/health.snapshot%3Aprivate-key";
    const transaction = scrubServerSentryTransaction({
      spans: [
        {
          data: { "url.full": legacy },
          span_id: "1",
          start_timestamp: 1,
          trace_id: "1",
        },
      ],
      transaction: "GET /api/v1/admin/operation-receipts/inspect",
      type: "transaction",
    });

    for (const operationKey of ["inspect", "reconcile", "resolve"]) {
      expect(
        scrubLegacyReceiptCoordinate(
          `https://www.fluncle.com/api/v1/admin/operation-receipts/${operationKey}`,
        ),
      ).toBe("https://www.fluncle.com/api/v1/admin/operation-receipts/{operationKey}");
    }
    expect(transaction.transaction).toBe("GET /api/v1/admin/operation-receipts/{operationKey}");
    expect(transaction.spans?.[0]?.data["url.full"]).not.toContain("private-key");
  });
});

const MAGIC_TOKEN = "zzMagicLinkSecretToken0123456789";

function tokenBearingUrl(): string {
  return `https://www.fluncle.com/api/auth/magic-link/verify?token=${MAGIC_TOKEN}&callbackURL=%2Flabel%2Fx%3Ffollow%3D${MAGIC_TOKEN}`;
}

describe("auth tokens never leave the Worker in a Sentry payload", () => {
  it("scrubs the token from the request url, query string, referer, breadcrumbs and transaction", () => {
    const event = scrubServerSentryEvent({
      breadcrumbs: [
        { category: "fetch", data: { method: "GET", url: tokenBearingUrl() } },
        { category: "navigation", data: { from: `/follows?token=${MAGIC_TOKEN}`, to: "/" } },
      ],
      request: {
        headers: { referer: `https://www.fluncle.com/reset-password/${MAGIC_TOKEN}` },
        query_string: [
          ["token", MAGIC_TOKEN],
          ["callbackURL", `/account?follow=${MAGIC_TOKEN}`],
        ],
        url: tokenBearingUrl(),
      },
      transaction: `GET ${tokenBearingUrl()}`,
      type: undefined,
    });

    expect(JSON.stringify(event)).not.toContain(MAGIC_TOKEN);
    expect(event.request?.url).toBe(
      "https://www.fluncle.com/api/auth/magic-link/verify?[Filtered]",
    );
  });

  it("scrubs a string query_string too", () => {
    const event = scrubServerSentryEvent({
      request: { query_string: `token=${MAGIC_TOKEN}&unsubscribe=${MAGIC_TOKEN}` },
      type: undefined,
    });

    expect(JSON.stringify(event)).not.toContain(MAGIC_TOKEN);
  });

  it("scrubs spans and transactions", () => {
    const span = scrubServerSentrySpan({
      data: {
        "http.query": `?token=${MAGIC_TOKEN}`,
        "url.full": tokenBearingUrl(),
        "url.query": `token=${MAGIC_TOKEN}`,
      },
      description: `GET ${tokenBearingUrl()}`,
      span_id: "1",
      start_timestamp: 1,
      trace_id: "1",
    });
    const transaction = scrubServerSentryTransaction({
      request: { url: tokenBearingUrl() },
      spans: [
        {
          data: { "url.full": tokenBearingUrl() },
          description: "GET",
          span_id: "2",
          start_timestamp: 1,
          trace_id: "1",
        },
      ],
      transaction: `GET ${tokenBearingUrl()}`,
      type: "transaction",
    });

    expect(JSON.stringify(span)).not.toContain(MAGIC_TOKEN);
    expect(JSON.stringify(transaction)).not.toContain(MAGIC_TOKEN);
  });
});

describe("the Worker's Sentry hooks", () => {
  it("scrub every exported payload kind, breadcrumbs included", async () => {
    const { serverSentryScrubHooks } = await import("./sentry-options");

    expect(Object.keys(serverSentryScrubHooks).sort()).toEqual([
      "beforeBreadcrumb",
      "beforeSend",
      "beforeSendSpan",
      "beforeSendTransaction",
    ]);
    expect(
      JSON.stringify(
        serverSentryScrubHooks.beforeBreadcrumb({ data: { url: `/x?token=${MAGIC_TOKEN}` } }),
      ),
    ).not.toContain(MAGIC_TOKEN);
  });
});

describe("the Worker scrub sees through encodings", () => {
  it("scrubs encoded names and nested urls in spans and events", () => {
    const secret = "zzWorkerEncodedSecret77";
    const span = scrubServerSentrySpan({
      data: {
        "http.query": `?%74oken=${secret}`,
        "url.full": `https://www.fluncle.com/go?next=${encodeURIComponent(encodeURIComponent(`/x?token=${secret}`))}`,
      },
      description: `GET /api/auth/magic-link/verify?%2574oken=${secret}`,
      span_id: "1",
      start_timestamp: 1,
      trace_id: "1",
    });
    const event = scrubServerSentryEvent({
      request: {
        query_string: `%74oken=${secret}`,
        url: `https://www.fluncle.com/follows?t=${secret}`,
      },
      type: undefined,
    });

    expect(JSON.stringify(span)).not.toContain(secret);
    expect(JSON.stringify(event)).not.toContain(secret);
  });
});

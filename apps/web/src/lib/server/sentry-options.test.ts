import * as Sentry from "@sentry/cloudflare";
import { describe, expect, it } from "vitest";
import {
  scrubLegacyReceiptCoordinate,
  scrubServerSentryEvent,
  scrubServerSentrySpan,
  scrubServerSentryTransaction,
  serverSentryIntegrations,
} from "./sentry-options";

describe("serverSentryIntegrations", () => {
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

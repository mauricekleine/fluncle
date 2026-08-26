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

  it("redacts initialization-era receipt keys from errors and spans", () => {
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

  it("redacts every accepted legacy key and bundled transaction span", () => {
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

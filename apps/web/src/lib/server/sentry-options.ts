import * as Sentry from "@sentry/cloudflare";
import {
  type ErrorEvent,
  type Integration,
  type SpanJSON,
  type TransactionEvent,
} from "@sentry/core";

const LEGACY_RECEIPT_KEY_IN_URL = /(\/api\/v1\/admin\/operation-receipts\/)[^/?#\s]+/g;

export function scrubLegacyReceiptCoordinate(value: string): string {
  return value.replace(LEGACY_RECEIPT_KEY_IN_URL, "$1{operationKey}");
}

function scrubEventCoordinates<T extends { request?: { url?: string }; transaction?: string }>(
  event: T,
): T {
  if (typeof event.request?.url === "string") {
    event.request.url = scrubLegacyReceiptCoordinate(event.request.url);
  }
  if (typeof event.transaction === "string") {
    event.transaction = scrubLegacyReceiptCoordinate(event.transaction);
  }

  return event;
}

export function scrubServerSentryEvent(event: ErrorEvent): ErrorEvent {
  return scrubEventCoordinates(event);
}

export function scrubServerSentrySpan(span: SpanJSON): SpanJSON {
  if (typeof span.description === "string") {
    span.description = scrubLegacyReceiptCoordinate(span.description);
  }
  for (const attribute of ["url.full", "url.path", "http.route"] as const) {
    const value = span.data[attribute];
    if (typeof value === "string") {
      span.data[attribute] = scrubLegacyReceiptCoordinate(value);
    }
  }

  return span;
}

export function scrubServerSentryTransaction(event: TransactionEvent): TransactionEvent {
  scrubEventCoordinates(event);
  event.spans = event.spans?.map(scrubServerSentrySpan);

  return event;
}

export function serverSentryIntegrations(defaultIntegrations: Integration[]): Integration[] {
  const metadataOnlyHttp = Sentry.httpServerIntegration({ maxRequestBodySize: "none" });

  return [
    ...defaultIntegrations.filter((integration) => integration.name !== metadataOnlyHttp.name),
    metadataOnlyHttp,
  ];
}

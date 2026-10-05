import * as Sentry from "@sentry/cloudflare";
import {
  type ErrorEvent,
  type Integration,
  type SpanJSON,
  type SamplingContext,
  type TransactionEvent,
} from "@sentry/core";
import {
  ADMIN_TRACE_RATE,
  isAutomatedUserAgent,
  sentryEnvironmentForHost,
  TRACE_RATE_ALWAYS,
  TRACE_RATE_BASELINE,
  TRACE_RATE_NONE,
} from "../sentry-sampling";
import { scrubSensitiveValue } from "../sentry-scrub";

const HIGH_VALUE_TRACE_MATCHERS = ["recommend", "search", "frontier"];
const NOISE_TRACE_MATCHERS = [
  "/status",
  "/health",
  "/robots",
  "/sitemap",
  "/llms.txt",
  "/.well-known",
  "/og/",
  "/mixtape-cover",
  "/preview/",
  "/favicon",
  "/assets/",
  "/cdn-cgi",
];

export function serverTracesSampler(context: SamplingContext): number {
  const name = context.name.toLowerCase();
  if (NOISE_TRACE_MATCHERS.some((matcher) => name.includes(matcher))) {
    return TRACE_RATE_NONE;
  }

  const host =
    context.attributes?.["server.address"] ??
    context.attributes?.["url.full"] ??
    context.normalizedRequest?.url;
  if (typeof host !== "string" || sentryEnvironmentForHost(host) !== "production") {
    return TRACE_RATE_NONE;
  }
  if (name.includes("/api/v1/admin/database-admission")) {
    return TRACE_RATE_NONE;
  }
  if (name.includes("/api/v1/admin/")) {
    return ADMIN_TRACE_RATE;
  }
  const userAgent = context.attributes?.["user_agent.original"];
  if (isAutomatedUserAgent(typeof userAgent === "string" ? userAgent : undefined)) {
    return TRACE_RATE_NONE;
  }
  if (typeof context.parentSampled === "boolean") {
    return context.parentSampled ? TRACE_RATE_ALWAYS : TRACE_RATE_NONE;
  }
  if (HIGH_VALUE_TRACE_MATCHERS.some((matcher) => name.includes(matcher))) {
    return TRACE_RATE_ALWAYS;
  }
  return TRACE_RATE_BASELINE;
}

export function shouldCreateSpanForRequest(url: string): boolean {
  try {
    return !new URL(url).hostname.endsWith(".turso.io");
  } catch {
    return true;
  }
}

const LEGACY_RECEIPT_KEY_IN_URL = /(\/api\/v1\/admin\/operation-receipts\/)[^/?#\s]+/g;

export function scrubLegacyReceiptCoordinate(value: string): string {
  return value.replace(LEGACY_RECEIPT_KEY_IN_URL, "$1{operationKey}");
}

function scrubEventCoordinates<
  T extends { environment?: string; request?: { url?: string }; transaction?: string },
>(event: T): T {
  if (typeof event.request?.url === "string") {
    event.environment = sentryEnvironmentForHost(event.request.url);
    event.request.url = scrubLegacyReceiptCoordinate(event.request.url);
  }
  if (typeof event.transaction === "string") {
    event.transaction = scrubLegacyReceiptCoordinate(event.transaction);
  }

  return event;
}

export function scrubServerSentryEvent(event: ErrorEvent): ErrorEvent {
  return scrubSensitiveValue(scrubEventCoordinates(event));
}

export function scrubServerSentryBreadcrumb<T>(breadcrumb: T): T {
  return scrubSensitiveValue(breadcrumb);
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

  return scrubSensitiveValue(span);
}

export function scrubServerSentryTransaction(event: TransactionEvent): TransactionEvent {
  scrubEventCoordinates(event);
  event.spans = event.spans?.map(scrubServerSentrySpan);

  return scrubSensitiveValue(event);
}

export function serverSentryIntegrations(defaultIntegrations: Integration[]): Integration[] {
  const metadataOnlyHttp = Sentry.httpServerIntegration({ maxRequestBodySize: "none" });
  const fetch = Sentry.fetchIntegration({ shouldCreateSpanForRequest });

  return [
    ...defaultIntegrations.filter(
      (integration) =>
        integration.name !== metadataOnlyHttp.name && integration.name !== fetch.name,
    ),
    fetch,
    metadataOnlyHttp,
  ];
}

export const serverSentryScrubHooks = {
  beforeBreadcrumb: scrubServerSentryBreadcrumb,
  beforeSend: scrubServerSentryEvent,
  beforeSendSpan: scrubServerSentrySpan,
  beforeSendTransaction: scrubServerSentryTransaction,
};

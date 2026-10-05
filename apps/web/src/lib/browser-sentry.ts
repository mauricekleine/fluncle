import { type StartSpanOptions } from "@sentry/core";
import { getRouterInstance } from "@tanstack/react-start";
import { BROWSER_SENTRY_DSN, SENTRY_RELEASE, SENTRY_TUNNEL_PATH } from "./sentry-config";
import {
  BROWSER_TRACE_RATE,
  isAutomatedUserAgent,
  sentryEnvironmentForHost,
  TRACE_RATE_NONE,
} from "./sentry-sampling";
import { browserSentryScrubHooks } from "./sentry-scrub";

export function browserTracesSampler(hostname: string, userAgent: string): number {
  return sentryEnvironmentForHost(hostname) === "production" && !isAutomatedUserAgent(userAgent)
    ? BROWSER_TRACE_RATE
    : TRACE_RATE_NONE;
}

export function browserSpanStart(options: StartSpanOptions, timeOrigin: number): StartSpanOptions {
  return options.op === "pageload" ? { ...options, startTime: timeOrigin / 1000 } : options;
}

export function bufferBrowserErrors(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
) {
  const errors: { error: unknown; mechanism: { handled: false; type: string } }[] = [];
  const buffer = (error: unknown, type: string) => {
    if (errors.length === 20) {
      errors.shift();
    }
    errors.push({ error, mechanism: { handled: false, type } });
  };
  const onError = (event: ErrorEvent) =>
    buffer(event.error ?? event.message, "auto.browser.global_handlers.onerror");
  const onRejection = (event: PromiseRejectionEvent) =>
    buffer(event.reason, "auto.browser.global_handlers.onunhandledrejection");
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);

  return (
    capture: (error: unknown, hint: { mechanism: { handled: false; type: string } }) => void,
  ) => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    for (const { error, mechanism } of errors.splice(0)) {
      capture(error, { mechanism });
    }
  };
}

let flushEarlyErrors: ReturnType<typeof bufferBrowserErrors> | undefined;
let shouldDropError: () => boolean = () => false;
let sentryPromise:
  | Promise<ReturnType<typeof import("./browser-sentry-sdk").initBrowserSentry>>
  | undefined;

async function loadBrowserSentry() {
  sentryPromise ??= (async () => {
    const { initBrowserSentry } = await import("./browser-sentry-sdk");
    const router = await getRouterInstance();
    const tracingOptions = {
      beforeStartSpan: (options: StartSpanOptions) =>
        browserSpanStart(options, performance.timeOrigin),
    };
    const capture = initBrowserSentry(
      {
        ...browserSentryScrubHooks,
        beforeSend: (event) =>
          shouldDropError() ? null : browserSentryScrubHooks.beforeSend(event),
        dsn: BROWSER_SENTRY_DSN,
        environment: sentryEnvironmentForHost(window.location.hostname),
        release: SENTRY_RELEASE,
        sendDefaultPii: false,
        tracesSampler: () => browserTracesSampler(window.location.hostname, navigator.userAgent),
        tunnel: SENTRY_TUNNEL_PATH,
      },
      router,
      tracingOptions,
    );
    flushEarlyErrors?.(capture);
    flushEarlyErrors = undefined;
    return capture;
  })().catch((error: unknown) => {
    sentryPromise = undefined;
    throw error;
  });
  return sentryPromise;
}

export function startBrowserSentry(options: { shouldDropError?: () => boolean } = {}): void {
  if (!import.meta.env.PROD || flushEarlyErrors || sentryPromise) {
    return;
  }
  if (options.shouldDropError) {
    shouldDropError = options.shouldDropError;
  }
  flushEarlyErrors = bufferBrowserErrors(window);
  const load = () => {
    void loadBrowserSentry().catch(() => undefined);
  };
  const whenIdle = () => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(load, { timeout: 2000 });
      return;
    }
    window.setTimeout(load, 0);
  };
  if (document.readyState === "complete") {
    whenIdle();
    return;
  }
  window.addEventListener("load", whenIdle, { once: true });
}

export function captureBrowserException(error: unknown): void {
  if (import.meta.env.PROD) {
    void loadBrowserSentry()
      .then((capture) => capture(error))
      .catch(() => undefined);
  }
}

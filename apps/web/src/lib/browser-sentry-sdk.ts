import {
  browserTracingIntegration,
  captureException,
  init,
  tanstackRouterBrowserTracingIntegration,
} from "@sentry/tanstackstart-react";
import { type RegisteredRouter } from "@tanstack/react-router";
import { createClientOnlyFn } from "@tanstack/react-start";

export const initBrowserSentry = createClientOnlyFn(
  (
    options: Parameters<typeof init>[0],
    router: RegisteredRouter | undefined,
    tracingOptions: Parameters<typeof browserTracingIntegration>[0],
  ): typeof captureException => {
    init({
      ...options,
      integrations: [
        router
          ? tanstackRouterBrowserTracingIntegration(router, tracingOptions)
          : browserTracingIntegration(tracingOptions),
      ],
    });
    return captureException;
  },
);

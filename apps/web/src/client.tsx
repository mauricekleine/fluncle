import * as Sentry from "@sentry/tanstackstart-react";
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { config as configureZod } from "zod";
import { createChunkReloadGuard } from "./lib/chunk-reload";
import { BROWSER_SENTRY_DSN, SENTRY_RELEASE } from "./lib/sentry-config";
import { browserSentryScrubHooks } from "./lib/sentry-scrub";

configureZod({ jitless: true });

const chunkReloadGuard = createChunkReloadGuard({
  location: window.location,
  now: Date.now,
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  get storage() {
    return window.sessionStorage;
  },
});

if (import.meta.env.PROD) {
  Sentry.init({
    ...browserSentryScrubHooks,
    beforeSend: (event) =>
      chunkReloadGuard.isReloading() ? null : browserSentryScrubHooks.beforeSend(event),
    dsn: BROWSER_SENTRY_DSN,
    release: SENTRY_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
}

window.addEventListener("vite:preloadError", chunkReloadGuard.handlePreloadError);

hydrateRoot(
  document,
  <StrictMode>
    <StartClient />
  </StrictMode>,
);

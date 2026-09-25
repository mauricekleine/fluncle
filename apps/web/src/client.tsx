import * as Sentry from "@sentry/tanstackstart-react";
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { config as configureZod } from "zod";
import { BROWSER_SENTRY_DSN, SENTRY_RELEASE } from "./lib/sentry-config";
import { browserSentryScrubHooks } from "./lib/sentry-scrub";

configureZod({ jitless: true });

if (import.meta.env.PROD) {
  Sentry.init({
    ...browserSentryScrubHooks,
    dsn: BROWSER_SENTRY_DSN,
    release: SENTRY_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
}

window.addEventListener("vite:preloadError", (event) => {
  const guard = "fluncle-chunk-reload";

  if (sessionStorage.getItem(guard) === window.location.href) {
    return;
  }

  sessionStorage.setItem(guard, window.location.href);
  event.preventDefault();
  window.location.reload();
});

hydrateRoot(
  document,
  <StrictMode>
    <StartClient />
  </StrictMode>,
);

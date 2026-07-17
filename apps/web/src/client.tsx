import * as Sentry from "@sentry/tanstackstart-react";
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { BROWSER_SENTRY_DSN, SENTRY_RELEASE } from "./lib/sentry-config";

// Browser error tracking. init() installs the global `error` +
// `unhandledrejection` handlers, so unhandled client exceptions are captured
// with stacks. Errors only, free-tier posture (ratified): no tracing, no session
// replay, no PII. Production builds only — `import.meta.env.PROD` is `false`
// under vite dev, so a dev session sends nothing.
if (import.meta.env.PROD) {
  Sentry.init({
    dsn: BROWSER_SENTRY_DSN,
    release: SENTRY_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
}

hydrateRoot(
  document,
  <StrictMode>
    <StartClient />
  </StrictMode>,
);

import * as Sentry from "@sentry/tanstackstart-react";
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { config as configureZod } from "zod";
import { BROWSER_SENTRY_DSN, SENTRY_RELEASE } from "./lib/sentry-config";

// Zod's JIT probe, turned off ON THE CLIENT ONLY — a CSP fix, not a perf choice.
//
// Zod 4 compiles a fastpath for object parsing with `new Function`, and decides
// whether it may by PROBING: `try { new Function("") } catch { … }`. The throw is
// swallowed, so nothing breaks under our policy — but the browser still fires a
// `securitypolicyviolation` on the attempt, and our report-only CSP dutifully posts
// it. That is FLUNCLE-WEB-7: 124 reports of `blocked-uri: eval` traced to zod inside
// the vendor chunk the homepage already loads. It is a false positive with a real
// cost — the issue had to be archived forever to keep the feed readable, which blinds
// us to any FUTURE eval violation, the kind an actual injection would raise.
//
// `jitless` short-circuits the probe before the `new Function` (zod's own source
// names strict CSPs as the reason the flag exists), so the report stops at the source
// instead of being silenced downstream. The cost is the object fastpath on client-side
// parses only — UI-scale payloads, where it is not measurable. The SERVER keeps its
// JIT: this runs in the browser entry, and `globalConfig` is per-instance.
//
// Placed above `Sentry.init` deliberately: `allowsEval` is cached on first read, so
// this has to land before the first parse of any object schema.
configureZod({ jitless: true });

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

// Deploy-skew self-heal. A tab left open across a deploy holds HTML that
// references the OLD build's hashed chunks; a later lazy navigation then 404s
// A stale tab can hit this after a deploy; Vite
// fires `vite:preloadError` for exactly this, so reload once to pick up the
// fresh build instead of surfacing a broken page. The sessionStorage guard
// keeps a genuinely-missing chunk (or an offline client) from reload-looping:
// one attempt per page, then the error propagates to Sentry as usual.
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

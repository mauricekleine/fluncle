# Error tracking

Fluncle's web app (`apps/web`) reports unexpected errors to **Sentry** for private diagnostics — the stack traces and context an operator needs to fix a break, visible only to the operator. This is deliberately separate from the **public liveness** surface: the `/status` + `/health` stack (and the on-box `record_health` layer described in [docs/agents/hermes-agent.md](./agents/hermes-agent.md)) answers "is Fluncle up?" for anyone; Sentry answers "what exactly threw, and where?" for the operator. The two never overlap — the health stack is untouched by this wiring, and Sentry never renders on a public surface.

## The posture: errors + sampled DB-query tracing

Sentry captures **errors and stacks**, and — since the operator-approved raise onto the paid **Team plan** (5M spans/mo) — **sampled performance tracing focused on database queries**. Still no session replay, no profiling, and `sendDefaultPii: false`. Raise this bar further only by an explicit decision, not by accident.

### What tracing captures

The Worker's `Sentry.withSentry` (`apps/web/src/server.ts`) opens a request transaction; under it, the `getDb()` chokepoint in `apps/web/src/lib/server/db.ts` wraps the created libSQL client in a **Proxy** that runs every `.execute()` and `.batch()` inside a Sentry span — `op: db.query`, `name`/`db.statement` = the SQL string (libSQL already parameterizes to `?`, so the name is the normalized/grouped query, truncated to ~200 chars; `batch` is named `db.batch (<count>)`). One chokepoint means every caller — the raw client and Drizzle alike — is covered without touching call sites. Those spans feed the **Queries insight** and the auto **"Slow DB Queries"** detector (op `db*`, SELECT, ≥500ms). The load-bearing target is the **recommendation vector scan**, which the Frontier bench showed hitting a multi-second wall as the catalogue grows — this measures it in prod rather than guessing.

The same chokepoint carries a **transient-gateway retry**, because Turso is reached over HTTP and its gateway occasionally answers a bare 5xx that has nothing to do with the query — one such 502 took a crawler's `/artist/<slug>` render to the root error boundary, and the libSQL HTTP transport has no retry of its own. The safety contract is asymmetric on purpose: **reads retry, writes never do.** A 5xx on a write is ambiguous — it may already have applied — so only `execute` retries, and only for a statement classified as a read (`select …`, or `with …` carrying no write verb, since SQLite allows `WITH … INSERT/UPDATE/DELETE`); anything else, `batch` (one unit, may contain writes), and `transaction` run exactly once as before. When the classifier is unsure it declines, because a false negative is just today's behaviour while a false positive can double-apply a write. Retryable statuses are **502 / 503 / 504** only: 4xx is our own fault and would fail identically, and **524 is excluded deliberately** — the gateway already timed out on that query, so re-running it doubles the load for a near-certain second failure. Up to 2 retries (3 attempts) with a short jittered backoff, run **inside** the existing span so one logical query stays one span, with `db.retry.attempts` recorded when a retry actually happened.

The span import (`startSpan`) comes from **`@sentry/core`** (env-agnostic), NOT `@sentry/cloudflare` (Worker-oriented), because `db.ts` is also imported by bun scripts that run in Node and by tests. When no Sentry client is active — every one of those Node importers, and any dev/test run — `startSpan` is a safe passthrough that just runs the callback and returns its value, so the wrap is invisible and results are unchanged there.

### The sampler policy

Tracing is sampled by a `tracesSampler` keyed on the transaction name (method + path, e.g. `GET /me/recommendations`), with named rate constants:

- **1.0 (`TRACE_RATE_ALWAYS`)** for the scaling-risk surfaces — any name matching `recommend`, `search`, or `frontier` (the recs / vector-scan paths). These are traced on every request so a slow scan is never missed.
- **0 (`TRACE_RATE_NONE`)** for pure noise with no query value — health/status probes, robots/sitemap/llms.txt/.well-known, and the OG + cover image + static-asset routes.
- **0.2 (`TRACE_RATE_BASELINE`)** for everything else — a modest low-traffic baseline.

The name substring is deliberately coarse: server-fn endpoints share a generic transaction name, so this can't perfectly route-match those, but it reliably traces the risk paths and drops the noise. These are the **low-traffic starting settings** — as volume grows toward the 5M-spans/mo budget, lower the baseline first and refine the route lists rather than widening them; keep an eye on the span quota.

### Cost posture and the pending alert

The Team plan's 5M spans/mo is the budget the sampler is tuned against. The **p95 slow-load alert** (fire when a route's p95 crosses a threshold) is configured **operator-side in Sentry** once spans are flowing — it is a deferred dashboard step, not code.

## What is covered today

**Browser** — `apps/web/src/client.tsx` initializes the SDK (`@sentry/tanstackstart-react`) before hydration, which installs the global `error` and `unhandledrejection` handlers, so an unhandled client exception is captured with its stack.

**The root error boundary** — `apps/web/src/components/root-error-state.tsx` is the root route's `errorComponent` (sibling of `NotFoundBlackHole`, the `notFoundComponent`). A custom error boundary is **not** auto-captured by the router, so it reports the caught error itself via `captureException`. It renders a quiet, canon-styled "rough re-entry" state with a way back — never raw error detail on a public surface.

**The Worker** — `apps/web/src/server.ts` wraps the entire custom server entry with `Sentry.withSentry` (`@sentry/cloudflare`, the Cloudflare-native path). The wrap sits over the whole `fetch`, so an unhandled throw from **either** path — `handleOrpc` (mounted first) or the TanStack router beneath it — is captured with a stack.

**Unexpected API faults** — `apiFault` in `apps/web/src/lib/server/orpc/_shared.ts` already logs an unexpected (non-`ApiError`) 500 to the server log; it now also `captureException`s it, tagged `source: orpc.apiFault`, so those 500s land in Sentry as one filterable group. The existing log line and the generic wire body are unchanged.

Both SDKs initialize **only in a production build** (`import.meta.env.PROD`, statically `false` under `vite dev` / `bun run dev` / the smoke routine, `true` in the deployed Worker bundle). A dev session sends nothing, and when the DSN is absent the SDK is inert.

## CSP violation reports — the report sink

Sentry is also the sink for **Content-Security-Policy violation reports**, which land in its own **Security** feed (Sentry ingests them at a per-project Security Header endpoint, so this needs no route, no storage, and no rate-limiting of ours).

`apps/web/src/lib/server/security-headers.ts` derives that endpoint from the committed **browser** DSN rather than pasting it — a DSN is `https://<publicKey>@<host>/<projectId>` and the endpoint is `https://<host>/api/<projectId>/security/?sentry_key=<publicKey>`, the same three parts rearranged, so the sink can never drift from the DSN the SDK reports to. It carries `sentry_release` too, so a violation is attributed to the build that introduced it. The browser project is the right home: a CSP violation is something a **visitor's browser** observed, and it belongs beside the client-side errors it correlates with. A DSN that fails to parse degrades to **no reporting** — never a `report-uri undefined`.

Three headers carry it, all on HTML documents only:

- `Content-Security-Policy-Report-Only: …; report-uri <endpoint>; report-to csp-endpoint` — both directives, as Sentry documents. `report-uri` is deprecated-but-universal and is the compatibility floor (Firefox and Safari still have nothing else); `report-to` is the Reporting-API successor, which a browser that honours it prefers, ignoring `report-uri`. The legacy `Report-To` JSON header (Reporting API v0) is deliberately not sent — `Reporting-Endpoints` supersedes it, and `report-uri` covers the engines that shipped neither.
- `Reporting-Endpoints: csp-endpoint="<endpoint>"` — gives that group its URL. Only `csp-endpoint` is declared and no `default`, so nothing else (deprecation, intervention, crash reports) is routed to Sentry.
- The **enforcing** `Content-Security-Policy` header stays reporting-free. It carries `frame-ancestors 'self'` and nothing else; a framing block is a deliberate, already-understood outcome, and routing it here would mix enforced blocks into the feed the report-only rollout is read from.

**Where the sink is withheld.** Only a public `https://` origin gets it. Local dev (`http://localhost:3000`) and the `.onion` mirror get the identical policy **directives** with no `report-uri`, no `report-to`, and no `Reporting-Endpoints` — a dev session or a headless browser smoke must not write into the production Security feed in exactly the window it is being watched, and a Tor visitor's browser must never be handed an instruction to POST to sentry.io.

**Expected volume, and why the operator watches before flipping.** Every visitor's browser reports, and a report-only policy reports on things that are not attacks: a browser extension injecting a script or stylesheet into the page is the single largest source, and `script-src`'s `'unsafe-inline'` does not cover an extension's `src=`. Expect the feed to be extension noise plus a long tail of ISP/proxy injection. Sentry groups by directive + blocked URI, so the noise collapses into a handful of issues rather than a flood, and its inbound filters can drop the browser-extension class outright if it gets loud. **Graduating the report-only policy to enforcing is an operator decision made from this feed** — watch it across a real traffic window, confirm no legitimate first-party subresource appears, then flip. No evidence, no flip.

## What is pending

The **mobile app** (`apps/mobile`) is not wired here; it rides its own 1.1 build. The **on-box agent sweeps** (rave-02 systemd timers) do not report to Sentry — their failure path is the systemd/Discord operator channel, not this one. Both are deliberate: this slice is the web app's browser + Worker surface.

## Source maps and the release

Every event is stamped with a **release** = the build commit SHA (`WORKERS_CI_COMMIT_SHA` on Cloudflare Workers Builds, falling back to `git rev-parse HEAD` locally), injected at build time by `vite.config.ts` and read in `apps/web/src/lib/sentry-config.ts`. Source maps are uploaded by `@sentry/vite-plugin` **only when `SENTRY_AUTH_TOKEN` is present** in the build env: it emits hidden maps, uploads them for that release, then deletes the `.map` files so nothing ships in the served assets. Without the token — local dev, the `deploy:gate`, a contributor build — no maps are generated at all and the build is unchanged. Any upload failure (wrong slug, revoked token) is downgraded to a warning and **never fails the deploy**.

The build produces **two bundles** — the browser client (`dist/client`) and the Cloudflare Worker (`dist/server`) — whose runtime errors go to two **separate** Sentry projects (browser → `fluncle-web`, Worker → `fluncle-worker`). Because Sentry resolves source maps **per-project**, the config runs **two plugin instances**, one per bundle, each scoped by `sourcemaps.assets` to its own output directory and uploading to its own project — otherwise Worker events would resolve against the browser project and stay minified. The `filesToDeleteAfterUpload` glob is scoped to the **same subtree** on each instance (`dist/client/**/*.map` / `dist/server/**/*.map`): the delete globs run independently, so scoping keeps one instance from deleting the other's maps before that other has uploaded them, while their union still covers every emitted map so a tokened build ships **zero** `.map`. Both instances share the same release and the same warn-never-fail `errorHandler`, and both exist only under the single `SENTRY_AUTH_TOKEN` gate.

## Credentials

The two **DSNs** (browser + Worker) are committed in `apps/web/src/lib/sentry-config.ts` and allowlisted in `.gitleaks.toml`. A DSN is a **public ingestion identifier** — like the R2 account id in `wrangler.jsonc`, it names where events go but grants nothing on its own (ingestion is one-way; it cannot read issues). The **`SENTRY_AUTH_TOKEN`** — which can read and write the project — lives only in the **operator vault** and never in this repo.

## The one operator requirement

For **readable stacks** on a production deploy, `SENTRY_AUTH_TOKEN` must be set in the **Cloudflare Workers Build env** (org `fluncle`, projects `fluncle-web` for the browser bundle and `fluncle-worker` for the Worker bundle — org overridable via `SENTRY_ORG`, the two projects via `SENTRY_PROJECT` / `SENTRY_PROJECT_WORKER`). The one token grants both uploads. Without it the app still reports errors — they just carry minified frames instead of original source. Nothing else is required; the DSNs and release wiring are in the repo.

## Nightly triage — the read side

Reporting is only half the loop: the errors above are read back and acted on by a nightly **`fluncle-sentry-triage`** box cron (03:30 Amsterdam, on rave-02) — its own timer, deliberately outside the codebase-audit rotation, so Sentry is looked at every night. Each run reconciles yesterday's merged fixes (resolving their Sentry issues), pulls the day's unresolved issues from both projects (`fluncle-web`, `fluncle-worker`), and runs one agentic `claude -p` session that **opens a fix PR for each straightforward issue** and files the rest to `docs/sentry-backlog.md` for a human. It resolves an issue in Sentry only when that issue's fix PR actually merges to `main` — never a blanket sweep.

Same hybrid shape as the nightly audit: the deterministic half (`docs/agents/hermes/scripts/sentry-triage-sweep.ts`) owns every Sentry API call, so the Sentry token never enters the claude process. The architecture, the stateless PR-body markers, the opt-in auto-merge posture, the secrets, and the one-time operator activation live in [`docs/agents/hermes/sentry-triage-timer/README.md`](./agents/hermes/sentry-triage-timer/README.md); the filed ledger is [`docs/sentry-backlog.md`](./sentry-backlog.md). This is a distinct token from `SENTRY_AUTH_TOKEN` above — triage needs an internal-integration token with `event:read` + `event:write` (org auth tokens can't read issues); the source-map upload above needs only release-write.

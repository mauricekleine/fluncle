# Error tracking

Fluncle's web app (`apps/web`) reports unexpected errors to **Sentry** for private diagnostics — the stack traces and context an operator needs to fix a break, visible only to the operator. This is deliberately separate from the **public liveness** surface: the `/status` + `/health` stack (and the on-box `record_health` layer described in [docs/agents/hermes-agent.md](./agents/hermes-agent.md)) answers "is Fluncle up?" for anyone; Sentry answers "what exactly threw, and where?" for the operator. The two never overlap — the health stack is untouched by this wiring, and Sentry never renders on a public surface.

## The posture: errors + sampled DB-query tracing

Sentry runs on the Team plan with a 5M-spans/month budget. Capture errors and sampled DB-query tracing; keep session replay and profiling disabled, with `sendDefaultPii: false`. The Worker also replaces Sentry's default HTTP integration with `maxRequestBodySize: "none"`, because that integration otherwise captures JSON request bodies independently of the PII switch; raw request bodies therefore never enter error events or spans. The initialization-era keyed operation-receipt inspection route remains available for compatibility until its contraction phase, so `beforeSend`, `beforeSendTransaction`, and `beforeSendSpan` replace that path segment with `{operationKey}` before telemetry leaves the Worker.

### What tracing captures

Database spans cover the recommendation vector scan and other scaling-sensitive queries. The libSQL wrapper retries transient HTTP gateway failures for read-only statements. Treat 4xx responses as non-retryable.

Every completed `execute` and `batch` span keeps `op=db.query` and carries the same bounded performance vocabulary used by the fleet run ledger: `fluncle.operation_id`, `fluncle.access_class`, `fluncle.release`, `fluncle.attempt_count`, `fluncle.batch_count`, `fluncle.duration_ms`, and the closed `fluncle.outcome` verdict. A caller may attach a validated stable operation ID and may elevate a proven read to `heavy-read`; otherwise the wrapper derives a deterministic bounded fallback from a literal-redacted statement shape. The SQL text is never a span name or description. `db.statement` contains only the access verb and operation ID, and no SQL argument, interpolated literal, URL, hostname, secret, or row identity enters an attribute.

Recurring-work admission uses the same privacy posture outside query spans. `database.admission` records only bounded registry/run coordinates and protocol facts: contender, owner/run, operation id, physical access class, heavy-reader consumption, queue age, wait, hold, yield reason, recovery, enforcement mode, and outcome. It never records SQL, arguments, credentials, topology, response bodies, or work-row identities; the unit runner mirrors that vocabulary to journald while the separate fleet ledger remains the payload-result authority.

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

`apiFault` logs unexpected non-`ApiError` 500s and calls `captureException` with `source: orpc.apiFault`, while returning the generic wire response.

Both SDKs initialize **only in a production build** (`import.meta.env.PROD`, statically `false` under `vite dev` / `bun run dev` / the smoke routine, `true` in the deployed Worker bundle). A dev session sends nothing, and when the DSN is absent the SDK is inert.

## CSP violation reports — the report sink

Sentry is also the sink for **Content-Security-Policy violation reports**, which land in its own **Security** feed (Sentry ingests them at a per-project Security Header endpoint, so this needs no route, no storage, and no rate-limiting of ours).

`apps/web/src/lib/server/security-headers.ts` derives that endpoint from the committed **browser** DSN rather than pasting it — a DSN is `https://<publicKey>@<host>/<projectId>` and the endpoint is `https://<host>/api/<projectId>/security/?sentry_key=<publicKey>`, the same three parts rearranged, so the sink can never drift from the DSN the SDK reports to. It carries `sentry_release` too, so a violation is attributed to the build that introduced it. The browser project is the right home: a CSP violation is something a **visitor's browser** observed, and it belongs beside the client-side errors it correlates with. A DSN that fails to parse degrades to **no reporting** — never a `report-uri undefined`.

Two headers carry it, both on HTML documents only:

- `Content-Security-Policy: …; report-uri <endpoint>; report-to csp-endpoint` — both directives, as Sentry documents. `report-uri` is deprecated-but-universal and is the compatibility floor (Firefox and Safari still have nothing else); `report-to` is the Reporting-API successor, which a browser that honours it prefers, ignoring `report-uri`. The legacy `Report-To` JSON header (Reporting API v0) is deliberately not sent — `Reporting-Endpoints` supersedes it, and `report-uri` covers the engines that shipped neither.
- `Reporting-Endpoints: csp-endpoint="<endpoint>"` — gives that group its URL. Only `csp-endpoint` is declared and no `default`, so nothing else (deprecation, intervention, crash reports) is routed to Sentry.

**The policy is ENFORCED as of 2026-08-02**, and reporting moved onto the enforcing header with it — the inverse of the rollout-era rule, deliberately. While the policy was advisory, reporting was withheld from the enforced header so that deliberate framing blocks could not pollute the feed being read to decide the flip. Now the full policy is what blocks, and there is **no runtime kill switch**: `securityHeadersFor` is sync and pure because it runs on every response including edge-cache hits, so a settings or env lookup there would put an await on the hot path. Rollback is revert-and-deploy (~10 min), which makes these reports the only signal that a rollback is needed. A report here is now a real block reaching a real visitor — read it as an incident, not as telemetry.

**Where the sink is withheld, and where enforcement still applies — two different lines.** The sink goes only to a public `https://` origin: local dev and the `.onion` mirror get no `report-uri`, no `report-to`, no `Reporting-Endpoints`, because a dev session must not write into the production feed and a Tor visitor must never be handed an instruction to POST to sentry.io. **Enforcement** is withheld from local dev ONLY. The mirror serves byte-identical markup, so it is enforced silently rather than given the weaker posture; local dev stays report-only because vite binds `127.0.0.1` while most people browse `localhost`, and CSP treats those as different origins — enforcing `connect-src 'self'` there would refuse the HMR websocket and kill hot reload with no security gain.

**The flip's gate, for whoever tightens this next.** Report-only only ever observes pages visitors actually opened, so four days of a clean feed proved less than it appeared to. A real-browser sweep of 23 surfaces collecting `securitypolicyviolation` found the one thing the feed never could: `/docs/api` pulling 14 webfonts from `fonts.scalar.com`, on a page nobody loads. Answered by turning Scalar's fonts off (`withDefaultFonts: false`) rather than widening `font-src`, since `customCss` already overrode them. Repeat the sweep before any future tightening.

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

Same hybrid shape as the nightly audit: the deterministic half (`docs/agents/hermes/scripts/sentry-triage-sweep.ts`) owns every Sentry API call, so the agent never needs a Sentry credential — and the driver scrubs the box's credential set out of the child's environment (`docs/agents/hermes/scripts/agent-env.sh`) so it never holds one either. That scrub is load-bearing rather than tidy: an issue's `title`, `culprit`, `metadata`, and stack-frame filenames are written by whoever sent the event, and the ingest DSN that lets them send it is public by design. This is the **Agentjacking** shape (Tenet Security, disclosed to Sentry 2026-06-03 and declined at the root as "technically not defensible"), so untrusted text in that prompt is a permanent property of the design. The other two halves of the answer are the field capping in `sanitizeUntrusted` and the untrusted-data framing in `sentry-triage-prompt.md`; none of the three is sufficient alone. The architecture, the stateless PR-body markers, the opt-in auto-merge posture, the secrets, and the one-time operator activation live in [`docs/agents/hermes/sentry-triage-timer/README.md`](./agents/hermes/sentry-triage-timer/README.md); the filed ledger is [`docs/sentry-backlog.md`](./sentry-backlog.md). This is a distinct token from `SENTRY_AUTH_TOKEN` above — triage needs an internal-integration token with `event:read` + `event:write` (org auth tokens can't read issues); the source-map upload above needs only release-write.

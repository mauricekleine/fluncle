# Error tracking

Fluncle's web app (`apps/web`) reports unexpected errors to **Sentry** for private diagnostics — the stack traces and context an operator needs to fix a break, visible only to the operator. This is deliberately separate from the **public liveness** surface: the `/status` + `/health` stack (and the on-box `record_health` layer described in [docs/agents/hermes-agent.md](./agents/hermes-agent.md)) answers "is Fluncle up?" for anyone; Sentry answers "what exactly threw, and where?" for the operator. The two never overlap — the health stack is untouched by this wiring, and Sentry never renders on a public surface.

## The posture: errors only, free-tier

Ratified: Sentry captures **errors and stacks, nothing else**. No performance tracing (`tracesSampleRate: 0`, no tracing integrations), no session replay, no profiling, and `sendDefaultPii: false`. This keeps the account inside the free tier and keeps event volume to the thing that matters — a real exception with a real stack. Raise this bar only by an explicit decision, not by accident.

## What is covered today

**Browser** — `apps/web/src/client.tsx` initializes the SDK (`@sentry/tanstackstart-react`) before hydration, which installs the global `error` and `unhandledrejection` handlers, so an unhandled client exception is captured with its stack.

**The root error boundary** — `apps/web/src/components/root-error-state.tsx` is the root route's `errorComponent` (sibling of `NotFoundBlackHole`, the `notFoundComponent`). A custom error boundary is **not** auto-captured by the router, so it reports the caught error itself via `captureException`. It renders a quiet, canon-styled "rough re-entry" state with a way back — never raw error detail on a public surface.

**The Worker** — `apps/web/src/server.ts` wraps the entire custom server entry with `Sentry.withSentry` (`@sentry/cloudflare`, the Cloudflare-native path). The wrap sits over the whole `fetch`, so an unhandled throw from **either** path — `handleOrpc` (mounted first) or the TanStack router beneath it — is captured with a stack.

**Unexpected API faults** — `apiFault` in `apps/web/src/lib/server/orpc/_shared.ts` already logs an unexpected (non-`ApiError`) 500 to the server log; it now also `captureException`s it, tagged `source: orpc.apiFault`, so those 500s land in Sentry as one filterable group. The existing log line and the generic wire body are unchanged.

Both SDKs initialize **only in a production build** (`import.meta.env.PROD`, statically `false` under `vite dev` / `bun run dev` / the smoke routine, `true` in the deployed Worker bundle). A dev session sends nothing, and when the DSN is absent the SDK is inert.

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

// Sentry wiring constants, shared by the browser entry (client.tsx) and the
// Worker entry (server.ts). See docs/error-tracking.md.
//
// The two DSNs are PUBLIC identifiers — like the R2 account id in wrangler.jsonc,
// they name where events go but grant nothing on their own (ingestion is one-way;
// reading issues needs the auth token, which lives only in the operator vault and
// never in this repo). Both are allowlisted in .gitleaks.toml. Org `fluncle`, EU
// region.

// Browser (client) project DSN.
export const BROWSER_SENTRY_DSN =
  "https://b7fe8117b1aa9848d5f8252a65e8b9ae@o4511752557232128.ingest.de.sentry.io/4511752574468176";

// Worker (server) project DSN.
export const WORKER_SENTRY_DSN =
  "https://9843d82b6f64fef790791e58047ed52b@o4511752557232128.ingest.de.sentry.io/4511752578138192";

// The release name is the build commit SHA, injected at build time by vite's
// `define` (vite.config.ts): `WORKERS_CI_COMMIT_SHA` on Cloudflare Workers Builds,
// falling back to `git rev-parse HEAD` locally. Empty when neither is resolvable
// (e.g. a shallow CI checkout with no git), in which case events carry no release
// rather than a wrong one — so it degrades to `undefined`, never a bogus string.
export const SENTRY_RELEASE: string | undefined =
  typeof import.meta.env.VITE_FLUNCLE_SENTRY_RELEASE === "string" &&
  import.meta.env.VITE_FLUNCLE_SENTRY_RELEASE.length > 0
    ? import.meta.env.VITE_FLUNCLE_SENTRY_RELEASE
    : undefined;

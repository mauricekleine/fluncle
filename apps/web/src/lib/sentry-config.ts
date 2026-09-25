export const BROWSER_SENTRY_DSN =
  "https://b7fe8117b1aa9848d5f8252a65e8b9ae@o4511752557232128.ingest.de.sentry.io/4511752574468176";

export const WORKER_SENTRY_DSN =
  "https://9843d82b6f64fef790791e58047ed52b@o4511752557232128.ingest.de.sentry.io/4511752578138192";

const configuredSentryRelease = import.meta.env?.VITE_FLUNCLE_SENTRY_RELEASE;
export const SENTRY_RELEASE: string | undefined =
  typeof configuredSentryRelease === "string" && configuredSentryRelease.length > 0
    ? configuredSentryRelease
    : undefined;

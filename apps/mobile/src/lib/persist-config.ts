// The offline-cache policy: how long a cached answer lives, which generation a restored
// cache belongs to, and WHAT survives a cold start. Kept pure — no react-query import, no
// AsyncStorage, no RN tree — so every invariant here is pinned by a test. app/_layout.tsx
// is the only wiring: it hands this config plus a persister to PersistQueryClientProvider.
//
// The predicates take structural shapes rather than react-query's `Query` / `Mutation`
// classes; the real types satisfy them, so the call site stays type-checked while this
// module stays framework-free.

/**
 * The shape of the cache we write. Bump it when a persisted payload can no longer satisfy
 * the code that reads it (a hook's `select` changes, a mutation's variables gain a required
 * field). It rides in the buster beside the app version, so a shape change can invalidate
 * every device WITHOUT waiting on a store release.
 */
export const CACHE_SCHEMA = 1;

/**
 * How long an unused cached answer survives in memory. Stated explicitly (react-query
 * defaults to 5 minutes) because the persister's `maxAge` is meaningless above it: gcTime
 * evicts the entry first, so a longer maxAge would be a number that never applies.
 */
export const QUERY_GC_TIME_MS = 24 * 60 * 60 * 1000;

/**
 * How old a RESTORED cache may be before the persister throws it away. Held at (never
 * above) `QUERY_GC_TIME_MS` — see above. Note this discards SILENTLY: a queued submission
 * older than this vanishes with no error and no callback, which is why the window is
 * generous rather than tuned tight.
 */
export const PERSIST_MAX_AGE_MS = QUERY_GC_TIME_MS;

/**
 * The submit flow's mutation key. Stable and hand-written (rather than derived from the
 * oRPC client) because a dehydrated mutation is found again by this key alone after a cold
 * start, and because the dehydrate predicate below must be able to name it without pulling
 * the transport into a pure module.
 */
export const SUBMIT_TRACK_MUTATION_KEY: readonly unknown[] = ["fluncle", "submit_track"];

/**
 * Replays preserve ORDER but not concurrency — without a scope they all fire at once. A
 * shared scope id serializes them, so two submissions queued in a tunnel reach the server
 * one after the other and its hourly rate limit sees a queue rather than a burst.
 */
export const SUBMIT_TRACK_SCOPE = { id: "submit_track" };

/** The minimum a mutation must expose for the dehydrate decision. */
export type DehydratableMutation = {
  options: { mutationKey?: readonly unknown[] };
  state: { isPaused: boolean };
};

/** The minimum a query must expose for the dehydrate decision. */
export type DehydratableQuery = {
  queryKey: readonly unknown[];
  state: { status: string };
};

/**
 * Queries whose cached answer is a live sample of the server's clock, worthless the instant
 * it is stored. Restoring a stale one would hand the radio a slot that finished hours ago.
 */
export const EPHEMERAL_QUERY_OPERATIONS: readonly string[] = ["get_radio_now_playing"];

/**
 * The operation name inside a query key. oRPC keys are `[[path…], { type, input }]`, so the
 * name sits one level in; a plain `["name", …]` key is read too, and anything else answers
 * `undefined` (which persists — an unrecognised key is not a reason to drop a cache entry).
 */
export function queryKeyOperation(queryKey: readonly unknown[]): string | undefined {
  const head = queryKey[0];
  const name = Array.isArray(head) ? (head[0] as unknown) : head;
  return typeof name === "string" ? name : undefined;
}

/**
 * Which mutations are written to storage. react-query already narrows this to PAUSED
 * mutations; this narrows further to an ALLOWLIST, so replay is something a mutation opts
 * into rather than something every future write inherits by accident.
 *
 * What is deliberately out: `search_tracks` (a Spotify lookup the reader fired by hand —
 * replaying it tomorrow answers a question nobody is still asking) and `register_device`
 * (an idempotent push-token upsert that the next consent pass repeats anyway).
 */
export function shouldDehydrateMutation(mutation: DehydratableMutation): boolean {
  return mutation.state.isPaused && isReplayableMutationKey(mutation.options.mutationKey);
}

/** Does this key name a mutation worth replaying after a restart? */
export function isReplayableMutationKey(key: readonly unknown[] | undefined): boolean {
  return (
    key !== undefined &&
    key.length === SUBMIT_TRACK_MUTATION_KEY.length &&
    key.every((segment, i) => segment === SUBMIT_TRACK_MUTATION_KEY[i])
  );
}

/**
 * Which queries are written to storage: the successful ones (react-query's own default —
 * a pending or failed query has nothing worth restoring), minus the live samples above.
 */
export function shouldDehydrateQuery(query: DehydratableQuery): boolean {
  if (query.state.status !== "success") {
    return false;
  }
  const operation = queryKeyOperation(query.queryKey);
  return operation === undefined || !EPHEMERAL_QUERY_OPERATIONS.includes(operation);
}

/**
 * The cache generation. A restored cache whose buster differs is dropped wholesale, so this
 * combines the two reasons to invalidate: shipping a new app version, and changing the
 * persisted shape between versions (CACHE_SCHEMA).
 */
export function cacheBuster(appVersion: string | undefined): string {
  return `${appVersion ?? "0.0.0"}-schema${CACHE_SCHEMA}`;
}

/** Everything PersistQueryClientProvider needs except the persister itself. */
export type PersistConfig = {
  buster: string;
  dehydrateOptions: {
    shouldDehydrateMutation: (mutation: DehydratableMutation) => boolean;
    shouldDehydrateQuery: (query: DehydratableQuery) => boolean;
  };
  maxAge: number;
};

/** Build the persist options for a given app version (expo-constants supplies it). */
export function createPersistConfig(appVersion: string | undefined): PersistConfig {
  return {
    buster: cacheBuster(appVersion),
    dehydrateOptions: { shouldDehydrateMutation, shouldDehydrateQuery },
    maxAge: PERSIST_MAX_AGE_MS,
  };
}

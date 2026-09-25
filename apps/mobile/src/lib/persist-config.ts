export const CACHE_SCHEMA = 1;

export const QUERY_GC_TIME_MS = 24 * 60 * 60 * 1000;

export const PERSIST_MAX_AGE_MS = QUERY_GC_TIME_MS;

export const SUBMIT_TRACK_MUTATION_KEY: readonly unknown[] = ["fluncle", "submit_track"];

export const SUBMIT_TRACK_SCOPE = { id: "submit_track" };

export type DehydratableMutation = {
  options: { mutationKey?: readonly unknown[] };
  state: { isPaused: boolean };
};

export type DehydratableQuery = {
  queryKey: readonly unknown[];
  state: { status: string };
};

const EPHEMERAL_QUERY_OPERATIONS: readonly string[] = ["get_radio_now_playing"];

export function queryKeyOperation(queryKey: readonly unknown[]): string | undefined {
  const head = queryKey[0];
  const name = Array.isArray(head) ? (head[0] as unknown) : head;
  return typeof name === "string" ? name : undefined;
}

export function shouldDehydrateMutation(mutation: DehydratableMutation): boolean {
  return mutation.state.isPaused && isReplayableMutationKey(mutation.options.mutationKey);
}

export function isReplayableMutationKey(key: readonly unknown[] | undefined): boolean {
  return (
    key !== undefined &&
    key.length === SUBMIT_TRACK_MUTATION_KEY.length &&
    key.every((segment, i) => segment === SUBMIT_TRACK_MUTATION_KEY[i])
  );
}

export function shouldDehydrateQuery(query: DehydratableQuery): boolean {
  if (query.state.status !== "success") {
    return false;
  }
  const operation = queryKeyOperation(query.queryKey);
  return operation === undefined || !EPHEMERAL_QUERY_OPERATIONS.includes(operation);
}

export function cacheBuster(appVersion: string | undefined): string {
  return `${appVersion ?? "0.0.0"}-schema${CACHE_SCHEMA}`;
}

export type PersistConfig = {
  buster: string;
  dehydrateOptions: {
    shouldDehydrateMutation: (mutation: DehydratableMutation) => boolean;
    shouldDehydrateQuery: (query: DehydratableQuery) => boolean;
  };
  maxAge: number;
};

export function createPersistConfig(appVersion: string | undefined): PersistConfig {
  return {
    buster: cacheBuster(appVersion),
    dehydrateOptions: { shouldDehydrateMutation, shouldDehydrateQuery },
    maxAge: PERSIST_MAX_AGE_MS,
  };
}

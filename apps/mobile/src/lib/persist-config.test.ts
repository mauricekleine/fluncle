import {
  CACHE_SCHEMA,
  PERSIST_MAX_AGE_MS,
  QUERY_GC_TIME_MS,
  SUBMIT_TRACK_MUTATION_KEY,
  SUBMIT_TRACK_SCOPE,
  cacheBuster,
  createPersistConfig,
  isReplayableMutationKey,
  queryKeyOperation,
  shouldDehydrateMutation,
  shouldDehydrateQuery,
} from "@/lib/persist-config";

function assertEqual<T>(actual: T, expected: T, message = "assertion failed"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(actual: boolean, message = "assertion failed"): void {
  if (!actual) {
    throw new Error(message);
  }
}

function mutation(key: readonly unknown[] | undefined, isPaused: boolean) {
  return { options: { mutationKey: key }, state: { isPaused } };
}
function query(queryKey: readonly unknown[], status: string) {
  return { queryKey, state: { status } };
}

const SEARCH_TRACKS_KEY = [["search_tracks"], { type: "mutation" }];
const REGISTER_DEVICE_KEY = [["register_device"], { type: "mutation" }];
const RADIO_QUERY_KEY = [["get_radio_now_playing"], { type: "query" }];
const FINDINGS_QUERY_KEY = [["list_findings"], { type: "infinite" }];

assertTrue(
  PERSIST_MAX_AGE_MS <= QUERY_GC_TIME_MS,
  `persister maxAge (${PERSIST_MAX_AGE_MS}) must not exceed query gcTime (${QUERY_GC_TIME_MS})`,
);
assertTrue(QUERY_GC_TIME_MS > 5 * 60 * 1000, "gcTime is stated, not react-query's 5m default");

assertEqual(cacheBuster("1.4.0"), `1.4.0-schema${CACHE_SCHEMA}`, "buster joins version + schema");
assertTrue(cacheBuster("1.4.0") !== cacheBuster("1.5.0"), "a version bump changes the buster");
assertEqual(cacheBuster(undefined), `0.0.0-schema${CACHE_SCHEMA}`, "a missing version still busts");
assertTrue(cacheBuster(undefined).length > 0, "the buster is never an empty string");

assertTrue(
  shouldDehydrateMutation(mutation(SUBMIT_TRACK_MUTATION_KEY, true)),
  "a paused submit_track is persisted for replay",
);
assertTrue(
  !shouldDehydrateMutation(mutation(SEARCH_TRACKS_KEY, true)),
  "a paused search_tracks is DROPPED — replaying a hand-fired lookup answers nothing",
);
assertTrue(
  !shouldDehydrateMutation(mutation(REGISTER_DEVICE_KEY, true)),
  "a paused register_device is DROPPED — the next consent pass upserts it anyway",
);
assertTrue(
  !shouldDehydrateMutation(mutation(undefined, true)),
  "a keyless mutation is DROPPED — replay could never find its function again",
);

assertTrue(
  !shouldDehydrateMutation(mutation([["some_future_write"], { type: "mutation" }], true)),
  "an unknown mutation key is excluded by default",
);

assertTrue(
  !shouldDehydrateMutation(mutation(SUBMIT_TRACK_MUTATION_KEY, false)),
  "a submit_track that is NOT paused is not persisted",
);

assertTrue(isReplayableMutationKey(SUBMIT_TRACK_MUTATION_KEY), "the exact key matches");
assertTrue(isReplayableMutationKey(["fluncle", "submit_track"]), "a structural copy matches");
assertTrue(!isReplayableMutationKey(["fluncle"]), "a prefix does not match");
assertTrue(
  !isReplayableMutationKey(["fluncle", "submit_track", "extra"]),
  "a longer key does not match",
);
assertTrue(!isReplayableMutationKey([]), "an empty key does not match");
assertTrue(!isReplayableMutationKey(undefined), "no key does not match");

assertTrue(
  !shouldDehydrateQuery(query(RADIO_QUERY_KEY, "success")),
  "the radio now-playing sample is never persisted, even on success",
);
assertTrue(
  shouldDehydrateQuery(query(FINDINGS_QUERY_KEY, "success")),
  "the findings feed IS persisted — it is the whole point of the offline cache",
);
assertTrue(
  !shouldDehydrateQuery(query(FINDINGS_QUERY_KEY, "pending")),
  "a pending query has nothing worth restoring",
);
assertTrue(
  !shouldDehydrateQuery(query(FINDINGS_QUERY_KEY, "error")),
  "a failed query has nothing worth restoring",
);

assertTrue(shouldDehydrateQuery(query(["list_mixtapes"], "success")), "a flat string key persists");
assertTrue(shouldDehydrateQuery(query([{ odd: true }], "success")), "an unreadable key persists");

assertEqual(SUBMIT_TRACK_SCOPE.id, "submit_track", "submit replays share one scope id");

const config = createPersistConfig("2.0.1");
assertEqual(config.maxAge, PERSIST_MAX_AGE_MS, "factory maxAge is the constant");
assertEqual(config.buster, cacheBuster("2.0.1"), "factory buster is the derived string");
assertTrue(
  config.dehydrateOptions.shouldDehydrateMutation(mutation(SUBMIT_TRACK_MUTATION_KEY, true)),
  "factory carries the mutation predicate",
);
assertTrue(
  !config.dehydrateOptions.shouldDehydrateQuery(query(RADIO_QUERY_KEY, "success")),
  "factory carries the query predicate",
);

assertEqual(queryKeyOperation(RADIO_QUERY_KEY), "get_radio_now_playing", "nested oRPC key");
assertEqual(queryKeyOperation(["list_mixtapes"]), "list_mixtapes", "flat key");
assertEqual(queryKeyOperation([]), undefined, "empty key has no operation");
assertEqual(queryKeyOperation([{ odd: true }]), undefined, "unreadable key has no operation");

// Re-registering the replayable mutations' functions on a fresh QueryClient, BEFORE the
// persisted cache is restored.
//
// A dehydrated mutation carries its key and its variables and nothing else — a function
// cannot cross AsyncStorage. So a restored queue with no defaults fails with "No mutationFn
// found" the moment it replays, which is why this runs at client construction rather than
// in an effect.
//
// The second half of the same trap: callbacks handed to `.mutate(vars, { onSuccess })` are
// dropped on dehydrate and NEVER fire on a replay. Anything a replayed submission must also
// do belongs in the defaults below, not at the call site. Today a replayed submission needs
// nothing beyond the POST — the screen that fired it is long gone, and the server owns the
// submission's status from there.
import { type QueryClient } from "@tanstack/react-query";
import { orpc } from "@/api/orpc";
import { SUBMIT_TRACK_MUTATION_KEY, SUBMIT_TRACK_SCOPE } from "@/lib/persist-config";

export function registerMutationDefaults(queryClient: QueryClient): void {
  const { mutationFn } = orpc.submit_track.mutationOptions({
    mutationKey: SUBMIT_TRACK_MUTATION_KEY,
  });

  queryClient.setMutationDefaults(SUBMIT_TRACK_MUTATION_KEY, {
    mutationFn,
    scope: SUBMIT_TRACK_SCOPE,
  });
}

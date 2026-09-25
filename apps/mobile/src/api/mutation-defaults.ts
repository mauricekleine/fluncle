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

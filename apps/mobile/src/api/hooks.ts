// Typed TanStack Query hooks — the only thing the UI imports for data.
// Forward path (Phase 1): these wrap the oRPC client via @orpc/tanstack-query
// (orpc.tracks.list.infiniteOptions(...) etc.); components stay unchanged.
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { type TrackListItem, type TrackListPage } from "@fluncle/contracts";
import {
  fetchFinding,
  fetchFindingsFeed,
  registerDevice,
  type RegisterDeviceRequest,
} from "@/api/client";

export const queryKeys = {
  finding: (idOrLogId: string) => ["findings", "one", idOrLogId] as const,
  findingsFeed: ["findings", "feed"] as const,
};

/** The findings feed (the Stories pager + the archive both read this). */
export function useFindingsFeed() {
  return useInfiniteQuery({
    getNextPageParam: (last: TrackListPage) => last.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchFindingsFeed(pageParam),
    queryKey: queryKeys.findingsFeed,
    staleTime: Infinity,
  });
}

/** Flatten the infinite-query pages into one findings array. */
export function flattenFeed(pages: { tracks: TrackListItem[] }[] | undefined): TrackListItem[] {
  return pages?.flatMap((p) => p.tracks) ?? [];
}

export function useFinding(idOrLogId: string) {
  return useQuery({
    enabled: Boolean(idOrLogId),
    queryFn: () => fetchFinding(idOrLogId),
    queryKey: queryKeys.finding(idOrLogId),
  });
}

export function useRegisterDevice() {
  return useMutation({
    mutationFn: (req: RegisterDeviceRequest) => registerDevice(req),
  });
}

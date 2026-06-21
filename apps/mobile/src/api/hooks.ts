// Typed TanStack Query hooks — the only thing the UI imports for data. Phase 1:
// these wrap the live oRPC client (`orpc.tracks.*` from ./orpc.ts) over the same
// public contract the web serves. The hook names + return shapes are stable, so
// no UI file changes.
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { type FeedItem, type TrackListItem } from "@fluncle/contracts";
import { orpc } from "@/api/orpc";

// Phase 1 (slice B) replaces this with the real `devices` contract op. Kept as a
// typed stub so the push consent UX (app/notifications.tsx) stays wired.
export type RegisterDeviceRequest = {
  appVersion?: string;
  mutedCategories?: ("finding" | "mixtape")[];
  platform: "android" | "ios";
  token: string;
};

/** A feed page as the contract emits it (findings + published mixtapes interleaved). */
type FeedPage = { nextCursor?: string; tracks: FeedItem[] };

/** A finding (the `TrackListItem` arm of a feed item — not a mixtape). */
function isFinding(item: FeedItem): item is TrackListItem {
  return item.type !== "mixtape";
}

/** The findings feed (the Stories pager + the archive both read this). */
export function useFindingsFeed() {
  return useInfiniteQuery(
    orpc.list_tracks.infiniteOptions({
      getNextPageParam: (last) => last.nextCursor,
      initialPageParam: undefined as string | undefined,
      input: (cursor: string | undefined) => ({ cursor }),
    }),
  );
}

/**
 * Flatten the infinite-query pages into one findings array. The merged feed can
 * carry published mixtapes; the app's surfaces render findings, so mixtapes are
 * dropped here (the UI only ever sees `TrackListItem`).
 */
export function flattenFeed(pages: FeedPage[] | undefined): TrackListItem[] {
  return pages?.flatMap((p) => p.tracks.filter(isFinding)) ?? [];
}

/**
 * A single finding by Spotify trackId or Log ID. `get_track` can resolve a Log ID
 * to a mixtape; the app's /log surface renders findings, so the mixtape arm maps
 * to `undefined` (the screen shows its "not found" state).
 */
export function useFinding(idOrLogId: string) {
  return useQuery(
    orpc.get_track.queryOptions({
      enabled: Boolean(idOrLogId),
      input: { idOrLogId },
      select: (res) => ("track" in res ? res.track : undefined),
    }),
  );
}

export function useRegisterDevice() {
  return useMutation({
    // TODO(slice B): call the real `devices` contract op (POST /api/v1/devices)
    // once it lands; until then this is a no-op so the consent UX is testable.
    mutationFn: async (req: RegisterDeviceRequest): Promise<{ ok: true }> => {
      if (__DEV__) {
        console.log("[push] registerDevice (stub):", req.platform);
      }
      return { ok: true };
    },
  });
}

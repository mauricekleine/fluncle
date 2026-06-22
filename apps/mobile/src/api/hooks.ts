// Typed TanStack Query hooks — the only thing the UI imports for data. Phase 1:
// these wrap the live oRPC client (the flat `orpc.*` ops from ./orpc.ts) over the
// same public contract the web serves. The hook names + return shapes are stable,
// so no UI file changes.
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { type FeedItem, type TrackListItem } from "@fluncle/contracts";
import { orpc } from "@/api/orpc";

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
 * What a Log ID resolved to: a finding the app can render, a mixtape it can't
 * (those live on the web), or nothing (a dead coordinate). The screen tells the
 * three apart so a mixtape deep-link reads "open on web", not "not found".
 */
export type FindingResolution =
  | { kind: "finding"; finding: TrackListItem }
  | { kind: "mixtape"; logId?: string }
  | { kind: "missing" };

/**
 * A single finding by Spotify trackId or Log ID. `get_track` can resolve a Log ID
 * to a mixtape; the app renders findings, not mixtapes, so a mixtape resolves to
 * its own `mixtape` arm (the screen points the crew to the web) rather than the
 * same "not found" state as a dead coordinate.
 */
export function useFinding(idOrLogId: string) {
  return useQuery(
    orpc.get_track.queryOptions({
      enabled: Boolean(idOrLogId),
      input: { idOrLogId },
      select: (res): FindingResolution => {
        if ("track" in res) {
          return { finding: res.track, kind: "finding" };
        }

        return { kind: "mixtape", logId: res.mixtape.logId };
      },
    }),
  );
}

/**
 * Register this device's Expo push token for new-finding / new-mixtape pushes —
 * the live `register_device` op (POST /api/v1/devices), an idempotent upsert. The
 * token comes from the consent flow (src/push/notifications.ts); the actual send
 * stays dark until the server's EXPO_ACCESS_TOKEN is set.
 */
export function useRegisterDevice() {
  return useMutation(orpc.register_device.mutationOptions());
}

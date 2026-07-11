// Typed TanStack Query hooks — the only thing the UI imports for data. Phase 1:
// these wrap the live oRPC client (the flat `orpc.*` ops from ./orpc.ts) over the
// same public contract the web serves. The hook names + return shapes are stable,
// so no UI file changes.
import { useCallback } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FeedItem, type RadioNowPlaying, type TrackListItem } from "@fluncle/contracts";
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

/**
 * Spotify candidate search for the submit flow — the `search_tracks` op
 * (GET /api/v1/search?q=…). Driven imperatively (a Search button, not type-ahead)
 * so the operator's shared Spotify token isn't burned on every keystroke; the
 * server rate-limits it regardless. `.mutate({ q })` returns `{ ok, results }`.
 */
export function useTrackSearch() {
  return useMutation(orpc.search_tracks.mutationOptions());
}

/**
 * Submit a picked candidate as a finding for review — the public anonymous-write
 * `submit_track` op (POST /api/v1/submissions), the same contract the web submit
 * dialog posts. No auth: a submission is a message in a bottle, and the server owns
 * its status (validation, the hourly rate limit, triage). `.mutate(SubmissionBody)`
 * resolves to `{ ok: true, submission }`; faults carry the server `{ status, data }`
 * the screen maps to its honest result states.
 */
export function useSubmitTrack() {
  return useMutation(orpc.submit_track.mutationOptions());
}

/**
 * Fluncle's published mixtapes, newest first — the `list_mixtapes` op (GET /mixtapes),
 * the same read the web `/mixtapes` surface uses. Selects the `mixtapes` array out of
 * the `{ ok, mixtapes }` envelope so the screen gets a plain list. The mixtape detail
 * reads the same cached query and finds its logId, so no per-mixtape op is needed.
 */
export function useMixtapes() {
  return useQuery(orpc.list_mixtapes.queryOptions({ select: (res) => res.mixtapes }));
}

/** A timed now-playing sample: the slot plus the send/receive instants for NTP-lite skew. */
export type RadioSlotFetch = { receivedAt: number; sentAt: number; slot: RadioNowPlaying };

/**
 * An imperative fetcher for the radio's server-authoritative now-playing slot
 * (`get_radio_now_playing`, GET /radio/now-playing). Returned as a function (not a
 * subscribed query) because the radio controller polls it on its own cadence and needs
 * the send/receive timestamps AROUND each call to compute clock skew. Bypasses the
 * cache (`staleTime: 0`) so every poll is a genuine network sample of the server clock.
 * An empty eligible set is a 404 the caller catches into the quiet-sector state.
 */
export function useRadioSlotFetcher(): () => Promise<RadioSlotFetch> {
  const queryClient = useQueryClient();

  return useCallback(async () => {
    const options = orpc.get_radio_now_playing.queryOptions();
    const sentAt = Date.now();
    const res = await queryClient.fetchQuery({ ...options, gcTime: 0, staleTime: 0 });
    const receivedAt = Date.now();

    return { receivedAt, sentAt, slot: res.nowPlaying };
  }, [queryClient]);
}

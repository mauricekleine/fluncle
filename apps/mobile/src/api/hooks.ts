import { useCallback } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FeedItem, type RadioNowPlaying, type TrackListItem } from "@fluncle/contracts";
import { orpc } from "@/api/orpc";
import { SUBMIT_TRACK_MUTATION_KEY, SUBMIT_TRACK_SCOPE } from "@/lib/persist-config";

type FeedPage = { nextCursor?: string; tracks: FeedItem[] };

function isFinding(item: FeedItem): item is TrackListItem {
  return item.type !== "mixtape";
}

export function useFindingsFeed() {
  return useInfiniteQuery(
    orpc.list_findings.infiniteOptions({
      getNextPageParam: (last) => last.nextCursor,
      initialPageParam: undefined as string | undefined,
      input: (cursor: string | undefined) => ({ cursor }),
    }),
  );
}

export function flattenFeed(pages: FeedPage[] | undefined): TrackListItem[] {
  return pages?.flatMap((p) => p.tracks.filter(isFinding)) ?? [];
}

export type FindingResolution =
  | { kind: "finding"; finding: TrackListItem }
  | { kind: "mixtape"; logId?: string }
  | { kind: "missing" };

export function useFinding(idOrLogId: string) {
  return useQuery(
    orpc.get_track.queryOptions({
      enabled: Boolean(idOrLogId),
      input: { idOrLogId },
      select: (res): FindingResolution => {
        if ("track" in res) {
          return { finding: res.track, kind: "finding" };
        }

        if (!("mixtape" in res)) {
          return { kind: "missing" };
        }

        return { kind: "mixtape", logId: res.mixtape.logId };
      },
    }),
  );
}

export function useArchiveSearch(query: string | undefined) {
  const trimmed = query?.trim() ?? "";
  return useQuery(
    orpc.search_archive.queryOptions({
      enabled: trimmed.length >= 2,
      input: { q: trimmed },
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    }),
  );
}

export function useRegisterDevice() {
  return useMutation(orpc.register_device.mutationOptions());
}

export function useTrackSearch() {
  return useMutation(orpc.search_tracks.mutationOptions());
}

export function useSubmitTrack() {
  return useMutation(
    orpc.submit_track.mutationOptions({
      mutationKey: SUBMIT_TRACK_MUTATION_KEY,
      scope: SUBMIT_TRACK_SCOPE,
    }),
  );
}

export function useMixtapes() {
  return useQuery(orpc.list_mixtapes.queryOptions({ select: (res) => res.mixtapes }));
}

export function useMixableArtists(q?: string) {
  const trimmed = q?.trim() ?? "";
  return useQuery(
    orpc.list_mixable_artists.queryOptions({
      input: trimmed ? { limit: "48", q: trimmed } : { limit: "48" },
      refetchOnWindowFocus: false,
      select: (res) => res.artists,
      staleTime: 60_000,
    }),
  );
}

export function useMixOpeners(taste: string[]) {
  return useQuery(
    orpc.list_mix_openers.queryOptions({
      enabled: taste.length > 0,
      input: { limit: "24", taste: taste.join(",") },
      refetchOnWindowFocus: false,
      select: (res) => res.tracks,
      staleTime: 60_000,
    }),
  );
}

export function useMixableTracks(params: {
  exclude: string[];
  idOrLogId: string | undefined;
  taste: string[];
}) {
  const { exclude, idOrLogId, taste } = params;
  return useQuery(
    orpc.list_mixable_tracks.queryOptions({
      enabled: Boolean(idOrLogId),
      input: {
        idOrLogId: idOrLogId ?? "",
        limit: "12",
        ...(exclude.length > 0 ? { exclude: exclude.join(",") } : {}),
        ...(taste.length > 0 ? { taste: taste.join(",") } : {}),
      },
      refetchOnWindowFocus: false,
      select: (res) => res.findings,
    }),
  );
}

export type RadioSlotFetch = { receivedAt: number; sentAt: number; slot: RadioNowPlaying };

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

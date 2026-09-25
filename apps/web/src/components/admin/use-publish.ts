import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { type MixtapeMembership } from "@/lib/server/mixtapes";
import { type PlanMembership } from "@/lib/server/recordings";
import { type SocialPostItem } from "@/lib/server/social";
import { type BoardTrackListItem } from "@/lib/server/tracks";

export type BoardRow = BoardTrackListItem & {
  discogsRan: boolean;

  hasContextNote: boolean;

  hasEmbedding: boolean;

  lastfmLoved: boolean;

  lastfmRan: boolean;

  mixtapes: MixtapeMembership[];

  noteRan: boolean;

  plans: PlanMembership[];
  posts: SocialPostItem[];
};
export type BoardPage = { nextCursor?: string; totalCount: number; tracks: BoardRow[] };

export function usePublish(boardKey: readonly unknown[]) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | undefined>();

  const applyPost = useCallback(
    (trackId: string, platform: string, patch: Partial<SocialPostItem>) => {
      const now = new Date().toISOString();

      queryClient.setQueryData<InfiniteData<BoardPage, string | undefined>>(boardKey, (current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            tracks: page.tracks.map((row) => {
              if (row.trackId !== trackId) {
                return row;
              }

              const existing = row.posts.find((post) => post.platform === platform);
              const merged: SocialPostItem = existing
                ? { ...existing, ...patch, updatedAt: now }
                : { createdAt: now, platform, status: "draft", updatedAt: now, ...patch };

              return {
                ...row,
                posts: [...row.posts.filter((post) => post.platform !== platform), merged],
              };
            }),
          })),
        };
      });
    },
    [boardKey, queryClient],
  );

  const run = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [key]: true }));
    setError(undefined);

    try {
      await fn();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy((current) => ({ ...current, [key]: false }));
    }
  }, []);

  const pushDraft = useCallback(
    (trackId: string, platform: string) =>
      run(`${trackId}:${platform}:draft`, async () => {
        const response = await fetch(`/api/v1/admin/tracks/${trackId}/social/${platform}/draft`, {
          credentials: "same-origin",
          method: "POST",
        });
        const data = (await response.json()) as {
          externalId?: string;
          message?: string;
          ok?: boolean;
          status?: string;
        };

        if (!response.ok || !data.ok) {
          throw new Error(data.message ?? `Push failed (${response.status})`);
        }

        applyPost(trackId, platform, {
          externalId: data.externalId,
          status: data.status ?? "draft",
        });
      }),
    [applyPost, run],
  );

  const setStatus = useCallback(
    (trackId: string, platform: string, status: string, url?: string) =>
      run(`${trackId}:${platform}:${status}`, async () => {
        const response = await fetch(`/api/v1/admin/tracks/${trackId}/social/${platform}`, {
          body: JSON.stringify({ status, ...(url ? { url } : {}) }),
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        const data = (await response.json()) as { message?: string; ok?: boolean };

        if (!response.ok || !data.ok) {
          throw new Error(data.message ?? `Update failed (${response.status})`);
        }

        applyPost(trackId, platform, { status, ...(url ? { url } : {}) });
      }),
    [applyPost, run],
  );

  return { busy, error, pushDraft, setError, setStatus };
}

import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { type ArtistFollowTarget } from "@/lib/server/artists";
import { type MixtapeMembership } from "@/lib/server/mixtapes";
import { type PlanMembership } from "@/lib/server/recordings";
import { type SocialPostItem } from "@/lib/server/social";
import { type TrackListItem } from "@/lib/server/tracks";

// The publish engine for the admin board (`/admin`). It reads the
// `social_posts`-joined infinite query and pushes/records posts through the same
// gated admin API the CLI uses; the mutations + optimistic cache patching live
// here. The board passes its react-query key; the hook patches that cache in place
// after each mutation and the next window-focus refetch reconciles with the server.

/** A page row: a finding plus its per-platform posts and mixtape memberships. */
export type BoardRow = TrackListItem & {
  // The Spotify/YouTube follow targets for this finding's artist(s) — the automated-
  // socials cell reads this (folded with the Last.fm love). Aggregated per platform:
  // `followed` is true only when every such target is followed. Pulled through the
  // admin-only board path (the identity graph never rides the public track contract).
  artistFollows: ArtistFollowTarget[];
  // Whether the Discogs backfill has RUN for this finding — the presence of
  // `backfill_discogs_attempted_at`, stamped on every real attempt (a resolve OR a
  // clean no-match). The board's Discogs cell is a WORKFLOW tracker: `done` once it
  // ran (whether or not it linked a release), grey only while it's never run. Paired
  // with `discogsReleaseUrl` to tell "Linked" from "Checked — no release". Pulled
  // through the admin-only board path (reliability columns never ride the public
  // `TrackListItem` contract).
  discogsRan: boolean;
  // Whether the finding carries an internal `context_note` (the firecrawl-derived
  // facts that fuel the observation script). Pulled through the admin-only board
  // path, never the public `TrackListItem` contract — see observation-board.ts.
  hasContextNote: boolean;
  // Whether the finding carries a MuQ audio embedding (`embedding_json IS NOT NULL`).
  // Drives the Embeddings cell: the embed cron drains the `embedding_json IS NULL`
  // queue and stamps the vector. The vector is internal analysis fuel, so only its
  // presence rides this admin-only board path, never the public `TrackListItem`
  // contract — see tracks.ts listEmbeddingPresenceForTracks + docs/rfcs/audio-embedding-rfc.md.
  hasEmbedding: boolean;
  // Whether the finding is already loved on Last.fm — the presence of
  // `backfill_lastfm_done_at`, the same stamp the Last.fm backfill writes on a
  // successful `track.love`. Pulled through the admin-only board path (the
  // backfill-reliability columns never ride the public `TrackListItem` contract).
  lastfmLoved: boolean;
  // Whether the Last.fm backfill has RUN for this finding — the presence of
  // `backfill_lastfm_attempted_at`, stamped on every real attempt. Like Discogs, the
  // Last.fm cell is a workflow tracker: `done` once it ran, grey only while it's
  // never run; paired with `lastfmLoved` to tell "Loved" from "Checked — not loved".
  lastfmRan: boolean;
  // The MINTED mixtapes this finding is on (published/distributing — drafts
  // retired for plans).
  mixtapes: MixtapeMembership[];
  // Whether the auto-note authoring has RUN for this finding — the presence of
  // `backfill_note_attempted_at`, stamped on every authoring attempt by `note_track`.
  // Like Discogs/Last.fm the Note cell is a workflow tracker: `done` once a note
  // exists, grey only while none does (the cron hasn't authored one and the operator
  // hasn't typed one). Pulled through the admin-only board path, never the public
  // `TrackListItem` contract.
  noteRan: boolean;
  // The PLANS this finding is pencilled into — the pre-publish sibling of
  // `mixtapes` (a plan is a videoless recording; its cues carry the finding link).
  plans: PlanMembership[];
  posts: SocialPostItem[];
};
export type BoardPage = { nextCursor?: string; totalCount: number; tracks: BoardRow[] };

export function usePublish(boardKey: readonly unknown[]) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | undefined>();

  // Merge a platform post into a row after a successful mutation, so the board
  // reflects the new state without a full refetch. Patches the cached infinite
  // pages directly; the next window-focus refetch reconciles with the server.
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
        const response = await fetch(`/api/admin/tracks/${trackId}/social/${platform}/draft`, {
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
        const response = await fetch(`/api/admin/tracks/${trackId}/social/${platform}`, {
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

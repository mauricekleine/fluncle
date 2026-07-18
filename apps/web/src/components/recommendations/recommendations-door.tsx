// THE VERIFIED WORKING SURFACE — the door behind the gate, laid out as THE PLAYLIST
// BUILDER (Spotify's own playlist-edit grammar, in Fluncle's register): the playlist
// panel on the left (the header — collage, name, the gold Get-playlist CTA — over the
// numbered tracklist being assembled, with the search between them) and the Recommended
// shelf on the right (what the engine lines up from the picks, each row an Add pill).
// It owns the two loader-seeded react-query reads (the picks + the computed
// recommendations, the account-door hybrid: SSR real content on first paint, refetchable
// after a write) and the two CSRF-guarded pick mutations both panels lean on. A pick
// write invalidates BOTH reads: new picks mean a new shelf.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PlaylistPanel } from "./playlist-panel";
import { RecommendedPanel } from "./recommended-panel";
import { type RecommendationsResult, type RecSeedItem, seedMutationMessage } from "./shared";

export function RecommendationsDoor({
  csrfToken,
  initialRecommendations,
  initialSeeds,
  loadRecommendations,
  loadSeeds,
}: {
  csrfToken: string;
  initialRecommendations: RecommendationsResult;
  initialSeeds: RecSeedItem[];
  loadRecommendations: () => Promise<RecommendationsResult>;
  loadSeeds: () => Promise<RecSeedItem[]>;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");

  // The picks and the computed recommendations, each seeded from the loader (SSR) and never
  // refetched on focus — this is a public surface, not the admin board (focus-refetch would
  // also burn the recommendations' hourly budget). A pick write invalidates BOTH: new picks
  // mean new recommendations.
  //
  // The staleTime is LOAD-BEARING: without it react-query treats initialData as already
  // stale (staleTime 0) and re-runs the whole engine on mount — a second full vector scan
  // for the exact result the SSR loader just computed, and a second tick off the hourly
  // budget, on every page open. Freshness rides the mutations (each pick write invalidates
  // both keys), never the clock.
  const seedsQuery = useQuery({
    initialData: initialSeeds,
    queryFn: loadSeeds,
    queryKey: ["rec-seeds"],
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  const recsQuery = useQuery({
    initialData: initialRecommendations,
    queryFn: loadRecommendations,
    queryKey: ["recommendations"],
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });

  const seeds = seedsQuery.data;
  const recs = recsQuery.data;

  const seedMutation = useMutation({
    mutationFn: async (op: { kind: "add" | "remove"; trackId: string }) => {
      const response =
        op.kind === "add"
          ? await fetch("/api/me/rec-seeds", {
              body: JSON.stringify({ trackId: op.trackId }),
              headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
              method: "POST",
            })
          : await fetch(`/api/me/rec-seeds/${encodeURIComponent(op.trackId)}`, {
              headers: { "Content-Type": "application/json", "x-fluncle-csrf": csrfToken },
              method: "DELETE",
            });

      if (response.status === 401) {
        window.location.href = "/account";

        return;
      }

      const body = await response.json().catch(() => undefined);

      setMessage(seedMutationMessage({ body, ok: response.ok, status: response.status }));

      if (response.ok) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["rec-seeds"] }),
          queryClient.invalidateQueries({ queryKey: ["recommendations"] }),
        ]);
      }
    },
  });

  return (
    <div className="rec-build">
      <PlaylistPanel
        csrfToken={csrfToken}
        message={message}
        onAdd={(trackId) => seedMutation.mutateAsync({ kind: "add", trackId })}
        onRemove={(trackId) => seedMutation.mutateAsync({ kind: "remove", trackId })}
        seeds={seeds}
      />
      <RecommendedPanel
        catalogue={recs.catalogue}
        findings={recs.findings}
        onAdd={(trackId) => seedMutation.mutateAsync({ kind: "add", trackId })}
        onRemove={(trackId) => seedMutation.mutateAsync({ kind: "remove", trackId })}
        seeds={seeds}
        seedsSkipped={recs.seedsSkipped}
      />
    </div>
  );
}
